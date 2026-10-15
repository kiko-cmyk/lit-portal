import { after } from "next/server";
import { withCustomer } from "@/lib/api-helpers";
import { referralsEnabledFor } from "@/lib/flags";
import { runAsBackgroundJob } from "@/lib/http-timeout";
import { enforceRateLimit } from "@/lib/rate-limit";
import { hasB2BTag, REFERRAL_FRIEND_AMOUNT_EUR, REFERRAL_REWARD_CENTS } from "@/lib/referral-core";
import { ensurePendingCode, issuePendingCodes, readReferralStats } from "@/lib/referral-reward";
import { readCustomerBasics } from "@/lib/referral-shopify";
import { mapStatus, seal } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";
import type { ReferralCodeResponse } from "@/lib/types";

/**
 * GET /apps/portal/api/referral/code — la tarjeta «Trae a alguien» de Mi LIT.
 *
 * Lee el código del cliente y, si aún no tiene, se lo RESERVA (una fila `pending`
 * en Supabase). Desde el 2026-10-14 el alta en Shopify de ese código sale AL
 * MOMENTO, en segundo plano después de contestar, y la tarjeta vuelve a preguntar
 * unos segundos hasta tenerlo (Juan: «¿cómo que estará listo en unas horas?»).
 * Antes esperaba a la pasada del cron `referral-sweep` (cada 4 h), que sigue
 * siendo la red si el alta de aquí falla.
 *
 * Nunca devuelve nada de los amigos: solo contadores y fechas.
 *
 * Sustituye al GET de abril, que generaba un código con Math.random que no
 * existía en Shopify y devolvía un enlace con `?ref=` (el parámetro de GoAffPro).
 * Nada del front lo llamaba.
 */
export const GET = withCustomer<ReferralCodeResponse>(async (_req, ctx) => {
  await enforceRateLimit(ctx.customerId, "referral-code", { limit: 30, windowMs: 60_000 });

  const off: ReferralCodeResponse = {
    enabled: false,
    status: "unavailable",
    code: null,
    friendAmountEur: Number(REFERRAL_FRIEND_AMOUNT_EUR),
    rewardAmountEur: REFERRAL_REWARD_CENTS / 100,
    friendsJoined: 0,
    rewards: { queued: 0, applied: 0, consumed: 0, nextDiscountedChargeAt: null },
    termsUrl: null,
  };
  if (!referralsEnabledFor(ctx.customerId)) return off;

  // Nombre (para reservarle el código) y etiquetas (B2B) en una sola lectura. La
  // etiqueta se mira directa, no con isB2BCustomer: apagar el modo B2B del portal
  // (B2B_ACCOUNT_ONLY=off) no puede abrir los referidos a los partners.
  const basics = await readCustomerBasics(ctx.customerId);
  if (!basics || hasB2BTag(basics.tags)) return off;

  const sb = supabaseAdmin();
  const { data: row, error } = await sb
    .from("referral_codes")
    .select("code, status, updated_at")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  if (error) throw new Error(`referral_codes read: ${error.message}`);

  let status: ReferralCodeResponse["status"];
  let code: string | null = null;
  let issueNow = false;
  if (row?.status === "active") {
    status = "active";
    code = row.code as string;
  } else if (!row || row.status === "retired") {
    // Solo invita quien tiene una suscripción ACTIVA (condiciones del programa).
    // Se comprueba contra Seal una sola vez, al reservar; después ya hay fila.
    const subs = basics.email ? await seal.getSubscriptionsByEmail(basics.email) : [];
    if (!subs.some((s) => mapStatus(s) === "active")) return { ...off, enabled: true };
    await ensurePendingCode(ctx.customerId, basics.firstName);
    status = "pending";
    issueNow = true;
  } else if (row.status === "pending") {
    status = "pending";
    // Cada intento de alta toca `updated_at`: si hay uno de hace menos de 30 s,
    // sigue en marcha y la tarjeta solo tiene que volver a preguntar.
    issueNow = Date.now() - Date.parse(String(row.updated_at ?? "")) > 30_000;
  } else {
    // failed | disabled: no se le enseña un código que no funciona.
    status = "unavailable";
  }

  if (issueNow) {
    // Alta en Shopify de ESTE código, ya, sin esperar a la pasada del cron. En
    // segundo plano para no alargar la respuesta (el alta y su comprobación tardan
    // unos segundos). Si dos altas del mismo código se cruzan, issuePendingCodes da
    // por bueno el que ya esté dentro del descuento padre; si esta falla, el cron
    // la recoge en su pasada.
    const customerId = ctx.customerId;
    after(() =>
      runAsBackgroundJob(() =>
        issuePendingCodes({ max: 1, onlyCustomerIds: [customerId], deadlineMs: Date.now() + 30_000 }),
      ).catch((e) => console.warn("[referral/code] alta al momento falló; la recoge el cron", customerId, e)),
    );
  }

  const stats = await readReferralStats(ctx.customerId);
  return {
    enabled: true,
    status,
    code,
    friendAmountEur: Number(REFERRAL_FRIEND_AMOUNT_EUR),
    rewardAmountEur: REFERRAL_REWARD_CENTS / 100,
    friendsJoined: stats.friendsJoined,
    rewards: {
      queued: stats.queued,
      applied: stats.applied,
      consumed: stats.consumed,
      nextDiscountedChargeAt: stats.nextDiscountedChargeAt,
    },
    termsUrl: process.env.REFERRAL_TERMS_URL?.trim() || null,
  };
});

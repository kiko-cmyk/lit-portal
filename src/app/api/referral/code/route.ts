import { withCustomer } from "@/lib/api-helpers";
import { referralsEnabledFor } from "@/lib/flags";
import { enforceRateLimit } from "@/lib/rate-limit";
import { hasB2BTag, REFERRAL_FRIEND_AMOUNT_EUR, REFERRAL_REWARD_CENTS } from "@/lib/referral-core";
import { ensurePendingCode, readReferralStats } from "@/lib/referral-reward";
import { readCustomerBasics } from "@/lib/referral-shopify";
import { mapStatus, seal } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";
import type { ReferralCodeResponse } from "@/lib/types";

/**
 * GET /apps/portal/api/referral/code — la tarjeta «Trae a alguien» de Mi LIT.
 *
 * Solo LEE (2026-10-10). El código de cada cliente lo da de alta en Shopify el
 * cron `referral-sweep`, en bloque; aquí no se crea nada en Shopify. Lo único que
 * puede escribir es la RESERVA de un cliente que aún no tiene código (una fila
 * `pending` en Supabase), para que el cron se lo emita: la tarjeta dice entonces
 * «tu código estará listo en unas horas» (el cron pasa cada 4 h).
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
    .select("code, status")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  if (error) throw new Error(`referral_codes read: ${error.message}`);

  let status: ReferralCodeResponse["status"];
  let code: string | null = null;
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
  } else if (row.status === "pending") {
    status = "pending";
  } else {
    // failed | disabled: no se le enseña un código que no funciona.
    status = "unavailable";
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

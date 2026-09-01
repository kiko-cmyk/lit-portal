import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { suggestLongerCadence } from "@/lib/cadence-fit";
import { awardDrops, DROPS_AMOUNTS, TIER_THRESHOLD } from "@/lib/drops";
import { mixBoxCount } from "@/lib/mix";
import { SURVEY_CONSENT } from "@/lib/survey-consent-copy";
import { validateAnswers } from "@/lib/profile-questions";
import { langFromRequest } from "@/lib/request-lang";
import { enforceRateLimit } from "@/lib/rate-limit";
import { mapToSubscription } from "@/lib/seal";
import { resolveActiveSubFast } from "@/lib/sub-resolve";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";
import type { Frequency } from "@/lib/types";

/**
 * Formulario de perfilado del área personal ("Conoce a tus clientes").
 *
 *   GET  /apps/portal/api/survey/profile  → estado + respuestas previas
 *   POST /apps/portal/api/survey/profile  → guarda, paga 50 drops, propone cadencia
 *
 * ── Tres decisiones de esta ruta, con su motivo ──
 *
 * 1. NO habla con Klaviyo. Escribe Postgres y responde; un cron empuja las `cs_*`
 *    leyendo `klaviyo_synced_at is null`. Motivo: `klaviyo.ts` no pasa `signal` a
 *    `fetch` (lo dice `http-timeout.ts` como hueco conocido), así que un socket
 *    colgado se comería el `maxDuration` entero y moriría en silencio DESPUÉS de
 *    haber guardado. Y `upsertProfile` no tenía ni un call site en el repo, o sea
 *    que es un camino que se estrena. Estrenarlo en un job de fondo reintentable
 *    es gratis; estrenarlo delante de un cliente que acaba de contestar nueve
 *    preguntas, no. (Tampoco vale mandarlo fire-and-forget después de responder:
 *    el repo ya se quemó con eso, ver el comentario de `subscription/cancel`.)
 *
 * 2. El guardado va ANTES que el pago, y el pago en su propio try/catch. Si la
 *    migración del CHECK de `drops_events.action` no llegó a producción, el
 *    INSERT de los drops revienta — y en ese caso queremos perder el premio, que
 *    se puede reconciliar después, y NO la respuesta del cliente, que no la va a
 *    escribir dos veces.
 *
 * 3. La propuesta de cadencia se calcula AQUÍ, releyendo la suscripción viva, y
 *    no en el cliente con el objeto que ya tenía en memoria. Una pestaña puede
 *    llevar media hora abierta, y en ese rato el cliente ha podido pausar, saltar
 *    una entrega o entrar en la ventana de corte.
 */

export const maxDuration = 20;

const DEDUP_PREFIX = "survey:profile_v1:";

interface SurveyBody {
  answers?: unknown;
  consent?: unknown;
}

export interface CadenceOffer {
  from: Frequency;
  to: Frequency;
  /** El suministro daba para más de 6 meses. La propuesta mejora igual, pero es
   *  incompleta. NO se le dice al cliente: sale por una lista. */
  cappedAtSixMonths: boolean;
}

export interface SurveyState {
  answered: boolean;
  answers: Record<string, string>;
  consent: boolean;
  /** Ya cobró alguna vez. Un reenvío no vuelve a pagar. */
  alreadyPaid: boolean;
}

export interface SurveySubmitResult {
  dropsAwarded: number;
  balance: number;
  /** Ha cruzado los 300 CON este envío. Solo entonces se celebra el tier. */
  tierCrossed: boolean;
  cadenceOffer: CadenceOffer | null;
}

// ── GET: estado ──────────────────────────────────────────────────────────────

export const GET = withCustomer<SurveyState>(async (_req, ctx) => {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("profile_survey_answers")
    .select("answers, consent")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();

  const { data: paid } = await sb
    .from("drops_events")
    .select("id")
    .eq("dedup_key", `${DEDUP_PREFIX}${ctx.customerId}`)
    .maybeSingle();

  return {
    answered: !!data,
    answers: (data?.answers as Record<string, string> | undefined) ?? {},
    consent: data?.consent === true,
    alreadyPaid: !!paid,
  };
});

// ── POST: guardar ────────────────────────────────────────────────────────────

export const POST = withCustomer<SurveySubmitResult>(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "survey-profile", { limit: 10, windowMs: 60_000 });

  const body = (await req.json().catch(() => ({}))) as SurveyBody;
  if (typeof body.consent !== "boolean") {
    throw new ApiHttpError(400, "missing_consent", "consent (boolean) required");
  }

  // El tipo de TypeScript es solo de compilación: un cliente puede postear
  // cualquier cosa. Se valida contra el banco de preguntas y se guarda lo
  // validado, nunca lo que llegó.
  const v = validateAnswers(body.answers ?? {});
  if (!v.ok) {
    throw new ApiHttpError(
      400,
      v.unknown.length ? "unknown_question" : v.invalid.length ? "invalid_option" : "not_asked",
      `unknown=${v.unknown.join(",")} invalid=${v.invalid.join(",")} notAsked=${v.notAsked.join(",")}`,
    );
  }

  const sb = supabaseAdmin();

  // ── 1. La respuesta, primero y confirmada ──────────────────────────────────
  // `klaviyo_synced_at: null` en CADA escritura, no solo en la primera. Sin eso,
  // corregir una respuesta ya sincronizada la dejaría congelada en Klaviyo con
  // el valor viejo, que es el bug LIT-397 del CS Platform. Aquí nace cerrado.
  const { error: saveErr } = await sb.from("profile_survey_answers").upsert(
    {
      customer_id: ctx.customerId,
      answers: v.clean,
      consent: body.consent,
      consent_at: body.consent ? new Date().toISOString() : null,
      consent_version: body.consent ? SURVEY_CONSENT.version : null,
      // El idioma en el que LEYÓ el consentimiento, y aquí no se adivina. El
      // api-client reenvía `?lang=` en cada llamada desde el segmento [locale]
      // de la URL, así que normalmente viene. Si no viniera se guarda
      // "unknown" en vez de caer a `customer_preferences.language`, que está a
      // 'en' por DEFECTO del esquema y no es una medición: registraría "en"
      // para alguien que lo leyó en español. Un registro de consentimiento no
      // puede contener una conjetura.
      locale_shown: langFromRequest(req) ?? "unknown",
      klaviyo_synced_at: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "customer_id" },
  );

  if (saveErr) {
    // 42P01 = la tabla no existe: la migración no llegó a producción. Se dice
    // con ese nombre en vez de un 500 genérico, porque es el fallo que más
    // probablemente veremos el día del despliegue y hay que reconocerlo rápido.
    if ((saveErr as { code?: string }).code === "42P01") {
      throw new ApiHttpError(503, "survey_storage_unavailable", "profile_survey_answers missing");
    }
    throw new Error(`profile_survey_answers upsert: ${saveErr.message}`);
  }

  // ── 2. Los drops, en su propio try/catch ───────────────────────────────────
  // Si el CHECK de `drops_events.action` no acepta todavía 'profile_survey', el
  // INSERT revienta. Preferimos perder el premio (reconciliable a posteriori)
  // antes que la respuesta, que el cliente no va a volver a escribir.
  const amount = DROPS_AMOUNTS.profile_survey ?? 50;
  let dropsAwarded = 0;
  try {
    const before = await readBalance(ctx.customerId);
    await awardDrops(
      ctx.customerId,
      "profile_survey",
      amount,
      { source: "portal", answered: Object.keys(v.clean).length },
      `${DEDUP_PREFIX}${ctx.customerId}`,
    );
    const after = await readBalance(ctx.customerId);
    // Se mide el saldo, no se asume: `awardDrops` con dedupKey hace
    // ON CONFLICT DO NOTHING, así que un reenvío no paga y tiene que decir +0.
    dropsAwarded = Math.max(0, after.balance - before.balance);
  } catch (err) {
    console.error("[survey/profile] drops award failed:", err);
  }

  const { balance } = await readBalance(ctx.customerId);
  // Solo se celebra si ha cruzado CON este envío. Se compara el saldo contra el
  // que tenía antes de pagar, no `tier_earned_at`: quien ya era INNER CIRCLE
  // también tiene esa fecha puesta, y decirle "acabas de entrar" a alguien que
  // lleva dentro tres meses es peor que no decirle nada.
  const tierCrossed =
    dropsAwarded > 0 && balance >= TIER_THRESHOLD && balance - dropsAwarded < TIER_THRESHOLD;

  // ── 3. La propuesta de cadencia ────────────────────────────────────────────
  const cadenceOffer = await buildCadenceOffer(ctx.customerId, v.clean);

  return { dropsAwarded, balance, tierCrossed, cadenceOffer };
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function readBalance(
  customerId: string,
): Promise<{ balance: number; tierEarnedAt: string | null }> {
  const { data } = await supabaseAdmin()
    .from("drops_balances")
    .select("balance, tier_earned_at")
    .eq("customer_id", customerId)
    .maybeSingle();
  return {
    balance: (data?.balance as number | undefined) ?? 0,
    tierEarnedAt: (data?.tier_earned_at as string | null | undefined) ?? null,
  };
}

/**
 * Lee la suscripción VIVA y decide si se propone espaciar.
 *
 * Best-effort de punta a punta: si Seal no contesta, no hay oferta y el cliente
 * ve su pantalla de gracias igual. Una propuesta es un extra; perder el acuse de
 * los 50 drops por un timeout de Seal no lo es.
 */
async function buildCadenceOffer(
  customerId: string,
  answers: Record<string, string>,
): Promise<CadenceOffer | null> {
  try {
    const email = await shopifyAdmin.getCustomerEmail(customerId);
    if (!email) return null;

    const live = await resolveActiveSubFast(customerId, email, null);
    if (!live) return null;
    const sub = mapToSubscription(live, customerId);

    // Exclusiones que NO son de la regla, sino del estado de la suscripción.
    // Cada una con su motivo, porque todas se descubrieron leyendo el código:
    //  - no activa: un post_cancel no tiene cadencia futura que cambiar.
    //  - dentro de la ventana de corte: el cambio fallaría con `cutoff_passed`, y
    //    enseñar un botón con fallo garantizado es peor que no enseñar nada.
    //  - sin próxima entrega: Seal está regenerando el calendario; no se apila
    //    una mutación encima.
    //  - las cajas leídas no cuadran con la composición: son las dos subs de más
    //    de 6 cajas, que `getBoxCount` clampa. Ahí la aritmética miente por la
    //    mitad y un cambio les partiría el envío.
    if (sub.status !== "active") return null;
    if (sub.withinCutoff) return null;
    if (!sub.nextShipDate) return null;

    const realBoxes = mixBoxCount(sub.composition ?? []);
    if (realBoxes === 0) return null;
    if (realBoxes !== sub.boxCount) return null;

    const fit = suggestLongerCadence({
      currentFrequency: sub.frequency,
      realBoxes,
      boxDuration: answers["caja_dura"],
      stockLeft: answers["stock_dura"],
    });
    if (!fit.target) return null;

    return { from: sub.frequency, to: fit.target, cappedAtSixMonths: fit.cappedAtSixMonths };
  } catch (err) {
    console.warn("[survey/profile] cadence offer skipped:", err);
    return null;
  }
}

/**
 * «Adelantar» que la tarjeta rechaza DESPUÉS de que Seal acepte el cobro
 * (2026-10-14).
 *
 * Medido en 90 días: 45 cobros adelantados fallidos en 39 subs, y subiendo (7 en
 * julio, 10 en agosto, 18 en septiembre, 10 en la primera quincena de octubre).
 * Lo que pasa en cada uno:
 *
 *   1. El portal llama a /subscription-create-charge-now con reset_schedule. Seal
 *      acepta, contesta success y en ese momento YA ha reanclado el calendario a
 *      hoy + un ciclo.
 *   2. Segundos después la pasarela rechaza el cobro. Seal manda su email de
 *      cobro fallido, pero NO deshace el reanclaje, NO reintenta (un cobro manual
 *      no entra en su ciclo de 4 intentos) y NO manda el webhook
 *      billing_attempt/failed (3 de 3 comprobados en webhook_log).
 *   3. El cliente se queda sin la caja que pidió y su siguiente cobro salta un
 *      ciclo entero (6 meses en dos de los casos mirados). El arreglo que ya había
 *      en charge-now (pullCadenceBackTo) solo cubre el rechazo SÍNCRONO, el raro.
 *
 * Lo que sí llega es un subscription/updated 1-3 minutos después, con el intento
 * fallido dentro (`status: "error"`, `triggered_manually` con la hora). Eso es lo
 * que escucha el webhook de Seal, y el cron diario `subscription-notices` hace de
 * red por si ese webhook no llega.
 *
 * Qué se hace con el cobro (Juan 2026-10-14: «si falla, se debería reintentar
 * solo, para no generar fricción al cliente»):
 *
 *   - Rechazo normal (saldo, límite, banco…): se reintenta MAÑANA. El calendario
 *     se trae a mañana y desde ahí es un cobro programado más: si vuelve a fallar,
 *     entra en el ciclo normal de Seal (4 intentos) y en nuestro aviso de cobro
 *     fallido (`payment_failed`).
 *   - Antifraude de la pasarela (FRAUD__SUSPECTED, la mitad de los casos): NO se
 *     reintenta, porque cada reintento fuera de sesión sube el riesgo y empeora el
 *     bloqueo (sub 13071159, mayo). El calendario vuelve a la fecha que el cliente
 *     tenía antes de adelantar: no recibe antes, pero no pierde la caja.
 *
 * En los dos casos sale `charge_now_failed` a Klaviyo con lo que ha pasado, para
 * que el email lo cuente bien. Solo se tocan cobros que lanzó ESTE portal (fila en
 * `charge_now_attempts`): los «cobrar ya» de soporte desde el admin de Seal se
 * quedan como están.
 */

import { alertSlackErrorAwaited } from "@/lib/alert";
import { klaviyo } from "@/lib/klaviyo";
import { mapStatus, seal, type SealSubscription } from "@/lib/seal";
import { formatShipDateEs } from "@/lib/ship-date-label";
import { customerLocale, subscriptionSnapshotProps } from "@/lib/sub-event-props";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Un intento de cobro tal como lo manda Seal de verdad. El tipo SealBillingAttempt
 * del repo dice "succeeded"/"failed", pero llegan "completed"/"error", y trae
 * `attempted_at`, que el tipo no tiene.
 */
export interface RawBillingAttempt {
  id: number | string;
  date?: string;
  status?: string;
  attempted_at?: string | null;
  completed_at?: string;
  skipped_on?: string;
  triggered_manually?: string;
  error_code?: string;
  error_message?: string;
}

/** Con estos NO se reintenta: es el antifraude de la pasarela. Seal usa las dos grafías. */
export const NO_RETRY_ERROR_CODES = new Set(["FRAUD__SUSPECTED", "FRAUD_SUSPECTED"]);

/** Ventana para casar un intento fallido con la fila que escribió charge-now. */
const MATCH_BEFORE_MS = 10 * 60 * 1000;
const MATCH_AFTER_MS = 3 * 60 * 1000;

const H = 60 * 60 * 1000;

function attemptsOf(s: SealSubscription | null | undefined): RawBillingAttempt[] {
  return ((s?.billing_attempts ?? []) as unknown as RawBillingAttempt[]).filter(Boolean);
}

const attemptTime = (a: RawBillingAttempt): number => Date.parse(a.attempted_at || a.date || "");

/** Cobros MANUALES (Adelantar, «cobrar ya» del admin) que han fallado en las últimas `maxAgeHours`. */
export function failedManualAttempts(
  attempts: RawBillingAttempt[],
  now: number,
  maxAgeHours = 24,
): RawBillingAttempt[] {
  return attempts.filter((a) => {
    if (a.status !== "error") return false;
    // Vacío = cobro programado: eso es cosa del ciclo de Seal y de payment_failed.
    if (!(a.triggered_manually ?? "").trim()) return false;
    const t = attemptTime(a);
    return Number.isFinite(t) && t <= now + 60_000 && now - t <= maxAgeHours * H;
  });
}

/** Filtro barato para el webhook: ¿merece la pena mirar esta sub? */
export function hasRecentManualFailure(s: SealSubscription | null | undefined, now = Date.now()): boolean {
  return failedManualAttempts(attemptsOf(s), now).length > 0;
}

/**
 * ¿Hubo un cobro bueno DESPUÉS de este fallo? Entonces el cliente ya ha pagado
 * (otro Adelantar, soporte…) y traer el calendario a mañana le cobraría dos veces.
 */
export function hasLaterSuccess(attempts: RawBillingAttempt[], failed: RawBillingAttempt): boolean {
  const t = attemptTime(failed);
  return attempts.some((a) => a.status === "completed" && attemptTime(a) > t);
}

/** `YYYY-MM-DD` + n días, en UTC. */
export function addDaysUtc(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface RecoveryPlan {
  /** retry: se cobra mañana. restore: vuelve la fecha de antes de adelantar. */
  action: "retry" | "restore";
  targetDate: string;
}

export function decideRecovery(input: {
  errorCode: string | null | undefined;
  preChargeDate: string | null | undefined;
  todayYmd: string;
}): RecoveryPlan {
  const tomorrow = addDaysUtc(input.todayYmd, 1);
  if (NO_RETRY_ERROR_CODES.has((input.errorCode ?? "").trim().toUpperCase())) {
    const pre = input.preChargeDate ? input.preChargeDate.slice(0, 10) : null;
    // Nunca hoy ni antes: la fecha de antes, si aún está por llegar; si no, mañana.
    return { action: "restore", targetDate: pre && pre > tomorrow ? pre : tomorrow };
  }
  return { action: "retry", targetDate: tomorrow };
}

export interface ChargeNowIntentRow {
  id: number;
  seal_subscription_id: string;
  customer_id: string;
  pre_charge_date: string | null;
  requested_at: string;
  status: string;
}

/** La fila de charge-now de este intento: la más reciente dentro de la ventana. */
export function matchIntent(
  rows: ChargeNowIntentRow[],
  failed: RawBillingAttempt,
): ChargeNowIntentRow | null {
  // `date` del intento manual = la hora en que se pidió el cobro (unos ms después
  // de escribir la fila); `attempted_at`, cuando la pasarela lo procesó.
  const t = Date.parse(failed.date || failed.attempted_at || "");
  if (!Number.isFinite(t)) return null;
  const inWindow = rows
    .filter((r) => {
      const at = Date.parse(r.requested_at);
      return at >= t - MATCH_BEFORE_MS && at <= t + MATCH_AFTER_MS;
    })
    .sort((a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at));
  return inWindow[0] ?? null;
}

// ─── Escrituras ─────────────────────────────────────────────────────────────

/** charge-now la escribe ANTES de llamar a Seal. Nunca lanza: sin fila, el Adelantar sigue. */
export async function recordChargeNowIntent(input: {
  sealSubscriptionId: string;
  customerId: string;
  preChargeDate: string | null;
}): Promise<number | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("charge_now_attempts")
      .insert({
        seal_subscription_id: input.sealSubscriptionId,
        customer_id: input.customerId,
        pre_charge_date: input.preChargeDate,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return Number(data.id);
  } catch (err) {
    console.error("[charge-now-recovery] no se pudo guardar el intento (sigue sin red)", {
      sealSubscriptionId: input.sealSubscriptionId,
      msg: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Pasa la fila a `status` SOLO si sigue en `requested`. Devuelve true si la ha
 * cambiado este proceso: es el cerrojo que impide que dos entregas del webhook (o
 * el webhook y el cron, o el webhook y el catch de charge-now) actúen a la vez.
 */
export async function claimChargeNowIntent(
  id: number,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("charge_now_attempts")
    .update({ status, handled_at: new Date().toISOString(), ...extra })
    .eq("id", id)
    .eq("status", "requested")
    .select("id");
  if (error) {
    // 23505: ese intento fallido ya lo reclamó otra fila.
    if ((error as { code?: string }).code === "23505") return false;
    throw new Error(`charge_now_attempts: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

async function finishIntent(id: number, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("charge_now_attempts")
    .update({ status, handled_at: new Date().toISOString(), ...extra })
    .eq("id", id);
  if (error) console.error("[charge-now-recovery] no se pudo cerrar la fila", { id, status, msg: error.message });
}

// ─── El rescate ─────────────────────────────────────────────────────────────

export type RecoveryOutcome =
  | { kind: "not_ours" | "already_handled" | "superseded" | "not_active" }
  | { kind: "retry_scheduled" | "date_restored"; targetDate: string; moved: number }
  | { kind: "would_retry" | "would_restore"; targetDate: string }
  | { kind: "unhandled"; reason: string };

export async function handleManualChargeFailure(
  subFromEvent: SealSubscription,
  opts: { maxAgeHours?: number; now?: number; dryRun?: boolean } = {},
): Promise<RecoveryOutcome[]> {
  const now = opts.now ?? Date.now();
  const failed = failedManualAttempts(attemptsOf(subFromEvent), now, opts.maxAgeHours ?? 24);
  if (failed.length === 0) return [];

  const sealId = String(subFromEvent.id);
  const { data, error } = await supabaseAdmin()
    .from("charge_now_attempts")
    .select("id, seal_subscription_id, customer_id, pre_charge_date, requested_at, status")
    .eq("seal_subscription_id", sealId)
    .gte("requested_at", new Date(now - 96 * H).toISOString())
    .order("requested_at", { ascending: false });
  if (error) throw new Error(`charge_now_attempts: ${error.message}`);
  const rows = (data ?? []) as ChargeNowIntentRow[];

  const out: RecoveryOutcome[] = [];
  for (const f of failed) {
    const intent = matchIntent(rows, f);
    if (!intent) {
      out.push({ kind: "not_ours" });
      continue;
    }
    if (intent.status !== "requested") {
      out.push({ kind: "already_handled" });
      continue;
    }
    const errorCode = (f.error_code ?? "").trim() || null;
    // Otro Adelantar después de este, o un cobro bueno después del fallo: el
    // cliente ya ha pagado o está pagando. Mover el calendario le cobraría dos veces.
    const newer = rows.some(
      (r) => r.id !== intent.id && Date.parse(r.requested_at) > Date.parse(intent.requested_at),
    );
    if (newer || hasLaterSuccess(attemptsOf(subFromEvent), f)) {
      if (!opts.dryRun) {
        await claimChargeNowIntent(intent.id, "superseded", { failed_attempt_id: String(f.id), error_code: errorCode });
      }
      out.push({ kind: "superseded" });
      continue;
    }
    if (opts.dryRun) {
      const plan = decideRecovery({
        errorCode,
        preChargeDate: intent.pre_charge_date,
        todayYmd: new Date(now).toISOString().slice(0, 10),
      });
      out.push({ kind: plan.action === "retry" ? "would_retry" : "would_restore", targetDate: plan.targetDate });
      continue;
    }
    const mine = await claimChargeNowIntent(intent.id, "handling", {
      failed_attempt_id: String(f.id),
      error_code: errorCode,
    });
    if (!mine) {
      out.push({ kind: "already_handled" });
      continue;
    }
    out.push(await recover(intent, f, errorCode, now));
  }
  return out;
}

async function recover(
  intent: ChargeNowIntentRow,
  f: RawBillingAttempt,
  errorCode: string | null,
  now: number,
): Promise<RecoveryOutcome> {
  const subId = Number(intent.seal_subscription_id);
  // Lectura fresca: el payload del webhook puede ir por detrás, y hay que saber si
  // la sub sigue activa (14582750 se dio de baja 7 minutos después del fallo).
  const fresh = await seal.getSubscriptionById(subId, undefined, { throwTransient: true });
  if (!fresh || mapStatus(fresh) !== "active") {
    await finishIntent(intent.id, "not_active", { note: fresh ? `estado ${fresh.status}` : "Seal no la devuelve" });
    return { kind: "not_active" };
  }
  if (hasLaterSuccess(attemptsOf(fresh), f)) {
    await finishIntent(intent.id, "superseded", { note: "cobro bueno posterior" });
    return { kind: "superseded" };
  }

  const plan = decideRecovery({
    errorCode,
    preChargeDate: intent.pre_charge_date,
    todayYmd: new Date(now).toISOString().slice(0, 10),
  });

  let moved = 0;
  try {
    // Solo mueve HACIA ATRÁS y nunca a una fecha pasada; desplaza todo el
    // calendario con el mismo desfase, así que la cadencia sigue desde la fecha
    // nueva (mismo mecanismo que reanchorCadence, verificado el 15-jun).
    moved = await seal.pullCadenceBackTo(subId, plan.targetDate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishIntent(intent.id, "unhandled", { note: `pullCadenceBackTo: ${msg}`.slice(0, 500) });
    await alertSlackErrorAwaited({
      path: "lib/charge-now-recovery",
      code: "charge_now_recovery_failed",
      msg:
        `sub ${subId}: el Adelantar falló (${errorCode ?? "sin código"}) y no se ha podido mover ` +
        `el calendario a ${plan.targetDate}. Revisar a mano: puede haberse quedado sin envío. (${msg})`,
      customerId: intent.customer_id,
    });
    return { kind: "unhandled", reason: "reschedule_failed" };
  }
  if (moved === 0) {
    await finishIntent(intent.id, "unhandled", { note: `nada que mover hacia ${plan.targetDate}` });
    await alertSlackErrorAwaited({
      path: "lib/charge-now-recovery",
      code: "charge_now_recovery_noop",
      msg:
        `sub ${subId}: el Adelantar falló (${errorCode ?? "sin código"}) y el calendario no se ha ` +
        `podido traer a ${plan.targetDate} (el primer cobro pendiente no está más tarde). Revisar a mano.`,
      customerId: intent.customer_id,
    });
    return { kind: "unhandled", reason: "nothing_moved" };
  }

  const status = plan.action === "retry" ? "retry_scheduled" : "date_restored";
  await finishIntent(intent.id, status, { retry_date: plan.targetDate });
  await notifyCustomer(fresh, f, errorCode, plan, intent.customer_id);
  console.log("[charge-now-recovery]", { subId, status, targetDate: plan.targetDate, moved, errorCode });
  return { kind: status, targetDate: plan.targetDate, moved };
}

async function notifyCustomer(
  fresh: SealSubscription,
  f: RawBillingAttempt,
  errorCode: string | null,
  plan: RecoveryPlan,
  customerId: string,
): Promise<void> {
  const email = (fresh.email ?? "").trim();
  if (!email) return;
  try {
    // Relectura para que el email lleve el calendario ya movido.
    const after = (await seal.getSubscriptionById(Number(fresh.id)).catch(() => null)) ?? fresh;
    let paymentType: string | null = null;
    try {
      const { shopifyAdmin } = await import("@/lib/shopify-admin");
      paymentType = (await shopifyAdmin.getCustomerPaymentMethod(customerId))?.type ?? null;
    } catch {
      // Solo cambia el texto del email (tarjeta frente a Shop Pay / PayPal).
    }
    await klaviyo.trackEvent(
      "charge_now_failed",
      email,
      {
        ...subscriptionSnapshotProps(after),
        // retry_tomorrow: lo volvemos a intentar mañana. date_kept: no se
        // reintenta (antifraude) y el pedido sigue en la fecha que tenía.
        outcome: plan.action === "retry" ? "retry_tomorrow" : "date_kept",
        willRetry: plan.action === "retry",
        retryDate: plan.targetDate,
        retryDateLabel: formatShipDateEs(plan.targetDate),
        errorCode,
        gatewayMessage: f.error_message || null,
        attemptDate: f.attempted_at || f.date || null,
        paymentType,
        cardExpiryMonth: fresh.card_expiry_month || null,
        cardExpiryYear: fresh.card_expiry_year || null,
        locale: await customerLocale(customerId),
      },
      { uniqueId: `charge-now-failed-${f.id}`, externalId: customerId },
    );
  } catch (err) {
    // El calendario ya está bien, que es lo que importa. Sin aviso, el cliente
    // aún tiene el email de cobro fallido de Seal mientras siga encendido.
    console.warn("[charge-now-recovery] aviso a Klaviyo fallido", {
      sealId: fresh.id,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Para el webhook: nunca lanza. */
export async function handleManualChargeFailureSafe(sub: SealSubscription): Promise<void> {
  try {
    await handleManualChargeFailure(sub);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[charge-now-recovery] fallo inesperado", { sealId: sub?.id, msg });
    await alertSlackErrorAwaited({
      path: "lib/charge-now-recovery",
      code: "charge_now_recovery_crashed",
      msg: `sub ${sub?.id ?? "?"}: falló el rescate de un Adelantar rechazado (${msg}). El cron diario lo reintenta.`,
    }).catch(() => {});
  }
}

// ─── La red: el cron diario ─────────────────────────────────────────────────

export interface ChargeNowSweepTally {
  open: number;
  succeeded: number;
  expired: number;
  handled: number;
  outcomes: string[];
}

/**
 * Repasa los Adelantar aún «requested» de las últimas 72 h: cierra los que
 * cobraron bien, rescata los que fallaron y el webhook no vio, y caduca el resto.
 */
export async function sweepChargeNowAttempts(
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<ChargeNowSweepTally> {
  const now = opts.now ?? Date.now();
  const { data, error } = await supabaseAdmin()
    .from("charge_now_attempts")
    .select("id, seal_subscription_id, customer_id, pre_charge_date, requested_at, status")
    .eq("status", "requested")
    .lte("requested_at", new Date(now - 15 * 60 * 1000).toISOString())
    .order("requested_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`charge_now_attempts: ${error.message}`);
  const rows = (data ?? []) as ChargeNowIntentRow[];
  const tally: ChargeNowSweepTally = { open: rows.length, succeeded: 0, expired: 0, handled: 0, outcomes: [] };

  for (const row of rows) {
    const age = now - Date.parse(row.requested_at);
    if (age > 72 * H) {
      if (!opts.dryRun) await finishIntent(row.id, "expired", { note: "sin resolver en 72 h" });
      tally.expired++;
      continue;
    }
    const s = await seal.getSubscriptionById(Number(row.seal_subscription_id)).catch(() => null);
    if (!s) continue;
    const mineAttempt = attemptsOf(s)
      .filter((a) => (a.triggered_manually ?? "").trim() && a.triggered_manually !== "attempt_now")
      .find((a) => matchIntent([row], a)?.id === row.id);
    if (!mineAttempt) {
      // Seal no llegó a crear el cobro (rechazo síncrono que no se marcó, o
      // «ya hay un cobro en curso»). Pasadas 2 h no hay nada que esperar.
      if (age > 2 * H) {
        if (!opts.dryRun) await finishIntent(row.id, "expired", { note: "Seal no tiene ese cobro manual" });
        tally.expired++;
      }
      continue;
    }
    if (mineAttempt.status === "completed") {
      if (!opts.dryRun) await finishIntent(row.id, "succeeded");
      tally.succeeded++;
      continue;
    }
    if (mineAttempt.status === "error") {
      const outcomes = await handleManualChargeFailure(s, { maxAgeHours: 72, now, dryRun: opts.dryRun });
      tally.handled++;
      tally.outcomes.push(...outcomes.map((o) => `${row.seal_subscription_id}:${o.kind}`));
    }
  }
  return tally;
}

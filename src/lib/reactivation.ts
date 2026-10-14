/**
 * Reactivar y reanudar desde el portal (2026-10-14).
 *
 * ── Quién puede reactivar ──
 * Hasta hoy solo las bajas hechas desde el propio portal: primera baja y dentro
 * de 90 días, con la regla en customer_preferences. Las bajas por impago (Seal
 * cancela tras 4 cobros fallidos, ~20 al mes) y las hechas por atención desde el
 * admin de Seal (~30 al mes) no podían volver desde aquí y el Hub les mandaba a
 * la tienda. Juan 14-oct: que también puedan reactivar. Quién canceló sale del
 * log de Seal (classifyCancel, lib/cancel-notice.ts).
 *
 * ── Lo que pasa DESPUÉS de reactivar o reanudar ──
 * Seal regenera el calendario por su cuenta 27-170 s después (medido en 6
 * reactivaciones del portal), anclado en el último intento de cobro. Dos cosas
 * dependen de ese calendario nuevo, y por eso no se hacen en la petición sino
 * cuando el webhook subscription/updated trae el calendario ya regenerado (el
 * cron diario subscription-notices es la red):
 *
 *  1. Solo impago: el siguiente cobro pasa a MAÑANA. El último intento es el
 *     fallido, así que la caja que no se pudo cobrar llegaría un ciclo más tarde
 *     (6 meses en un semestral). Mañana y no hoy: da un día para cambiar la
 *     tarjeta, y si vuelve a fallar entra en el ciclo normal de Seal y en nuestro
 *     aviso de cobro fallido.
 *  2. El aviso a Klaviyo (`subscription_reactivated` / `subscription_resumed`)
 *     con la fecha de la próxima caja ya buena.
 *
 * Todo se apunta en `reactivation_followups`, una fila por sub.
 */

import { alertSlackErrorAwaited } from "@/lib/alert";
import { classifyCancel } from "@/lib/cancel-notice";
import { addDaysUtc, type RawBillingAttempt } from "@/lib/charge-now-recovery";
import { klaviyo } from "@/lib/klaviyo";
import { getNextBillingAttempt, mapStatus, seal, type SealSubscription } from "@/lib/seal";
import { customerLocale, subscriptionSnapshotProps } from "@/lib/sub-event-props";
import { supabaseAdmin } from "@/lib/supabase";

export const REACTIVATION_HOLD_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const H = 60 * 60 * 1000;

/** De qué viene la sub que vuelve. `resume` = estaba en pausa. */
export type FollowupKind = "portal" | "unpaid" | "support" | "resume";

// ─── Quién puede reactivar ──────────────────────────────────────────────────

/** La regla de siempre: baja hecha desde el portal, la primera, hace 90 días o menos. */
export function portalCancelEligible(
  prefs: { cancel_count?: number | null; last_cancelled_at?: string | null } | null | undefined,
  now = Date.now(),
): boolean {
  return (
    (prefs?.cancel_count ?? 0) === 1 &&
    !!prefs?.last_cancelled_at &&
    now - new Date(prefs.last_cancelled_at).getTime() <= REACTIVATION_HOLD_DAYS * DAY
  );
}

/**
 * La sub candidata a reactivar fuera del portal: la cancelada más reciente, si
 * el cliente no tiene ninguna activa ni pausada y la baja es de hace 90 días o
 * menos. Pura: quién la canceló se mira después, con el log.
 */
export function pickExternalCandidate(subs: SealSubscription[], now = Date.now()): SealSubscription | null {
  if (subs.some((s) => s.status === "ACTIVE" || s.status === "PAUSED" || !!s.cancellation_scheduled_for)) return null;
  const latest = subs
    .filter((s) => s.status === "CANCELLED" && !!s.cancelled_on)
    .sort((a, b) => b.cancelled_on.localeCompare(a.cancelled_on))[0];
  if (!latest) return null;
  const t = Date.parse(latest.cancelled_on);
  if (!Number.isFinite(t) || now - t > REACTIVATION_HOLD_DAYS * DAY) return null;
  return latest;
}

export interface ExternalCancel {
  sub: SealSubscription;
  actor: "unpaid" | "support";
}

/** Baja por impago o por atención que se puede reactivar desde el portal, o null. */
export async function findExternalCancel(subs: SealSubscription[], now = Date.now()): Promise<ExternalCancel | null> {
  const candidate = pickExternalCandidate(subs, now);
  if (!candidate) return null;
  // El listado de Seal no trae el log: una lectura por id.
  // throwTransient: un 429/5xx de Seal NO puede leerse como «no es externa»;
  // la ruta caería en la regla del portal (Drops devueltos, sin cobro a mañana).
  const full = await seal.getSubscriptionById(Number(candidate.id), undefined, { throwTransient: true });
  if (!full || full.status !== "CANCELLED") return null;
  const { actor } = classifyCancel((full as SealSubscription & { log?: Array<{ content?: string; created?: string }> }).log);
  if (actor !== "unpaid" && actor !== "support") return null;
  return { sub: full, actor };
}

// ─── Lo que pasa después ────────────────────────────────────────────────────

export interface FollowupRow {
  seal_subscription_id: string;
  customer_id: string;
  kind: FollowupKind;
  pull_to: string | null;
  extra: Record<string, unknown> | null;
  status: string;
  created_at: string;
}

export type FollowupDecision =
  | { kind: "wait" }
  | { kind: "pull"; targetDate: string }
  | { kind: "notify"; why: "no_pull" | "already_soon" | "charged_after" };

/**
 * Qué hacer con un apunte, dada la sub tal como está ahora. Pura.
 *
 *  - wait: Seal aún no la ha reactivado, aún no ha regenerado el calendario, o
 *    tiene un cobro vencido o en marcha (la 15304997 cobró a los 87 s de
 *    reactivar): se espera a ver cómo acaba.
 *  - pull: impago con el primer cobro más tarde de mañana; traerlo a mañana.
 *  - notify: solo avisar. Sin cobro que traer, el primero ya es mañana o antes,
 *    o ya hubo un cobro tras reactivar (Seal al momento, o un Adelantar del
 *    cliente): traer otro a mañana le cobraría dos veces.
 */
export function decideFollowup(
  sub: SealSubscription,
  row: Pick<FollowupRow, "pull_to" | "created_at">,
  opts: { now?: number; chargeNowAfter?: boolean } = {},
): FollowupDecision {
  const now = opts.now ?? Date.now();
  if (mapStatus(sub) !== "active") return { kind: "wait" };
  const attempts = (sub.billing_attempts ?? []) as unknown as RawBillingAttempt[];
  const dueOrInFlight = attempts.some((a) => {
    if (a.status || a.completed_at || a.skipped_on) return false;
    const t = Date.parse(a.date || "");
    return Number.isFinite(t) && t <= now + 5 * 60 * 1000;
  });
  if (dueOrInFlight) return { kind: "wait" };
  const first = getNextBillingAttempt(sub)?.date?.slice(0, 10) ?? null;
  if (!first) return { kind: "wait" };
  if (!row.pull_to) return { kind: "notify", why: "no_pull" };

  // Cualquier intento de cobro desde poco ANTES de apuntar, haya pasado o NO:
  // un cobro bueno (Seal al momento, o un Adelantar) ya es la caja; uno fallido
  // ya está en el ciclo de reintentos de Seal, y traer otro a mañana coincidiría
  // con su reintento (si el cliente cambia la tarjeta, cobrarían los dos;
  // revisión adversarial). Se mira cualquiera de sus marcas de tiempo: Seal fecha
  // el cobro inmediato en el instante de reactivar, antes de que exista la fila, y
  // un reintento conserva la fecha del intento original.
  const since = Date.parse(row.created_at) - 10 * 60 * 1000;
  const chargedAfter = attempts.some((a) => {
    if (a.status !== "completed" && a.status !== "error" && !(a.triggered_manually ?? "").trim()) return false;
    return [a.date, a.attempted_at, a.completed_at].some((x) => {
      const t = Date.parse(x || "");
      return Number.isFinite(t) && t > since;
    });
  });
  if (chargedAfter || opts.chargeNowAfter) return { kind: "notify", why: "charged_after" };

  const tomorrow = addDaysUtc(new Date(now).toISOString().slice(0, 10), 1);
  const target = row.pull_to > tomorrow ? row.pull_to : tomorrow;
  if (first <= target) return { kind: "notify", why: "already_soon" };
  return { kind: "pull", targetDate: target };
}

/**
 * Lo escriben /reactivate y /resume. Nunca lanza: devuelve false si no se pudo,
 * y la ruta avisa al momento con lo que tenga.
 */
export async function recordFollowup(input: {
  sealSubscriptionId: string;
  customerId: string;
  kind: FollowupKind;
  pullTo?: string | null;
  extra?: Record<string, unknown>;
  /** Lo fija la ruta: también es la clave del aviso, para que el de respaldo y el
   *  del seguimiento no salgan los dos. */
  createdAt?: string;
}): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin()
      .from("reactivation_followups")
      .upsert(
        {
          seal_subscription_id: input.sealSubscriptionId,
          customer_id: input.customerId,
          kind: input.kind,
          pull_to: input.pullTo ?? null,
          extra: input.extra ?? {},
          status: "pending",
          created_at: input.createdAt ?? new Date().toISOString(),
          handled_at: null,
          note: null,
        },
        { onConflict: "seal_subscription_id" },
      );
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[reactivation] no se pudo apuntar el seguimiento", { sub: input.sealSubscriptionId, msg });
    if (input.pullTo) {
      await alertSlackErrorAwaited({
        path: "lib/reactivation",
        code: "reactivation_pull_not_recorded",
        msg:
          `sub ${input.sealSubscriptionId}: al reactivar tras un impago no se pudo apuntar el cobro para ` +
          `${input.pullTo}. Si la reactivación entra, Seal lo pondrá un ciclo más tarde: moverlo a mano. (${msg})`,
        customerId: input.customerId,
      }).catch(() => {});
    }
    return false;
  }
}

/** El aviso a Klaviyo con la foto de la sub. Nunca lanza. */
export async function notifyFollowup(
  sub: SealSubscription,
  kind: FollowupKind,
  customerId: string,
  extra: Record<string, unknown> = {},
  uniqueSuffix?: string,
): Promise<void> {
  const email = (sub.email ?? "").trim();
  if (!email) return;
  try {
    const event = kind === "resume" ? "subscription_resumed" : "subscription_reactivated";
    await klaviyo.trackEvent(
      event,
      email,
      {
        ...subscriptionSnapshotProps(sub),
        ...extra,
        ...(kind === "resume" ? {} : { reactivatedFrom: kind }),
        locale: await customerLocale(customerId),
      },
      {
        externalId: customerId,
        ...(uniqueSuffix ? { uniqueId: `${event}-${sub.id}-${new Date(uniqueSuffix).toISOString()}` } : {}),
      },
    );
  } catch (err) {
    console.warn("[reactivation] aviso a Klaviyo fallido", {
      sealId: sub.id,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Seal rechazó la reactivación o la reanudación: el apunte ya no sirve. */
export async function expireFollowup(sealSubscriptionId: string, note: string): Promise<void> {
  await setFollowup(sealSubscriptionId, "expired", { note }, "pending");
}

async function setFollowup(
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
  from?: string,
): Promise<boolean> {
  let q = supabaseAdmin()
    .from("reactivation_followups")
    .update({ status, handled_at: new Date().toISOString(), ...extra })
    .eq("seal_subscription_id", id);
  if (from) q = q.eq("status", from);
  const { data, error } = await q.select("seal_subscription_id");
  if (error) throw new Error(`reactivation_followups: ${error.message}`);
  return (data ?? []).length > 0;
}

async function chargeNowSince(sealId: string, sinceIso: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("charge_now_attempts")
    .select("id")
    .eq("seal_subscription_id", sealId)
    .gt("requested_at", sinceIso)
    .limit(1);
  if (error) throw new Error(`charge_now_attempts: ${error.message}`);
  return (data ?? []).length > 0;
}

export type FollowupOutcome = "none" | "wait" | "busy" | "would_pull" | "would_notify" | "moved" | "notified" | "failed";

/**
 * Aplica el apunte pendiente de esta sub, si lo hay. Seguro de llamar en cada
 * subscription/updated: sin apunte pendiente es una lectura y nada más.
 */
export async function applyFollowup(
  subFromEvent: SealSubscription,
  opts: { now?: number; dryRun?: boolean } = {},
): Promise<FollowupOutcome> {
  const now = opts.now ?? Date.now();
  const sealId = String(subFromEvent.id);
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("reactivation_followups")
    .select("seal_subscription_id, customer_id, kind, pull_to, extra, status, created_at")
    .eq("seal_subscription_id", sealId)
    .eq("status", "pending")
    .maybeSingle();
  if (error) throw new Error(`reactivation_followups: ${error.message}`);
  if (!data) return "none";
  const row = data as FollowupRow;

  const first = decideFollowup(subFromEvent, row, {
    now,
    chargeNowAfter: row.pull_to ? await chargeNowSince(sealId, row.created_at) : false,
  });
  if (first.kind === "wait") {
    if (!opts.dryRun && now - Date.parse(row.created_at) > 72 * H) {
      await setFollowup(sealId, "expired", { note: "72 h sin regenerar o sin estar activa" }, "pending");
    }
    return "wait";
  }
  if (opts.dryRun) return first.kind === "pull" ? "would_pull" : "would_notify";

  // Reclamo atómico: solo una entrega del webhook (o el cron) actúa.
  if (!(await setFollowup(sealId, "handling", {}, "pending"))) return "busy";
  const subId = Number(sealId);
  let lockHeld = false;
  try {
    let sub = subFromEvent;
    let outcome: FollowupOutcome = "notified";
    if (first.kind === "pull") {
      // El mismo cerrojo que charge-now: un Adelantar que entrara ahora mismo no
      // puede cruzarse con el movimiento del calendario.
      await sb
        .from("charge_now_locks")
        .delete()
        .eq("seal_subscription_id", subId)
        .lt("created_at", new Date(Date.now() - 120_000).toISOString());
      const { error: lockErr } = await sb
        .from("charge_now_locks")
        .insert({ seal_subscription_id: subId, customer_id: row.customer_id });
      if (lockErr && (lockErr as { code?: string }).code === "23505") {
        await setFollowup(sealId, "pending", { handled_at: null }, "handling");
        return "busy";
      }
      lockHeld = !lockErr;
      // Relectura justo antes de mover: la decisión se repite con lo último de Seal.
      const fresh = await seal.getSubscriptionById(subId, undefined, { throwTransient: true });
      if (!fresh) throw new Error("Seal no devuelve la sub");
      const again = decideFollowup(fresh, row, { now, chargeNowAfter: await chargeNowSince(sealId, row.created_at) });
      if (again.kind === "wait") {
        await setFollowup(sealId, "pending", { handled_at: null }, "handling");
        return "wait";
      }
      sub = fresh;
      if (again.kind === "pull") {
        const moved = await seal.pullCadenceBackTo(subId, again.targetDate);
        if (moved === 0) {
          outcome = "failed";
          await alertSlackErrorAwaited({
            path: "lib/reactivation",
            code: "reactivation_pull_noop",
            msg: `sub ${sealId}: reactivada tras un impago y no se pudo traer el cobro a ${again.targetDate}. Revisar a mano.`,
            customerId: row.customer_id,
          });
        } else {
          outcome = "moved";
          sub = (await seal.getSubscriptionById(subId).catch(() => null)) ?? fresh;
        }
      }
    }
    await notifyFollowup(sub, row.kind, row.customer_id, row.extra ?? {}, new Date(row.created_at).toISOString());
    await setFollowup(sealId, outcome === "failed" ? "failed" : "done", { note: outcome }, "handling");
    return outcome;
  } catch (err) {
    // Vuelve a la cola: la siguiente entrega del webhook o el cron lo reintentan.
    await setFollowup(sealId, "pending", { handled_at: null }, "handling").catch(() => {});
    throw err;
  } finally {
    if (lockHeld) await sb.from("charge_now_locks").delete().eq("seal_subscription_id", subId);
  }
}

/** Para el webhook: nunca lanza. */
export async function applyFollowupSafe(sub: SealSubscription): Promise<void> {
  try {
    await applyFollowup(sub);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[reactivation] fallo inesperado", { sealId: sub?.id, msg });
    await alertSlackErrorAwaited({
      path: "lib/reactivation",
      code: "reactivation_followup_crashed",
      msg: `sub ${sub?.id ?? "?"}: falló el seguimiento de una reactivación o reanudación (${msg}). El cron diario lo reintenta.`,
    }).catch(() => {});
  }
}

/** La red: el cron diario repasa los apuntes pendientes. */
export async function sweepFollowups(
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<{ pending: number; outcomes: string[] }> {
  const now = opts.now ?? Date.now();
  const sb = supabaseAdmin();
  if (!opts.dryRun) {
    // Seguimientos que murieron a medias (>15 min en handling): vuelven a la cola.
    await sb
      .from("reactivation_followups")
      .update({ status: "pending", handled_at: null })
      .eq("status", "handling")
      .lt("handled_at", new Date(now - 15 * 60 * 1000).toISOString());
  }
  const { data, error } = await sb
    .from("reactivation_followups")
    .select("seal_subscription_id")
    .eq("status", "pending")
    .lte("created_at", new Date(now - 5 * 60 * 1000).toISOString())
    .limit(50);
  if (error) throw new Error(`reactivation_followups: ${error.message}`);
  const outcomes: string[] = [];
  for (const r of (data ?? []) as Array<{ seal_subscription_id: string }>) {
    try {
      const s = await seal.getSubscriptionById(Number(r.seal_subscription_id));
      if (!s) {
        outcomes.push(`${r.seal_subscription_id}:sin_sub`);
        continue;
      }
      outcomes.push(`${r.seal_subscription_id}:${await applyFollowup(s, { now, dryRun: opts.dryRun })}`);
    } catch (err) {
      outcomes.push(`${r.seal_subscription_id}:error`);
      console.error("[reactivation] repaso: fila con error", {
        sub: r.seal_subscription_id,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { pending: (data ?? []).length, outcomes };
}

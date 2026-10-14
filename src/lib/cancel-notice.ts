/**
 * Avisos de las bajas que NO pasan por el portal (2026-10-14).
 *
 * La baja desde el portal ya manda `subscription_cancelled` (flow «Suscripción -
 * Cancelación»). Las otras dos no mandaban nada. Medido en el log de Seal de los
 * últimos 30 días: 21 bajas por impago (Seal cancela tras 4 cobros fallidos) y 31
 * hechas por atención desde el admin de Seal. Juan 2026-10-14: que también
 * reciban su email.
 *
 * ── Por qué un cron diario y no el webhook ──
 * ~6 % de esas bajas se deshacen a los pocos minutos: soporte reactiva a mano (2
 * de 32 por admin, a los 2 y 23 min; 1 de 21 por impago, a los 5 min). Decirle
 * «tu suscripción está cancelada» a quien ya está activo de nuevo es peor que
 * avisar unas horas más tarde, así que se espera al menos una hora y se relee
 * Seal antes de avisar.
 *
 * ── Quién la canceló ──
 * Sale del `log` de Seal, que nombra al actor literalmente:
 *   «Subscription was cancelled because the payment couldn't be processed…» → impago
 *   «Merchant cancelled the subscription.»                                    → atención, desde el admin
 *   «Merchant cancelled the subscription through API.»                        → API: el portal ya avisó
 *   «Customer cancelled…»                                                     → portal de Seal (cerrado el 14-oct)
 *
 * ── Eventos propios, no `subscription_cancelled` ──
 * El email de ese flow lleva «Reactivar mis pedidos» al portal, y el portal solo
 * deja reactivar las bajas hechas desde el propio portal (necesita
 * `customer_preferences.last_cancelled_at`). Con `subscription_cancelled_unpaid`
 * y `subscription_cancelled_support` no sale nada hasta que LIT-CRM monte sus
 * emails, con el botón donde toque.
 *
 * Las bajas por impago además entran en la cola `recuperacion` de la CS Platform,
 * que llama al cliente (ver el case subscription.cancelled del webhook de Seal):
 * el email va además de esa llamada, por decisión de Juan del 14-oct.
 *
 * Guarda de multi-sub: si el cliente tiene OTRA sub activa o pausada no se avisa.
 * Soporte limpiando un duplicado no debe decirle a nadie que se ha quedado sin LIT.
 */

import { klaviyo, type KlaviyoEvent } from "@/lib/klaviyo";
import { seal, type SealSubscription } from "@/lib/seal";
import { formatShipDateEs } from "@/lib/ship-date-label";
import { customerLocale, subscriptionSnapshotProps } from "@/lib/sub-event-props";
import { supabaseAdmin } from "@/lib/supabase";

export const CANCEL_NOTICE_TEMPLATE = "cancel_notice";

export type CancelActor = "unpaid" | "support" | "api" | "customer_seal_portal" | "unknown";

interface SealLogEntry {
  content?: string;
  created?: string;
}

const H = 60 * 60 * 1000;
/** Mínimo de espera desde la baja antes de avisar (ver «Por qué un cron diario»). */
const SETTLE_MS = 1 * H;
const LOOKBACK_MS = 72 * H;
const MAX_PER_RUN = 40;

/** La ÚLTIMA baja del log de la sub y quién la hizo. */
export function classifyCancel(log: SealLogEntry[] | null | undefined): { actor: CancelActor; at: string | null } {
  const cancels = (log ?? [])
    .filter((e) => /(cancelled the subscription|subscription was cancelled)/i.test(e.content ?? ""))
    .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
  const last = cancels[cancels.length - 1];
  if (!last) return { actor: "unknown", at: null };
  const c = (last.content ?? "").trim();
  let actor: CancelActor = "unknown";
  if (/^Subscription was cancelled because the payment/i.test(c)) actor = "unpaid";
  else if (/^Merchant cancelled the subscription through (the )?API/i.test(c)) actor = "api";
  else if (/^Merchant cancelled the subscription\.?$/i.test(c)) actor = "support";
  else if (/^Customer cancelled/i.test(c)) actor = "customer_seal_portal";
  return { actor, at: last.created ?? null };
}

export function cancelNoticeEvent(actor: CancelActor): KlaviyoEvent | null {
  if (actor === "unpaid") return "subscription_cancelled_unpaid";
  if (actor === "support") return "subscription_cancelled_support";
  return null;
}

interface RawAttempt {
  date?: string;
  status?: string;
  attempted_at?: string | null;
  completed_at?: string;
  error_code?: string;
  error_message?: string;
}

function cancelProps(s: SealSubscription, actor: CancelActor): Record<string, unknown> {
  const attempts = (s.billing_attempts ?? []) as unknown as RawAttempt[];
  const byTime = (a: RawAttempt) => a.attempted_at || a.completed_at || a.date || "";
  const lastCharge = attempts
    .filter((a) => a.status === "completed")
    .sort((a, b) => byTime(b).localeCompare(byTime(a)))[0];
  const cancelledOn = s.cancelled_on || null;
  const props: Record<string, unknown> = {
    ...subscriptionSnapshotProps(s),
    cancelledBy: actor === "unpaid" ? "payment_failed" : "support",
    cancelledOn,
    cancelledOnLabel: cancelledOn ? formatShipDateEs(cancelledOn) : null,
    lastChargeDate: lastCharge ? byTime(lastCharge) : null,
    lastChargeDateLabel: lastCharge ? formatShipDateEs(byTime(lastCharge)) : null,
  };
  if (actor === "unpaid") {
    const lastError = attempts
      .filter((a) => a.status === "error")
      .sort((a, b) => byTime(b).localeCompare(byTime(a)))[0];
    Object.assign(props, {
      lastErrorCode: lastError?.error_code || null,
      gatewayMessage: lastError?.error_message || null,
      lastAttemptDate: lastError ? byTime(lastError) : null,
      amount: s.total_value ?? null,
      currency: s.currency ?? "EUR",
      cardExpiryMonth: s.card_expiry_month || null,
      cardExpiryYear: s.card_expiry_year || null,
    });
  }
  return props;
}

export interface CancelNoticeTally {
  candidates: number;
  notified: { unpaid: number; support: number };
  skipped: Record<string, number>;
  failed: number;
  /** Solo en dry run: lo que se mandaría. */
  preview?: Array<{ sealSubscriptionId: string; event: string; cancelledOn: string | null }>;
}

export async function runCancelNotices(opts: { dryRun?: boolean; now?: number } = {}): Promise<CancelNoticeTally> {
  const now = opts.now ?? Date.now();
  const sb = supabaseAdmin();
  const tally: CancelNoticeTally = { candidates: 0, notified: { unpaid: 0, support: 0 }, skipped: {}, failed: 0 };
  const skip = (why: string) => (tally.skipped[why] = (tally.skipped[why] ?? 0) + 1);
  if (opts.dryRun) tally.preview = [];

  // 1. Candidatas: bajas que Seal notificó hace entre 1 y 72 horas.
  const { data: hooks, error } = await sb
    .from("webhook_log")
    .select("received_at, sid:payload->>id")
    .eq("provider", "seal")
    .eq("topic", "subscription/cancelled")
    .gte("received_at", new Date(now - LOOKBACK_MS).toISOString())
    .lte("received_at", new Date(now - SETTLE_MS).toISOString())
    .order("received_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(`webhook_log: ${error.message}`);
  const ids = [...new Set(((hooks ?? []) as Array<{ sid: string | null }>).map((h) => h.sid).filter(Boolean))] as string[];
  tally.candidates = ids.length;
  if (ids.length === 0) return tally;

  // 2. Las ya avisadas. Si esta lectura falla se para todo: un set vacío
  //    volvería a avisar a todas.
  const { data: sent, error: sentErr } = await sb
    .from("email_logs")
    .select("metadata")
    .eq("template_id", CANCEL_NOTICE_TEMPLATE)
    .gte("sent_at", new Date(now - 10 * 24 * H).toISOString());
  if (sentErr) throw new Error(`email_logs: ${sentErr.message}`);
  const done = new Set(
    ((sent ?? []) as Array<{ metadata: { sealSubscriptionId?: string; cancelledOn?: string } | null }>).map(
      (r) => `${r.metadata?.sealSubscriptionId}|${r.metadata?.cancelledOn}`,
    ),
  );

  // 3. Una a una, releyendo Seal.
  for (const id of ids.slice(0, MAX_PER_RUN)) {
    let s: SealSubscription | null = null;
    try {
      s = await seal.getSubscriptionById(Number(id), undefined, { throwTransient: true });
    } catch {
      tally.failed++;
      continue;
    }
    if (!s) {
      skip("sin_sub");
      continue;
    }
    if (s.status !== "CANCELLED") {
      skip("ya_no_cancelada");
      continue;
    }
    const cancelledOn = s.cancelled_on || null;
    if (done.has(`${s.id}|${cancelledOn}`)) {
      skip("ya_avisada");
      continue;
    }
    const { actor } = classifyCancel((s as SealSubscription & { log?: SealLogEntry[] }).log);
    const event = cancelNoticeEvent(actor);
    if (!event) {
      skip(actor === "api" ? "desde_el_portal" : actor);
      continue;
    }
    const email = (s.email ?? "").trim();
    if (!email) {
      skip("sin_email");
      continue;
    }
    try {
      const others = await seal.getSubscriptionsByEmail(email);
      if (others.some((o) => String(o.id) !== String(s!.id) && (o.status === "ACTIVE" || o.status === "PAUSED"))) {
        skip("tiene_otra_activa");
        continue;
      }
    } catch {
      // Sin saber si tiene otra, mejor no avisar hoy: mañana se reintenta.
      tally.failed++;
      continue;
    }

    const customerId = String((s as SealSubscription & { customer_id?: string | number }).customer_id ?? "");
    const validCustomer = /^\d+$/.test(customerId) && customerId !== "0" ? customerId : null;
    if (opts.dryRun) {
      tally.preview!.push({ sealSubscriptionId: String(s.id), event, cancelledOn });
      if (actor === "unpaid") tally.notified.unpaid++;
      else tally.notified.support++;
      continue;
    }
    try {
      await klaviyo.trackEvent(
        event,
        email,
        { ...cancelProps(s, actor), locale: await customerLocale(validCustomer) },
        {
          uniqueId: `cancel-notice-${s.id}-${cancelledOn ?? "?"}`,
          ...(validCustomer ? { externalId: validCustomer } : {}),
        },
      );
    } catch (err) {
      console.warn("[cancel-notice] Klaviyo falló; mañana se reintenta", {
        sealId: s.id,
        msg: err instanceof Error ? err.message : String(err),
      });
      tally.failed++;
      continue;
    }
    const { error: logErr } = await sb.from("email_logs").insert({
      customer_id: validCustomer ?? `seal:${s.id}`,
      template_id: CANCEL_NOTICE_TEMPLATE,
      metadata: { sealSubscriptionId: String(s.id), cancelledOn, actor, event },
    });
    if (logErr) {
      // El uniqueId de Klaviyo evita el doble email aunque esto falle.
      console.error("[cancel-notice] avisado pero sin fila en email_logs", { sealId: s.id, msg: logErr.message });
    }
    if (actor === "unpaid") tally.notified.unpaid++;
    else tally.notified.support++;
  }
  if (ids.length > MAX_PER_RUN) skip("tope_por_tirada");
  return tally;
}

import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { alertSlackError, alertSlackNotice } from "@/lib/alert";
import { isWithinCutoff } from "@/lib/cutoff";
import { fireDunningTrigger } from "@/lib/dunning";
import { klaviyo } from "@/lib/klaviyo";
import { consumeRetentionDiscountIfCharged } from "@/lib/retention-discount";
import {
  getNextBillingAttempt,
  mapStatus,
  mapToSubscription,
  normalizeFrequency,
  seal,
  type SealSubscription,
} from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

// Seal signs each webhook with HMAC-SHA256 over the JSON body using the shop's
// "Seal API secret" (Seal app > Settings > General > API), sent in the
// X-Seal-Hmac-Sha256 header. Confirmed against Seal's official docs 2026-06-12.
// (The previous code read `x-seal-signature` with a guessed format — it never
// verified, which is partly why the portal webhook was never wired up.)
const SEAL_API_SECRET = process.env.SEAL_API_SECRET ?? process.env.SEAL_WEBHOOK_SECRET;

/**
 * POST /apps/portal/api/webhooks/seal
 *
 * Handles Seal webhook topics. The one that matters for the re-anchor flow is
 * `subscription/updated`, which Seal fires WHEN it finishes regenerating
 * billing_attempts after a frequency change — the only reliable moment to skip
 * the regenerated early attempts and preserve the customer's prior next-ship
 * date (see /api/subscription/plan and subscription_reanchor_intents).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Seal sends the topic with a slash (e.g. "subscription/updated").
  const eventType = req.headers.get("x-seal-topic") ?? req.headers.get("x-seal-event") ?? "unknown";
  const signature =
    req.headers.get("x-seal-hmac-sha256") ?? req.headers.get("x-seal-signature");
  const rawBody = await req.text();

  // Fail-closed: refuse if the secret isn't configured.
  if (!SEAL_API_SECRET) {
    console.error("[seal-webhook] SEAL_API_SECRET not set — refusing payload");
    return NextResponse.json({ error: "webhook_misconfigured" }, { status: 500 });
  }
  if (!verifySealSignature(rawBody, signature, SEAL_API_SECRET)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const sb = supabaseAdmin();
  // Dedup by a hash of the body (Seal doesn't send a stable event id header).
  const eventId = crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 32);
  const reservation = {
    provider: "seal",
    event_id: eventId,
    topic: eventType,
  };
  // Store the body (2026-07-28). Seal's subscription object carries a `log`
  // array that names the actor verbatim ("Customer paused the subscription."
  // vs "Merchant … through the API."), which is the only record of WHO did
  // what. Without this, answering "who paused these four subs" took ~40
  // minutes of paging the Seal API by hand; now it's a query. Parsed body, not
  // rawBody, so it lands as queryable jsonb. 90-day retention via purge_after.
  let dedup = await sb.from("webhook_log").insert({ ...reservation, payload: safeJson(rawBody) });

  // 42703 = undefined_column: this deploy landed BEFORE
  // database/migrations/2026-07-28_webhook_payload_audit.sql was applied. Retry
  // without the audit column, because the alternative is catastrophic: the only
  // error code handled below is 23505, so an unhandled insert error falls through
  // and the request proceeds with NO dedup reservation at all. Every Seal
  // redelivery would then reprocess, and applyReanchorIfPending calls
  // seal.reanchorCadence, a NON-idempotent mutation that would over-shift real
  // customers' billing schedules. Auditability is worth losing here; dedup is not.
  if (dedup.error?.code === "42703") {
    console.error(
      "[seal-webhook] webhook_log.payload missing — apply migrations/2026-07-28_webhook_payload_audit.sql. Falling back to reservation without audit payload.",
    );
    alertSlackError({
      path: "/api/webhooks/seal",
      code: "webhook_log_payload_missing",
      msg: "Falta la columna webhook_log.payload: aplica database/migrations/2026-07-28_webhook_payload_audit.sql. Los webhooks siguen funcionando pero sin auditoría.",
    });
    dedup = await sb.from("webhook_log").insert(reservation);
  }
  if (dedup.error?.code === "23505") {
    return NextResponse.json({ ok: true, dedup: true });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // The subscription this event is about. See subFromPayload: Seal sends it FLAT,
  // not wrapped in { subscription: … }, which is what every handler here assumed
  // until 2026-07-29.
  const sub = subFromPayload(payload);
  if (!sub) {
    // Nothing actionable. Loud, because until today this was the silent failure
    // that made the entire webhook a no-op.
    console.error("[seal-webhook] payload carries no resolvable subscription", {
      topic: eventType,
      keys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : typeof payload,
    });
    alertSlackError({
      path: "/api/webhooks/seal",
      code: "payload_shape_unrecognised",
      msg: `El payload de "${eventType}" no trae una suscripción reconocible. Revisa webhook_log.payload: si Seal ha cambiado la forma, TODOS los handlers dejan de hacer nada en silencio.`,
    });
    return NextResponse.json({ ok: true, ignored: "no_subscription" });
  }

  const topic = eventType.replace("/", ".");
  try {
    switch (topic) {
      case "subscription.created":
        await syncSubscription(sub);
        await applyReanchorIfPending(sub);
        break;
      case "subscription.updated":
        await syncSubscription(sub);
        await applyReanchorIfPending(sub);
        // A successful charge advances the schedule and fires subscription/updated,
        // so this is where we retire the cancel-flow 15%. This used to be the ONLY
        // place it could happen, because billing_attempt/succeeded wasn't
        // subscribed in Seal (incident 2026-07-23). It is subscribed now (74
        // delivered between 2026-07-22 and 2026-07-27), so both paths run; the
        // consumer is idempotent and guarded (removes ONLY after the discounted
        // charge has landed), so doing it twice is a no-op. Best-effort here: the
        // daily cron sweep is the guaranteed backstop, so a transient failure must
        // never fail the whole webhook.
        await consumeRetentionDiscountSafe(sub);
        break;
      case "subscription.cancelled":
      case "subscription.expired":
        await syncSubscription(sub);
        // Tell the humans when Seal, not a customer and not us, killed the
        // subscription because the card kept failing. 35 went this way in July
        // 2026 (~987 €/month) and not one of them produced a signal anywhere:
        // Seal's own admin notification for failed payments turns out not to
        // reach us either (zero in 90 days of inbox).
        //
        // Detected from the `log` array, which is the only field that names the
        // actor. `cancellation_reason` is empty on every cancellation we've
        // stored, so it cannot be used for this.
        notifyDunningCancelSafe(sub);
        break;
      // Four documented Seal topics that fell through to `default` until
      // 2026-07-28, i.e. a console.warn and nothing else. Seal's topic list is
      // subscription/{created,updated,paused,resumed,reactivated,expired,
      // payment_method_updated,shipping_address_updated,cancelled}. All four are
      // pure cache refreshes, idempotent, and already covered by REPLAY_SAFE.
      //
      // `resumed` and `reactivated` are the ones that mattered: Seal fires
      // resumed for the `resume` action and reactivated for `reactivate`, so
      // WITHOUT these a subscription brought back to life anywhere other than our
      // own resume route (Seal's admin, Seal's portal) left our cache reading
      // 'paused' or 'expired' forever. Terminal-looking states may never be
      // followed by another event for that sub, so nothing would have healed it.
      //
      // `payment_method_updated` is the other half of the dunning loop: it is the
      // signal that the customer fixed the card we just emailed them about.
      case "subscription.resumed":
      case "subscription.reactivated":
      case "subscription.shipping_address_updated":
        await syncSubscription(sub);
        break;
      case "subscription.payment_method_updated":
        await syncSubscription(sub);
        // Closes the dunning loop. The flow triggered by `payment_failed` sends a
        // last-chance email 48 h later, and this is the only signal that says
        // "they already fixed it, stop". Filter the flow on it.
        await trackPaymentFixedSafe(sub);
        break;
      // READ THIS BEFORE TRUSTING THIS CASE. Subscribed in Seal since 2026-07-23
      // (webhook id 129549), and it fires for an API pause but NOT for a customer
      // pause in Seal's own portal. Measured, not guessed:
      //
      //  - Three CUSTOMER pauses after that date (2026-07-23 14:31, 2026-07-23
      //    15:36, 2026-07-26 12:06) produced ZERO rows for this topic in
      //    webhook_log, while a subscription/updated landed one second after each.
      //  - A MERCHANT pause via the API (probe on sub 14692586, 2026-07-29
      //    10:03:08) delivered subscription/paused at 10:03:09, 1s later.
      //
      // The reservation insert runs after the HMAC check but before this switch
      // and records ANY topic, so the absence in the customer case is absence of
      // delivery, not a logging gap. So if you test this by pausing through the
      // API you will see the event arrive and wrongly conclude the case is enough.
      //
      // It isn't: the pauses that cost money are the customer ones, and those are
      // only observable as subscription/updated. That is why the notification
      // hangs off the active -> paused transition inside syncSubscription rather
      // than off this case. The transition guard means one pause produces exactly
      // one alert whichever topic (or both) happens to arrive.
      case "subscription.paused":
        await syncSubscription(sub);
        break;
      case "billing_attempt.succeeded": {
        // Charge succeeded → next ship moved. Refresh the cache.
        // (The comment that used to sit here said this topic "isn't subscribed
        // today". It is now: 74 delivered between 2026-07-22 and 2026-07-27.)
        await syncSubscription(sub);
        await consumeRetentionDiscountSafe(sub);
        break;
      }
      case "billing_attempt.failed": {
        // The retention moment. Seal retries 4 times on consecutive days,
        // emails the customer each time from a template we don't control whose
        // CTA is a magic link into Seal's portal, and then auto-cancels:
        // 35 subscriptions in July 2026 alone (~987 €/month). We now speak
        // first, with our own email and a CTA into the portal.
        //
        // Order matters: refresh the cache BEFORE the trigger so a customer who
        // clicks through immediately sees current state, and keep the trigger
        // last so a Klaviyo problem can't cost us the cache update.
        await syncSubscription(sub);
        // Seal calls the attempt `failed_billing_attempt` on this topic (and
        // `processed_billing_attempt` on the succeeded one). Verified against a
        // real payload 2026-07-29: { id, date, status: "error", completed_at,
        // number_of_tries }. `number_of_tries` is the dunning counter, 1-4, which
        // is what lets the email say how many chances are left before Seal
        // cancels. There is no `error_message` on this object, so the copy has to
        // stay generic about the cause.
        const attempt = (payload as { failed_billing_attempt?: SealFailedAttempt })
          .failed_billing_attempt;
        // The gateway's own words are NOT on failed_billing_attempt. They are on
        // the matching entry of the sub's `billing_attempts` array, which the same
        // payload carries. Pull it across so Klaviyo can segment "expired card"
        // from "gateway declined", which need different copy.
        const gatewayMessage =
          (sub.billing_attempts ?? []).find((a) => Number(a.id) === Number(attempt?.id))
            ?.error_message || null;
        const outcome = await fireDunningTrigger(sub, { ...attempt, error_message: gatewayMessage });
        // Do NOT discard the outcome. fireDunningTrigger never throws by design,
        // so without this a broken dunning path would return 200 and say nothing,
        // which is the exact failure mode this whole change exists to remove: the
        // TODO that sat here for months was silent too. `already_fired_this_cycle`
        // is the healthy steady state (Seal retries 4 times, we mail once), so it
        // is not an alert.
        if (!outcome.fired && outcome.reason !== "already_fired_this_cycle") {
          alertSlackError({
            path: "/api/webhooks/seal",
            code: `dunning_not_fired:${outcome.reason}`,
            msg:
              `Cobro fallido recibido y NO se avisó al cliente (${outcome.reason}). ` +
              `Seal cancela la suscripción al cuarto intento, quedan ~3 días. ` +
              `Sub ${sub?.id ?? "?"}.`,
          });
        }

        // LAST-CHANCE ALERT to the humans (Juan, 2026-07-29). Not on every failed
        // charge: there were 41 in a single morning, and an alert that fires 41
        // times a day is an alert nobody reads. Only from the third try, because
        // Seal cancels after the FOURTH, so this lands with roughly one day of
        // margin to do something about it.
        //
        // `number_of_tries` is the whole reason this is possible, and we only know
        // it exists because of the payload audit column.
        const tries = attempt?.number_of_tries ?? 0;
        if (tries >= 3) {
          alertSlackNotice({
            channel: "incidents",
            icon: ":warning:",
            title:
              tries >= 4
                ? "Suscripción a punto de cancelarse: CUARTO cobro fallido, Seal la cancela ya"
                : "Suscripción en riesgo: tercer cobro fallido, Seal la cancela al cuarto (mañana)",
            fields: {
              seal_subscription_id: String(sub.id),
              intento: `${tries} de 4`,
              importe: `${sub.total_value ?? "?"} ${sub.currency ?? ""}`.trim(),
              cadencia: sub.delivery_interval,
              tarjeta: [sub.card_expiry_month, sub.card_expiry_year].filter(Boolean).join("/"),
              aviso_al_cliente: outcome.fired
                ? "enviado en este ciclo"
                : `NO enviado (${outcome.reason})`,
              // NO es el proximo intento. Verificado sobre una alerta real
              // (sub 13944154, 2026-07-29): Seal mantiene fija la fecha del cobro
              // programado original y solo incrementa number_of_tries, asi que
              // etiquetarlo "siguiente_intento" mostraba una fecha ya pasada y
              // hacia pensar que el reintento ya se habia agotado.
              cobro_programado: attempt?.date ?? "?",
            },
          });
        }
        break;
      }
      default:
        console.warn(`[seal-webhook] unhandled topic ${eventType}`);
        // Alert, don't just log (2026-07-28). An unhandled topic is precisely
        // the bug class this whole change exists to close: a `break` with a TODO
        // sat in billing_attempt.failed for months and nothing ever said so.
        //
        // It also covers the one thing we can't verify from here: the exact
        // topic string. webhook_log proves Seal sends `billing_attempt/succeeded`
        // (74 of them), so `billing_attempt/failed` is the obvious counterpart,
        // but BACKEND_CONTRACT.md:579 calls it "billing.attempt.failure". If the
        // header turns out to be something else, the case below never matches
        // and we'd be back to silence. This turns that into a Slack ping the
        // first time Seal sends it, and the stored payload has the rest.
        //
        // alertSlackError dedupes by (path, code) for 60 s, so a burst of an
        // unknown topic posts once, not a thousand times.
        alertSlackError({
          path: "/api/webhooks/seal",
          code: "unhandled_topic",
          msg: `Seal envió el topic "${eventType}" y no lo maneja nadie. Revisa el switch y webhook_log.payload.`,
        });
    }
    await sb
      .from("webhook_log")
      .update({ processed_at: new Date().toISOString() })
      .eq("provider", "seal")
      .eq("event_id", eventId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[seal-webhook] handler failed for ${eventType}`, err);
    // Reservation policy on failure (audit 2026-07-06): Seal's redelivery
    // carries the SAME body → same hash → it would die on dedup:true, so a kept
    // reservation makes "return 500 so Seal redelivers" a guaranteed no-op and
    // a lost cancel/pause left the cache 'active' FOREVER (terminal events may
    // never be followed by another event for that sub).
    //
    // Split by topic:
    // - REPLAY-SAFE topics (cancelled/expired/paused/billing_attempt.succeeded):
    //   handlers are idempotent (cache upsert; retention-discount removal
    //   no-ops on replay) → RELEASE the un-processed reservation so the
    //   redelivery actually reprocesses.
    // - subscription.created/updated KEEP the reservation:
    //   applyReanchorIfPending → seal.reanchorCadence is a real NON-idempotent
    //   Seal mutation; a replay after partial failure would OVER-SHIFT the
    //   billing schedule. Their cache side self-heals on the next event and
    //   the re-anchor intent is driven by the bounded cron drain.
    const REPLAY_SAFE = new Set([
      "subscription.cancelled",
      "subscription.expired",
      "subscription.paused",
      // Pure cache refreshes, idempotent by construction.
      "subscription.resumed",
      "subscription.reactivated",
      "subscription.payment_method_updated",
      "subscription.shipping_address_updated",
      "billing_attempt.succeeded",
      // billing_attempt.failed is replay-safe too: syncSubscription is an
      // idempotent cache upsert and fireDunningTrigger is guarded by an
      // email_logs row per (sub, 5-day cycle), so a redelivery can't double-mail
      // the customer. Releasing matters here — if the Shopify lookup inside
      // syncSubscription blips, we'd otherwise lose the dunning signal for a
      // whole retry day.
      "billing_attempt.failed",
    ]);
    if (REPLAY_SAFE.has(topic)) {
      const { error: releaseErr } = await sb
        .from("webhook_log")
        .delete()
        .eq("provider", "seal")
        .eq("event_id", eventId)
        .is("processed_at", null);
      if (releaseErr) {
        console.error("[seal-webhook] failed to release reservation", releaseErr.message);
      }
    }
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}

/**
 * Verify Seal's HMAC-SHA256 signature. Seal's docs reference a PHP helper but
 * don't pin hex vs base64, so we accept either encoding (constant-time).
 */
function verifySealSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const hex = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const b64 = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return safeEqual(signature, hex) || safeEqual(signature, b64);
}

/**
 * Parse for storage only. The reservation insert runs BEFORE the route parses
 * the body for real, so a malformed payload must degrade to a NULL audit column,
 * never break dedup (the strict parse right after still returns 400).
 */
function safeJson(raw: string): unknown {
  try {
    // Strip NUL bytes. Postgres refuses \u0000 inside jsonb ("unsupported Unicode
    // escape sequence"), and that error would surface on the reservation INSERT,
    // whose only handled error code is 23505 (unique violation). Every other code
    // falls through and the request proceeds WITHOUT a dedup reservation, so a
    // stray control character in a customer's address could disable dedup for
    // that event. The audit column gives way, never the reservation.
    return JSON.parse(raw.replace(/\u0000/g, ""));
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * If there's a pending re-anchor intent for this subscription, preserve the
 * customer's prior next-ship date: skip every regenerated pending attempt that
 * falls BEFORE preserve_date so the next charge holds on (or after) it.
 *
 * Idempotent + anti-loop: the skip itself fires another subscription/updated;
 * on that re-entry there are no early attempts left, so we just clear the
 * intent and stop. Re-reads live Seal state (the webhook payload may be a
 * mid-regeneration snapshot).
 */
async function applyReanchorIfPending(subFromEvent?: SealSubscription | null): Promise<void> {
  const sealSubId = subFromEvent?.id;
  if (!sealSubId) return;

  const sb = supabaseAdmin();
  const { data: intent } = await sb
    .from("subscription_reanchor_intents")
    .select("customer_id, preserve_date, status")
    .eq("seal_subscription_id", String(sealSubId))
    .eq("status", "pending")
    .maybeSingle();
  if (!intent) return;

  const preserve = String(intent.preserve_date).slice(0, 10);

  // Cutoff guard — never re-anchor onto a date already inside 24h.
  if (isWithinCutoff(`${preserve}T13:00:00Z`)) {
    await sb
      .from("subscription_reanchor_intents")
      .delete()
      .eq("customer_id", intent.customer_id)
      .eq("seal_subscription_id", String(sealSubId));
    console.log("[seal-webhook] reanchor cleared (within cutoff)", { sealSubId, preserve });
    return;
  }

  // Read fresh state — the payload may be mid-regeneration.
  const sub = await seal.getSubscriptionById(Number(sealSubId));
  if (!sub) return; // transient; another webhook (or the cron/dashboard) retries

  const firstPending = getNextBillingAttempt(sub);
  if (!firstPending) {
    // Regen hasn't surfaced attempts yet (0 pending) — leave the intent for
    // the next webhook / cron / dashboard poll.
    console.log("[seal-webhook] reanchor waiting for regen", { sealSubId, preserve });
    return;
  }

  const firstDay = firstPending.date.slice(0, 10);
  if (firstDay >= preserve) {
    // Converged: the next charge is on/after the preserved date and the whole
    // cadence was shifted with it. Done — clear the intent. (This is also the
    // re-entry after our own reschedules fire another subscription/updated.)
    await sb
      .from("subscription_reanchor_intents")
      .delete()
      .eq("customer_id", intent.customer_id)
      .eq("seal_subscription_id", String(sealSubId));
    console.log("[seal-webhook] reanchor converged", { sealSubId, preserve, nextCharge: firstDay });
    return;
  }

  // Seal anchored earlier than preserve → shift the whole regenerated schedule
  // forward so the next charge lands on preserve and the new cadence runs from
  // there. reanchorCadence fires more subscription/updated events; on re-entry
  // firstDay === preserve, so we converge and clear the intent.
  const moved = await seal.reanchorCadence(Number(sealSubId), preserve);
  console.log("[seal-webhook] reanchor shifted schedule", { sealSubId, preserve, moved, from: firstDay });
}

/** Seal's attempt object on billing_attempt/* payloads. Verified 2026-07-29. */
interface SealFailedAttempt {
  id?: number;
  date?: string;
  status?: string;
  completed_at?: string;
  /** 1-4. Seal cancels the subscription after the fourth failure. */
  number_of_tries?: number;
}

/**
 * The subscription an incoming Seal webhook is about.
 *
 * THE BUG THIS FIXES (2026-07-29). Every handler in this file used to read
 * `payload.subscription`. Seal does not send that. It sends the subscription
 * object FLAT at the top level: { id, email, status, items, billing_attempts,
 * log, failed_billing_attempt, customer_id, … }. So `payload.subscription` was
 * `undefined` on every event, `syncSubscription` returned on its `if (!s)` guard,
 * and the ENTIRE webhook was a silent no-op for its whole life, for every topic.
 *
 * How we know, from webhook_log.payload (the audit column added the day before,
 * which is the only reason this was findable):
 *  - 59 of 59 stored payloads are flat. Zero have a nested `subscription` key.
 *  - Mean handler time was 7-16 ms across every topic. A handler that really did
 *    a Shopify GraphQL lookup plus a Supabase upsert cannot run in 9 ms.
 *
 * What silently never happened: the subscriptions cache was only ever written by
 * Hub visits, the re-anchor only ever landed via the Hub drain and the cron, and
 * the retention-discount retirement only ever via the daily sweep. Those all had
 * independent backstops, which is exactly why nobody noticed for months.
 *
 * The nested shape is still accepted first, in case Seal ever ships what its docs
 * imply, or a future payload wraps it.
 */
function subFromPayload(payload: unknown): SealSubscription | null {
  const p = payload as { subscription?: SealSubscription } & Partial<SealSubscription>;
  if (p?.subscription?.id) return p.subscription;
  // Flat shape: require BOTH id and email so a stray object can't be mistaken for
  // a subscription. Every real payload has both.
  if (p?.id && p?.email) return p as SealSubscription;
  return null;
}

/**
 * The customer updated their payment method. Fire it into Klaviyo so the dunning
 * flow can filter out anyone who has already solved the problem.
 *
 * Best-effort: a Klaviyo hiccup must not fail the cache refresh that already
 * happened, and the worst case is one unnecessary last-chance email.
 */
async function trackPaymentFixedSafe(sub: SealSubscription): Promise<void> {
  const email = (sub.email ?? "").trim().toLowerCase();
  if (!email) return;
  try {
    await klaviyo.trackEvent("payment_method_updated", email, {
      sealSubscriptionId: String(sub.id),
      cardExpiryMonth: sub.card_expiry_month || null,
      cardExpiryYear: sub.card_expiry_year || null,
    });
  } catch (err) {
    console.warn("[seal-webhook] payment_method_updated klaviyo event failed", {
      sealId: sub.id,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Seal auto-cancelled a subscription because the card kept failing. Tell the
 * humans, in the incidents channel, once.
 *
 * Detection is by Seal's own `log` array (the field that names the actor), whose
 * entry reads "Subscription was cancelled because the payment couldn't be
 * processed within the allowed number of…". `cancellation_reason` is empty on
 * every cancellation payload we have stored, so it is useless here.
 *
 * Synchronous and non-async on purpose: alertSlackNotice is fire-and-forget and
 * never throws, so this cannot affect the webhook response.
 */
function notifyDunningCancelSafe(sub: SealSubscription): void {
  try {
    const log = (sub as SealSubscription & { log?: Array<{ content?: string }> }).log ?? [];
    const entry = log
      .map((e) => e?.content ?? "")
      .find((t) => /payment could(n.t| not) be processed/i.test(t));
    if (!entry) return;

    alertSlackNotice({
      channel: "incidents",
      icon: ":x:",
      title: "Suscripción CANCELADA por Seal tras agotar los reintentos de cobro",
      fields: {
        seal_subscription_id: String(sub.id),
        importe_perdido: `${sub.total_value ?? "?"} ${sub.currency ?? ""}`.trim(),
        cadencia: sub.delivery_interval,
        cancelada_el: sub.cancelled_on,
        motivo_seal: entry.slice(0, 140),
      },
    });
  } catch (err) {
    console.warn("[seal-webhook] dunning-cancel notice failed (non-fatal)", {
      sealId: sub?.id,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A pause became visible to us. Two jobs, both best-effort:
 *
 *  1. Tell us on Slack. For a year the only way to learn about a pause was to
 *     page through the Seal API by hand.
 *  2. Fire a Klaviyo event so the customer can be walked back to the portal to
 *     resume (POST /api/subscription/resume). Nothing sends until someone
 *     switches the flow on in Klaviyo, so this is inert-but-ready.
 *
 * Called from syncSubscription on the active -> paused TRANSITION, not from the
 * subscription.paused case. See the comment there for why.
 *
 * Never throws: the cache upsert already happened and is the part that matters.
 */
async function notifyPausedSafe(sub?: SealSubscription): Promise<void> {
  if (!sub?.id) return;
  const sealId = String(sub.id);
  try {
    alertSlackNotice({
      title:
        "Suscripción PAUSADA (la pausa no existe en nuestro portal, viene del portal nativo de Seal)",
      fields: {
        seal_subscription_id: sealId,
        importe: `${sub.total_value ?? "?"} ${sub.currency ?? ""}`.trim(),
        cadencia: sub.delivery_interval,
        pausada_el: sub.paused_on,
      },
    });
    const email = (sub.email ?? "").trim().toLowerCase();
    if (email) {
      await klaviyo.trackEvent("subscription_paused", email, {
        sealSubscriptionId: sealId,
        pausedOn: sub.paused_on || null,
        amount: sub.total_value ?? null,
        currency: sub.currency ?? "EUR",
      });
    }
  } catch (err) {
    console.warn("[seal-webhook] paused notification failed (non-fatal)", {
      sealId,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Retire the cancel-flow 15% retention discount once its first (discounted)
 * charge has landed. Best-effort wrapper: never throws, so a transient Seal
 * failure can't fail the whole webhook (which, on subscription/updated, would
 * be swallowed by dedup on redelivery anyway). The daily cron sweep
 * (/api/cron/retention-discount-sweep) is the guaranteed backstop. The real
 * logic + guards live in lib/retention-discount.
 */
async function consumeRetentionDiscountSafe(subFromEvent?: SealSubscription | null): Promise<void> {
  const sealSubId = subFromEvent?.id;
  if (!sealSubId) return;
  try {
    await consumeRetentionDiscountIfCharged(sealSubId);
  } catch (e) {
    console.error("[seal-webhook] retention discount consume failed (cron will retry)", {
      sealSubId,
      msg: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Mirror Seal subscription state into Supabase for fast portal queries.
 */
async function syncSubscription(s: SealSubscription | null): Promise<void> {
  if (!s) return;

  // Fast path: Seal's payload carries `customer_id`, and it IS the Shopify
  // customer id. Verified 2026-07-29 against six live events, all six matching the
  // customer_id already in our cache. Using it skips a Shopify GraphQL round trip
  // per event (~4k Seal events a month) and removes the failure mode where a
  // Shopify blip made the webhook 500 and lose the event.
  //
  // BUT it is only a SHORTCUT, never an authority. `subscriptions.customer_id` is
  // the portal's authorization key: verifyOwnershipFast grants the mutation fast
  // path on the mere existence of a (customer_id, seal_subscription_id) row, so an
  // unverified id must not be able to decide who owns a subscription. Concretely,
  // if Seal's customer_id ever disagreed with the row we already have (support
  // fixing a checkout email typo is the documented way that happens, see the 23505
  // re-home below), trusting the payload would move the row AWAY from the real
  // owner, and the re-home branch written to repair that reassignment would be the
  // thing performing it.
  //
  // So: take the shortcut only when it agrees with what we already know, or when
  // we know nothing yet. On any disagreement, fall through to the email lookup,
  // which is the path that follows the corrected email and is allowed to re-home.
  // Raised by review; the 6/6 sample could not have caught it, because a cached row
  // only exists for subs whose owner reached the Hub, i.e. the already-agreeing ones.
  const idFromPayload = String(
    (s as SealSubscription & { customer_id?: string }).customer_id ?? "",
  );
  // `/^\d+$/` alone would accept "0" (a sub with no Shopify customer linked) and
  // pile every such sub into one bogus bucket under customer_id "0".
  if (/^\d+$/.test(idFromPayload) && idFromPayload !== "0") {
    const { data: existing } = await supabaseAdmin()
      .from("subscriptions")
      .select("customer_id")
      .eq("seal_subscription_id", String(s.id))
      .maybeSingle();
    const known = existing?.customer_id ? String(existing.customer_id) : null;
    if (!known || known === idFromPayload) {
      await writeSubscriptionCache(s, idFromPayload);
      return;
    }
    console.warn(
      "[seal-webhook] payload customer_id disagrees with cached owner, using the email lookup",
      { sealId: s.id, fromPayload: idFromPayload, cached: known },
    );
  }

  // Slow path: no usable customer_id in the payload, or it contradicts the cache →
  // resolve by email, as before.
  const { shopifyAdmin } = await import("@/lib/shopify-admin");
  const customer = await shopifyAdmin
    .graphql<{ customers: { edges: Array<{ node: { id: string } }> } }>(
      `query findByEmail($q: String!) { customers(first: 1, query: $q) { edges { node { id } } } }`,
      { q: `email:"${s.email.replace(/"/g, '\\"')}"` },
    );
  // Intentionally NO `.catch(() => null)`: a THROWN Shopify error (network / 5xx
  // / throttle, after shopify-admin's own retries) must propagate so the seal
  // webhook returns 500 and Seal REDELIVERS. Swallowing it silently dropped a
  // subscription.cancelled/paused/updated event on a transient blip, leaving the
  // cache stale-'active'. A genuine "customer not found" is empty edges (not a
  // throw) and is handled by the guard below.
  const customerGid = customer?.customers?.edges?.[0]?.node?.id;
  if (!customerGid) {
    console.warn(`[seal-webhook] no Shopify customer for Seal sub ${s.id}`);
    return;
  }
  const customerId = customerGid.replace(/^gid:\/\/shopify\/Customer\//, "");
  await writeSubscriptionCache(s, customerId);
}

/**
 * Upsert the Supabase cache row for one subscription, and fire the pause
 * notification on the active -> paused transition. Split out of syncSubscription
 * so both the customer_id fast path and the email slow path share it.
 */
async function writeSubscriptionCache(s: SealSubscription, customerId: string): Promise<void> {
  const sb = supabaseAdmin();
  const mapped = mapToSubscription(s, customerId);
  const nextStatus = mapStatus(s);

  // Previous cached status, read BEFORE the upsert overwrites it, so we can spot
  // the active -> paused transition. This is the only way we find out about the
  // pauses that matter: Seal delivers subscription/paused for an API pause but NOT
  // for a customer pause in its own portal (see that case above), and a customer
  // pause only ever shows up as subscription/updated. Best-effort read: a miss
  // just means no alert, never a failed webhook.
  let prevStatus: string | null = null;
  if (nextStatus === "paused") {
    const { data: prevRow } = await sb
      .from("subscriptions")
      .select("status")
      .eq("seal_subscription_id", String(s.id))
      .maybeSingle();
    prevStatus = (prevRow?.status as string | undefined) ?? null;
  }

  const cacheRow = {
    customer_id: customerId,
    seal_subscription_id: String(s.id),
    box_count: mapped.boxCount,
    frequency: normalizeFrequency(s.delivery_interval),
    // Flavor mix: the SUMMARY ("2× Lemon · 1× Watermelon"), not the dominant label.
    // A single-flavor sub still yields "Salty Lemon" byte-for-byte, so no existing
    // row churns and nothing reading this column changes behaviour.
    flavor: mapped.flavorSummary,
    composition: mapped.composition,
    shape: mapped.shape,
    line_count: mapped.lines.length,
    charge_total_cents: mapped.chargeTotalCents,
    next_ship_date: mapped.nextShipDate,
    next_box_number: mapped.nextBoxNumber,
    status: nextStatus,
    updated_at: new Date().toISOString(),
  };
  const { error: upsertErr } = await sb.from("subscriptions").upsert(
    cacheRow,
    // Multi-sub: one cache row per (customer, sub) — composite matches the
    // subscriptions PK after the flip, so each sub's webhook upserts its own row.
    { onConflict: "customer_id,seal_subscription_id" },
  );
  if (upsertErr) {
    // 23505 against the standalone UNIQUE(seal_subscription_id): the sub now
    // resolves to a DIFFERENT customer (support fixed a checkout email typo →
    // duplicate-account reassignment). The composite onConflict doesn't match
    // that row, so the insert collides with the old owner's row. Silently
    // dropping this (the pre-audit behaviour) left the cache pointing at the
    // OLD customer forever: verifyOwnershipFast kept passing for the old
    // account and the new one never got a fast-path. Re-home the row.
    if (upsertErr.code === "23505") {
      const { error: rehomeErr } = await sb
        .from("subscriptions")
        .update(cacheRow)
        .eq("seal_subscription_id", String(s.id));
      if (rehomeErr) {
        throw new Error(
          `subscriptions cache re-home failed for sub ${s.id}: ${rehomeErr.message}`,
        );
      }
      console.log(
        `[seal-webhook] cache row re-homed to customer ${customerId} for sub ${s.id} (email reassignment)`,
      );
    } else {
      // Propagate: the webhook 500s and the failure is visible instead of a
      // silently stale cache (the {error} used to be discarded entirely).
      throw new Error(`subscriptions cache upsert failed for sub ${s.id}: ${upsertErr.message}`);
    }
  }

  // Pause detection, by transition. Fires at most once per pause: after this the
  // cache reads 'paused', so the next event for the same sub finds
  // prevStatus === 'paused' and stays quiet. Runs for EVERY topic that carries the
  // subscription, which is what makes it work at all given that
  // subscription/paused never arrives. Deliberately after the upsert: if the
  // cache write failed we've already thrown, and alerting about a state we didn't
  // manage to persist would be lying.
  if (nextStatus === "paused" && prevStatus !== "paused") {
    await notifyPausedSafe(s);
  }
}

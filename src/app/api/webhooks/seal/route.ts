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

  let payload: { subscription?: SealSubscription } | unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const topic = eventType.replace("/", ".");
  try {
    switch (topic) {
      case "subscription.created":
        await syncSubscription(payload as { subscription: SealSubscription });
        await applyReanchorIfPending((payload as { subscription?: SealSubscription }).subscription);
        break;
      case "subscription.updated":
        await syncSubscription(payload as { subscription: SealSubscription });
        await applyReanchorIfPending((payload as { subscription?: SealSubscription }).subscription);
        // A successful charge advances the schedule and fires subscription/updated,
        // so this is where we retire the cancel-flow 15%. This used to be the ONLY
        // place it could happen, because billing_attempt/succeeded wasn't
        // subscribed in Seal (incident 2026-07-23). It is subscribed now (74
        // delivered between 2026-07-22 and 2026-07-27), so both paths run; the
        // consumer is idempotent and guarded (removes ONLY after the discounted
        // charge has landed), so doing it twice is a no-op. Best-effort here: the
        // daily cron sweep is the guaranteed backstop, so a transient failure must
        // never fail the whole webhook.
        await consumeRetentionDiscountSafe((payload as { subscription?: SealSubscription }).subscription);
        break;
      case "subscription.cancelled":
      case "subscription.expired":
        await syncSubscription(payload as { subscription: SealSubscription });
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
      case "subscription.payment_method_updated":
      case "subscription.shipping_address_updated":
        await syncSubscription(payload as { subscription: SealSubscription });
        break;
      // Subscribed in Seal since 2026-07-23 (webhook id 129549) and SEAL HAS
      // NEVER DELIVERED IT. Three customer pauses happened after that date
      // (2026-07-23 14:31, 2026-07-23 15:36, 2026-07-26 12:06) and webhook_log
      // has zero rows for this topic, while a subscription/updated landed one
      // second after each pause. The reservation insert happens after the HMAC
      // check but before the switch and records ANY topic, so absence here is
      // absence of delivery, not a logging gap.
      //
      // Conclusion: a customer-side pause is only observable as
      // subscription/updated. That is why the notification hangs off the
      // active -> paused transition inside syncSubscription instead of off this
      // case. This stays wired in case Seal starts delivering it, and the
      // transition guard means one pause produces exactly one alert either way.
      case "subscription.paused":
        await syncSubscription(payload as { subscription: SealSubscription });
        break;
      case "billing_attempt.succeeded": {
        // Charge succeeded → next ship moved. Refresh the cache.
        // (The comment that used to sit here said this topic "isn't subscribed
        // today". It is now: 74 delivered between 2026-07-22 and 2026-07-27.)
        const sub = await subFromBillingAttemptPayload(payload);
        if (sub) {
          await syncSubscription({ subscription: sub });
          await consumeRetentionDiscountSafe(sub);
        }
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
        const sub = await subFromBillingAttemptPayload(payload);
        if (sub) await syncSubscription({ subscription: sub });
        const outcome = await fireDunningTrigger(
          sub ?? undefined,
          (payload as { billing_attempt?: { date?: string; error_message?: string | null } })
            .billing_attempt,
        );
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
async function applyReanchorIfPending(subFromPayload?: SealSubscription): Promise<void> {
  const sealSubId = subFromPayload?.id;
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

/**
 * Get the subscription a `billing_attempt/*` event refers to.
 *
 * Seal's documented payload for the subscription topics is `{ subscription: … }`
 * and the billing_attempt topics were written here on the assumption that they
 * look the same. That assumption was never verified: the topic wasn't even
 * subscribed until 2026-07-22, and if the payload turned out to carry only the
 * attempt, `syncSubscription` would return early on `!s` and the whole handler
 * would be a silent no-op — the exact failure mode we're here to remove, just
 * one layer down.
 *
 * So: use the embedded subscription when it's there, otherwise take whatever id
 * the payload does carry and read the subscription from Seal. One extra GET on a
 * path that fires a handful of times a day, in exchange for the feature not
 * depending on an unverified payload shape.
 */
async function subFromBillingAttemptPayload(payload: unknown): Promise<SealSubscription | null> {
  const p = payload as {
    subscription?: SealSubscription;
    subscription_id?: number | string;
    billing_attempt?: { subscription_id?: number | string };
  };
  if (p?.subscription?.id) return p.subscription;

  const rawId = p?.billing_attempt?.subscription_id ?? p?.subscription_id;
  const id = Number(rawId);
  if (!rawId || Number.isNaN(id)) {
    console.warn("[seal-webhook] billing_attempt payload has no resolvable subscription", {
      keys: p && typeof p === "object" ? Object.keys(p) : typeof p,
    });
    return null;
  }
  const sub = await seal.getSubscriptionById(id);
  if (!sub) {
    // Transient Seal failure. Throwing here is deliberate: billing_attempt.* is
    // in REPLAY_SAFE, so the reservation is released and Seal's redelivery gets
    // another shot at the dunning trigger.
    throw new Error(`billing_attempt: subscription ${id} not readable from Seal`);
  }
  console.log("[seal-webhook] billing_attempt payload had no embedded subscription, fetched by id", { id });
  return sub;
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
async function consumeRetentionDiscountSafe(subFromPayload?: SealSubscription): Promise<void> {
  const sealSubId = subFromPayload?.id;
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
async function syncSubscription(payload: { subscription: SealSubscription }): Promise<void> {
  const s = payload?.subscription;
  if (!s) return;

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

  const sb = supabaseAdmin();
  const mapped = mapToSubscription(s, customerId);
  const nextStatus = mapStatus(s);

  // Previous cached status, read BEFORE the upsert overwrites it, so we can spot
  // the active -> paused transition. This is the only way we ever find out about
  // a pause: Seal has the subscription/paused topic subscribed since 2026-07-23
  // and has never delivered a single one, while a subscription/updated lands one
  // second after every pause. Best-effort read: a miss just means no alert, never
  // a failed webhook.
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

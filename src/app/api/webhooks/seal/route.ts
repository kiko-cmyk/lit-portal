import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { isWithinCutoff } from "@/lib/cutoff";
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
  const dedup = await sb.from("webhook_log").insert({
    provider: "seal",
    event_id: eventId,
    topic: eventType,
  });
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
        // so this is where we retire the cancel-flow 15%: the dedicated
        // billing_attempt/succeeded topic is NOT subscribed in Seal (incident
        // 2026-07-23 — only subscription/updated reaches the portal). The consumer
        // is idempotent and guarded (removes ONLY after the discounted charge has
        // landed). Best-effort here; the daily cron sweep is the guaranteed
        // backstop, so a transient failure must never fail the whole webhook.
        await consumeRetentionDiscountSafe((payload as { subscription?: SealSubscription }).subscription);
        break;
      case "subscription.cancelled":
      case "subscription.expired":
      case "subscription.paused":
        await syncSubscription(payload as { subscription: SealSubscription });
        break;
      case "billing_attempt.succeeded":
        // Charge succeeded → next ship moved. Refresh the cache. Kept wired even
        // though the topic isn't subscribed today, so it works as the primary
        // trigger the moment someone adds it in Seal (defense in depth).
        await syncSubscription(payload as { subscription: SealSubscription });
        await consumeRetentionDiscountSafe((payload as { subscription?: SealSubscription }).subscription);
        break;
      case "billing_attempt.failed":
        // TODO: notify customer via Klaviyo + log
        break;
      default:
        console.warn(`[seal-webhook] unhandled topic ${eventType}`);
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
      "billing_attempt.succeeded",
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
  const cacheRow = {
    customer_id: customerId,
    seal_subscription_id: String(s.id),
    box_count: mapped.boxCount,
    frequency: normalizeFrequency(s.delivery_interval),
    flavor: mapped.flavor,
    next_ship_date: mapped.nextShipDate,
    next_box_number: mapped.nextBoxNumber,
    status: mapStatus(s),
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
}

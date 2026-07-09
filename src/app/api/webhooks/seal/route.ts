import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { isWithinCutoff } from "@/lib/cutoff";
import {
  findAppliedDiscountCodeId,
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

  try {
    const topic = eventType.replace("/", ".");
    switch (topic) {
      case "subscription.created":
      case "subscription.updated":
        await syncSubscription(payload as { subscription: SealSubscription });
        await applyReanchorIfPending((payload as { subscription?: SealSubscription }).subscription);
        break;
      case "subscription.cancelled":
      case "subscription.expired":
      case "subscription.paused":
        await syncSubscription(payload as { subscription: SealSubscription });
        break;
      case "billing_attempt.succeeded":
        // Charge succeeded → next ship moved. Refresh the cache.
        await syncSubscription(payload as { subscription: SealSubscription });
        // If a retention discount (cancel-flow 15%) was riding on this charge,
        // remove it NOW so it never hits a later charge — the "15% next charge
        // only" guarantee (Juan, IMPORTANTÍSIMO).
        await removeRetentionDiscountIfPending((payload as { subscription?: SealSubscription }).subscription);
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
    // NOTE: deliberately NO delete-on-failure here (unlike the shopify webhook).
    // applyReanchorIfPending calls seal.reanchorCadence — a real, NON-idempotent
    // Seal mutation that shifts billing attempts. A forced webhook replay after
    // a partial failure would re-apply the offset to already-moved attempts and
    // OVER-SHIFT the customer's billing schedule (the convergence guard only
    // inspects the first attempt, so it wouldn't catch it). And Seal events
    // mostly self-heal without a replay: syncSubscription is a cache mirror the
    // NEXT Seal event re-upserts, and the re-anchor intent is driven to
    // completion by the BOUNDED cron drain (reanchor-drain, MAX_ATTEMPTS). So we
    // let the reservation stand and return 500 (baseline behavior); the customer
    // impact that motivated delete-on-failure (lost confirmation emails / box
    // drops) lives on the shopify webhook, not here.
    //
    // KNOWN GAP (Juan's review): syncSubscription is the ONLY writer of the
    // cached subscriptions.status. If a cancel/pause webhook is lost and no
    // further Seal event arrives, status stays 'active' indefinitely (the
    // dashboard is unaffected — it reads Seal live — but the monthly-streak
    // cron reads this cache and could award a streak Drop to a no-longer-active
    // sub). Low severity (monthly cron, small leak). Follow-up: have
    // monthly-streak verify status against Seal live before awarding, or add a
    // nightly status re-sync.
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
 * Cancel-flow retention discount: remove the 15% code right after its first
 * (discounted) charge succeeds, so no later charge ever gets it. Idempotent and
 * retryable — if removal fails we leave the row `pending_charge` and the next
 * billing_attempt.succeeded retries (and the Shopify 1-cycle limit is a backstop).
 */
async function removeRetentionDiscountIfPending(subFromPayload?: SealSubscription): Promise<void> {
  const sealSubId = subFromPayload?.id;
  if (!sealSubId) return;

  const sb = supabaseAdmin();
  const { data: row } = await sb
    .from("retention_discounts")
    .select("customer_id, discount_code_id, code, applied_at")
    .eq("seal_subscription_id", String(sealSubId))
    .eq("status", "pending_charge")
    .maybeSingle();
  if (!row) return;

  // Prefer the UUID captured at apply time; fall back to reading it off fresh state.
  let discountCodeId = (row.discount_code_id as string | null) ?? null;
  if (!discountCodeId) {
    const fresh = await seal.getSubscriptionById(Number(sealSubId));
    discountCodeId = fresh ? findAppliedDiscountCodeId(fresh, row.code as string) : null;
  }

  const markRemoved = () =>
    sb
      .from("retention_discounts")
      .update({ status: "removed", removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("customer_id", row.customer_id);

  if (!discountCodeId) {
    // No UUID found at item level. Either the code is genuinely gone (Shopify
    // 1-cycle limit dropped it / a prior run removed it) OR it carried over
    // INVISIBLY after an item swap (Seal gotcha: absent from
    // item.discount_codes but still discounting the sub — audit 2026-07-06).
    // Closing the row blindly in the second case makes the 15% recur forever
    // with nothing left to retry. Only close once the row is old enough that
    // the 1-cycle limit has certainly consumed the code (~1 billing cycle);
    // until then keep it pending so the next charge retries the lookup.
    const appliedAt = row.applied_at ? new Date(row.applied_at as string).getTime() : 0;
    const CLOSE_AFTER_MS = 35 * 24 * 60 * 60 * 1000;
    if (Date.now() - appliedAt > CLOSE_AFTER_MS) {
      await markRemoved();
      console.log("[seal-webhook] retention discount absent + row aged out, marked removed", { sealSubId });
    } else {
      console.warn(
        "[seal-webhook] retention discount UUID not found but row is recent — keeping pending_charge (possible invisible carry-over, will retry next charge)",
        { sealSubId, code: row.code },
      );
    }
    return;
  }

  try {
    await seal.removeDiscountCode(Number(sealSubId), discountCodeId);
    await markRemoved();
    console.log("[seal-webhook] retention discount removed after first charge", { sealSubId });
  } catch (e) {
    console.error("[seal-webhook] retention discount removal failed (will retry next charge)", {
      sealSubId,
      msg: e instanceof Error ? e.message : String(e),
    });
    // Leave pending_charge: retry on the next billing_attempt.succeeded.
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
  await sb.from("subscriptions").upsert(
    {
      customer_id: customerId,
      seal_subscription_id: String(s.id),
      box_count: mapped.boxCount,
      frequency: normalizeFrequency(s.delivery_interval),
      flavor: mapped.flavor,
      next_ship_date: mapped.nextShipDate,
      next_box_number: mapped.nextBoxNumber,
      status: mapStatus(s),
      updated_at: new Date().toISOString(),
    },
    // Multi-sub: one cache row per (customer, sub) — composite matches the
    // subscriptions PK after the flip, so each sub's webhook upserts its own row.
    { onConflict: "customer_id,seal_subscription_id" },
  );
}

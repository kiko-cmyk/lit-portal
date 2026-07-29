import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { klaviyo } from "@/lib/klaviyo";
import { enforceRateLimit } from "@/lib/rate-limit";
import { seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { supabaseAdmin } from "@/lib/supabase";

interface ResumeResponse {
  resumed: boolean;
  sealSubscriptionId: string;
}

/**
 * POST /apps/portal/api/subscription/resume
 *
 * Bring a PAUSED subscription back to ACTIVE.
 *
 * WHY THIS EXISTS (2026-07-28)
 * ----------------------------
 * 86 subscriptions sit in PAUSED, every one of them paused by the customer
 * inside Seal's own portal (Seal's `log`: "Customer paused the subscription").
 * Our portal had no way back:
 *   - the Hub only ever selected `status === "ACTIVE"`, with a fallback to
 *     CANCELLED, so a paused customer fell through to a 404 and was shown the
 *     "buy a subscription" empty state — the orphan-sub pattern that makes
 *     people buy a SECOND subscription;
 *   - /api/subscription/reactivate is cancel-shaped: it requires
 *     cancel_count === 1 and a last_cancelled_at inside the 90-day window, and a
 *     paused customer has neither, so it 400s with `no_cancellation`.
 * The only working resume button in existence was the one in Seal's portal,
 * which is exactly where we don't want customers. Hence a separate route.
 *
 * Deliberately NOT reusing /reactivate: reactivation restores a Drops snapshot
 * and lives inside the cancel accounting (cancel_count, cancellations rows). A
 * pause never touched any of that, so resuming must not either.
 */
export const POST = withCustomer<ResumeResponse>(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "resume", { limit: 5, windowMs: 60_000 });

  const url = new URL(req.url);
  const devEmail =
    process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) {
    throw new ApiHttpError(
      404,
      "customer_not_found",
      `No email for Shopify customer ${ctx.customerId}`,
    );
  }

  const body = (await req.json().catch(() => ({}))) as { sealSubscriptionId?: number | string };
  const subSel = url.searchParams.get("seal_subscription_id") ?? body.sealSubscriptionId;

  // Full email scan on purpose: resolveActiveSubFast filters on ACTIVE, so it
  // can never resolve the very sub we're here to fix. Resuming is a
  // once-per-customer action, so the slow path is the right trade.
  const subs = await seal.getSubscriptionsByEmail(email);
  // Status ONLY, never `paused_on`. Probed against Seal 2026-07-29 on sub
  // 14692586: `resume` DOES clear paused_on, but a sub that goes PAUSED ->
  // CANCELLED keeps it forever. Two such subs exist today (6851511 and 5978121,
  // both paused and then cancelled within two minutes back in 2025), and treating
  // them as resumable would let a CANCELLED customer come back through here and
  // skip everything /reactivate enforces: cancel_count, the 90-day window, and
  // the Drops restore.
  const isPaused = (s: SealSubscription) => s.status === "PAUSED";

  let sub: SealSubscription | null = null;
  if (subSel) {
    // Requested-but-unresolved must 404, never fall back to another sub (same
    // policy as every other route since the 2026-07-06 audit).
    const requested = subs.find((s) => String(s.id) === String(subSel));
    if (!requested) {
      throw new ApiHttpError(404, "subscription_not_found", `No subscription ${subSel}`);
    }
    if (!isPaused(requested)) {
      throw new ApiHttpError(
        400,
        "subscription_not_paused",
        `Subscription ${subSel} is ${requested.status}, not paused`,
      );
    }
    sub = requested;
  } else {
    sub = subs.find(isPaused) ?? null;
  }
  if (!sub) {
    throw new ApiHttpError(400, "subscription_not_paused", "No paused subscription to resume");
  }
  assertSubscriptionBelongsToCustomer(sub, email, "subscription/resume");

  await seal.resumeSubscription(sub.id);

  // Optimistic cache flip. Seal fires subscription/resumed (now handled in the
  // webhook) which reconciles this for real; without it the cache would read
  // 'paused' until then and anything reading it would disagree with what the
  // customer just did. 'active' is in the status CHECK (schema.sql:31).
  //
  // Scoped by seal_subscription_id ALONE, deliberately, even though the table's
  // PK is (customer_id, seal_subscription_id): there is also a standalone UNIQUE
  // on seal_subscription_id, so this can only ever hit one row, and if that row
  // happens to be homed to a different customer (the checkout-email-typo
  // reassignment the webhook handles by re-homing) we still want it corrected
  // rather than silently left at 'paused'. Ownership was already asserted against
  // Seal above, which is the real gate.
  const sb = supabaseAdmin();
  const { error: cacheErr } = await sb
    .from("subscriptions")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("seal_subscription_id", String(sub.id));
  if (cacheErr) {
    // Non-fatal: Seal is the source of truth and the webhook will fix the cache.
    console.warn("[resume] cache flip failed (non-fatal):", cacheErr.message);
  }

  klaviyo
    .trackEvent("subscription_resumed", email, {
      sealSubscriptionId: String(sub.id),
      pausedOn: sub.paused_on || null,
    })
    .catch((err) => console.warn("[resume] klaviyo event failed:", err));

  return { resumed: true, sealSubscriptionId: String(sub.id) };
});

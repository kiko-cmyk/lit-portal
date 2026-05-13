import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { klaviyo } from "@/lib/klaviyo";
import { seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { supabaseAdmin } from "@/lib/supabase";

const HOLD_DAYS = 90;

/**
 * POST /apps/portal/api/subscription/reactivate
 *
 * Allowed if:
 *   - cancel_count === 1 (already cancelled once but never twice)
 *   - within 90 days of last_cancelled_at
 *
 * Restores Drops balance from the snapshot (cancellations.drops_held_at_cancel)
 * by inserting a positive drops_event so the trigger recomputes the balance.
 *
 * No cooldown (per locked decision 2026-04-27 — same-day reactivation OK).
 */
export const POST = withCustomer(async (req, ctx) => {
  const sb = supabaseAdmin();

  const { data: prefs } = await sb
    .from("customer_preferences")
    .select("cancel_count, last_cancelled_at")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  if (!prefs || !prefs.last_cancelled_at) {
    throw new ApiHttpError(400, "no_cancellation", "No prior cancellation to reactivate from");
  }
  if (prefs.cancel_count > 1) {
    throw new ApiHttpError(410, "second_cancel_no_reactivation", "Already cancelled twice — Drops were reset");
  }

  const cancelledAt = new Date(prefs.last_cancelled_at).getTime();
  if (Date.now() - cancelledAt > HOLD_DAYS * 24 * 60 * 60 * 1000) {
    throw new ApiHttpError(410, "reactivation_window_expired", "Beyond 90-day hold window");
  }

  // Resolve email + sub
  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) throw new ApiHttpError(404, "customer_not_found", "");

  const subs = await seal.getSubscriptionsByEmail(email);
  // Find the most recent subscription (cancelled or otherwise) for this customer
  const sub = subs.sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0];
  if (!sub) throw new ApiHttpError(404, "subscription_not_found", "");
  assertSubscriptionBelongsToCustomer(sub, email, "subscription/reactivate");

  // Reactivate in Seal — Seal asynchronously regenerates billing_attempts
  await seal.reactivateSubscription(sub.id);

  // Restore Drops balance: read snapshot from cancellations row
  const { data: lastCancel } = await sb
    .from("cancellations")
    .select("drops_held_at_cancel, id")
    .eq("customer_id", ctx.customerId)
    .eq("status", "confirmed")
    .order("confirmed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const heldBalance = lastCancel?.drops_held_at_cancel ?? 0;
  if (heldBalance > 0) {
    // Read current balance to compute delta (in case partial activity happened)
    const { data: bal } = await sb
      .from("drops_balances")
      .select("balance")
      .eq("customer_id", ctx.customerId)
      .maybeSingle();
    const currentBalance = bal?.balance ?? 0;
    const restore = heldBalance - currentBalance;
    if (restore > 0) {
      await sb.from("drops_events").insert({
        customer_id: ctx.customerId,
        action: "manual_adjustment",
        amount: restore,
        metadata: { reason: "reactivation_restore", cancellationId: lastCancel?.id },
      });
    }
  }

  klaviyo
    .trackEvent("subscription_reactivated", email, {
      sealSubscriptionId: String(sub.id),
      dropsRestored: heldBalance,
    })
    .catch((err) => console.warn("[reactivate] klaviyo event failed:", err));

  return {
    reactivated: true,
    sealSubscriptionId: String(sub.id),
    dropsRestored: heldBalance,
  };
});

import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { enforceRateLimit } from "@/lib/rate-limit";
import { seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { resolveActiveSubFast } from "@/lib/sub-resolve";

// POST /apps/portal/api/subscription/skip/undo
// Reverts the most recent skip on the customer's active subscription.
// Allowed while we're still before the cutoff window of the originally-skipped
// date.
export const POST = withCustomer(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "skip-undo", { limit: 10, windowMs: 60_000 });

  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) {
    throw new ApiHttpError(404, "customer_not_found", `No email for Shopify customer ${ctx.customerId}`);
  }

  let sub: SealSubscription | null = await resolveActiveSubFast(ctx.customerId, email);
  if (!sub) {
    const subs = await seal.getSubscriptionsByEmail(email);
    sub = subs.find((s) => s.status === "ACTIVE") ?? null;
  }
  if (!sub) throw new ApiHttpError(404, "subscription_not_found", `No active subscription for ${email}`);
  assertSubscriptionBelongsToCustomer(sub, email, "subscription/skip/undo");

  // Find the most recent skipped attempt
  const skipped = (sub.billing_attempts ?? [])
    .filter((ba) => ba.skipped_on)
    .sort((a, b) => (b.skipped_on ?? "").localeCompare(a.skipped_on ?? ""))[0];

  if (!skipped) {
    throw new ApiHttpError(400, "no_skip_to_undo", "No skipped attempt found");
  }

  // Don't resurrect a charge that's already past or inside the 24h cutoff:
  // un-skipping it would re-queue an imminent/overdue attempt (unexpected
  // charge). isWithinCutoff is true when now >= date-24h, i.e. also for past
  // dates. Undo is only valid while safely before the originally-skipped date.
  if (isWithinCutoff(skipped.date)) {
    throw new ApiHttpError(
      409,
      "skip_undo_expired",
      "This order's date has passed — it can no longer be un-skipped.",
    );
  }

  await seal.unskipBillingAttempt(skipped.id, sub.id);

  return { undone: true, status: "active" };
});

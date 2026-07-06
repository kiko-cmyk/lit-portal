import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { mapToSubscription, seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { resolveActiveSubFast } from "@/lib/sub-resolve";
import type { Subscription } from "@/lib/types";

// GET /apps/portal/api/subscription
// Resolves the customer's email via Shopify Admin, then queries Seal for their
// active subscription and maps it to the portal contract.
export const GET = withCustomer<Subscription>(async (_req, ctx) => {
  // Dev bypass: allow ?__dev_email= to skip the Shopify Admin roundtrip
  const url = new URL(_req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  // Multi-sub: an explicit selection from the selector. Optional; absent → auto-pick.
  const requestedSubId = url.searchParams.get("seal_subscription_id");

  let email = devEmail;
  if (!email) {
    email = await shopifyAdmin.getCustomerEmail(ctx.customerId);
  }
  if (!email) {
    throw new ApiHttpError(404, "customer_not_found", `No email for Shopify customer ${ctx.customerId}`);
  }

  // Fast-path: resolve via the cached Seal id (1 quick call). Falls back to
  // the full email scan on a cache miss.
  let pick: SealSubscription | null = await resolveActiveSubFast(ctx.customerId, email, requestedSubId);
  // Explicit sub requested but not resolvable/owned → 404. Never silently fall
  // back to a different subscription than the one selected.
  if (!pick && requestedSubId) {
    throw new ApiHttpError(404, "subscription_not_found", `No subscription ${requestedSubId} for ${email}`);
  }
  if (!pick) {
    const subs = await seal.getSubscriptionsByEmail(email);
    // Pick the most relevant subscription:
    //   1. ACTIVE one with the soonest next ship date
    //   2. otherwise the most recent (by order_placed)
    const active = subs.filter((s) => s.status === "ACTIVE");
    pick =
      active.sort((a, b) => {
        const aNext = a.billing_attempts.find((ba) => !ba.completed_at && !ba.status && !ba.skipped_on)?.date ?? "";
        const bNext = b.billing_attempts.find((ba) => !ba.completed_at && !ba.status && !ba.skipped_on)?.date ?? "";
        return aNext.localeCompare(bNext);
      })[0] ??
      subs.sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0] ??
      null;
  }

  if (!pick) {
    throw new ApiHttpError(404, "subscription_not_found", `No subscription for ${email}`);
  }
  assertSubscriptionBelongsToCustomer(pick, email, "subscription:GET");

  return mapToSubscription(pick, ctx.customerId);
});

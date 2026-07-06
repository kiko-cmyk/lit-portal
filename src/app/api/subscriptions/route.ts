import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { getNextBillingAttempt, mapToSubscription, seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import type { Subscription } from "@/lib/types";

// GET /apps/portal/api/subscriptions  (PLURAL)
//
// Returns ALL of the customer's manageable subscriptions (ACTIVE or scheduled to
// cancel), mapped to the portal contract, soonest-ship first. Foundation for the
// multi-subscription selector.
//
// Multi-sub F2 — ADDITIVE + INVISIBLE: nothing renders this yet. The singular
// GET /api/subscription and every mutation route are unchanged, so single-sub
// behaviour is untouched. The selector (F3b) will consume this and only render
// when `subscriptions.length > 1`.
export const GET = withCustomer<{ subscriptions: Subscription[] }>(async (req, ctx) => {
  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) {
    throw new ApiHttpError(404, "customer_not_found", `No email for Shopify customer ${ctx.customerId}`);
  }

  const subs = await seal.getSubscriptionsByEmail(email);

  const manageable = subs.filter((s) => {
    if (s.status !== "ACTIVE" && !s.cancellation_scheduled_for) return false;
    // Defence-in-depth: only ever return subs that belong to this email.
    try {
      assertSubscriptionBelongsToCustomer(s, email, "subscriptions:GET");
      return true;
    } catch {
      return false;
    }
  });

  // Soonest next charge first; subs with no pending attempt sink to the bottom.
  manageable.sort((a, b) => {
    const an = getNextBillingAttempt(a)?.date ?? "9999-12-31";
    const bn = getNextBillingAttempt(b)?.date ?? "9999-12-31";
    return an.localeCompare(bn);
  });

  return { subscriptions: manageable.map((s) => mapToSubscription(s, ctx.customerId)) };
});

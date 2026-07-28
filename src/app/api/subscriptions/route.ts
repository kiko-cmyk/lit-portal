import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getNextBillingAttempt, mapToSubscription, seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import type { Subscription } from "@/lib/types";

// GET /apps/portal/api/subscriptions  (PLURAL)
//
// Returns ALL of the customer's manageable subscriptions (ACTIVE or scheduled to
// cancel), mapped to the portal contract, soonest-ship first. Consumed by
// SubscriptionGate/SubscriptionChooser, which show the first-screen chooser only
// when this returns >1 — so single-sub customers (1 result) see nothing.
export const GET = withCustomer<{ subscriptions: Subscription[] }>(async (req, ctx) => {
  // Only authed route without a rate limit until the audit (2026-07-06): every
  // hit costs a Shopify Admin + a Seal call. Generous cap — the gate calls it
  // once per entry and the chooser once per switch; only a hammering loop
  // (stuck retry, script) gets clipped. The FE treats 429 as retryable.
  await enforceRateLimit(ctx.customerId, "subscriptions-list", { limit: 20, windowMs: 60_000 });
  // Open to all: getSubscriptionsByEmail is a single email-scoped Seal call
  // (total_pages=1), so this is cheap per portal session. Single-sub customers
  // get 1 back → the chooser stays hidden; multi-sub customers get >1 → chooser.
  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) {
    throw new ApiHttpError(404, "customer_not_found", `No email for Shopify customer ${ctx.customerId}`);
  }

  const subs = await seal.getSubscriptionsByEmail(email);

  const manageable = subs.filter((s) => {
    // PAUSED counts as manageable (2026-07-28). Without it, 18 of the 86 paused
    // subscriptions were unreachable: their owner ALSO has an active sub, so the
    // Hub's selection picks the active one (correctly, it prefers ACTIVE) and the
    // chooser never listed the paused one, leaving no way to reach the resume
    // card. That is 21% of the population this whole change exists to serve.
    // Status only, never `paused_on`: Seal never clears that timestamp, so
    // paused-then-cancelled subs still carry it.
    if (s.status !== "ACTIVE" && s.status !== "PAUSED" && !s.cancellation_scheduled_for) return false;
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

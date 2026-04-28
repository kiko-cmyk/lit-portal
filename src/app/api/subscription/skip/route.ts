import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { getNextBillingAttempt, seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import type { SkipResponse } from "@/lib/types";

// POST /apps/portal/api/subscription/skip
// Skips the next pending billing attempt of the customer's active subscription.
// Enforces 72h cutoff. After skip, the new "next" becomes the attempt after
// the skipped one — surfaced in newNextShipDate.
export const POST = withCustomer<SkipResponse>(async (req, ctx) => {
  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) {
    throw new ApiHttpError(404, "customer_not_found", `No email for Shopify customer ${ctx.customerId}`);
  }

  const subs = await seal.getSubscriptionsByEmail(email);
  const sub = subs.find((s) => s.status === "ACTIVE");
  if (!sub) throw new ApiHttpError(404, "subscription_not_found", `No active subscription for ${email}`);

  const next = getNextBillingAttempt(sub);
  if (!next) throw new ApiHttpError(400, "no_pending_attempt", "Subscription has no upcoming billing attempt");

  if (isWithinCutoff(next.date)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot skip within 72h of next ship");
  }

  await seal.skipBillingAttempt(next.id, sub.id);

  // Re-fetch to compute the post-skip next ship date (Seal regenerates attempts;
  // see reference_seal_api.md). Fresh GET avoids stale state.
  const refreshed = await seal.getSubscription(sub.id);
  const newNext = refreshed ? getNextBillingAttempt(refreshed) : null;

  // Undo window: until the new cutoff (72h before the kept attempt), or until
  // the original attempt date — whichever comes first.
  const undoExpiresAt = newNext?.date ?? next.date;

  return {
    skipped: true,
    newNextShipDate: newNext?.date ?? next.date,
    undoExpiresAt,
  };
});

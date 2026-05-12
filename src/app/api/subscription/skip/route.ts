import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { klaviyo } from "@/lib/klaviyo";
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

  // Compute the post-skip next ship date locally instead of re-fetching.
  // Seal has eventual consistency on billing-attempt mutations — a GET fired
  // immediately after PUT can return stale data showing the just-skipped
  // attempt as still pending. Local computation is exact: we know `next.id`
  // is now skipped, so the next non-skipped attempt is the right answer.
  const remainingAttempts = (sub.billing_attempts ?? []).map((a) =>
    a.id === next.id ? { ...a, skipped_on: new Date().toISOString() } : a,
  );
  const newNext = remainingAttempts.find(
    (a) => !a.completed_at && !a.status && !a.skipped_on,
  ) ?? null;

  // Undo window: until the new cutoff (72h before the kept attempt), or until
  // the original attempt date — whichever comes first.
  const undoExpiresAt = newNext?.date ?? next.date;

  // Fire Klaviyo event so the flow (if configured) can react.
  klaviyo
    .trackEvent("subscription_skip", email, {
      newNextShipDate: newNext?.date ?? next.date,
      sealSubscriptionId: String(sub.id),
    })
    .catch((err) => console.warn("[skip] klaviyo event failed:", err));

  return {
    skipped: true,
    newNextShipDate: newNext?.date ?? next.date,
    undoExpiresAt,
  };
});

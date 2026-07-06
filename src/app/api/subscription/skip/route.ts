import { ApiHttpError, isDryRunRequest, withCustomer } from "@/lib/api-helpers";
import { klaviyo } from "@/lib/klaviyo";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getNextBillingAttempt, seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { verifyOwnershipFast } from "@/lib/sub-ownership";
import { pickRequestedSub, requestedSubIdFrom } from "@/lib/sub-resolve";
import type { SkipResponse } from "@/lib/types";

// POST /apps/portal/api/subscription/skip
// Skips the next pending billing attempt of the customer's active subscription.
// After skip, the new "next" becomes the attempt after the skipped one —
// surfaced in newNextShipDate.
//
// NO 24h cutoff (removed 2026-06-15, Juan): the billing-attempt date is the
// CHARGE/order-generation moment, not the ship date, so the customer should be
// able to skip right up until Seal actually charges. The real guard is now
// Seal itself — if the attempt has already started processing/charged, Seal
// rejects the skip and we surface `already_charged`. The 24h cutoff still
// applies to plan/flavor/address/extras (see lib/cutoff.ts), which need
// operator lead time; skip does not.
//
// Body (optional): { sealSubscriptionId } — when present, takes the fast-path
// (Supabase ownership + targeted Seal GET) and skips the 33-page pagination
// scan. Added 2026-05-21 after Juan reported first-click skip from Cuenta
// failing on cold start — the slow path was bumping into Vercel/proxy timeouts.
export const POST = withCustomer<SkipResponse>(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "skip", { limit: 10, windowMs: 60_000 });

  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;

  const body = (await req.json().catch(() => ({}))) as {
    sealSubscriptionId?: number | string;
    /** Skip retention flow: why the customer is skipping (for Klaviyo). */
    reason?: string;
    freeText?: string;
    /** Simulación: compute the result without calling Seal/Klaviyo. */
    dryRun?: boolean;
  };
  const dryRun = isDryRunRequest(req, body);

  let sub: SealSubscription | null = null;
  let email: string | null = null;

  const requestedSubId = requestedSubIdFrom(req, body.sealSubscriptionId);
  if (requestedSubId) {
    const owns = await verifyOwnershipFast(Number(requestedSubId), ctx.customerId);
    if (owns) {
      sub = await seal.getSubscriptionById(Number(requestedSubId));
      if (sub) {
        email = sub.email ?? null;
        assertSubscriptionBelongsToCustomer(sub, email ?? "", "subscription/skip:fast");
      }
    }
  }

  if (!sub) {
    email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
    if (!email) {
      throw new ApiHttpError(404, "customer_not_found", `No email for Shopify customer ${ctx.customerId}`);
    }
    const subs = await seal.getSubscriptionsByEmail(email);
    // Multi-sub: never skip a DIFFERENT sub than the one requested — resolve
    // the requested id from the email-scoped list, or 404.
    sub = pickRequestedSub(subs, requestedSubId);
    if (!sub) throw new ApiHttpError(404, "subscription_not_found", `No active subscription for ${email}`);
    assertSubscriptionBelongsToCustomer(sub, email, "subscription/skip");
  }
  if (!email) email = sub.email ?? null;
  if (!email) throw new ApiHttpError(404, "customer_not_found", "");

  const next = getNextBillingAttempt(sub);
  if (!next) throw new ApiHttpError(400, "no_pending_attempt", "Subscription has no upcoming billing attempt");

  // Dry-run ("simulación"): compute the post-skip next date locally and return,
  // without touching Seal or firing the Klaviyo event. Honoured only in non-prod
  // (api-helpers.dryRunAllowed). Mirrors the local computation done below.
  if (dryRun) {
    const remaining = (sub.billing_attempts ?? []).map((a) =>
      a.id === next.id ? { ...a, skipped_on: new Date().toISOString() } : a,
    );
    const newNext =
      remaining
        .filter((a) => !a.completed_at && !a.status && !a.skipped_on && a.date)
        .sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
    return {
      skipped: true,
      newNextShipDate: newNext?.date ?? next.date,
      undoExpiresAt: newNext?.date ?? next.date,
    };
  }

  try {
    await seal.skipBillingAttempt(next.id, sub.id);
  } catch (err) {
    // With the 24h cutoff gone, the only remaining guard is the race where
    // Seal charged this attempt between our read above and this call (or it's
    // already processing). Seal rejects the skip → surface a clear code so the
    // UI tells the customer the order is already on its way instead of a 500.
    console.warn(`[skip] seal rejected skip for sub ${sub.id} attempt ${next.id}:`, err);
    throw new ApiHttpError(409, "already_charged", "This order is already being processed and can no longer be skipped.");
  }

  // Compute the post-skip next ship date locally instead of re-fetching.
  // Seal has eventual consistency on billing-attempt mutations — a GET fired
  // immediately after PUT can return stale data showing the just-skipped
  // attempt as still pending. Local computation is exact: we know `next.id`
  // is now skipped, so the next non-skipped attempt is the right answer.
  const remainingAttempts = (sub.billing_attempts ?? []).map((a) =>
    a.id === next.id ? { ...a, skipped_on: new Date().toISOString() } : a,
  );
  // EARLIEST pending attempt by date — Seal doesn't guarantee chronological
  // array order, so sort rather than trust .find() (matches getNextBillingAttempt).
  const newNext =
    remainingAttempts
      .filter((a) => !a.completed_at && !a.status && !a.skipped_on && a.date)
      .sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;

  // Undo window: until the new cutoff (24h before the kept attempt), or until
  // the original attempt date — whichever comes first.
  const undoExpiresAt = newNext?.date ?? next.date;

  // Fire Klaviyo event so the flow (if configured) can react.
  klaviyo
    .trackEvent("subscription_skip", email, {
      newNextShipDate: newNext?.date ?? next.date,
      sealSubscriptionId: String(sub.id),
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.freeText ? { freeText: body.freeText } : {}),
    })
    .catch((err) => console.warn("[skip] klaviyo event failed:", err));

  return {
    skipped: true,
    newNextShipDate: newNext?.date ?? next.date,
    undoExpiresAt,
  };
});

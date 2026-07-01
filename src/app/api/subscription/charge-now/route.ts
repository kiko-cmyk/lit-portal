import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { klaviyo } from "@/lib/klaviyo";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  getNextBillingAttempt,
  isChargeAlreadyScheduledError,
  normalizeFrequency,
  seal,
  type SealSubscription,
} from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { verifyOwnershipFast } from "@/lib/sub-ownership";
import type { ChargeNowResponse, Frequency } from "@/lib/types";

// POST /apps/portal/api/subscription/charge-now
//
// "Adelantar mi pedido": charges the customer's active subscription RIGHT
// NOW and resets the billing schedule from today (Seal
// /subscription-create-charge-now with reset_schedule). The next order moves
// to ~today + one cycle.
//
// This is a real, immediate card charge — tighter rate limit than skip, and
// the customer explicitly confirms in the overlay before this fires.
//
// Body (optional): { sealSubscriptionId } — fast-path (Supabase ownership +
// targeted Seal GET), same optimisation as skip/plan to dodge the 33-page
// pagination scan on cold starts.
export const POST = withCustomer<ChargeNowResponse>(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "charge-now", { limit: 5, windowMs: 60_000 });

  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;

  const body = (await req.json().catch(() => ({}))) as {
    sealSubscriptionId?: number | string;
  };

  let sub: SealSubscription | null = null;
  let email: string | null = null;

  if (body.sealSubscriptionId !== undefined) {
    const owns = await verifyOwnershipFast(Number(body.sealSubscriptionId), ctx.customerId);
    if (owns) {
      sub = await seal.getSubscriptionById(Number(body.sealSubscriptionId));
      if (sub) {
        email = sub.email ?? null;
        assertSubscriptionBelongsToCustomer(sub, email ?? "", "subscription/charge-now:fast");
      }
    }
  }

  if (!sub) {
    email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
    if (!email) {
      throw new ApiHttpError(404, "customer_not_found", `No email for Shopify customer ${ctx.customerId}`);
    }
    const subs = await seal.getSubscriptionsByEmail(email);
    sub = subs.find((s) => s.status === "ACTIVE") ?? null;
    if (!sub) throw new ApiHttpError(404, "subscription_not_found", `No active subscription for ${email}`);
    assertSubscriptionBelongsToCustomer(sub, email, "subscription/charge-now");
  }
  if (!email) email = sub.email ?? null;
  if (!email) throw new ApiHttpError(404, "customer_not_found", "");

  if (sub.status !== "ACTIVE") {
    throw new ApiHttpError(400, "subscription_not_active", "Subscription is not active");
  }

  // If the next order is already inside the 24h ship window, there's nothing
  // to bring forward — block it the same way skip/plan do.
  const next = getNextBillingAttempt(sub);
  if (next && isWithinCutoff(next.date)) {
    throw new ApiHttpError(400, "cutoff_passed", "Next order already ships within 24h");
  }

  // Charge now + reset the schedule so the cadence re-anchors on today.
  try {
    await seal.chargeNow(sub.id, { resetSchedule: true });
  } catch (err) {
    // Seal refuses a second charge while one is already queued ("…already has
    // an attempt scheduled for processing. Try again in 15 minutes."). That's
    // an expected, transient condition — a charge is already in flight for
    // this subscription and re-charging would risk a double charge. Surface it
    // as a typed 409 so the customer gets a calm "already processing" message
    // instead of a scary 500, and so `withCustomer` returns it WITHOUT firing
    // an `internal_error` P0 in #n8n-errors. Any other Seal failure (card
    // declined, real 503 outage, etc.) still bubbles up as a genuine alert.
    if (isChargeAlreadyScheduledError(err)) {
      throw new ApiHttpError(
        409,
        "charge_already_scheduled",
        "A charge for this subscription is already being processed. Try again in a few minutes.",
      );
    }
    throw err;
  }

  // Best-effort estimate of the new next ship date (today + one cycle) for
  // instant UI feedback. Seal regenerates billing_attempts asynchronously,
  // so the authoritative date arrives via the FE silent re-poll.
  const frequency = normalizeFrequency(sub.delivery_interval);
  const newNextShipDate = estimateNextShipDate(frequency).toISOString();

  klaviyo
    .trackEvent("subscription_charge_now", email, {
      newNextShipDate,
      sealSubscriptionId: String(sub.id),
    })
    .catch((err) => console.warn("[charge-now] klaviyo event failed:", err));

  return { charged: true, newNextShipDate };
});

/**
 * Add one subscription cycle to today. Used only for the optimistic next-ship
 * estimate shown right after a charge; the real value is reconciled by the
 * Hub's silent re-poll once Seal finishes rebuilding the schedule.
 */
function estimateNextShipDate(frequency: Frequency, from = new Date()): Date {
  const d = new Date(from);
  switch (frequency) {
    case "15d":
      d.setDate(d.getDate() + 15);
      break;
    case "45d":
      d.setDate(d.getDate() + 45);
      break;
    case "1mo":
      d.setMonth(d.getMonth() + 1);
      break;
    case "2mo":
      d.setMonth(d.getMonth() + 2);
      break;
    case "3mo":
      d.setMonth(d.getMonth() + 3);
      break;
    case "4mo":
      d.setMonth(d.getMonth() + 4);
      break;
    case "5mo":
      d.setMonth(d.getMonth() + 5);
      break;
    case "6mo":
      d.setMonth(d.getMonth() + 6);
      break;
  }
  return d;
}

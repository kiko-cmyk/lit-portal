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
import { pickRequestedSub, requestedSubIdFrom } from "@/lib/sub-resolve";
import { supabaseAdmin } from "@/lib/supabase";
import type { ChargeNowResponse, Frequency } from "@/lib/types";

// Max plausible duration of a chargeNow call — a lock older than this is
// treated as stale (a crashed prior request) and reclaimed.
const CHARGE_LOCK_STALE_MS = 120_000;

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

  const requestedSubId = requestedSubIdFrom(req, body.sealSubscriptionId);
  if (requestedSubId) {
    const owns = await verifyOwnershipFast(Number(requestedSubId), ctx.customerId);
    if (owns) {
      sub = await seal.getSubscriptionById(Number(requestedSubId));
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
    // Multi-sub: never charge a DIFFERENT sub than the one requested — resolve
    // the requested id from the email-scoped list, or 404.
    sub = pickRequestedSub(subs, requestedSubId);
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

  // Idempotency mutex: acquire a per-subscription lock BEFORE calling Seal so
  // two near-simultaneous charge-now requests can't both reach Seal and
  // double-charge. FAIL-OPEN — any lock-infra error just proceeds (Seal's own
  // "already scheduled" guard still applies); the lock can only ADD protection,
  // never block a legitimate charge.
  const sb = supabaseAdmin();
  let lockHeld = false;
  try {
    // Self-heal a stale lock left by a crashed request.
    await sb
      .from("charge_now_locks")
      .delete()
      .eq("seal_subscription_id", sub.id)
      .lt("created_at", new Date(Date.now() - CHARGE_LOCK_STALE_MS).toISOString());
    const { error: lockErr } = await sb
      .from("charge_now_locks")
      .insert({ seal_subscription_id: sub.id, customer_id: ctx.customerId });
    if (lockErr) {
      if ((lockErr as { code?: string }).code === "23505") {
        throw new ApiHttpError(
          409,
          "charge_already_scheduled",
          "A charge for this subscription is already being processed. Try again in a few minutes.",
        );
      }
      console.error("[charge-now] lock acquire failed, proceeding (fail-open):", lockErr.message);
    } else {
      lockHeld = true;
    }
  } catch (e) {
    if (e instanceof ApiHttpError) throw e; // the 409 above
    console.error("[charge-now] lock error, proceeding (fail-open):", e);
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
  } finally {
    // Release the lock (best-effort) so a later legitimate charge isn't blocked.
    // On success, Seal's own "already scheduled" guard covers any request that
    // arrives after this point.
    if (lockHeld) {
      await sb.from("charge_now_locks").delete().eq("seal_subscription_id", sub.id);
    }
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

import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import {
  getNextBillingAttempt,
  mapToSubscription,
  seal,
  type SealBillingAttempt,
  type SealSubscription,
} from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import type { Frequency, Subscription } from "@/lib/types";

const FREQ_TO_HUMAN: Record<Frequency, string> = {
  "15d": "15 days",
  "1mo": "1 month",
  "45d": "45 days",
  "2mo": "2 months",
  "3mo": "3 months",
  "4mo": "4 months",
  "5mo": "5 months",
  "6mo": "6 months",
};

/**
 * Compute the next attempt date by adding the given frequency to a base date.
 * Used to reschedule the chain of future billing attempts when the customer
 * changes their cadence.
 */
function addFrequency(base: Date, freq: Frequency): Date {
  const d = new Date(base.getTime());
  switch (freq) {
    case "15d":
      d.setUTCDate(d.getUTCDate() + 15);
      break;
    case "45d":
      d.setUTCDate(d.getUTCDate() + 45);
      break;
    case "1mo":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "2mo":
      d.setUTCMonth(d.getUTCMonth() + 2);
      break;
    case "3mo":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "4mo":
      d.setUTCMonth(d.getUTCMonth() + 4);
      break;
    case "5mo":
      d.setUTCMonth(d.getUTCMonth() + 5);
      break;
    case "6mo":
      d.setUTCMonth(d.getUTCMonth() + 6);
      break;
  }
  return d;
}

/**
 * PATCH /apps/portal/api/subscription/plan
 *
 * Body: { boxCount?: 1..6, frequency?: Frequency }
 *
 * On frequency change: per Juan (2026-04-27) we MUST reschedule all future
 * pending billing attempts to the new cadence. The first pending attempt's
 * date stays put; subsequent ones get re-spaced by the new interval.
 *
 * Implementation:
 *  1. Validate input + cutoff.
 *  2. Edit subscription via Seal (`action=edit`):
 *     - delivery_interval + billing_interval (if frequency changed)
 *     - main item quantity (if boxCount changed)
 *  3. If frequency changed: re-fetch sub, walk pending attempts in order, and
 *     reschedule each (except the first) to first.date + N × new interval.
 *  4. Return updated subscription.
 *
 * NOT YET tested against prod (per "no toques datos reales" rule). Needs a
 * sandbox / test customer for first end-to-end verification.
 */
export const PATCH = withCustomer<Subscription>(async (req, ctx) => {
  // Auth → resolve email → lookup sub
  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) {
    throw new ApiHttpError(404, "customer_not_found", `No email for ${ctx.customerId}`);
  }

  const body = (await req.json().catch(() => ({}))) as {
    boxCount?: number;
    frequency?: Frequency;
  };

  // Validate
  if (body.boxCount !== undefined && (body.boxCount < 1 || body.boxCount > 6)) {
    throw new ApiHttpError(400, "invalid_box_count", "boxCount must be 1..6");
  }
  if (body.frequency !== undefined && !(body.frequency in FREQ_TO_HUMAN)) {
    throw new ApiHttpError(400, "invalid_frequency", `Unknown frequency: ${body.frequency}`);
  }
  if (body.boxCount === undefined && body.frequency === undefined) {
    throw new ApiHttpError(400, "no_changes", "Provide boxCount and/or frequency");
  }

  const subs = await seal.getSubscriptionsByEmail(email);
  const sub = subs.find((s) => s.status === "ACTIVE");
  if (!sub) throw new ApiHttpError(404, "subscription_not_found", `No active sub for ${email}`);

  const next = getNextBillingAttempt(sub);
  if (next && isWithinCutoff(next.date)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change plan within 72h of next ship");
  }

  // Build edit payload for Seal
  const edits: Record<string, unknown> = {};
  const frequencyChanged = body.frequency !== undefined && FREQ_TO_HUMAN[body.frequency] !== sub.delivery_interval;
  if (frequencyChanged && body.frequency !== undefined) {
    edits.delivery_interval = FREQ_TO_HUMAN[body.frequency];
    edits.billing_interval = FREQ_TO_HUMAN[body.frequency];
  }
  const mainItem = sub.items.find((it) => !it.is_one_time_item) ?? sub.items[0];
  if (body.boxCount !== undefined && mainItem && mainItem.quantity !== body.boxCount) {
    // Best-guess: Seal accepts a partial items update via the variant_id key.
    // To verify on first sandbox test.
    edits.items = [{ id: mainItem.id, quantity: body.boxCount }];
  }

  if (Object.keys(edits).length === 0) {
    // No-op: return current state without hitting Seal
    return mapToSubscription(sub, ctx.customerId);
  }

  await seal.editSubscription(sub.id, edits);

  // If frequency changed, walk and reschedule the chain.
  if (frequencyChanged && body.frequency !== undefined) {
    await rescheduleFutureAttempts(sub.id, body.frequency);
  }

  // Re-fetch fresh state and return
  const refreshed = await seal.getSubscription(sub.id);
  if (!refreshed) {
    throw new ApiHttpError(500, "post_edit_fetch_failed", "Could not re-fetch subscription after edit");
  }
  return mapToSubscription(refreshed, ctx.customerId);
});

/**
 * Walk the pending billing attempts in date order; keep the first; reschedule
 * each subsequent one to (firstDate + N × newFrequency).
 *
 * Per reference_seal_api.md:
 *   - Skipped attempts count for "close to date" validation
 *   - Seal regenerates attempts after reschedule — must re-fetch after each step
 *   - Need date YYYY-MM-DD, time HH:MM, timezone +HH:MM
 *
 * Strategy: refetch the subscription before each iteration so we always operate
 * on Seal's current state (since reschedule mutates the chain).
 */
async function rescheduleFutureAttempts(subscriptionId: number, frequency: Frequency): Promise<void> {
  // First pending = anchor
  let sub: SealSubscription | null = await seal.getSubscription(subscriptionId);
  if (!sub) return;

  let pending: SealBillingAttempt[] = (sub.billing_attempts ?? []).filter(
    (a) => !a.completed_at && !a.status && !a.skipped_on,
  );
  if (pending.length <= 1) return;

  pending = pending.sort((a, b) => a.date.localeCompare(b.date));
  const anchorDate = new Date(pending[0].date);

  for (let i = 1; i < pending.length; i++) {
    const target = addFrequency(anchorDate, frequency);
    // The ith attempt should land at anchor + i × frequency
    let multipliedTarget = new Date(anchorDate.getTime());
    for (let j = 0; j < i; j++) {
      multipliedTarget = addFrequency(multipliedTarget, frequency);
    }
    void target;

    const dateStr = multipliedTarget.toISOString().slice(0, 10);
    try {
      await seal.rescheduleBillingAttempt(pending[i].id, subscriptionId, dateStr, "13:00", "+00:00");
    } catch (err) {
      console.warn(`[plan-reschedule] attempt ${pending[i].id} → ${dateStr} failed:`, err);
      // Continue — Seal may regenerate / reject some. Surface in monitoring.
    }
  }
}

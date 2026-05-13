import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { mapToSubscription, seal, getNextBillingAttempt } from "@/lib/seal";
import { SELLING_PLAN_BY_FREQUENCY, VARIANT_BY_BOX_COUNT } from "@/lib/seal-plans";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import type { Frequency, Subscription } from "@/lib/types";

const VALID_FREQUENCIES: Frequency[] = ["15d", "1mo", "45d", "2mo", "3mo", "4mo", "5mo", "6mo"];

/**
 * PATCH /apps/portal/api/subscription/plan
 *
 * Body: { boxCount?: 1..6, frequency?: Frequency }
 *
 * Strategy: SWAP. Update line item's `variant_id` (if box count changed)
 * and `selling_plan_id` (if frequency changed) in Seal. Seal handles
 * reschedule of upcoming billing attempts natively — no manual reschedule
 * loop required.
 *
 * Pre-requisites:
 * - All 6 variants exist in Shopify (1, 2, 3, 4, 5, 6 boxes)
 * - All 8 selling plans exist in Seal/Shopify (15d, 1mo, 45d, 2mo, 3mo, 4mo, 5mo, 6mo)
 * - IDs hard-mapped in lib/seal-plans.ts
 *
 * Validates 72h cutoff before touching anything.
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
  if (
    body.boxCount !== undefined &&
    (!Number.isInteger(body.boxCount) || body.boxCount < 1 || body.boxCount > 6)
  ) {
    throw new ApiHttpError(400, "invalid_box_count", "boxCount must be integer 1..6");
  }
  if (body.frequency !== undefined && !VALID_FREQUENCIES.includes(body.frequency)) {
    throw new ApiHttpError(400, "invalid_frequency", `Unknown frequency: ${body.frequency}`);
  }
  if (body.boxCount === undefined && body.frequency === undefined) {
    throw new ApiHttpError(400, "no_changes", "Provide boxCount and/or frequency");
  }

  const subs = await seal.getSubscriptionsByEmail(email);
  const sub = subs.find((s) => s.status === "ACTIVE");
  if (!sub) throw new ApiHttpError(404, "subscription_not_found", `No active sub for ${email}`);
  assertSubscriptionBelongsToCustomer(sub, email, "subscription/plan");

  const next = getNextBillingAttempt(sub);
  if (next && isWithinCutoff(next.date)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change plan within 72h of next ship");
  }

  // Locate the main subscription item (skip one-time extras)
  const mainItem = sub.items.find((it) => !it.is_one_time_item) ?? sub.items[0];
  if (!mainItem) {
    throw new ApiHttpError(500, "no_main_item", "Subscription has no main item");
  }

  // Build the patch — only include keys that actually changed
  const itemPatch: { id: number; variant_id?: string; selling_plan_id?: string } = {
    id: mainItem.id,
  };

  if (body.boxCount !== undefined) {
    const newVariantId =
      VARIANT_BY_BOX_COUNT[body.boxCount as 1 | 2 | 3 | 4 | 5 | 6];
    if (!newVariantId) {
      throw new ApiHttpError(500, "variant_not_mapped", `No variant ID for ${body.boxCount} box(es)`);
    }
    if (newVariantId !== mainItem.variant_id) {
      itemPatch.variant_id = newVariantId;
    }
  }

  if (body.frequency !== undefined) {
    const newPlanId = SELLING_PLAN_BY_FREQUENCY[body.frequency];
    if (!newPlanId) {
      throw new ApiHttpError(500, "selling_plan_not_mapped", `No selling plan for ${body.frequency}`);
    }
    if (newPlanId !== mainItem.selling_plan_id) {
      itemPatch.selling_plan_id = newPlanId;
    }
  }

  // Nothing actually changed
  if (!itemPatch.variant_id && !itemPatch.selling_plan_id) {
    return mapToSubscription(sub, ctx.customerId);
  }

  // Fire the swap. Seal recomputes billing/delivery intervals + reschedules
  // future attempts automatically based on the new selling_plan.
  await seal.editSubscription(sub.id, { items: [itemPatch] });

  // Re-fetch fresh state
  const refreshed = await seal.getSubscription(sub.id);
  if (!refreshed) {
    throw new ApiHttpError(500, "post_edit_fetch_failed", "Could not re-fetch subscription after swap");
  }
  return mapToSubscription(refreshed, ctx.customerId);
});

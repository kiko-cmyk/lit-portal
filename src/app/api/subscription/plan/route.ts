import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { mapToSubscription, normalizeFrequency, seal } from "@/lib/seal";
import { resolveSubIds } from "@/lib/seal-mapping";
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
 * Rewrite 2026-05-14: mutates via Seal Merchant API using `add_items +
 * remove_items` (confirmed by Seal support as the only API path for swapping
 * a subscription's products). Prior attempt to mutate Shopify contracts
 * directly was blocked by the `_own` scope limitation — our app cannot see
 * Seal-owned contracts.
 *
 * Order of operations:
 *   1. add_items(new variant)  — must come FIRST. If it fails we abort
 *      cleanly with the sub still containing the original item.
 *   2. remove_items(old item)  — only runs after add succeeds.
 *   3. (optional) edit { delivery_interval } when frequency changed —
 *      Seal stores cadence at the subscription level too, separate from
 *      each item's selling_plan_id.
 *
 * Open questions to validate empirically:
 *   - Does add_items respect selling_plan_id, or does Seal force the new
 *     item to inherit the sub's existing cadence?
 *   - Does Seal's `edit` with delivery_interval actually mutate, or is it
 *     the same silent no-op we saw on item edits?
 */
export const PATCH = withCustomer<Subscription>(async (req, ctx) => {
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

  const ids = await resolveSubIds(ctx.customerId, email);
  if (!ids) {
    throw new ApiHttpError(404, "subscription_not_found", `No active subscription for ${email}`);
  }

  const sealSub = await seal.getSubscription(ids.sealSubscriptionId);
  if (!sealSub) {
    throw new ApiHttpError(404, "seal_sub_not_found", `Seal sub ${ids.sealSubscriptionId} not found`);
  }
  assertSubscriptionBelongsToCustomer(sealSub, email, "subscription/plan");

  // Pick the main subscription line (non-one-time item)
  const mainItem = sealSub.items.find((it) => !it.is_one_time_item) ?? sealSub.items[0];
  if (!mainItem) {
    throw new ApiHttpError(500, "no_main_line", "Seal subscription has no items");
  }

  // Cutoff against next billing attempt date
  const nextAttempt = (sealSub.billing_attempts ?? []).find(
    (ba) => !ba.completed_at && !ba.status && !ba.skipped_on,
  );
  if (nextAttempt?.date && isWithinCutoff(nextAttempt.date)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change plan within 72h of next ship");
  }

  // Resolve target variant + frequency + detect what actually changed.
  // Important: we always WRITE the canonical selling_plan_id for the target
  // frequency (legacy IDs may not be associated with the new variant —
  // Seal then silently swaps to an arbitrary plan it considers valid).
  const targetBoxCount = body.boxCount ?? null;
  const currentFrequency = normalizeFrequency(sealSub.delivery_interval);
  const targetFrequency = body.frequency ?? currentFrequency;

  const newVariantNumeric = targetBoxCount
    ? VARIANT_BY_BOX_COUNT[targetBoxCount as 1 | 2 | 3 | 4 | 5 | 6]
    : null;
  if (targetBoxCount && !newVariantNumeric) {
    throw new ApiHttpError(500, "variant_not_mapped", `No variant for ${targetBoxCount} box(es)`);
  }
  const targetSellingPlanNumeric = SELLING_PLAN_BY_FREQUENCY[targetFrequency];
  if (!targetSellingPlanNumeric) {
    throw new ApiHttpError(500, "selling_plan_not_mapped", `No selling plan for ${targetFrequency}`);
  }

  const variantChanged = newVariantNumeric !== null && newVariantNumeric !== mainItem.variant_id;
  const planChanged = body.frequency !== undefined && body.frequency !== currentFrequency;

  if (!variantChanged && !planChanged) {
    return mapToSubscription(sealSub, ctx.customerId);
  }

  // Build the new item we'll add. The variant is either the requested new
  // one OR the existing one (when only the cadence is changing).
  const effectiveVariantNumeric = variantChanged ? newVariantNumeric! : mainItem.variant_id;
  const variantDetails = await shopifyAdmin.getVariantForSealAddItems(effectiveVariantNumeric);
  if (!variantDetails) {
    throw new ApiHttpError(500, "variant_lookup_failed", `Shopify has no variant ${effectiveVariantNumeric}`);
  }

  // Always write the canonical selling_plan_id for the target frequency.
  // The customer's cadence is preserved (no change requested) or set to
  // the new frequency (change requested). Legacy IDs are not propagated.
  const effectiveSellingPlan = targetSellingPlanNumeric;

  // 1) Add the new item. Preserve the current quantity (LIT model: always 1).
  // `price` is REQUIRED by Seal — verified 2026-05-14, returns
  // "Item is missing price value." otherwise. We pass Shopify's variant
  // price as the per-unit value (memory: `price` × `quantity` = total).
  await seal.addItems(ids.sealSubscriptionId, [{
    productId: variantDetails.productId,
    variantId: variantDetails.variantId,
    quantity: mainItem.quantity,
    title: variantDetails.title,
    sku: variantDetails.sku,
    taxable: variantDetails.taxable,
    requiresShipping: variantDetails.requiresShipping,
    price: variantDetails.price,
    sellingPlanId: effectiveSellingPlan,
  }]);

  // 2) Remove the original item by its Seal item ID.
  await seal.removeItems(ids.sealSubscriptionId, [mainItem.id]);

  // 3) If the cadence changed, also bump the subscription-level interval —
  // Seal seems to store it both per-item AND on the sub. We don't know for
  // certain if this lands, but the call is harmless if it no-ops.
  if (planChanged) {
    const intervalLabelByFrequency: Record<Frequency, string> = {
      "15d": "15 days",
      "1mo": "1 month",
      "45d": "45 days",
      "2mo": "2 months",
      "3mo": "3 months",
      "4mo": "4 months",
      "5mo": "5 months",
      "6mo": "6 months",
    };
    try {
      await seal.editSubscription(ids.sealSubscriptionId, {
        delivery_interval: intervalLabelByFrequency[targetFrequency],
        billing_interval: intervalLabelByFrequency[targetFrequency],
      });
    } catch (e) {
      console.warn(
        `[plan] interval edit failed (non-fatal — item-level plan may still apply): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Re-fetch and return the updated subscription
  const refreshed = await seal.getSubscription(ids.sealSubscriptionId);
  if (!refreshed) {
    throw new ApiHttpError(500, "post_edit_fetch_failed", "Could not re-fetch Seal subscription after update");
  }
  return mapToSubscription(refreshed, ctx.customerId);
});

import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { mapToSubscription, normalizeFrequency, seal } from "@/lib/seal";
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
  const t0 = Date.now();
  const log = (step: string, extra?: Record<string, unknown>) =>
    console.log(
      `[plan-change] ${step} t+${Date.now() - t0}ms customer=${ctx.customerId}`,
      extra ?? {},
    );

  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) {
    throw new ApiHttpError(404, "customer_not_found", `No email for ${ctx.customerId}`);
  }
  log("resolved-email", { email });

  const body = (await req.json().catch(() => ({}))) as {
    boxCount?: number;
    frequency?: Frequency;
  };
  log("body", body);

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

  // Resolve the active Seal subscription directly. We deliberately do NOT
  // call resolveSubIds() here: that helper also requires a Shopify
  // SubscriptionContract, which only exists for Shopify-owned (Skio-style)
  // subs. The plan-change pipeline below only mutates Seal (add_items +
  // remove_items + edit interval), so requiring the Shopify contract would
  // 404 every Seal-owned sub unnecessarily.
  const sealSubs = await seal.getSubscriptionsByEmail(email);
  const sealSubMatch =
    sealSubs.find((s) => s.status === "ACTIVE") ??
    sealSubs.sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0];
  if (!sealSubMatch) {
    throw new ApiHttpError(404, "subscription_not_found", `No Seal subscription for ${email}`);
  }
  const sealSub = await seal.getSubscription(sealSubMatch.id);
  if (!sealSub) {
    throw new ApiHttpError(404, "seal_sub_not_found", `Seal sub ${sealSubMatch.id} not found`);
  }
  assertSubscriptionBelongsToCustomer(sealSub, email, "subscription/plan");
  const sealSubscriptionId = sealSub.id;
  log("seal-sub-fetched", { sealSubscriptionId, items: sealSub.items.length });

  // Pick the main subscription line (non-one-time item)
  const mainItem = sealSub.items.find((it) => !it.is_one_time_item) ?? sealSub.items[0];
  if (!mainItem) {
    throw new ApiHttpError(500, "no_main_line", "Seal subscription has no items");
  }
  log("main-item", { id: mainItem.id, variant: mainItem.variant_id, qty: mainItem.quantity });

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

  log("change-detected", { variantChanged, planChanged, targetFrequency, targetBoxCount });
  if (!variantChanged && !planChanged) {
    log("no-op");
    return mapToSubscription(sealSub, ctx.customerId);
  }

  // Build the new item we'll add. The variant is either the requested new
  // one OR the existing one (when only the cadence is changing).
  const effectiveVariantNumeric = variantChanged ? newVariantNumeric! : mainItem.variant_id;
  const variantDetails = await shopifyAdmin.getVariantForSealAddItems(effectiveVariantNumeric);
  if (!variantDetails) {
    throw new ApiHttpError(500, "variant_lookup_failed", `Shopify has no variant ${effectiveVariantNumeric}`);
  }
  log("variant-resolved", {
    productId: variantDetails.productId,
    variantId: variantDetails.variantId,
    sku: variantDetails.sku,
    price: variantDetails.price,
  });

  // Always write the canonical selling_plan_id for the target frequency.
  // The customer's cadence is preserved (no change requested) or set to
  // the new frequency (change requested). Legacy IDs are not propagated.
  const effectiveSellingPlan = targetSellingPlanNumeric;

  // 1) Add the new item. Preserve the current quantity (LIT model: always 1).
  // `price` is REQUIRED by Seal — verified 2026-05-14, returns
  // "Item is missing price value." otherwise. We pass Shopify's variant
  // price as the per-unit value (memory: `price` × `quantity` = total).
  try {
    await seal.addItems(sealSubscriptionId, [{
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
    log("seal-add-items-ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("seal-add-items-failed", { msg });
    throw new ApiHttpError(502, "seal_add_items_failed", msg);
  }

  // 2) Remove the original item by its Seal item ID.
  try {
    await seal.removeItems(sealSubscriptionId, [mainItem.id]);
    log("seal-remove-items-ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("seal-remove-items-failed", { msg });
    throw new ApiHttpError(502, "seal_remove_items_failed", msg);
  }

  // 3) If the cadence changed, also bump the subscription-level interval —
  // Seal stores it both per-item AND on the sub.
  let intervalEditFailed: string | null = null;
  if (planChanged) {
    // Seal requires singular interval units ("1 month", "45 day", "3 month")
    // — plurals are rejected with "interval format is invalid" (verified
    // 2026-05-14). Sending these in tandem with add+remove also realigns
    // each item's selling_plan_id to match the new cadence.
    const intervalLabelByFrequency: Record<Frequency, string> = {
      "15d": "15 day",
      "1mo": "1 month",
      "45d": "45 day",
      "2mo": "2 month",
      "3mo": "3 month",
      "4mo": "4 month",
      "5mo": "5 month",
      "6mo": "6 month",
    };
    try {
      await seal.editSubscription(sealSubscriptionId, {
        delivery_interval: intervalLabelByFrequency[targetFrequency],
        billing_interval: intervalLabelByFrequency[targetFrequency],
      });
      log("seal-edit-interval-ok", { interval: intervalLabelByFrequency[targetFrequency] });
    } catch (e) {
      // Non-throwing. The add_items + remove_items already changed the active
      // item's selling_plan_id (Seal applies cadence per-item too), so a
      // failed sub-level edit means the new item ships at the right cadence
      // but the sub field still reads the previous interval. We log and
      // surface via the response so the FE can warn the customer instead of
      // crashing the whole mutation — losing the variant swap that did land
      // would be worse than a misaligned label.
      intervalEditFailed = e instanceof Error ? e.message : String(e);
      log("seal-edit-interval-failed", {
        msg: intervalEditFailed,
        interval: intervalLabelByFrequency[targetFrequency],
      });
    }
  }

  // Re-fetch the updated subscription. Seal regenerates `billing_attempts`
  // async after `add_items + remove_items + edit interval` — usually within
  // 1–3 s. We poll for up to ~4 s so we leave plenty of headroom inside
  // Shopify App Proxy's 30 s upstream timeout. The Hub front-end picks up
  // any slower-than-4-s case with its own silent retry loop.
  const refreshed = await waitForSealBillingAttempts(sealSubscriptionId, 4_000, 500);
  if (!refreshed) {
    throw new ApiHttpError(500, "post_edit_fetch_failed", "Could not re-fetch Seal subscription after update");
  }
  log("done", {
    items: refreshed.items.length,
    pendingAttempts: (refreshed.billing_attempts ?? []).filter(
      (ba) => !ba.completed_at && !ba.status && !ba.skipped_on,
    ).length,
  });
  return mapToSubscription(refreshed, ctx.customerId);
});

/**
 * Poll Seal for the updated subscription until it has a pending
 * `billing_attempts` entry, or until `timeoutMs` elapses. Returns the most
 * recent fetch regardless — caller decides what to do with a stale response.
 */
async function waitForSealBillingAttempts(
  sealSubId: number,
  timeoutMs: number,
  intervalMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await seal.getSubscription(sealSubId);
  while (Date.now() < deadline) {
    if (latest) {
      const pending = (latest.billing_attempts ?? []).find(
        (ba) => !ba.completed_at && !ba.status && !ba.skipped_on,
      );
      if (pending?.date) return latest;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    latest = await seal.getSubscription(sealSubId);
  }
  return latest;
}

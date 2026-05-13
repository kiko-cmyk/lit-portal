import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { mapToSubscription, seal } from "@/lib/seal";
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
 * Rewrite 2026-05-13: mutates Shopify SubscriptionContract directly via
 * Admin GraphQL (subscriptionContractUpdate + draft line update + commit).
 * Seal Merchant API's `edit` action silently no-ops on variant/selling_plan
 * changes — we used to call it and pretend it worked; that bug shipped a
 * "success" UI while leaving the customer's plan unchanged. Shopify is the
 * source of truth; Seal syncs via its webhooks.
 *
 * Pre-requisites:
 * - `subscriptions` table cached customer_id → seal_sub_id + shopify_contract_id
 * - App scopes: write_own_subscription_contracts + read_own_subscription_contracts
 * - All 6 variants + 8 selling plans exist (verified 2026-05-13)
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

  // Validate body
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

  // Resolve both IDs (cache hit on Supabase ~30 ms, miss path ~3 s)
  const ids = await resolveSubIds(ctx.customerId, email);
  if (!ids) {
    throw new ApiHttpError(404, "subscription_not_found", `No active subscription for ${email}`);
  }

  // Fetch the Shopify contract + Seal sub in parallel
  const [contract, sealSub] = await Promise.all([
    shopifyAdmin.getSubscriptionContract(ids.shopifyContractId),
    seal.getSubscription(ids.sealSubscriptionId),
  ]);

  if (!contract) {
    throw new ApiHttpError(404, "contract_not_found", `Shopify contract ${ids.shopifyContractId} not found`);
  }
  if (!sealSub) {
    throw new ApiHttpError(404, "seal_sub_not_found", `Seal sub ${ids.sealSubscriptionId} not found`);
  }

  // Defensive cross-customer guard — would also catch a stale mapping row
  assertSubscriptionBelongsToCustomer(sealSub, email, "subscription/plan");

  // Cutoff against Shopify's nextBillingDate (source of truth for billing)
  if (contract.nextBillingDate && isWithinCutoff(contract.nextBillingDate)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change plan within 72h of next ship");
  }

  // Pick the main subscription line (LIT Daily Hydration product)
  const mainLine = contract.lines[0];
  if (!mainLine) {
    throw new ApiHttpError(500, "no_main_line", "Contract has no lines");
  }

  // Build the patch — only include keys that actually changed
  const patch: { variantId?: string; sellingPlanId?: string; quantity?: number } = {};

  if (body.boxCount !== undefined) {
    const newVariantId = VARIANT_BY_BOX_COUNT[body.boxCount as 1 | 2 | 3 | 4 | 5 | 6];
    if (!newVariantId) {
      throw new ApiHttpError(500, "variant_not_mapped", `No variant ID for ${body.boxCount} box(es)`);
    }
    const currentVariantNumeric = mainLine.variantId?.split("/").pop() ?? "";
    if (newVariantId !== currentVariantNumeric) {
      patch.variantId = newVariantId;
    }
  }

  if (body.frequency !== undefined) {
    const newPlanId = SELLING_PLAN_BY_FREQUENCY[body.frequency];
    if (!newPlanId) {
      throw new ApiHttpError(500, "selling_plan_not_mapped", `No selling plan for ${body.frequency}`);
    }
    const currentPlanNumeric = mainLine.sellingPlanId?.split("/").pop() ?? "";
    if (newPlanId !== currentPlanNumeric) {
      patch.sellingPlanId = newPlanId;
    }
  }

  // Nothing actually changed
  if (!patch.variantId && !patch.sellingPlanId) {
    return mapToSubscription(sealSub, ctx.customerId);
  }

  // Fire the swap via Shopify draft/commit. Seal will sync via webhook,
  // but for the immediate response we re-fetch Seal anyway to mirror UI.
  await shopifyAdmin.updateSubscriptionLine(contract.id, mainLine.id, patch);

  // Best-effort Seal re-fetch. If Seal hasn't synced yet, return the
  // Seal sub with overlaid values from the patch so the UI is correct.
  const refreshedSeal = await seal.getSubscription(ids.sealSubscriptionId);
  if (!refreshedSeal) {
    throw new ApiHttpError(500, "post_edit_fetch_failed", "Could not re-fetch Seal subscription after update");
  }

  return mapToSubscription(refreshedSeal, ctx.customerId);
});

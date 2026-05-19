import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { mapToSubscription, normalizeFrequency, seal, type SealSubscription } from "@/lib/seal";
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
  //
  // PERF (Juan 2026-05-19): we used to call getSubscription(id) right after
  // this to "refresh" the data, but getSubscriptionsByEmail already passes
  // with-items=true&with-billing-attempts=true so the records are complete.
  // Each Seal paginated call costs ~2-4 s (Seal ignores ?id= so we scan
  // all 26 pages). Dropping the redundant fetch saves ~3 s per request.
  const sealSubs = await seal.getSubscriptionsByEmail(email);
  const sealSub =
    sealSubs.find((s) => s.status === "ACTIVE") ??
    sealSubs.sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0];
  if (!sealSub) {
    throw new ApiHttpError(404, "subscription_not_found", `No Seal subscription for ${email}`);
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
  // Compensating action (post-audit 2026-05-18 [CRIT]): if remove fails after
  // add succeeded, the sub is left with BOTH items and the customer would be
  // charged for both at the next billing. We immediately try to roll back the
  // add by locating the newly-added item and removing it, then surface the
  // failure as `seal_inconsistent_state` so the FE can warn the customer to
  // contact support if the compensation also fails.
  try {
    await seal.removeItems(sealSubscriptionId, [mainItem.id]);
    log("seal-remove-items-ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("seal-remove-items-failed", { msg });
    let compensated = false;
    try {
      const afterAdd = await seal.getSubscription(sealSubscriptionId);
      const added = (afterAdd?.items ?? []).find(
        (it) =>
          !it.is_one_time_item &&
          it.id !== mainItem.id &&
          it.variant_id === variantDetails.variantId,
      );
      if (added?.id) {
        await seal.removeItems(sealSubscriptionId, [added.id]);
        compensated = true;
        log("seal-compensate-remove-ok", { addedItemId: added.id });
      } else {
        log("seal-compensate-skipped-no-added-item-found");
      }
    } catch (rollbackErr) {
      log("seal-compensate-remove-failed", {
        msg: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      });
    }
    throw new ApiHttpError(
      502,
      compensated ? "seal_remove_items_failed" : "seal_inconsistent_state",
      compensated
        ? `${msg} (rolled back add)`
        : `${msg} (could NOT roll back add — subscription has duplicate items, contact support)`,
    );
  }

  // 3) If the cadence changed, also bump the subscription-level interval —
  // Seal stores it both per-item AND on the sub.
  //
  // CRITICAL: this used to be wrapped in a try/catch that just logged the
  // failure and continued. Result: Seal rejects the edit (e.g. transient
  // hiccup right after add+remove), we log it, return the refreshed sub
  // with the OLD delivery_interval, and the FE shows "all good" even
  // though frequency didn't change. Juan hit this 2026-05-19: changed
  // boxes from 1 to 4 + frequency from 45d to 15d, only boxes landed.
  //
  // New strategy: editSubscription propagates errors. We retry ONCE with
  // a small delay (Seal occasionally needs a beat after add+remove for
  // the sub to settle). On second failure we throw — the variant change
  // already landed, so the customer needs to know the cadence didn't.
  //
  // Seal requires singular interval units ("1 month", "45 day", "3 month")
  // — plurals are rejected with "interval format is invalid" (verified
  // 2026-05-14, see reference_seal_api).
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
  const expectedInterval = intervalLabelByFrequency[targetFrequency];
  if (planChanged) {
    let firstErr: unknown = null;
    try {
      await seal.editSubscription(sealSubscriptionId, {
        delivery_interval: expectedInterval,
        billing_interval: expectedInterval,
      });
      log("seal-edit-interval-ok", { interval: expectedInterval, attempt: 1 });
    } catch (e) {
      firstErr = e;
      log("seal-edit-interval-retry", {
        msg: e instanceof Error ? e.message : String(e),
        interval: expectedInterval,
      });
      // Give Seal ~700ms to settle after the add+remove churn, then retry.
      // editSubscription with the same interval is idempotent so retry is
      // safe even if the first call actually committed and just timed out.
      await new Promise((r) => setTimeout(r, 700));
      try {
        await seal.editSubscription(sealSubscriptionId, {
          delivery_interval: expectedInterval,
          billing_interval: expectedInterval,
        });
        log("seal-edit-interval-ok", { interval: expectedInterval, attempt: 2 });
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        log("seal-edit-interval-failed-twice", {
          firstMsg: firstErr instanceof Error ? firstErr.message : String(firstErr),
          secondMsg: msg,
          interval: expectedInterval,
        });
        // The variant change DID land (add+remove succeeded), but the
        // cadence didn't. Tell the FE specifically — generic 502 means
        // the customer is left thinking everything worked.
        throw new ApiHttpError(
          502,
          variantChanged ? "frequency_change_failed_partial" : "frequency_change_failed",
          variantChanged
            ? `Boxes updated but frequency change rejected by Seal: ${msg}`
            : `Frequency change rejected by Seal: ${msg}`,
        );
      }
    }
  }

  // PERF (Juan 2026-05-19): we used to call waitForSealBillingAttempts
  // here, which loops getSubscription() (each call paginates 26 pages on
  // LIT's data, ~2-4 s/call). Combined with the upstream
  // getSubscriptionsByEmail (~2-4 s) + editSubscription + retry, the route
  // routinely hit Vercel's 10 s function timeout and returned storefront
  // HTML, leaving the customer thinking the change had failed when it
  // had actually committed.
  //
  // New strategy: trust the mutation responses. editSubscription now
  // propagates success:false errors (commit 3f1fa4b) and retries once on
  // failure (700 ms delay). If we got here, all three mutations returned
  // success:true to us. Skip the synchronous re-fetch + verification
  // entirely and build the response synthetically from what we just
  // committed. The Hub front-end has its own 60 s silent re-poll loop
  // that picks up Seal's regenerated billing_attempts (nextShipDate)
  // when they're ready — same pattern we already use for skip/undo.
  //
  // Trade-off: a silent Seal lie (success:true on a no-op) wouldn't be
  // caught in-band. That risk is mitigated by: (a) editSubscription
  // raising on success:false, (b) the retry catching transient hiccups,
  // (c) Vercel logs showing the edit response body for post-mortem.
  // If Seal lies start happening we'll observe it and reintroduce a
  // light verification fetch.
  const responseSub = synthesizePostMutationSub(
    sealSub,
    targetFrequency,
    targetBoxCount,
    expectedInterval,
    variantChanged ? variantDetails.variantId : null,
  );
  log("done-synthetic", {
    sealSubscriptionId,
    finalInterval: expectedInterval,
    finalVariant: variantChanged ? variantDetails.variantId : sealSub.items.find((it) => !it.is_one_time_item)?.variant_id,
    fePollWillRefresh: true,
  });
  return mapToSubscription(responseSub, ctx.customerId);
});

/**
 * Build a SealSubscription-shaped object that reflects the post-mutation
 * state we just committed. We avoid the costly re-fetch (each paginated
 * read costs 2-4 s) by stitching together: (a) the pre-mutation snapshot
 * for fields that don't change, (b) the explicit target values for the
 * fields we just changed, (c) an empty/null billing_attempts so the FE
 * triggers its silent re-poll for the regenerated date.
 */
function synthesizePostMutationSub(
  pre: SealSubscription,
  _targetFrequency: Frequency,
  _targetBoxCount: number | null,
  expectedInterval: string,
  newVariantId: string | null,
): SealSubscription {
  const mainPre = pre.items.find((it) => !it.is_one_time_item) ?? pre.items[0]!;
  const items = pre.items.map((it) => {
    if (it.is_one_time_item) return it;
    if (it.id !== mainPre.id) return it;
    return newVariantId !== null
      ? { ...it, variant_id: newVariantId, selling_plan_name: expectedInterval }
      : { ...it, selling_plan_name: expectedInterval };
  });
  return {
    ...pre,
    delivery_interval: expectedInterval,
    billing_interval: expectedInterval,
    items,
    // Clear pending billing_attempts so the FE knows to re-poll for the
    // regenerated date (it will auto-update once Seal finishes async).
    billing_attempts: (pre.billing_attempts ?? []).filter(
      (ba) => ba.completed_at || ba.status || ba.skipped_on,
    ),
  };
}

// waitForSealBillingAttempts removed 2026-05-19: it was the main cause of
// 10 s Vercel timeouts on this route. Each iteration paginated through 26
// pages of Seal data (~2-4 s per call) and the route ran out of budget
// before completing. Replaced with the synthetic response strategy above,
// where the FE picks up the regenerated nextShipDate via its own 60 s
// silent re-poll. If we need server-side verification again later, ship
// it as a separate light-weight call with a strict timeout (e.g.,
// AbortController.signal after 2 s) so we never block the response.

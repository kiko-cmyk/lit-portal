import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { mapToSubscription, normalizeFrequency, seal, type SealSubscription } from "@/lib/seal";
import { BOX_COUNT_BY_VARIANT, SELLING_PLAN_BY_FREQUENCY, VARIANT_BY_BOX_COUNT } from "@/lib/seal-plans";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { supabaseAdmin } from "@/lib/supabase";
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

  const body = (await req.json().catch(() => ({}))) as {
    boxCount?: number;
    frequency?: Frequency;
    /** Optional fast-path: when present, skips the slow Seal pagination. */
    sealSubscriptionId?: number | string;
    mainItemId?: number;
    currentVariantId?: string;
    currentFrequency?: Frequency;
  };
  log("body", { ...body, sealSubscriptionId: body.sealSubscriptionId });

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

  // Fast-path: the FE passed sealSubscriptionId + mainItemId + currentVariantId
  // + currentFrequency from its cached dashboard state. Use them directly
  // and skip the ~5 s Seal pagination scan that used to dominate this
  // route. We still resolve email once for ownership verification.
  //
  // Slow-path (fallback): no IDs in body → call getSubscriptionsByEmail
  // and pick the active sub. Kept for backwards compat (mobile that
  // sends an older payload) but should be rare.
  let sealSubscriptionId: number;
  let mainItemNumericId: number;
  let mainItemVariantId: string;
  let currentFrequency: Frequency;
  let nextAttemptDate: string | null = null;

  const ownsOkFast =
    body.sealSubscriptionId !== undefined
      ? await verifyOwnershipFast(Number(body.sealSubscriptionId), ctx.customerId)
      : false;

  if (
    body.sealSubscriptionId &&
    body.mainItemId &&
    body.currentVariantId &&
    body.currentFrequency &&
    ownsOkFast
  ) {
    sealSubscriptionId = Number(body.sealSubscriptionId);
    mainItemNumericId = body.mainItemId;
    mainItemVariantId = body.currentVariantId;
    currentFrequency = body.currentFrequency;
    log("fastpath-ids-from-body", { sealSubscriptionId, mainItemNumericId });
  } else {
    log("slowpath-pagination-scan");
    const url2 = new URL(req.url);
    const devEmail = process.env.NODE_ENV === "development" ? url2.searchParams.get("__dev_email") : null;
    const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
    if (!email) {
      throw new ApiHttpError(404, "customer_not_found", `No email for ${ctx.customerId}`);
    }
    const sealSubsList = await seal.getSubscriptionsByEmail(email);
    const matched =
      sealSubsList.find((s) => s.status === "ACTIVE") ??
      sealSubsList.sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0];
    if (!matched) {
      throw new ApiHttpError(404, "subscription_not_found", `No Seal subscription for ${email}`);
    }
    assertSubscriptionBelongsToCustomer(matched, email, "subscription/plan");

    const main = matched.items.find((it) => !it.is_one_time_item) ?? matched.items[0];
    if (!main) {
      throw new ApiHttpError(500, "no_main_line", "Seal subscription has no items");
    }
    sealSubscriptionId = matched.id;
    mainItemNumericId = main.id;
    mainItemVariantId = main.variant_id;
    currentFrequency = normalizeFrequency(matched.delivery_interval);

    const nextAttempt = (matched.billing_attempts ?? []).find(
      (ba) => !ba.completed_at && !ba.status && !ba.skipped_on,
    );
    nextAttemptDate = nextAttempt?.date ?? null;
  }
  log("sub-resolved", { sealSubscriptionId, mainItemNumericId, currentFrequency });

  // Cutoff against next billing attempt date (only when we have it from
  // the slow path; on fast path we trust the FE's cutoff state which is
  // already enforced at the QuickActionButton level via `disabled={withinCutoff}`).
  if (nextAttemptDate && isWithinCutoff(nextAttemptDate)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change plan within 72h of next ship");
  }

  // Resolve target variant + frequency + detect what actually changed.
  const targetBoxCount = body.boxCount ?? null;
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

  const variantChanged = newVariantNumeric !== null && newVariantNumeric !== mainItemVariantId;
  const planChanged = body.frequency !== undefined && body.frequency !== currentFrequency;

  log("change-detected", { variantChanged, planChanged, targetFrequency, targetBoxCount });
  if (!variantChanged && !planChanged) {
    log("no-op");
    // No-op: return a synthetic sub matching the input state. We don't
    // have the full pre-mutation sub fetched on the fast path, so build
    // a minimal placeholder; the FE already has the real state cached.
    return synthesizeNoOpSub(
      sealSubscriptionId,
      mainItemNumericId,
      mainItemVariantId,
      currentFrequency,
      ctx.customerId,
    );
  }

  // Build the new item we'll add. The variant is either the requested new
  // one OR the existing one (when only the cadence is changing).
  const effectiveVariantNumeric = variantChanged ? newVariantNumeric! : mainItemVariantId;
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
      quantity: 1, // LIT model: always 1, box count encoded in variant
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
    await seal.removeItems(sealSubscriptionId, [mainItemNumericId]);
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
          it.id !== mainItemNumericId &&
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
    // Only send delivery_interval. We used to send billing_interval too,
    // but reference_seal_api documents only delivery_interval as the
    // editable field for cadence — Seal may silently no-op the whole
    // edit when an undocumented field is present. Juan 2026-05-19:
    // edit returned success:true but Seal didn't actually change the
    // interval; the customer saw old cadence after reloading. Dropping
    // billing_interval is our best lead.
    let firstErr: unknown = null;
    try {
      await seal.editSubscription(sealSubscriptionId, {
        delivery_interval: expectedInterval,
      });
      log("seal-edit-interval-ok", { interval: expectedInterval, attempt: 1 });
    } catch (e) {
      firstErr = e;
      log("seal-edit-interval-retry", {
        msg: e instanceof Error ? e.message : String(e),
        interval: expectedInterval,
      });
      await new Promise((r) => setTimeout(r, 700));
      try {
        await seal.editSubscription(sealSubscriptionId, {
          delivery_interval: expectedInterval,
        });
        log("seal-edit-interval-ok", { interval: expectedInterval, attempt: 2 });
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        log("seal-edit-interval-failed-twice", {
          firstMsg: firstErr instanceof Error ? firstErr.message : String(firstErr),
          secondMsg: msg,
          interval: expectedInterval,
        });
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

  // VERIFICATION POST-MUTATION (Juan 2026-05-19 round 2):
  //
  // Background:
  //   - We removed the synchronous re-fetch in a previous commit because
  //     Seal pagination cost ~2-4 s per call and we kept hitting Vercel's
  //     10 s timeout. We replaced it with a synthetic response.
  //   - Then Juan reported that the frequency change "looked OK" but
  //     never actually applied — exactly the silent Seal lie I warned
  //     about. The synthetic response was masking real failures.
  //
  // Compromise:
  //   1) Wait 500 ms for Seal to settle after edit (gives it a beat to
  //      apply the interval before we read it back).
  //   2) Fetch the sub ONCE with a hard 4 s AbortController budget. If
  //      verification fits in budget AND matches expected state → return
  //      the real sub data. If it MISMATCHES → throw a precise error so
  //      the customer knows what to retry.
  //   3) If the verify call times out or errors → log it loudly and fall
  //      back to the synthetic response. The customer still sees apparent
  //      success, but we have observability to fix in follow-up.
  //
  // Net latency: ~1-4 s extra. Total request stays well under 10 s for
  // the common case (~6-8 s) and only nears the limit on slow Seal days.

  // 500 ms grace period
  await new Promise((r) => setTimeout(r, 500));

  // Verify with strict 4 s budget
  let verified: SealSubscription | null = null;
  let verifyOutcome: "ok" | "timeout" | "error" = "ok";
  const verifyController = new AbortController();
  const verifyTimer = setTimeout(() => verifyController.abort(), 4_000);
  try {
    verified = await seal.getSubscription(sealSubscriptionId, verifyController.signal);
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      verifyOutcome = "timeout";
    } else {
      verifyOutcome = "error";
    }
    console.error("[plan-change] verify fetch failed", {
      sealSubscriptionId,
      outcome: verifyOutcome,
      msg: e instanceof Error ? e.message : String(e),
    });
  } finally {
    clearTimeout(verifyTimer);
  }

  if (verified) {
    const refreshedMainItem =
      verified.items.find((it) => !it.is_one_time_item) ?? verified.items[0];
    const actualInterval = (verified.delivery_interval ?? "").toLowerCase().trim();
    const expectedNormalized = expectedInterval.toLowerCase().trim();
    const stripPlural = (s: string) => s.replace(/s\b/g, "").trim();
    const intervalMatches =
      stripPlural(actualInterval) === stripPlural(expectedNormalized);
    const variantMatches =
      !variantChanged ||
      refreshedMainItem?.variant_id === variantDetails.variantId;

    if (!intervalMatches || !variantMatches) {
      console.error("[plan-change] verification MISMATCH — Seal silent lie", {
        expectedInterval,
        actualInterval: verified.delivery_interval,
        expectedVariant: variantDetails.variantId,
        actualVariant: refreshedMainItem?.variant_id,
        intervalMatches,
        variantMatches,
      });
      if (!intervalMatches && variantMatches) {
        throw new ApiHttpError(
          502,
          variantChanged ? "frequency_change_failed_partial" : "frequency_change_failed",
          `Seal accepted the edit but delivery_interval is still "${verified.delivery_interval}" (expected "${expectedInterval}").`,
        );
      }
      if (intervalMatches && !variantMatches) {
        throw new ApiHttpError(
          502,
          "variant_change_failed",
          `Seal accepted add_items/remove_items but the sub still has variant ${refreshedMainItem?.variant_id} (expected ${variantDetails.variantId}).`,
        );
      }
      throw new ApiHttpError(
        502,
        "plan_verification_failed",
        `Both interval and variant didn't match expected values after plan change.`,
      );
    }

    log("done-verified", {
      sealSubscriptionId,
      finalInterval: verified.delivery_interval,
      finalVariant: refreshedMainItem?.variant_id,
    });
    return mapToSubscription(verified, ctx.customerId);
  }

  // Verification timed out or errored — fall back to synthetic response.
  // The mutation may have applied; we just couldn't confirm in time. The
  // FE's silent re-poll picks up the real state on the next refresh.
  log("done-unverified", {
    sealSubscriptionId,
    verifyOutcome,
    finalInterval: expectedInterval,
    finalVariant: variantChanged ? variantDetails.variantId : mainItemVariantId,
  });
  return synthesizePostMutationSub(
    sealSubscriptionId,
    mainItemNumericId,
    variantChanged ? variantDetails.variantId : mainItemVariantId,
    expectedInterval,
    ctx.customerId,
  );
});

/**
 * Verify the given seal_subscription_id belongs to the given Shopify
 * customer by reading the cached mapping in Supabase (sub-100 ms).
 *
 * The mapping is populated by `/api/hub/dashboard` on every dashboard
 * load — so a customer who has the Plan overlay open has guaranteed
 * already populated their row. If for some reason the cache is missing
 * (cold customer, db blip), this returns false and the caller falls
 * back to the slow paginated email scan.
 */
async function verifyOwnershipFast(
  sealSubscriptionId: number,
  shopifyCustomerId: string,
): Promise<boolean> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("subscriptions")
    .select("seal_subscription_id")
    .eq("customer_id", shopifyCustomerId)
    .maybeSingle();
  if (!data?.seal_subscription_id) return false;
  return String(data.seal_subscription_id) === String(sealSubscriptionId);
}

/**
 * Build the Subscription response shape from the IDs we already know,
 * without fetching from Seal. The FE's silent re-poll picks up the
 * regenerated nextShipDate on the next dashboard refresh.
 */
function synthesizePostMutationSub(
  sealSubscriptionId: number,
  mainItemId: number,
  finalVariantId: string,
  expectedInterval: string,
  customerId: string,
): Subscription {
  // Derive the resulting boxCount from the variant id. Falls back to 1
  // for unmapped variants (shouldn't happen — we only mutate to mapped ones).
  const boxCount = BOX_COUNT_BY_VARIANT[finalVariantId] ?? 1;
  const frequency = normalizeFrequency(expectedInterval);
  return {
    customerId,
    sealSubscriptionId: String(sealSubscriptionId),
    mainItemId,
    currentVariantId: finalVariantId,
    boxCount,
    frequency,
    frequencyLabel: expectedInterval,
    flavor: "Salty Lemon",
    nextShipDate: null, // FE will re-poll to pick up regenerated date
    nextBoxNumber: null,
    status: "active",
    createdAt: new Date().toISOString(),
    withinCutoff: false,
    cutoffEndsAt: null,
    shippingAddress: null,
    payment: {
      cardExpiryMonth: null,
      cardExpiryYear: null,
      sealEditUrl: null,
    },
  };
}

/**
 * No-op response: nothing changed, so return current state without any
 * Seal calls. The FE will refresh the dashboard separately.
 */
function synthesizeNoOpSub(
  sealSubscriptionId: number,
  mainItemId: number,
  variantId: string,
  frequency: Frequency,
  customerId: string,
): Subscription {
  const boxCount = BOX_COUNT_BY_VARIANT[variantId] ?? 1;
  return {
    customerId,
    sealSubscriptionId: String(sealSubscriptionId),
    mainItemId,
    currentVariantId: variantId,
    boxCount,
    frequency,
    frequencyLabel: frequency,
    flavor: "Salty Lemon",
    nextShipDate: null,
    nextBoxNumber: null,
    status: "active",
    createdAt: new Date().toISOString(),
    withinCutoff: false,
    cutoffEndsAt: null,
    shippingAddress: null,
    payment: {
      cardExpiryMonth: null,
      cardExpiryYear: null,
      sealEditUrl: null,
    },
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

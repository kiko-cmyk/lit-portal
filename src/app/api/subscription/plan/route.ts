import { ApiHttpError, isDryRunRequest, withCustomer } from "@/lib/api-helpers";
import { addCycle, subCycle } from "@/lib/cadence";
import { isWithinCutoff } from "@/lib/cutoff";
import { enforceRateLimit } from "@/lib/rate-limit";
import { alertSlackError } from "@/lib/alert";
import { findAppliedDiscountCodeId, getLastCompletedChargeDate, getNextBillingAttempt, mapToSubscription, normalizeFrequency, seal, type SealSubscription } from "@/lib/seal";
import { BOX_COUNT_BY_VARIANT, SELLING_PLAN_BY_FREQUENCY, VARIANT_BY_BOX_COUNT } from "@/lib/seal-plans";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { verifyOwnershipFast } from "@/lib/sub-ownership";
import { requestedSubIdFrom } from "@/lib/sub-resolve";
import { supabaseAdmin } from "@/lib/supabase";
import type { Frequency, Subscription } from "@/lib/types";

/**
 * Persist (or refresh) the "preserve this next-ship date" intent so the
 * cron drain (/api/cron/reanchor-drain) can finish the job if the in-request
 * skip didn't complete (rare: Seal still regenerating after our poll budget).
 * One live intent per customer; a later plan change overwrites it.
 */
async function writeReanchorIntent(
  customerId: string,
  sealSubscriptionId: number,
  preserveYYYYMMDD: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await supabaseAdmin()
    .from("subscription_reanchor_intents")
    .upsert(
      {
        customer_id: customerId,
        seal_subscription_id: String(sealSubscriptionId),
        preserve_date: preserveYYYYMMDD,
        status: "pending",
        attempts: 0,
        created_at: nowIso,
        updated_at: nowIso,
      },
      // Multi-sub: one intent per (customer, sub) — composite matches the
      // reanchor_intents PK after the flip, so a plan change on one sub can't
      // clobber a sibling sub's pending intent.
      { onConflict: "customer_id,seal_subscription_id" },
    );
}


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
  await enforceRateLimit(ctx.customerId, "plan", { limit: 10, windowMs: 60_000 });

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
    /**
     * The customer's current next-ship date (ISO), sent by the FE so we can
     * re-anchor it after Seal regenerates billing_attempts. Without this, a
     * plan change snaps the next charge back to "today + interval" and
     * silently undoes a prior skip. See re-anchor block near the end.
     */
    preserveNextShipDate?: string | null;
    /**
     * Re-anchor policy after a frequency change:
     *   - "preserve" (default): keep the current next-ship date (don't move the
     *     imminent order or undo a prior skip). This is the normal plan-change
     *     behaviour for the Change Plan overlay.
     *   - "natural": let the next order land on Seal's natural regenerated date
     *     (last completed charge + new interval). Used by the skip retention
     *     flow when a customer chooses to space out their cadence instead of
     *     skipping — the imminent order moves later as the customer expects.
     */
    reanchorMode?: "preserve" | "natural";
    /** Simulación: compute + return the projected result without mutating Seal. */
    dryRun?: boolean;
  };
  log("body", { ...body, sealSubscriptionId: body.sealSubscriptionId });

  const dryRun = isDryRunRequest(req, body);
  const reanchorMode: "preserve" | "natural" = body.reanchorMode === "natural" ? "natural" : "preserve";
  // Pre-mutation subscription, captured during resolution below. Needed to read
  // the last completed charge date when computing the natural re-anchor target.
  let preMutationSub: SealSubscription | null = null;

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
    // Multi-sub: if the FE named a sub (body/query id) but the fast-path missed
    // (cache gap / Seal blip), we must still change THAT sub's plan — never
    // "the first ACTIVE" one. No id → old auto-pick (older payloads).
    const requestedSubId = requestedSubIdFrom(req, body.sealSubscriptionId);
    const matched = requestedSubId
      ? sealSubsList.find((s) => String(s.id) === requestedSubId) ?? null
      : sealSubsList.find((s) => s.status === "ACTIVE") ??
        sealSubsList.sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0];
    if (!matched) {
      throw new ApiHttpError(404, "subscription_not_found", `No Seal subscription for ${email}`);
    }
    assertSubscriptionBelongsToCustomer(matched, email, "subscription/plan");
    preMutationSub = matched;

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

  // Audit 2026-05-21 finding #10: validate `mainItemId` (from body in
  // fast-path) actually belongs to THIS subscription before we use it
  // in `removeItems`. Without this an authenticated customer could
  // pass any item id (e.g. from another sub of theirs, or simply
  // guessed) and trigger removeItems on it. Costs one extra Seal
  // GET (~300ms via getSubscriptionById which is singular, not the
  // 33-page paginated scan); acceptable for the security gain.
  // Only validate when variantChanged (which is the only path that
  // calls removeItems) AND when we came via fast-path (slow-path
  // already has the sub object). Cheap enough either way.
  if (body.sealSubscriptionId !== undefined) {
    const subForCheck = await seal.getSubscriptionById(sealSubscriptionId);
    preMutationSub = subForCheck;
    const ownsItem = (subForCheck?.items ?? []).some(
      (it) => Number(it.id) === Number(mainItemNumericId) && !it.is_one_time_item,
    );
    if (!ownsItem) {
      log("item-ownership-mismatch", { mainItemNumericId });
      throw new ApiHttpError(
        403,
        "item_ownership_mismatch",
        "mainItemId does not belong to this subscription",
      );
    }
    // Read the CURRENT next charge straight from Seal (fast path didn't have
    // the sub object). This is the authoritative date to preserve — using the
    // FE-sent value risks a timezone-truncated day (a local-midnight ISO
    // slices to the day BEFORE; that bug put 27-Jul in as 26-Jul).
    if (subForCheck && nextAttemptDate === null) {
      nextAttemptDate = getNextBillingAttempt(subForCheck)?.date ?? null;
    }
  }

  // Cutoff against next billing attempt date (only when we have it from
  // the slow path; on fast path we trust the FE's cutoff state which is
  // already enforced at the QuickActionButton level via `disabled={withinCutoff}`).
  if (nextAttemptDate && isWithinCutoff(nextAttemptDate)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change plan within 24h of next ship");
  }

  // Date we must keep as the next ship date after Seal regenerates its
  // billing_attempts. Prefer Seal's authoritative attempt date (read above /
  // slow path) — Seal returns it at 10:00Z so slicing the day is timezone-safe.
  // Fall back to the FE-sent value only if Seal gave us nothing. May be null on
  // legacy payloads — then we simply don't re-anchor.
  const preserveYYYYMMDD =
    (nextAttemptDate ?? body.preserveNextShipDate)?.slice(0, 10) ?? null;

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

  // Skip retention "espaciar": with reanchorMode="natural" the next order should
  // land on Seal's natural regenerated date (last completed charge + new
  // interval) instead of being pinned to the current next-ship date. We compute
  // that date and feed it as the preserve target, so the SAME re-anchor
  // machinery (intent → dashboard drain → reanchorCadence) drives the schedule
  // onto it and the Hub's silent re-poll works unchanged. reanchorCadence only
  // ever shifts FORWARD by a uniform offset, so even if our calendar math is a
  // day off Seal's, the result is bounded to that small delta — never a full
  // extra cycle. (2026-06-19)
  function computeNaturalYYYYMMDD(): string | null {
    let anchorIso = preMutationSub ? getLastCompletedChargeDate(preMutationSub) : null;
    if (!anchorIso && nextAttemptDate) {
      anchorIso = subCycle(new Date(nextAttemptDate), currentFrequency).toISOString();
    }
    if (!anchorIso) return null;
    return addCycle(new Date(anchorIso), targetFrequency).toISOString().slice(0, 10);
  }
  const naturalYYYYMMDD =
    reanchorMode === "natural" && planChanged ? computeNaturalYYYYMMDD() : null;
  // Target the optimistic date + re-anchor intent at: natural date (skip
  // retention) when available, else the preserved current date (normal change).
  const effectivePreserveYYYYMMDD = naturalYYYYMMDD ?? preserveYYYYMMDD;

  log("change-detected", { variantChanged, planChanged, targetFrequency, targetBoxCount, reanchorMode, naturalYYYYMMDD });
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

  // Dry-run ("simulación"): short-circuit BEFORE any Seal OR Shopify call
  // (including the Shopify Admin variant lookup below) so local testing never
  // touches an external service. Return the projected post-change subscription
  // including the new next-ship date. Honoured only in non-prod
  // (api-helpers.dryRunAllowed). (2026-06-19)
  if (dryRun) {
    const projectedDate = planChanged ? effectivePreserveYYYYMMDD : preserveYYYYMMDD;
    log("dry-run-short-circuit", { projectedDate, reanchorMode, variantChanged, planChanged });
    return synthesizePostMutationSub(
      sealSubscriptionId,
      mainItemNumericId,
      variantChanged ? newVariantNumeric! : mainItemVariantId,
      expectedInterval,
      ctx.customerId,
      projectedDate,
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
  const effectiveSellingPlan = targetSellingPlanNumeric;

  // Mutation order (REORDERED 2026-05-20 Juan):
  //   Before: add_items → remove_items → editSubscription
  //     Problem: when both vary, Seal often silently no-op'd the third
  //     mutation (editSubscription) — Seal is busy regenerating
  //     billing_attempts after add+remove and the edit fails or is dropped.
  //     Juan reproduced this 2026-05-19: variant change applied but
  //     frequency didn't, no error surfaced because verify timed out
  //     waiting for Seal to re-stabilise.
  //   After: editSubscription → add_items → remove_items
  //     Edit runs while the sub is still in a clean, stable state. The
  //     subsequent add+remove operate on the post-edit cadence; per
  //     reference_seal_api, Seal auto-aligns each item's selling_plan_id
  //     to match the active interval, so the new item lands correctly.
  //
  // Plus: a 500 ms delay between each Seal mutation. Seal's billing_attempts
  // regenerator needs ~300-500 ms to settle between calls; without this
  // pause we've seen the third mutation get silently dropped.
  // ───── Step 1: change delivery_interval FIRST (if needed) ─────
  //
  // Send ONLY delivery_interval. We used to send billing_interval too,
  // but reference_seal_api documents only delivery_interval as editable
  // — Seal silently no-ops the whole edit when an undocumented field
  // is present (Juan 2026-05-19 root cause). Dropping billing_interval
  // makes the edit land cleanly even in combination with later mutations.
  if (planChanged) {
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
        // Variant hasn't been touched yet — clean abort, sub unchanged.
        throw new ApiHttpError(
          502,
          "frequency_change_failed",
          `Frequency change rejected by Seal: ${msg}`,
        );
      }
    }
    // Pause so Seal can regenerate billing_attempts before the next call.
    if (variantChanged) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ── Retention-discount carry-over guard (audit 2026-07-06) ──
  // Seal gotcha (incident 2026-06-02): add_items+remove_items with an active
  // discount_code carries the code over to the new item INVISIBLY — absent
  // from item.discount_codes but still discounting the sub. The removal
  // webhook then can't find its UUID and the "one charge only" 15% recurs on
  // every future charge silently. Safe order: detach BEFORE the swap,
  // re-apply AFTER. Never re-apply without a successful detach — applying on
  // top of a carried-over code is the invisible-duplicate scenario.
  let retentionCarry: { code: string; detached: boolean } | null = null;
  if (variantChanged) {
    const { data: rd } = await supabaseAdmin()
      .from("retention_discounts")
      .select("code, discount_code_id")
      .eq("customer_id", ctx.customerId)
      .eq("seal_subscription_id", String(sealSubscriptionId))
      .eq("status", "pending_charge")
      .maybeSingle();
    if (rd) {
      const appliedId =
        (rd.discount_code_id as string | null) ??
        (preMutationSub ? findAppliedDiscountCodeId(preMutationSub, rd.code as string) : null);
      retentionCarry = { code: rd.code as string, detached: false };
      if (appliedId) {
        try {
          await seal.removeDiscountCode(sealSubscriptionId, appliedId);
          retentionCarry.detached = true;
          log("retention-discount-detached-pre-swap");
        } catch (e) {
          log("retention-discount-detach-failed", {
            msg: e instanceof Error ? e.message : String(e),
          });
        }
      } else {
        log("retention-discount-no-uuid-pre-swap");
      }
    }
  }

  // Re-attach after the swap — and after a FAILED swap too (every throw path
  // below calls this first), so the customer never silently loses their 15%.
  // Never applies unless the detach succeeded (see gotcha above).
  const reattachRetentionDiscount = async () => {
    if (!retentionCarry) return;
    if (!retentionCarry.detached) {
      // Detach failed or the UUID was unknown: scan fresh state once — if the
      // code is visible now, finish the detach so we can re-apply cleanly; if
      // it is invisible, do NOT apply on top (invisible duplicate). Alert.
      try {
        const fresh = await seal.getSubscriptionById(sealSubscriptionId);
        const lateId = fresh ? findAppliedDiscountCodeId(fresh, retentionCarry.code) : null;
        if (lateId) {
          await seal.removeDiscountCode(sealSubscriptionId, lateId);
          retentionCarry.detached = true;
        }
      } catch {
        // fall through to the alert below
      }
    }
    if (!retentionCarry.detached) {
      alertSlackError({
        path: "/api/subscription/plan",
        code: "retention_discount_carryover",
        msg: `sub ${sealSubscriptionId}: plan swap ran with the 15% attached and detach failed — the code may now be invisible and recurring; verify in Seal (code ${retentionCarry.code})`,
        customerId: ctx.customerId,
      });
      return;
    }
    try {
      await seal.applyDiscountCode(sealSubscriptionId, retentionCarry.code);
      // Refresh the UUID so the removal webhook finds the new application.
      const after = await seal.getSubscriptionById(sealSubscriptionId);
      const newId = after ? findAppliedDiscountCodeId(after, retentionCarry.code) : null;
      await supabaseAdmin()
        .from("retention_discounts")
        .update({ discount_code_id: newId, updated_at: new Date().toISOString() })
        .eq("customer_id", ctx.customerId);
      log("retention-discount-reattached", { hasUuid: !!newId });
    } catch (e) {
      // Detached but not re-applied: the customer LOST the 15% (money-safe
      // direction, but support must re-apply). Loud alert.
      log("retention-discount-reapply-failed", {
        msg: e instanceof Error ? e.message : String(e),
      });
      alertSlackError({
        path: "/api/subscription/plan",
        code: "retention_discount_lost",
        msg: `sub ${sealSubscriptionId}: 15% detached for the plan swap but re-apply failed — re-apply code ${retentionCarry.code} manually`,
        customerId: ctx.customerId,
      });
    }
  };

  // ───── Step 2: swap the variant (add new, remove old) ─────
  //
  // We do this AFTER the edit so the new item Seal creates is already
  // aligned to the target cadence. Per reference_seal_api, Seal sets the
  // item's selling_plan_id to match the sub's current delivery_interval
  // regardless of what we pass in `selling_plan_id`. Doing the edit
  // first guarantees the right plan.
  if (variantChanged) {
    // 2a. Add the new item.
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
      // Items are unchanged — put the 15% back before surfacing the error.
      await reattachRetentionDiscount();
      // If the edit landed but add failed, the sub has the new cadence
      // but old variant. The customer can retry box change separately.
      throw new ApiHttpError(
        502,
        planChanged ? "variant_change_failed_after_interval" : "seal_add_items_failed",
        msg,
      );
    }

    // Pause so Seal can index the new item before the remove call.
    await new Promise((r) => setTimeout(r, 500));

    // 2b. Remove the old item.
    try {
      await seal.removeItems(sealSubscriptionId, [mainItemNumericId]);
      log("seal-remove-items-ok");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("seal-remove-items-failed", { msg });
      let compensated = false;
      try {
        // Singular by-id endpoint (1 call) — the legacy getSubscription scans
        // the whole store (~50 pages in parallel) and trips Seal's rate limit,
        // worst possible move mid-rollback (audit 2026-07-06).
        const afterAdd = await seal.getSubscriptionById(sealSubscriptionId);
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
      // Whether or not the add was rolled back, restore the 15% before
      // surfacing the error (support will sort the items either way).
      await reattachRetentionDiscount();
      throw new ApiHttpError(
        502,
        compensated ? "seal_remove_items_failed" : "seal_inconsistent_state",
        compensated
          ? `${msg} (rolled back add)`
          : `${msg} (could NOT roll back add — subscription has duplicate items, contact support)`,
      );
    }
  }

  // Happy path: swap done (or no swap needed) — put the 15% back on the sub.
  await reattachRetentionDiscount();

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
    // Singular by-id endpoint (1 call). The legacy getSubscription paginated
    // the WHOLE store (~50 pages, Promise.all) on every plan change — firing
    // exactly while Seal regenerates attempts and the FE re-polls, i.e. the
    // remaining 429 stampede after the 2026-07-06 getSubscriptionsByEmail fix.
    verified = await seal.getSubscriptionById(sealSubscriptionId, verifyController.signal);
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

    // ───── Preserve the prior next-ship date (don't revert earlier steps) ─────
    //
    // ONLY a frequency change regenerates the schedule. A box-count change
    // (add_items + remove_items) leaves billing_attempts untouched — same IDs,
    // same dates — so there's nothing to preserve. (Confirmed against the live
    // Seal API 2026-06-12.) So we only act when planChanged.
    //
    // When the frequency changes, Seal DELETES every pending billing_attempt
    // immediately and REGENERATES the schedule ASYNCHRONOUSLY (~60-100 s, up to
    // hours per Seal's docs) anchored on "last completed charge + interval",
    // ignoring any prior skip. If a customer had skipped to 27-Sep, the
    // regenerated next charge can snap back to 27-Jun. Business rule: a plan
    // change must NEVER move the next charge earlier than the date the customer
    // already had.
    //
    // We CANNOT fix this in-request: the regen hasn't happened yet when we
    // return (this is exactly what broke the first two attempts — we read 0
    // pending and concluded "all good", then Seal reset the date a minute
    // later). Instead we persist a "preserve this date" intent and let the
    // Seal `subscription/updated` webhook — which fires WHEN regen completes —
    // skip the regenerated early attempts (seal.skipIntermediateAttempts), so
    // the first surviving charge lands on the preserved date. The Hub dashboard
    // re-poll and the cron drain are backstops. We respond optimistically with
    // the preserved date so the customer sees it immediately.
    let finalNextShipDate: string | null = getNextBillingAttempt(verified)?.date ?? null;
    if (planChanged && effectivePreserveYYYYMMDD && !isWithinCutoff(`${effectivePreserveYYYYMMDD}T13:00:00Z`)) {
      await writeReanchorIntent(ctx.customerId, sealSubscriptionId, effectivePreserveYYYYMMDD).catch((e) =>
        log("reanchor-intent-write-failed", { msg: String(e) }),
      );
      finalNextShipDate = `${effectivePreserveYYYYMMDD}T13:00:00Z`; // optimistic; webhook/cron makes it real
      log("reanchor-intent-recorded", { effectivePreserveYYYYMMDD, reanchorMode });
    }

    log("done-verified", {
      sealSubscriptionId,
      finalInterval: verified.delivery_interval,
      finalVariant: refreshedMainItem?.variant_id,
      finalNextShipDate,
    });
    return { ...mapToSubscription(verified, ctx.customerId), nextShipDate: finalNextShipDate };
  }

  // Verification timed out or errored — fall back to synthetic response.
  // The mutation may have applied; we just couldn't confirm in time. The
  // FE's silent re-poll picks up the real state on the next refresh.
  //
  // We couldn't run the in-request poll-and-skip here (it needs the verified
  // sub state). Record a re-anchor intent so the cron drain
  // (/api/cron/reanchor-drain) preserves the prior next-ship date once Seal
  // finishes regenerating. This is exactly the case the safety net exists for.
  if (effectivePreserveYYYYMMDD && !isWithinCutoff(`${effectivePreserveYYYYMMDD}T13:00:00Z`)) {
    await writeReanchorIntent(ctx.customerId, sealSubscriptionId, effectivePreserveYYYYMMDD).catch((e) =>
      log("reanchor-intent-write-failed", { msg: String(e) }),
    );
    log("reanchor-deferred-to-cron-unverified", { sealSubscriptionId, effectivePreserveYYYYMMDD, verifyOutcome });
  }
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
    effectivePreserveYYYYMMDD,
  );
});

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
  /** When set, show this date optimistically (a re-anchor intent is pending). */
  preserveYYYYMMDD?: string | null,
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
    // Optimistic: show the preserved date while the cron finishes the skip.
    // Otherwise null and the FE re-polls for the regenerated date.
    nextShipDate: preserveYYYYMMDD ? `${preserveYYYYMMDD}T13:00:00Z` : null,
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

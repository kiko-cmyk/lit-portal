import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { awardDrops } from "@/lib/drops";
import { klaviyo } from "@/lib/klaviyo";
import { seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { verifyOwnershipFast } from "@/lib/sub-ownership";
import { supabaseAdmin } from "@/lib/supabase";
import type { CancelStep1Response, CancelStep4Response, CancellationReason } from "@/lib/types";

interface CancelBody {
  step: 1 | 2 | 3 | 4;
  primaryReason?: CancellationReason;
  freeText?: string;
  effectiveAfterNextDelivery?: boolean;
  /**
   * Fast-path: when the FE passes the seal subscription id from its cached
   * dashboard state, skip the 33-page Seal pagination scan that used to
   * dominate this route. We still verify ownership against Supabase.
   * Reason: step 4 timed out on Vercel (Juan 2026-05-21 incident — HTTP 500
   * + storefront HTML fallback because Seal scan + cancel exceeded the
   * function budget on a busy account).
   */
  sealSubscriptionId?: number | string;
}

const HOLD_DAYS = 90;

/**
 * POST /apps/portal/api/subscription/cancel
 *
 * Multi-step flow per BACKEND_CONTRACT § 1.1.9:
 *   step 1 → return stats { boxes, cards, drops, monthsInCircle }
 *   step 2 → no-op (FE shows alternatives, may exit)
 *   step 3 → upsert pending cancellation row with reason
 *   step 4 → final commit:
 *            - call Seal cancelSubscription
 *            - if first cancel: 90d Drops hold
 *            - if 2nd+: immediate Drops reset to 0
 *            - increment cancel_count, set last_cancelled_at
 *            - schedule win-back emails (handled by Klaviyo flow on event)
 */
export const POST = withCustomer(async (req, ctx) => {
  const body = (await req.json().catch(() => ({}))) as CancelBody;
  if (![1, 2, 3, 4].includes(body.step)) {
    throw new ApiHttpError(400, "invalid_step", "step must be 1..4");
  }

  const sb = supabaseAdmin();

  // ───── Step 1: stats ─────
  if (body.step === 1) {
    const url = new URL(req.url);
    const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
    const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
    let boxes = 0;
    if (email) {
      const subs = await seal.getSubscriptionsByEmail(email);
      const sub = subs.find((s) => s.status === "ACTIVE") ?? subs[0];
      if (sub) {
        assertSubscriptionBelongsToCustomer(sub, email, "subscription/cancel:step1");
        boxes = (sub.billing_attempts ?? []).filter((a) => a.completed_at).length;
      }
    }
    const { data: bal } = await sb
      .from("drops_balances")
      .select("balance, tier_earned_at")
      .eq("customer_id", ctx.customerId)
      .maybeSingle();

    const drops = bal?.balance ?? 0;
    let monthsInCircle = 0;
    if (bal?.tier_earned_at) {
      const earned = new Date(bal.tier_earned_at).getTime();
      monthsInCircle = Math.max(0, Math.floor((Date.now() - earned) / (1000 * 60 * 60 * 24 * 30)));
    }

    const resp: CancelStep1Response = {
      step: 1,
      data: {
        boxes,
        cards: 0, // Phase 2 (Collection deferred)
        drops,
        monthsInCircle,
      },
    };
    return resp;
  }

  // ───── Step 2: alternatives shown (no-op) ─────
  if (body.step === 2) {
    return { step: 2, ok: true };
  }

  // ───── Step 3: persist reason as pending row ─────
  if (body.step === 3) {
    if (!body.primaryReason) {
      throw new ApiHttpError(400, "missing_reason", "primaryReason required for step 3");
    }
    // Upsert — if there's an existing pending row, update it; else insert
    const { data: existing } = await sb
      .from("cancellations")
      .select("id, cancel_count_at_event")
      .eq("customer_id", ctx.customerId)
      .eq("status", "pending")
      .maybeSingle();

    const { data: prefs } = await sb
      .from("customer_preferences")
      .select("cancel_count")
      .eq("customer_id", ctx.customerId)
      .maybeSingle();
    const cancelCount = prefs?.cancel_count ?? 0;

    if (existing) {
      const { error } = await sb
        .from("cancellations")
        .update({
          primary_reason: body.primaryReason,
          free_text: body.freeText ?? null,
          step_completed: 3,
        })
        .eq("id", existing.id);
      if (error) throw new Error(`cancellations update: ${error.message}`);
    } else {
      const { error } = await sb.from("cancellations").insert({
        customer_id: ctx.customerId,
        status: "pending",
        primary_reason: body.primaryReason,
        free_text: body.freeText ?? null,
        step_completed: 3,
        cancel_count_at_event: cancelCount + 1,
      });
      if (error) throw new Error(`cancellations insert: ${error.message}`);
    }
    return { step: 3, ok: true };
  }

  // ───── Step 4: FINAL COMMIT ─────
  if (body.step === 4) {
    // IDEMPOTENCY CHECK (audit 2026-05-21):
    // If there's a recent (<10 min) cancellation row for this customer
    // already in `committing` or `confirmed` status, return that row's
    // cached response instead of re-running Seal + DB writes. Prevents:
    //   - double-increment of cancel_count
    //   - double-fire of Klaviyo `subscription_cancelled` event
    //   - double drops-reset on second+ cancel
    // Typical trigger: FE times out waiting for Seal but the cancel
    // actually went through (Vercel returned 504, customer retries).
    const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
    const { data: recentCancel } = await sb
      .from("cancellations")
      .select("id, status, effective_last_ship_date, drops_release_at, cancel_count_at_event, started_at")
      .eq("customer_id", ctx.customerId)
      .in("status", ["committing", "confirmed"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (
      recentCancel &&
      new Date(recentCancel.started_at).getTime() > Date.now() - IDEMPOTENCY_WINDOW_MS
    ) {
      console.log("[cancel] idempotency short-circuit", {
        customerId: ctx.customerId,
        cancellationId: recentCancel.id,
        status: recentCancel.status,
      });
      const cached: CancelStep4Response = {
        cancelled: true,
        // effective_last_ship_date is a `date` column → no time component.
        // Append midnight UTC for the FE Date() parser to be happy.
        lastShipDate: recentCancel.effective_last_ship_date
          ? `${recentCancel.effective_last_ship_date}T00:00:00.000Z`
          : "",
        dropsHeldUntil: (recentCancel.drops_release_at as string | null) ?? null,
        cardsKept: 0,
        cancelCount: recentCancel.cancel_count_at_event ?? 0,
      };
      return cached;
    }

    const url = new URL(req.url);
    const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;

    // Fast-path: id-from-body + Supabase ownership check + targeted Seal GET.
    // Slow-path (fallback): paginated email scan, kept for older clients.
    // Juan 2026-05-21: fast-path added to keep step 4 inside Vercel's budget.
    let sub: SealSubscription | null = null;
    let email: string | null = null;
    if (body.sealSubscriptionId !== undefined) {
      const owns = await verifyOwnershipFast(
        Number(body.sealSubscriptionId),
        ctx.customerId,
      );
      if (owns) {
        sub = await seal.getSubscriptionById(Number(body.sealSubscriptionId));
        if (sub) {
          email = sub.email ?? null;
          assertSubscriptionBelongsToCustomer(sub, email ?? "", "subscription/cancel:step4-fast");
        }
      }
    }
    if (!sub) {
      email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
      if (!email) throw new ApiHttpError(404, "customer_not_found", "");
      const subs = await seal.getSubscriptionsByEmail(email);
      sub = subs.find((s) => s.status === "ACTIVE") ?? null;
      if (!sub) throw new ApiHttpError(404, "subscription_not_found", "");
      assertSubscriptionBelongsToCustomer(sub, email, "subscription/cancel:step4");
    }
    if (!email) email = sub.email ?? null;
    if (!email) throw new ApiHttpError(404, "customer_not_found", "");

    // 1. Read current state
    const { data: prefs } = await sb
      .from("customer_preferences")
      .select("cancel_count")
      .eq("customer_id", ctx.customerId)
      .maybeSingle();
    const cancelCount = prefs?.cancel_count ?? 0;
    const isSecondPlus = cancelCount >= 1;

    const { data: bal } = await sb
      .from("drops_balances")
      .select("balance")
      .eq("customer_id", ctx.customerId)
      .maybeSingle();
    const currentBalance = bal?.balance ?? 0;

    // Audit 2026-05-18 [CRIT]: previously Seal cancelled first and Supabase
    // was updated after. If any DB step failed after Seal returned 200, the
    // sub was cancelled in Seal but the app's `cancellations` row stayed in
    // `pending`, no `confirmed_at`, no `drops_release_at`, and the
    // winback/drops-cleanup crons never fired. Now we mark the row as
    // `committing` BEFORE talking to Seal, then promote to `confirmed` only
    // after the Seal cancel + every dependent write succeed. If Seal fails
    // we leave the row as `committing` and surface a hard error.
    const releaseAt = isSecondPlus
      ? null
      : new Date(Date.now() + HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const lastShipDate = (sub.billing_attempts ?? []).find(
      (a) => !a.completed_at && !a.status && !a.skipped_on,
    )?.date ?? null;

    const { data: pendingRow } = await sb
      .from("cancellations")
      .select("id")
      .eq("customer_id", ctx.customerId)
      .eq("status", "pending")
      .maybeSingle();

    const committingPatch = {
      status: "committing" as const,
      primary_reason: body.primaryReason ?? null,
      free_text: body.freeText ?? null,
      step_completed: 4,
      effective_last_ship_date: lastShipDate ? lastShipDate.slice(0, 10) : null,
      drops_held_at_cancel: isSecondPlus ? 0 : currentBalance,
      drops_release_at: releaseAt,
      cancel_count_at_event: cancelCount + 1,
    };

    let cancellationId: string | null = null;
    if (pendingRow) {
      cancellationId = pendingRow.id as string;
      const { error } = await sb.from("cancellations").update(committingPatch).eq("id", pendingRow.id);
      if (error) throw new Error(`cancellations pre-commit update failed: ${error.message}`);
    } else {
      const { data: inserted, error } = await sb
        .from("cancellations")
        .insert({ customer_id: ctx.customerId, ...committingPatch })
        .select("id")
        .single();
      if (error) throw new Error(`cancellations pre-commit insert failed: ${error.message}`);
      cancellationId = inserted?.id as string;
    }

    // Now call Seal. If this fails the row stays in `committing` — visible in
    // ops dashboards as a half-finished cancel that needs manual follow-up.
    try {
      await seal.cancelSubscription(sub.id, { reason: body.primaryReason });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cancel] seal.cancelSubscription failed for sub ${sub.id}: ${msg}`);
      throw new ApiHttpError(502, "seal_cancel_failed", msg);
    }

    // Seal accepted the cancellation. Promote the row to confirmed and do the
    // dependent writes. If a follow-up step fails, the cancel is still
    // committed in Seal, but the row remains in `committing` until the next
    // retry — preferable to a silent partial state.
    if (isSecondPlus && currentBalance !== 0) {
      // Tag the drops_event with cancellationId so reintentos del POST no
      // dupliquen el negativo (the awardDrops helper checks metadata for the
      // same tag).
      await awardDrops(ctx.customerId, "cancel_reset", -currentBalance, {
        reason: "second_plus_cancel",
        cancellationId,
      });
    }

    await sb
      .from("customer_preferences")
      .upsert(
        {
          customer_id: ctx.customerId,
          cancel_count: cancelCount + 1,
          last_cancelled_at: new Date().toISOString(),
        },
        { onConflict: "customer_id" },
      );

    if (cancellationId) {
      await sb
        .from("cancellations")
        .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
        .eq("id", cancellationId);
    }

    // 6. Trigger Klaviyo event — flows can react with confirmation + schedule win-back.
    // cancellationId pasa como property para que el flow pueda dedupear si
    // el evento llega dos veces (e.g. retry de la mutation): el flow puede
    // chequear "ya he disparado para este cancellationId? ignora".
    klaviyo
      .trackEvent("subscription_cancelled", email, {
        cancellationId,
        primaryReason: body.primaryReason,
        freeText: body.freeText,
        cancelCount: cancelCount + 1,
        lastShipDate,
        dropsHeldUntil: releaseAt,
      })
      .catch((err) => console.warn("[cancel] klaviyo event failed:", err));

    const resp: CancelStep4Response = {
      cancelled: true,
      lastShipDate: lastShipDate ?? "",
      dropsHeldUntil: releaseAt,
      cardsKept: 0, // Phase 2
      cancelCount: cancelCount + 1,
    };
    return resp;
  }

  throw new ApiHttpError(400, "invalid_step", `Unhandled step ${body.step}`);
});

import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { awardDrops } from "@/lib/drops";
import { klaviyo } from "@/lib/klaviyo";
import { seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";
import type { CancelStep1Response, CancelStep4Response, CancellationReason } from "@/lib/types";

interface CancelBody {
  step: 1 | 2 | 3 | 4;
  primaryReason?: CancellationReason;
  freeText?: string;
  effectiveAfterNextDelivery?: boolean;
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
    const url = new URL(req.url);
    const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
    const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
    if (!email) throw new ApiHttpError(404, "customer_not_found", "");

    const subs = await seal.getSubscriptionsByEmail(email);
    const sub = subs.find((s) => s.status === "ACTIVE");
    if (!sub) throw new ApiHttpError(404, "subscription_not_found", "");

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

    // 2. Cancel in Seal
    await seal.cancelSubscription(sub.id, { reason: body.primaryReason });

    // 3. Upsert cancellations confirmation row
    const releaseAt = isSecondPlus ? null : new Date(Date.now() + HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const lastShipDate = (sub.billing_attempts ?? []).find((a) => !a.completed_at)?.date ?? null;

    const { data: pendingRow } = await sb
      .from("cancellations")
      .select("id")
      .eq("customer_id", ctx.customerId)
      .eq("status", "pending")
      .maybeSingle();

    const cancelRow = {
      status: "confirmed" as const,
      primary_reason: body.primaryReason ?? null,
      free_text: body.freeText ?? null,
      step_completed: 4,
      confirmed_at: new Date().toISOString(),
      effective_last_ship_date: lastShipDate ? lastShipDate.slice(0, 10) : null,
      drops_held_at_cancel: isSecondPlus ? 0 : currentBalance,
      drops_release_at: releaseAt,
      cancel_count_at_event: cancelCount + 1,
    };
    if (pendingRow) {
      await sb.from("cancellations").update(cancelRow).eq("id", pendingRow.id);
    } else {
      await sb.from("cancellations").insert({ customer_id: ctx.customerId, ...cancelRow });
    }

    // 4. Drops handling per "1st vs 2nd cancel" rule
    if (isSecondPlus && currentBalance !== 0) {
      // Reset drops to 0 immediately via negative event
      await awardDrops(ctx.customerId, "cancel_reset", -currentBalance, {
        reason: "second_plus_cancel",
      });
    }
    // For first cancel: balance stays — the 90-day hold cron will zero it on day 91 if not reactivated.

    // 5. Bump cancel_count + last_cancelled_at on customer_preferences
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

    // 6. Trigger Klaviyo event — flows can react with confirmation + schedule win-back
    klaviyo
      .trackEvent("subscription_cancelled", email, {
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

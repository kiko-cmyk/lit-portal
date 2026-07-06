import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { awardDrops } from "@/lib/drops";
import { klaviyo } from "@/lib/klaviyo";
import { enforceRateLimit } from "@/lib/rate-limit";
import { seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { verifyOwnershipFast } from "@/lib/sub-ownership";
import { requestedSubIdFrom } from "@/lib/sub-resolve";
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
 * Fire a Klaviyo event with a few retries. The cancel route used to call
 * `klaviyo.trackEvent(...)` fire-and-forget (no await, error swallowed), so a
 * transient Klaviyo hiccup — or the Vercel function freezing right after Seal
 * — silently dropped the confirmation event. We now await with retries; the
 * caller still treats a final failure as best-effort (logged for backfill).
 */
async function trackEventWithRetry(
  event: Parameters<typeof klaviyo.trackEvent>[0],
  email: string,
  properties: Record<string, unknown>,
  attempts = 3,
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await klaviyo.trackEvent(event, email, properties);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Valid cancellation reasons — mirrors the `cancellations.primary_reason` CHECK
// in schema.sql. Validated at runtime because `CancellationReason` is a
// compile-time type only: a client can POST anything, and an out-of-set value
// would otherwise reach the insert and blow the CHECK as a 500 instead of a
// clean 400. Must stay in sync with BOTH the DB CHECK and the reasons the UI
// offers (src/components/CancelTakeover.tsx): `dont_like` ("No me gusta") was in
// the UI but missing here and in the CHECK, so choosing it made cancel fail.
const CANCELLATION_REASONS = new Set<string>([
  "too_expensive",
  "too_much_product",
  "not_using_enough",
  "taking_a_break",
  "dont_like",
  "other",
]);

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

  // Validate the reason value up front (every insert path uses it). Without this
  // a bogus primaryReason reaches the cancellations CHECK and surfaces as a 500;
  // reject it here as a clean 400. Absent is still allowed (step 3 enforces its
  // own presence check; step 4 inserts null).
  if (body.primaryReason !== undefined && !CANCELLATION_REASONS.has(body.primaryReason)) {
    throw new ApiHttpError(400, "invalid_reason", "primaryReason is not a valid cancellation reason");
  }

  // Rate limit applies only to step 4 (the destructive one). Steps 1-3
  // are read/stage and the customer may legitimately go back-and-forth.
  if (body.step === 4) {
    await enforceRateLimit(ctx.customerId, "cancel", { limit: 5, windowMs: 60 * 60_000 });
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
      // Multi-sub: stats must describe the sub being cancelled (body/query id),
      // not "the first ACTIVE" — otherwise the takeover shows the other sub's
      // box count. No id → old auto-pick (single-sub payloads).
      const requestedSubId = requestedSubIdFrom(req, body.sealSubscriptionId);
      const sub = requestedSubId
        ? subs.find((s) => String(s.id) === requestedSubId) ?? null
        : subs.find((s) => s.status === "ACTIVE") ?? subs[0];
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
    const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

    // IDEMPOTENCY (audit 2026-05-21, HARDENED 2026-06-02 after the cancel
    // audit): ONLY a recent `confirmed` row short-circuits. Previously a
    // `committing` row also returned `cancelled:true` — but `committing`
    // means the Seal cancel may have FAILED, or a post-Seal write/the whole
    // function was interrupted (Vercel froze it after Seal). That produced
    // FALSE confirmations (sub still ACTIVE in Seal → still billing → "I
    // cancelled but my account is still active") AND skipped the Klaviyo
    // confirmation event. Live diagnosis 2026-06-02: 26/283 cancels stuck
    // `committing`; of 13 sampled, 2 still ACTIVE in Seal, 11 cancelled but
    // never finished (no email, no winback). We now RE-DRIVE `committing`
    // rows below until Seal truly reports CANCELLED, then complete every
    // dependent write.
    const { data: recentConfirmed } = await sb
      .from("cancellations")
      .select("id, effective_last_ship_date, drops_release_at, cancel_count_at_event, started_at")
      .eq("customer_id", ctx.customerId)
      .eq("status", "confirmed")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (
      recentConfirmed &&
      new Date(recentConfirmed.started_at).getTime() > Date.now() - IDEMPOTENCY_WINDOW_MS
    ) {
      console.log("[cancel] idempotency short-circuit (confirmed)", {
        customerId: ctx.customerId,
        cancellationId: recentConfirmed.id,
      });
      const cached: CancelStep4Response = {
        cancelled: true,
        // effective_last_ship_date is a `date` column → no time component.
        // Append midnight UTC for the FE Date() parser to be happy.
        lastShipDate: recentConfirmed.effective_last_ship_date
          ? `${recentConfirmed.effective_last_ship_date}T00:00:00.000Z`
          : "",
        dropsHeldUntil: (recentConfirmed.drops_release_at as string | null) ?? null,
        cardsKept: 0,
        cancelCount: recentConfirmed.cancel_count_at_event ?? 0,
      };
      return cached;
    }

    // Locate an in-flight row. `pending` = normal progression from step 3.
    // `committing` = a previous step-4 attempt that never reached `confirmed`
    // → RE-DRIVE it (same cancellationId, reuse its stored ordinal/hold so the
    // retry is idempotent).
    const { data: inflight } = await sb
      .from("cancellations")
      .select("id, status, cancel_count_at_event, drops_release_at, effective_last_ship_date")
      .eq("customer_id", ctx.customerId)
      .in("status", ["pending", "committing"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const isRedrive = inflight?.status === "committing";

    const url = new URL(req.url);
    const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;

    // Resolve the subscription. Fast-path: id-from-body + Supabase ownership
    // check + targeted Seal GET. Slow-path (fallback): paginated email scan.
    // On a RE-DRIVE the Seal sub may ALREADY be CANCELLED (cancel went through
    // but the commit didn't), so accept a cancelled sub there — otherwise we'd
    // 404 forever and the half-finished cancel could never finish its
    // email/cache/Shopify side. Juan 2026-05-21: fast-path keeps step 4 inside
    // Vercel's budget.
    let sub: SealSubscription | null = null;
    let email: string | null = null;
    const requestedSubId = requestedSubIdFrom(req, body.sealSubscriptionId);
    if (requestedSubId) {
      const owns = await verifyOwnershipFast(
        Number(requestedSubId),
        ctx.customerId,
      );
      if (owns) {
        sub = await seal.getSubscriptionById(Number(requestedSubId));
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
      // Multi-sub: never cancel a DIFFERENT sub than the one requested —
      // resolve the requested id from the email-scoped list (any status, so a
      // re-drive whose Seal cancel already went through still resolves), or
      // 404. Only auto-pick when nothing was requested (single-sub payloads).
      sub = requestedSubId
        ? subs.find((s) => String(s.id) === requestedSubId) ?? null
        : subs.find((s) => s.status === "ACTIVE") ??
          (isRedrive ? subs.find((s) => s.status === "CANCELLED") ?? subs[0] ?? null : null);
      if (!sub) throw new ApiHttpError(404, "subscription_not_found", "");
      assertSubscriptionBelongsToCustomer(sub, email, "subscription/cancel:step4");
    }
    if (!email) email = sub.email ?? null;
    if (!email) throw new ApiHttpError(404, "customer_not_found", "");

    // 1. Read current state. Reuse the in-flight row's stored ordinal so a
    //    re-drive can never double-count cancel_count.
    const { data: prefs } = await sb
      .from("customer_preferences")
      .select("cancel_count")
      .eq("customer_id", ctx.customerId)
      .maybeSingle();
    const priorCancelCount = prefs?.cancel_count ?? 0;
    const cancelOrdinal = inflight?.cancel_count_at_event ?? priorCancelCount + 1;
    const isSecondPlus = cancelOrdinal >= 2;

    const { data: bal } = await sb
      .from("drops_balances")
      .select("balance")
      .eq("customer_id", ctx.customerId)
      .maybeSingle();
    const currentBalance = bal?.balance ?? 0;

    // First cancel: 90d Drops hold. 2nd+: immediate reset (no hold). Reuse the
    // stored release date on a re-drive so the hold window doesn't slide.
    const releaseAt = isSecondPlus
      ? null
      : ((inflight?.drops_release_at as string | null) ??
        new Date(Date.now() + HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString());
    const lastShipDate =
      (inflight?.effective_last_ship_date as string | null) ??
      (sub.billing_attempts ?? []).find(
        (a) => !a.completed_at && !a.status && !a.skipped_on,
      )?.date ??
      null;

    // Audit 2026-05-18 [CRIT]: mark the row `committing` BEFORE talking to
    // Seal, promote to `confirmed` only after the Seal cancel + every
    // dependent write succeed. (See the idempotency note above for why
    // `committing` is now re-driven rather than trusted as done.)
    const committingPatch = {
      status: "committing" as const,
      primary_reason: body.primaryReason ?? null,
      free_text: body.freeText ?? null,
      step_completed: 4,
      effective_last_ship_date: lastShipDate ? lastShipDate.slice(0, 10) : null,
      drops_held_at_cancel: isSecondPlus ? 0 : currentBalance,
      drops_release_at: releaseAt,
      cancel_count_at_event: cancelOrdinal,
    };

    let cancellationId: string | null = inflight?.id ?? null;
    if (cancellationId) {
      const { error } = await sb.from("cancellations").update(committingPatch).eq("id", cancellationId);
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
    if (!cancellationId) throw new Error("cancellations: missing id after pre-commit");

    // Cancel in Seal — skip the call if Seal already has it cancelled (a
    // re-drive of a sub that cancelled fine but never committed downstream).
    // If this fails the row stays `committing` and we surface a hard error.
    if (sub.status !== "CANCELLED") {
      try {
        await seal.cancelSubscription(sub.id, { reason: body.primaryReason });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[cancel] seal.cancelSubscription failed for sub ${sub.id}: ${msg}`);
        throw new ApiHttpError(502, "seal_cancel_failed", msg);
      }
    }

    // VERIFY Seal actually cancelled before we ever report success. This is
    // THE guard against false confirmations: previously the route returned
    // `cancelled:true` whenever Seal didn't throw, but Seal can answer 200
    // without the sub flipping to CANCELLED. Re-read and require it; if not
    // cancelled we leave the row `committing` and 502 (a retry re-drives).
    const verify = await seal.getSubscriptionById(sub.id);
    const reallyCancelled =
      verify?.status === "CANCELLED" || !!verify?.cancellation_scheduled_for;
    if (!reallyCancelled) {
      console.error(
        `[cancel] post-cancel verify FAILED sub ${sub.id} status=${verify?.status ?? "unknown"} — leaving row committing`,
      );
      throw new ApiHttpError(502, "seal_cancel_unverified", "Seal did not confirm the cancellation");
    }

    // Seal confirmed CANCELLED. Complete every dependent write. All of these
    // are idempotent so the re-drive of a committing row is safe.

    // Drops reset for 2nd+ cancel. awardDrops does NOT dedup internally
    // (lib/drops.ts just inserts), so guard on an existing tagged event.
    if (isSecondPlus && currentBalance !== 0) {
      const { data: existingReset } = await sb
        .from("drops_events")
        .select("id")
        .eq("customer_id", ctx.customerId)
        .eq("action", "cancel_reset")
        .filter("metadata->>cancellationId", "eq", cancellationId)
        .maybeSingle();
      if (!existingReset) {
        // dedupKey makes the reset atomic on top of the existingReset guard
        // above: a concurrent re-drive that also read no existing row can't
        // double-deduct (unique index on dedup_key collapses it to one).
        await awardDrops(
          ctx.customerId,
          "cancel_reset",
          -currentBalance,
          { reason: "second_plus_cancel", cancellationId },
          `cancel_reset:${cancellationId}`,
        );
      }
    }

    // Set (not increment) cancel_count to this cancel's ordinal — idempotent
    // under re-drive.
    await sb
      .from("customer_preferences")
      .upsert(
        {
          customer_id: ctx.customerId,
          cancel_count: cancelOrdinal,
          last_cancelled_at: new Date().toISOString(),
        },
        { onConflict: "customer_id" },
      );

    // Promote to confirmed.
    await sb
      .from("cancellations")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
      .eq("id", cancellationId);

    // ── Block access (2026-06-02): cancelling must end the session. The FE
    // best-effort logout only kills the current device's token; invalidate
    // EVERY session for this customer so they can't keep using the portal on
    // another device. Combined with the data routes already gating on an
    // ACTIVE Seal sub (subscription_not_found), Seal=CANCELLED + no session =
    // no access.
    {
      const { error } = await sb.from("auth_sessions").delete().eq("customer_id", ctx.customerId);
      if (error) console.warn("[cancel] auth_sessions purge failed:", error.message);
    }

    // Invalidate the subscriptions cache so no fast-path reads a stale
    // "active" (it was never updated on cancel before — bug E in the audit).
    await sb
      .from("subscriptions")
      .update({
        status: verify?.cancellation_scheduled_for ? "post_cancel" : "expired",
        updated_at: new Date().toISOString(),
      })
      .eq("customer_id", ctx.customerId)
      // Scope to the cancelled sub so a multi-sub customer's OTHER active subs
      // aren't marked expired. No-op for single-sub (the one cache row is this sub).
      .eq("seal_subscription_id", String(sub.id));

    // NOTE on the Shopify SubscriptionContract (decided 2026-06-02 after
    // research): we intentionally do NOT call subscriptionContractCancel here.
    // Seal is the source of truth and owns the contract lifecycle + the
    // customer cancellation email. For a Seal-managed store, cancelling the
    // Shopify contract directly does NOT send a customer email (Shopify's
    // native subscription emails belong to the first-party "Shopify
    // Subscriptions" app, which this store does not use) and risks Seal/Shopify
    // drift. Billing is driven by Seal (it creates the billing attempts), so a
    // Seal cancel stops charges regardless of the mirror contract's status. The
    // customer-facing cancellation email is a Seal notification setting
    // (Seal > Settings > Notifications), not anything this route can send.

    // Fire the Klaviyo subscription_cancelled event with retries (was
    // fire-and-forget). This is for analytics / optional Klaviyo automation —
    // the customer-facing cancellation email comes from Seal, not this event.
    // Best-effort: the cancel is already committed, so a Klaviyo failure is
    // logged, not surfaced. cancellationId lets a flow dedupe on double-fire.
    try {
      await trackEventWithRetry("subscription_cancelled", email, {
        cancellationId,
        primaryReason: body.primaryReason,
        freeText: body.freeText,
        cancelCount: cancelOrdinal,
        lastShipDate,
        dropsHeldUntil: releaseAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[cancel][klaviyo-event-failed] cancellationId=${cancellationId} customer=${ctx.customerId}: ${msg}`,
      );
    }

    const resp: CancelStep4Response = {
      cancelled: true,
      lastShipDate: lastShipDate ?? "",
      dropsHeldUntil: releaseAt,
      cardsKept: 0, // Phase 2
      cancelCount: cancelOrdinal,
    };
    return resp;
  }

  throw new ApiHttpError(400, "invalid_step", `Unhandled step ${body.step}`);
});

import { ApiHttpError, isDryRunRequest, withCustomer } from "@/lib/api-helpers";
import { klaviyo } from "@/lib/klaviyo";
import { enforceRateLimit } from "@/lib/rate-limit";
import { findAppliedDiscountCodeId, seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { verifyOwnershipFast } from "@/lib/sub-ownership";
import { pickRequestedSub, requestedSubIdFrom } from "@/lib/sub-resolve";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /apps/portal/api/subscription/retention-discount
 *
 * Cancel-flow "15% a la desesperada": apply a 15% discount to the customer's
 * NEXT charge (and none after). It applies a Shopify discount code to the Seal
 * subscription; a Seal code recurs on every charge, so the "next charge only"
 * guarantee is enforced by REMOVING it right after the first discounted charge.
 *
 * Removal is driven by lib/retention-discount (consumeRetentionDiscountIfCharged),
 * called from the seal webhook (subscription/updated — and billing_attempt/succeeded
 * if ever subscribed) AND a daily cron sweep (/api/cron/retention-discount-sweep)
 * as the guaranteed backstop. NOTE: there is NO Shopify-side cap — LITSTAY15 has
 * usageLimit=null and Seal's recurring charges do not count against
 * appliesOncePerCustomer/asyncUsageCount, so removal is the ONLY thing that stops
 * the recurrence (incident 2026-07-23, when the only trigger — a
 * billing_attempt/succeeded webhook that was never subscribed in Seal — meant no
 * discount was ever removed).
 *
 * Guardrails (Juan): only on the customer's FIRST cancellation, and only ONCE
 * ever per customer (retention_discounts.customer_id is the primary key). So the
 * discount can't be "farmed" by cancelling repeatedly.
 *
 * The code name is configurable via RETENTION_DISCOUNT_CODE (must already exist
 * in Shopify as a subscription-eligible percentage code).
 */
export const POST = withCustomer<{ applied: boolean; code: string }>(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "retention-discount", { limit: 5, windowMs: 60_000 });

  const url = new URL(req.url);
  const devEmail =
    process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const body = (await req.json().catch(() => ({}))) as {
    sealSubscriptionId?: number | string;
    reason?: string;
    dryRun?: boolean;
  };
  const dryRun = isDryRunRequest(req, body);
  const CODE = process.env.RETENTION_DISCOUNT_CODE ?? "LITSTAY15";

  const sb = supabaseAdmin();

  // ── Guardrail 1: once ever per customer. ──
  const { data: existing } = await sb
    .from("retention_discounts")
    .select("customer_id")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  if (existing) {
    throw new ApiHttpError(409, "already_used", "Retention discount already used for this customer");
  }

  // ── Guardrail 2: only on the FIRST cancellation (never cancelled before). ──
  const { data: prefs } = await sb
    .from("customer_preferences")
    .select("cancel_count")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  if ((prefs?.cancel_count ?? 0) >= 1) {
    throw new ApiHttpError(409, "not_first_cancel", "Retention discount is only offered on the first cancellation");
  }

  // ── Resolve the subscription (fast-path, slow-path fallback — like /skip). ──
  let sub: SealSubscription | null = null;
  let email: string | null = null;
  const requestedSubId = requestedSubIdFrom(req, body.sealSubscriptionId);
  if (requestedSubId) {
    const owns = await verifyOwnershipFast(Number(requestedSubId), ctx.customerId);
    if (owns) {
      sub = await seal.getSubscriptionById(Number(requestedSubId));
      if (sub) {
        email = sub.email ?? null;
        assertSubscriptionBelongsToCustomer(sub, email ?? "", "retention-discount:fast");
      }
    }
  }
  if (!sub) {
    email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
    if (!email) throw new ApiHttpError(404, "customer_not_found", "");
    const subs = await seal.getSubscriptionsByEmail(email);
    // Multi-sub: never discount a DIFFERENT sub than the one requested.
    sub = pickRequestedSub(subs, requestedSubId);
    if (!sub) throw new ApiHttpError(404, "subscription_not_found", "No active subscription");
    assertSubscriptionBelongsToCustomer(sub, email, "retention-discount");
  }
  if (!email) email = sub.email ?? null;

  // Dry-run ("simulación"): no Seal/DB/Klaviyo mutation, just report success.
  if (dryRun) {
    return { applied: true, code: CODE };
  }

  // ── Reserve the once-per-customer slot BEFORE applying. This guarantees the
  //    webhook can always find + remove the code after the first charge (no
  //    apply-without-tracking → no accidental recurring discount). ──
  const ins = await sb
    .from("retention_discounts")
    .insert({
      customer_id: ctx.customerId,
      seal_subscription_id: String(sub.id),
      code: CODE,
      status: "pending_charge",
      reason: body.reason ?? null,
    });
  if (ins.error) {
    // 23505 = someone raced us to the single slot → already used.
    if (ins.error.code === "23505") {
      throw new ApiHttpError(409, "already_used", "Retention discount already used for this customer");
    }
    throw new Error(`retention_discounts insert failed: ${ins.error.message}`);
  }

  // ── Apply the code in Seal. ──
  try {
    await seal.applyDiscountCode(sub.id, CODE);
  } catch (e) {
    // Roll back the reservation so a transient failure doesn't burn the
    // customer's one shot.
    await sb.from("retention_discounts").delete().eq("customer_id", ctx.customerId);
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[retention-discount] apply failed for sub ${sub.id}: ${msg}`);
    throw new ApiHttpError(502, "discount_apply_failed", msg);
  }

  // ── Capture the applied code's UUID for a clean webhook removal (best-effort;
  //    the webhook falls back to matching by code string if this is null). ──
  const fresh = await seal.getSubscriptionById(sub.id).catch(() => null);
  const discountCodeId = fresh ? findAppliedDiscountCodeId(fresh, CODE) : null;
  if (discountCodeId) {
    await sb
      .from("retention_discounts")
      .update({ discount_code_id: discountCodeId, updated_at: new Date().toISOString() })
      .eq("customer_id", ctx.customerId);
  }

  // Fire-and-forget analytics.
  if (email) {
    klaviyo
      .trackEvent("retention_discount_accepted", email, {
        sealSubscriptionId: String(sub.id),
        code: CODE,
        reason: body.reason,
      })
      .catch((err) => console.warn("[retention-discount] klaviyo event failed:", err));
  }

  return { applied: true, code: CODE };
});

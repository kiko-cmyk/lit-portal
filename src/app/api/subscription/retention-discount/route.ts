import { ApiHttpError, isDryRunRequest, withCustomer } from "@/lib/api-helpers";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  applyRetentionDiscount,
  assertRetentionDiscountAllowed,
  retentionDiscountCode,
} from "@/lib/retention-discount-apply";
import { seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { verifyOwnershipFast } from "@/lib/sub-ownership";
import { pickRequestedSub, requestedSubIdFrom } from "@/lib/sub-resolve";

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
 *
 * The guardrails and the money path live in `@/lib/retention-discount-apply`
 * (27-oct-2026), shared with the WhatsApp bot's machine-to-machine entry
 * (`/api/internal/subscription/retention-discount`): one copy, one table, so a
 * customer can't get the 15% once per door.
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
  const CODE = retentionDiscountCode();

  // ── Guardrails (Juan): once ever per customer, only on the first cancellation. ──
  await assertRetentionDiscountAllowed(ctx.customerId);

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

  const { code } = await applyRetentionDiscount({
    customerId: ctx.customerId,
    sub,
    email,
    reason: body.reason ?? null,
    path: "/api/subscription/retention-discount",
    source: "portal",
  });
  return { applied: true, code };
});

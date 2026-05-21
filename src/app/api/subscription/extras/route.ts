import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { getNextBillingAttempt, seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";

interface ExtrasBody {
  shopifyVariantId: string;
  quantity?: number;
}

/**
 * POST /apps/portal/api/subscription/extras
 *
 * Adds a one-time product to the next subscription shipment.
 * Validates that the variant belongs to a product tagged `add-to-box`
 * (per locked decision 2026-04-27 — Shopify collection drives the catalog).
 * Enforces 24h cutoff. NOT yet tested against prod.
 */
export const POST = withCustomer(async (req, ctx) => {
  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) throw new ApiHttpError(404, "customer_not_found", `No email for ${ctx.customerId}`);

  const body = (await req.json().catch(() => ({}))) as ExtrasBody;
  if (!body.shopifyVariantId) {
    throw new ApiHttpError(400, "missing_variant", "shopifyVariantId is required");
  }
  const quantity = body.quantity ?? 1;
  if (quantity < 1 || quantity > 10) {
    throw new ApiHttpError(400, "invalid_quantity", "quantity must be 1..10");
  }

  // Validate variant is in the add-to-box catalog
  const allowed = await shopifyAdmin.isVariantInExtrasCatalog(body.shopifyVariantId);
  if (!allowed) {
    throw new ApiHttpError(403, "variant_not_in_catalog", "Variant is not tagged add-to-box");
  }

  const subs = await seal.getSubscriptionsByEmail(email);
  const sub = subs.find((s) => s.status === "ACTIVE");
  if (!sub) throw new ApiHttpError(404, "subscription_not_found", `No active sub for ${email}`);
  assertSubscriptionBelongsToCustomer(sub, email, "subscription/extras");

  const next = getNextBillingAttempt(sub);
  if (next && isWithinCutoff(next.date)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot add extras within 24h of next ship");
  }

  await seal.addOneTimeProduct(sub.id, body.shopifyVariantId, quantity);

  return {
    added: true,
    appliesFrom: next?.date ?? null,
  };
});

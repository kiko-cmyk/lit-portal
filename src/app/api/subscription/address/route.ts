import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { getNextBillingAttempt, mapToSubscription, seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";

interface AddressBody {
  address1: string;
  address2?: string;
  city: string;
  postalCode: string;
  country: string;
  countryCode: string;
  province?: string;
  provinceCode?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

/**
 * PATCH /apps/portal/api/subscription/address
 *
 * Updates BOTH:
 *   - Seal subscription's s_* fields (used for upcoming sub orders)
 *   - Shopify customer's default address (used for any new orders / catalog)
 *
 * Enforces 72h cutoff on the next sub shipment. NOT yet tested against prod.
 */
export const PATCH = withCustomer(async (req, ctx) => {
  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) throw new ApiHttpError(404, "customer_not_found", `No email for ${ctx.customerId}`);

  const body = (await req.json().catch(() => ({}))) as AddressBody;
  if (!body.address1 || !body.city || !body.postalCode || !body.country || !body.countryCode) {
    throw new ApiHttpError(400, "invalid_address", "address1, city, postalCode, country, countryCode are required");
  }

  const subs = await seal.getSubscriptionsByEmail(email);
  const sub = subs.find((s) => s.status === "ACTIVE");
  if (!sub) throw new ApiHttpError(404, "subscription_not_found", `No active sub for ${email}`);
  assertSubscriptionBelongsToCustomer(sub, email, "subscription/address");

  const next = getNextBillingAttempt(sub);
  if (next && isWithinCutoff(next.date)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change address within 72h of next ship");
  }

  // Update Seal first (the more critical of the two — drives the next box)
  await seal.updateShippingAddress(sub.id, {
    address1: body.address1,
    address2: body.address2,
    city: body.city,
    postalCode: body.postalCode,
    country: body.country,
    countryCode: body.countryCode,
    province: body.province,
    provinceCode: body.provinceCode,
    firstName: body.firstName,
    lastName: body.lastName,
    phone: body.phone,
  });

  // Then sync Shopify default address (best-effort — log but don't fail
  // the request if Shopify-side is rejected, since Seal already has it).
  try {
    await shopifyAdmin.updateCustomerDefaultAddress(ctx.customerId, {
      address1: body.address1,
      address2: body.address2,
      city: body.city,
      zip: body.postalCode,
      country: body.country,
      countryCode: body.countryCode,
      province: body.province,
      provinceCode: body.provinceCode,
      firstName: body.firstName,
      lastName: body.lastName,
      phone: body.phone,
    });
  } catch (err) {
    console.warn("[address-sync] Shopify default address update failed:", err);
  }

  // Return the updated subscription
  const refreshed = await seal.getSubscription(sub.id);
  return {
    updated: true,
    appliesFrom: refreshed ? getNextBillingAttempt(refreshed)?.date ?? null : null,
    subscription: refreshed ? mapToSubscription(refreshed, ctx.customerId) : null,
  };
});

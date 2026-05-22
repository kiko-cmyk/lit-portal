import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getNextBillingAttempt, mapToSubscription, seal } from "@/lib/seal";
import { resolveSubIds } from "@/lib/seal-mapping";
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
 *   - Shopify SubscriptionContract deliveryMethod (drives the next sub order)
 *   - Shopify customer default address (drives any new orders from the storefront)
 *
 * Rewrite 2026-05-13: stops calling Seal Merchant API's `edit` action because
 * it silently no-ops on every field we've tested. Shopify is the source of
 * truth; Seal projects state via webhooks.
 *
 * Enforces 24h cutoff against Shopify's nextBillingDate.
 */
export const PATCH = withCustomer(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "address", { limit: 10, windowMs: 60_000 });

  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) throw new ApiHttpError(404, "customer_not_found", `No email for ${ctx.customerId}`);

  const body = (await req.json().catch(() => ({}))) as AddressBody;
  if (!body.address1 || !body.city || !body.postalCode || !body.country || !body.countryCode) {
    throw new ApiHttpError(
      400,
      "invalid_address",
      "address1, city, postalCode, country, countryCode are required",
    );
  }
  // Audit 2026-05-21: validate format BEFORE talking to Shopify so we
  // return a clean 400 with a typed code, instead of bubbling up the
  // Shopify GraphQL error message (which used to leak via the now-fixed
  // stack-trace path). countryCode is ISO 3166-1 alpha-2 (e.g. "ES").
  // postalCode covers 3–10 chars to accommodate everything from "ES" to
  // long alphanumeric postcodes (UK, CA).
  if (!/^[A-Z]{2}$/.test(body.countryCode)) {
    throw new ApiHttpError(400, "invalid_country_code", "countryCode must be ISO 2-letter (e.g. ES)");
  }
  const pc = body.postalCode.trim();
  if (pc.length < 3 || pc.length > 10 || /[^A-Za-z0-9 \-]/.test(pc)) {
    throw new ApiHttpError(400, "invalid_postal_code", "postalCode must be 3-10 chars, alphanumeric");
  }
  if (body.provinceCode && !/^[A-Z0-9]{1,5}$/.test(body.provinceCode)) {
    throw new ApiHttpError(400, "invalid_province_code", "provinceCode must be 1-5 alphanumeric upper");
  }

  const ids = await resolveSubIds(ctx.customerId, email);
  if (!ids) {
    throw new ApiHttpError(404, "subscription_not_found", `No active sub for ${email}`);
  }

  const [contract, sealSub] = await Promise.all([
    shopifyAdmin.getSubscriptionContract(ids.shopifyContractId),
    seal.getSubscription(ids.sealSubscriptionId),
  ]);
  if (!contract) {
    throw new ApiHttpError(404, "contract_not_found", `Shopify contract ${ids.shopifyContractId} not found`);
  }
  if (!sealSub) {
    throw new ApiHttpError(404, "seal_sub_not_found", `Seal sub ${ids.sealSubscriptionId} not found`);
  }
  assertSubscriptionBelongsToCustomer(sealSub, email, "subscription/address");

  if (contract.nextBillingDate && isWithinCutoff(contract.nextBillingDate)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change address within 24h of next ship");
  }

  // 1. Update Shopify SubscriptionContract delivery method (drives sub orders)
  await shopifyAdmin.updateSubscriptionDeliveryAddress(contract.id, {
    address1: body.address1,
    address2: body.address2,
    city: body.city,
    zip: body.postalCode,
    countryCode: body.countryCode,
    province: body.province,
    provinceCode: body.provinceCode,
    firstName: body.firstName,
    lastName: body.lastName,
    phone: body.phone,
  });

  // 2. Sync Shopify default address (drives one-off storefront orders).
  //    Best-effort — log but don't fail if it 4xxs.
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

  // 3. Re-fetch Seal for the response (eventual consistency — may still
  //    show old address until Seal's Shopify webhook catches up).
  const refreshed = await seal.getSubscription(ids.sealSubscriptionId);
  return {
    updated: true,
    appliesFrom: refreshed ? getNextBillingAttempt(refreshed)?.date ?? null : null,
    subscription: refreshed ? mapToSubscription(refreshed, ctx.customerId) : null,
  };
});

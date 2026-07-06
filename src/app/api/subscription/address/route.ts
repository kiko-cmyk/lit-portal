import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getNextBillingAttempt, mapToSubscription, seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { resolveActiveSubFast } from "@/lib/sub-resolve";

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
  sealSubscriptionId?: number | string; // multi-sub: which sub to update (optional)
}

/**
 * PATCH /apps/portal/api/subscription/address
 *
 * Source of truth: Seal. We update Seal's s_* fields directly. Seal
 * generates the shipping label on the next billing attempt, so this
 * is what actually drives where the box gets sent.
 *
 * Best-effort: also sync the Shopify customer's default address so
 * future one-off storefront orders use the same address. If the
 * Shopify SubscriptionContract is active and present, we sync that
 * too. If it's cancelled / missing (e.g. after a Seal-direct
 * reactivate that didn't restore the Shopify contract), we just skip
 * that sync — Seal is enough for the subscription box.
 *
 * History (audit 2026-05-22 rewrite):
 *   - Pre-2026-05-13: Seal-only. Worked.
 *   - 2026-05-13: rewrote to Shopify-only, claiming Seal silently no-op'd.
 *     That claim was wrong for the address fields (probed 2026-05-22:
 *     Seal happily accepts s_* edits if you send all required fields,
 *     incl. s_first_name, s_last_name, s_country).
 *   - 2026-05-22: back to Seal-primary, Shopify-sync best-effort.
 *     Fixes Juan's `subscription_not_found` after a cancel+reactivate.
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
  // Light validation — Shopify/Seal will reject anything truly malformed.
  if (!/^[A-Za-z]{2}$/.test(body.countryCode)) {
    throw new ApiHttpError(400, "invalid_country_code", "countryCode must be ISO 2-letter (e.g. ES)");
  }
  const pc = body.postalCode.trim();
  if (pc.length < 3 || pc.length > 12) {
    throw new ApiHttpError(400, "invalid_postal_code", "postalCode must be 3-12 chars");
  }
  if (body.provinceCode && body.provinceCode.length > 12) {
    throw new ApiHttpError(400, "invalid_province_code", "provinceCode too long (max 12)");
  }

  // Fast-path: resolve via the cached Seal id (1 quick call). Falls back to
  // the full email scan on a cache miss. The old scan-first approach (twice
  // over) was the source of the intermittent "subscription_not_found" and the
  // lag Juan hit when saving an address. For resilience the fallback also
  // accepts the most recent sub (lets you edit a re-activated sub even if Seal
  // hasn't promoted its status yet).
  const subSel = url.searchParams.get("seal_subscription_id") ?? body.sealSubscriptionId;
  let sealSub = await resolveActiveSubFast(ctx.customerId, email, subSel);
  if (!sealSub && subSel) {
    throw new ApiHttpError(404, "subscription_not_found", `No subscription ${subSel}`);
  }
  if (!sealSub) {
    const sealSubs = await seal.getSubscriptionsByEmail(email);
    sealSub =
      sealSubs.find((s) => s.status === "ACTIVE") ??
      sealSubs.sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0] ??
      null;
  }
  if (!sealSub) {
    throw new ApiHttpError(404, "subscription_not_found", `No Seal subscription for ${email}`);
  }
  assertSubscriptionBelongsToCustomer(sealSub, email, "subscription/address");

  // Cutoff against the next billing attempt date (Seal's, since Seal is
  // source of truth for this flow).
  const nextAttempt = getNextBillingAttempt(sealSub);
  if (nextAttempt?.date && isWithinCutoff(nextAttempt.date)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change address within 24h of next ship");
  }

  // Seal requires `s_first_name` + `s_last_name` + `s_country` on every
  // address edit. If the FE didn't send them, fall back to current
  // values on the sub so the edit doesn't fail.
  const firstName = (body.firstName || sealSub.s_first_name || "").trim();
  const lastName = (body.lastName || sealSub.s_last_name || "").trim();
  const country = (body.country || sealSub.s_country || "").trim();
  if (!firstName || !lastName || !country) {
    throw new ApiHttpError(
      400,
      "invalid_address",
      "firstName, lastName and country must be present (existing or in payload)",
    );
  }

  await seal.updateShippingAddress(sealSub.id, {
    firstName,
    lastName,
    address1: body.address1,
    address2: body.address2,
    city: body.city,
    postalCode: body.postalCode,
    country,
    countryCode: body.countryCode,
    province: body.province,
    provinceCode: body.provinceCode,
    phone: body.phone,
  });

  // Sync Shopify customer default address (best-effort — drives one-off
  // storefront orders, not the subscription box).
  shopifyAdmin
    .updateCustomerDefaultAddress(ctx.customerId, {
      address1: body.address1,
      address2: body.address2,
      city: body.city,
      zip: body.postalCode,
      country,
      countryCode: body.countryCode,
      province: body.province,
      provinceCode: body.provinceCode,
      firstName,
      lastName,
      phone: body.phone,
    })
    .catch((err) => {
      console.warn("[address-sync] Shopify default address update failed:", err);
    });

  // Re-fetch Seal for the response (eventual consistency — Seal usually
  // catches up within ~1s). Use the fast singular by-id endpoint, not the
  // paginated scan.
  const refreshed = await seal.getSubscriptionById(sealSub.id);
  return {
    updated: true,
    appliesFrom: refreshed ? getNextBillingAttempt(refreshed)?.date ?? null : null,
    subscription: refreshed ? mapToSubscription(refreshed, ctx.customerId) : null,
  };
});

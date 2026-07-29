import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { provinceFromEsPostalCode } from "@/lib/es-provinces";
import { isB2BCustomer } from "@/lib/flags";
import { enforceRateLimit } from "@/lib/rate-limit";
import { shopifyAdmin, type ShopifyCustomerAddress } from "@/lib/shopify-admin";

// PATCH /apps/portal/api/customer/business
//
// A wholesale account's two addresses plus its fiscal data, all on the SHOPIFY
// customer record (never Seal: a partner has no subscription, and these are the
// addresses that prefill their checkout):
//
//   delivery → the customer's DEFAULT address. Where the boxes go.
//   billing  → a second, non-default entry in the same address book, pointed at
//              by the `lit_b2b.billing_address_id` metafield. Shopify addresses
//              have no type, and Shopify has no billing address on a customer at
//              all (only per order, from checkout), so the pointer is what makes
//              "this one is the fiscal one" a fact rather than a guess.
//   taxId    → `lit_b2b.tax_id`. The one field Shopify has nowhere to put on a
//              non-Plus customer.
//
// Deliberately NOT a generic "edit my address" endpoint. A subscriber's address
// lives on the Seal subscription and is edited through /api/subscription/address,
// which also syncs Shopify; if this route accepted their calls too, the same
// customer would have two doors writing the same field with different rules
// (cutoff, re-anchoring) and the Seal one would silently win on the next
// shipment. Hence the B2B guard: wrong-cohort callers get a 403, not a surprise.

interface AddressPatch {
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  postalCode?: string;
  phone?: string;
}

interface BusinessPatchBody {
  delivery?: AddressPatch;
  billing?: AddressPatch & { taxId?: string; sameAsDelivery?: boolean };
}

const ADDRESS_FIELDS = ["company", "address1", "address2", "city", "postalCode", "phone"] as const;

/**
 * Merge a patch over what Shopify already has. The UI saves ONE field at a time
 * and MailingAddressInput replaces the address, so anything left out would be
 * wiped. Empty travels as `undefined`, i.e. omitted from the mutation rather
 * than explicitly blanked, so a half-filled address is never rejected for
 * sending "". Trade-off worth naming: clearing a field that already has a value
 * is a no-op (it can be overwritten, not emptied), which is the right way round
 * for an address used to invoice.
 */
function mergeAddress(patch: AddressPatch, current: ShopifyCustomerAddress | null) {
  const pick = (next: string | undefined, prev: string | null | undefined) =>
    (next !== undefined ? next.trim() : (prev ?? "")) || undefined;

  const zip = pick(patch.postalCode, current?.zip);
  return {
    address1: pick(patch.address1, current?.address1),
    address2: pick(patch.address2, current?.address2),
    city: pick(patch.city, current?.city),
    zip,
    company: pick(patch.company, current?.company),
    phone: pick(patch.phone, current?.phone),
    countryCode: current?.countryCode || "ES",
    // Province is derived from the postal code, never asked for (same rule as
    // the subscription address form): in Spain it IS the first two digits, so a
    // move to another province can't leave a label contradicting itself.
    provinceCode: zip ? provinceFromEsPostalCode(zip)?.code : current?.provinceCode ?? undefined,
  };
}

function isEmpty(a: ReturnType<typeof mergeAddress>): boolean {
  return ![a.address1, a.address2, a.city, a.zip, a.company, a.phone].some(Boolean);
}

/** Same postal address, ignoring case and stray whitespace. */
function sameAddress(
  a: ReturnType<typeof mergeAddress>,
  b: ShopifyCustomerAddress | null,
): boolean {
  if (!b) return false;
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  return (
    norm(a.address1) === norm(b.address1) &&
    norm(a.address2) === norm(b.address2) &&
    norm(a.city) === norm(b.city) &&
    norm(a.zip) === norm(b.zip) &&
    norm(a.company) === norm(b.company)
  );
}

/**
 * The shape the client renders, read back from Shopify so the province and
 * country are the ones Shopify canonicalised rather than our guess.
 */
async function readBack(customerId: string) {
  const after = await shopifyAdmin.getCustomer(customerId);
  if (!after) {
    throw new ApiHttpError(404, "customer_not_found", `No Shopify customer ${customerId}`);
  }
  const billingId = after.b2bMetafields.billing_address_id || null;
  const billing = billingId ? after.addresses.find((a) => a.id === billingId) ?? null : null;

  const shape = (a: ShopifyCustomerAddress | null) => ({
    company: a?.company || null,
    address1: a?.address1 ?? null,
    address2: a?.address2 ?? null,
    city: a?.city ?? null,
    postalCode: a?.zip ?? null,
    province: a?.province ?? (a?.zip ? provinceFromEsPostalCode(a.zip)?.name ?? null : null),
    country: a?.country ?? null,
    phone: a?.phone ?? null,
  });

  return {
    updated: true,
    business: {
      delivery: shape(after.defaultAddress),
      billing: {
        ...shape(billing),
        taxId: after.b2bMetafields.tax_id || null,
        sameAsDelivery: billing == null,
      },
    },
  };
}

export const PATCH = withCustomer(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "customer-business", { limit: 15, windowMs: 60_000 });

  const body = (await req.json().catch(() => ({}))) as BusinessPatchBody;
  const touchesDelivery = !!body.delivery && ADDRESS_FIELDS.some((f) => typeof body.delivery![f] === "string");
  const touchesBillingAddr = !!body.billing && ADDRESS_FIELDS.some((f) => typeof body.billing![f] === "string");
  const touchesTaxId = typeof body.billing?.taxId === "string";
  const resetsBilling = body.billing?.sameAsDelivery === true;
  if (!touchesDelivery && !touchesBillingAddr && !touchesTaxId && !resetsBilling) {
    throw new ApiHttpError(400, "no_changes", "Nothing to update");
  }

  const current = await shopifyAdmin.getCustomer(ctx.customerId);
  if (!current) {
    throw new ApiHttpError(404, "customer_not_found", `No Shopify customer ${ctx.customerId}`);
  }
  if (!isB2BCustomer(current.tags)) {
    throw new ApiHttpError(403, "not_b2b", "Business details are only editable for B2B accounts");
  }

  const billingId = current.b2bMetafields.billing_address_id || null;
  const billingAddr = billingId ? current.addresses.find((a) => a.id === billingId) ?? null : null;

  if (touchesDelivery) {
    const next = mergeAddress(body.delivery!, current.defaultAddress);
    if (isEmpty(next)) {
      throw new ApiHttpError(400, "invalid_address", "The delivery address would be empty");
    }
    await shopifyAdmin.updateCustomerDefaultAddress(ctx.customerId, {
      ...next,
      address1: next.address1 ?? "",
    });
  }

  if (resetsBilling) {
    // "Same as delivery" is the absence of a fiscal address, not a copy of the
    // delivery one: copying would freeze a stale duplicate the day they move.
    // The address itself is left in the book (deleting a record a human may have
    // typed is not ours to do); only the pointer goes.
    if (billingId) {
      await shopifyAdmin.setCustomerMetafield(
        ctx.customerId,
        "lit_b2b",
        "billing_address_id",
        "",
        "single_line_text_field",
      );
    }
  } else if (touchesBillingAddr) {
    const next = mergeAddress(body.billing!, billingAddr);
    if (isEmpty(next)) {
      throw new ApiHttpError(400, "invalid_address", "The billing address would be empty");
    }
    // The form opens PREFILLED with the delivery address, so "save" with nothing
    // changed must not mint a duplicate: an identical fiscal address is the same
    // thing as not having one, and storing it would freeze a copy that goes
    // stale the day they move. Same reason the reset below drops the pointer
    // instead of copying.
    if (sameAddress(next, current.defaultAddress)) {
      if (billingId) {
        await shopifyAdmin.setCustomerMetafield(
          ctx.customerId,
          "lit_b2b",
          "billing_address_id",
          "",
          "single_line_text_field",
        );
      }
      return await readBack(ctx.customerId);
    }
    const savedId = await shopifyAdmin.upsertCustomerSecondaryAddress(
      ctx.customerId,
      billingAddr?.id ?? null,
      next,
    );
    if (savedId !== billingId) {
      await shopifyAdmin.setCustomerMetafield(
        ctx.customerId,
        "lit_b2b",
        "billing_address_id",
        savedId,
        "single_line_text_field",
      );
    }
  }

  if (touchesTaxId) {
    await shopifyAdmin.setCustomerMetafield(
      ctx.customerId,
      "lit_b2b",
      "tax_id",
      body.billing!.taxId!.trim().toUpperCase(),
      "single_line_text_field",
    );
  }

  return await readBack(ctx.customerId);
});

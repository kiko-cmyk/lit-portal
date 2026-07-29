import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { provinceFromEsPostalCode } from "@/lib/es-provinces";
import { isB2BCustomer } from "@/lib/flags";
import { enforceRateLimit } from "@/lib/rate-limit";
import { shopifyAdmin } from "@/lib/shopify-admin";
import type { BusinessDetails } from "@/lib/types";

// PATCH /apps/portal/api/customer/business
//
// The wholesale customer's own address + fiscal data. Writes to the SHOPIFY
// customer record (default address + the `lit_b2b.tax_id` metafield), never to
// Seal: a B2B account has no subscription, and this address is what prefills
// their checkout, so it is the only one worth editing for them.
//
// Deliberately NOT a generic "edit my address" endpoint. A subscriber's address
// lives on the Seal subscription and is edited through /api/subscription/address,
// which also syncs Shopify; if this route accepted their calls too, the same
// customer would have two doors writing the same field with different rules
// (cutoff, re-anchoring) and the Seal one would silently win on the next
// shipment. Hence the B2B guard: wrong-cohort callers get a 403, not a surprise.
interface BusinessPatchBody {
  company?: string;
  taxId?: string;
  address1?: string;
  address2?: string;
  city?: string;
  postalCode?: string;
  phone?: string;
}

const FIELDS = [
  "company",
  "taxId",
  "address1",
  "address2",
  "city",
  "postalCode",
  "phone",
] as const;

export const PATCH = withCustomer<{ updated: boolean; business: BusinessDetails }>(
  async (req, ctx) => {
    await enforceRateLimit(ctx.customerId, "customer-business", { limit: 10, windowMs: 60_000 });

    const body = (await req.json().catch(() => ({}))) as BusinessPatchBody;
    if (!FIELDS.some((f) => typeof body[f] === "string")) {
      throw new ApiHttpError(
        400,
        "no_changes",
        `Provide at least one of ${FIELDS.join(", ")}`,
      );
    }

    const current = await shopifyAdmin.getCustomer(ctx.customerId);
    if (!current) {
      throw new ApiHttpError(404, "customer_not_found", `No Shopify customer ${ctx.customerId}`);
    }
    if (!isB2BCustomer(current.tags)) {
      throw new ApiHttpError(403, "not_b2b", "Business details are only editable for B2B accounts");
    }

    const addr = current.defaultAddress;
    // Merge over what Shopify has: the UI saves one field at a time, and
    // MailingAddressInput replaces the whole address, so anything we leave out
    // would be wiped. Empty strings are meaningful (the customer cleared the
    // field); `undefined` means "not part of this save".
    const pick = (next: string | undefined, prev: string | null | undefined) =>
      next !== undefined ? next.trim() : (prev ?? "");

    const address1 = pick(body.address1, addr?.address1);
    const city = pick(body.city, addr?.city);
    const postalCode = pick(body.postalCode, addr?.zip);

    const touchesAddress = ["address1", "address2", "city", "postalCode", "phone", "company"].some(
      (f) => typeof body[f as keyof BusinessPatchBody] === "string",
    );

    if (touchesAddress) {
      // Shopify rejects an address with no street/city/zip, and a wholesale
      // customer who blanks one of them would land on a 500 with no idea why.
      if (!address1 || !city || !postalCode) {
        throw new ApiHttpError(
          400,
          "invalid_address",
          "address1, city and postalCode are all required",
        );
      }
      // Province is derived from the postal code, never asked for (same rule as
      // the subscription address form): in Spain it IS the first two digits, so
      // a move to another province can't leave a label contradicting itself.
      const province = provinceFromEsPostalCode(postalCode);
      await shopifyAdmin.updateCustomerDefaultAddress(ctx.customerId, {
        address1,
        address2: pick(body.address2, addr?.address2) || undefined,
        city,
        zip: postalCode,
        countryCode: addr?.countryCode || "ES",
        provinceCode: province?.code,
        company: pick(body.company, addr?.company) || undefined,
        phone: pick(body.phone, addr?.phone) || undefined,
      });
    }

    if (typeof body.taxId === "string") {
      await shopifyAdmin.setCustomerMetafield(
        ctx.customerId,
        "lit_b2b",
        "tax_id",
        body.taxId.trim().toUpperCase(),
        "single_line_text_field",
      );
    }

    // Read back so the client renders what Shopify actually stored (it
    // canonicalises the province and country display names).
    const after = await shopifyAdmin.getCustomer(ctx.customerId);
    const a = after?.defaultAddress;
    return {
      updated: true,
      business: {
        company: a?.company || null,
        taxId: after?.taxId ?? null,
        address1: a?.address1 ?? null,
        address2: a?.address2 ?? null,
        city: a?.city ?? null,
        postalCode: a?.zip ?? null,
        province:
          a?.province ?? (a?.zip ? provinceFromEsPostalCode(a.zip)?.name ?? null : null),
        country: a?.country ?? null,
        countryCode: a?.countryCode ?? null,
        phone: a?.phone ?? null,
      },
    };
  },
);

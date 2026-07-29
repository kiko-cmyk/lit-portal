import crypto from "node:crypto";
import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { provinceFromEsPostalCode } from "@/lib/es-provinces";
import { isB2BCustomer } from "@/lib/flags";
import { klaviyo } from "@/lib/klaviyo";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  shopifyAdmin,
  ShopifyUserError,
  type ShopifyCustomerAddress,
} from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";
import type { CustomerProfile } from "@/lib/types";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /apps/portal/api/customer
// MVP: pulls from Shopify customer record. When Supabase lands, will also
// merge in customer_preferences (language, whatsapp_opt_in, tier, etc).
export const GET = withCustomer<CustomerProfile>(async (_req, ctx) => {
  const [c, languagePref] = await Promise.all([
    shopifyAdmin.getCustomer(ctx.customerId),
    shopifyAdmin
      .getCustomerMetafield(ctx.customerId, "lit_portal", "language_pref")
      .catch(() => null),
  ]);
  if (!c) {
    throw new ApiHttpError(404, "customer_not_found", `No Shopify customer ${ctx.customerId}`);
  }

  const lang: "en" | "es" = languagePref === "es" || languagePref === "en" ? languagePref : "en";

  const isB2B = isB2BCustomer(c.tags);

  return {
    name: [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.email,
    email: c.email,
    phone: c.phone,
    memberSince: c.createdAt,
    boxesReceived: parseInt(c.numberOfOrders, 10) || 0,
    languagePref: lang,
    tierEarned: false, // TODO when Supabase: read drops_balances.tier_earned_at
    isB2B,
    // Only shipped for wholesale accounts: for a subscriber the address that
    // matters is the Seal one, and sending these would invite the Account page
    // to edit the wrong record.
    business: isB2B ? buildBusinessDetails(c) : null,
  };
});

/**
 * Shape the two wholesale addresses out of the raw Shopify customer.
 *
 * Delivery = the default address. Billing = the address book entry pointed at by
 * `lit_b2b.billing_address_id`; when that pointer is missing (or dangles, e.g.
 * the address was deleted from the admin) the invoice simply uses the delivery
 * address, which is both the honest default and the common case.
 */
function buildBusinessDetails(c: NonNullable<Awaited<ReturnType<typeof shopifyAdmin.getCustomer>>>) {
  const mf = c.b2bMetafields;
  const billingId = mf.billing_address_id || null;
  const billingAddr = billingId ? c.addresses.find((a) => a.id === billingId) ?? null : null;

  const shape = (a: ShopifyCustomerAddress | null) => ({
    company: a?.company || null,
    address1: a?.address1 ?? null,
    address2: a?.address2 ?? null,
    city: a?.city ?? null,
    postalCode: a?.zip ?? null,
    // Prefer what Shopify canonicalised; fall back to deriving it from the
    // postal code so the field is never blank on an address typed at checkout
    // without a province.
    province:
      a?.province ?? (a?.zip ? provinceFromEsPostalCode(a.zip)?.name ?? null : null),
    country: a?.country ?? null,
    phone: a?.phone ?? null,
  });

  return {
    delivery: shape(c.defaultAddress),
    billing: {
      ...shape(billingAddr),
      taxId: mf.tax_id || null,
      sameAsDelivery: billingAddr == null,
    },
  };
}

interface CustomerPatchBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

// PATCH /apps/portal/api/customer
//
// Update firstName / lastName / phone INSTANTLY (no reversal risk).
//
// Email is special: audit 2026-05-21 finding #11 — pre-fix the portal
// changed the customer's email in Shopify the moment they submitted,
// without verifying ownership of the new address. A stolen session
// would let an attacker pivot the account email to their own.
//
// New flow: when `email` differs from current, we create a row in
// `email_change_requests` with a 32-byte token + 15min TTL and fire
// a Klaviyo event `email_change_requested` with the confirmation URL.
// The change only applies when the customer clicks the link in their
// inbox (GET /api/customer/confirm-email?token=...).
export const PATCH = withCustomer(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "customer-patch", { limit: 10, windowMs: 60_000 });

  const body = (await req.json().catch(() => ({}))) as CustomerPatchBody;
  if (!body.firstName && !body.lastName && !body.email && !body.phone) {
    throw new ApiHttpError(400, "no_changes", "Provide at least one of firstName, lastName, email, phone");
  }

  // Apply non-email fields immediately (they're idempotent + reversible).
  if (body.firstName || body.lastName || body.phone) {
    try {
      await shopifyAdmin.updateCustomer(ctx.customerId, {
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
      });
    } catch (err) {
      // Shopify rejected the input itself (typically a malformed phone the
      // customer typed). That's a 400, not a 500 — surface a typed validation
      // error so the FE tells them to fix it, and so we don't page a false
      // internal_error / spam #server-errors. Anything else (network, auth, a
      // real bug) still bubbles up to the generic 500. We rely on Shopify's own
      // validation rather than a hand-rolled regex: its phone rules are
      // country-specific, so any regex we wrote would either reject valid
      // numbers or miss ones Shopify still refuses.
      if (err instanceof ShopifyUserError) {
        const badPhone = err.userErrors.some((e) => e.field?.includes("phone"));
        throw new ApiHttpError(
          400,
          badPhone ? "invalid_phone" : "invalid_input",
          badPhone ? "Phone number is not valid" : "One of the fields is not valid",
        );
      }
      throw err;
    }
  }

  // Email change → verification flow.
  let emailChangeRequested = false;
  let newEmail: string | undefined;
  if (body.email) {
    const proposed = body.email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(proposed)) {
      throw new ApiHttpError(400, "invalid_email", "Email must be a valid address");
    }
    const current = await shopifyAdmin.getCustomer(ctx.customerId);
    if (!current) {
      throw new ApiHttpError(404, "customer_not_found", `No Shopify customer ${ctx.customerId}`);
    }
    if (proposed !== (current.email ?? "").trim().toLowerCase()) {
      const token = crypto.randomBytes(32).toString("hex");
      const sb = supabaseAdmin();
      // Invalidate any prior pending requests for this customer to
      // avoid stale links floating around.
      await sb
        .from("email_change_requests")
        .update({ consumed_at: new Date().toISOString() })
        .eq("customer_id", ctx.customerId)
        .is("consumed_at", null);
      const { error: insertErr } = await sb.from("email_change_requests").insert({
        token,
        customer_id: ctx.customerId,
        new_email: proposed,
      });
      if (insertErr) {
        console.error("[customer-patch] email_change_requests insert failed:", insertErr);
        throw new ApiHttpError(500, "email_change_db_error", "Could not stage email change");
      }
      const confirmationUrl =
        `https://litsalt.com/apps/portal/api/customer/confirm-email?token=${token}`;
      klaviyo
        .trackEvent("email_change_requested", proposed, {
          confirmation_url: confirmationUrl,
          customer_id: ctx.customerId,
        })
        .catch((err) => console.warn("[customer-patch] klaviyo event failed:", err));
      emailChangeRequested = true;
      newEmail = proposed;
    }
  }

  return { updated: true, emailChangeRequested, newEmail };
});

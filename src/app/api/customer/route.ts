import crypto from "node:crypto";
import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { klaviyo } from "@/lib/klaviyo";
import { shopifyAdmin } from "@/lib/shopify-admin";
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

  return {
    name: [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.email,
    email: c.email,
    phone: c.phone,
    memberSince: c.createdAt,
    boxesReceived: parseInt(c.numberOfOrders, 10) || 0,
    languagePref: lang,
    tierEarned: false, // TODO when Supabase: read drops_balances.tier_earned_at
  };
});

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
  const body = (await req.json().catch(() => ({}))) as CustomerPatchBody;
  if (!body.firstName && !body.lastName && !body.email && !body.phone) {
    throw new ApiHttpError(400, "no_changes", "Provide at least one of firstName, lastName, email, phone");
  }

  // Apply non-email fields immediately (they're idempotent + reversible).
  if (body.firstName || body.lastName || body.phone) {
    await shopifyAdmin.updateCustomer(ctx.customerId, {
      firstName: body.firstName,
      lastName: body.lastName,
      phone: body.phone,
    });
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

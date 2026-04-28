import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { shopifyAdmin } from "@/lib/shopify-admin";
import type { CustomerProfile } from "@/lib/types";

// GET /apps/portal/api/customer
// MVP: pulls from Shopify customer record. When Supabase lands, will also
// merge in customer_preferences (language, whatsapp_opt_in, tier, etc).
export const GET = withCustomer<CustomerProfile>(async (_req, ctx) => {
  const c = await shopifyAdmin.getCustomer(ctx.customerId);
  if (!c) {
    throw new ApiHttpError(404, "customer_not_found", `No Shopify customer ${ctx.customerId}`);
  }

  return {
    name: [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.email,
    email: c.email,
    phone: c.phone,
    memberSince: c.createdAt,
    boxesReceived: parseInt(c.numberOfOrders, 10) || 0,
    languagePref: "en", // TODO when Supabase: read customer_preferences.language
    tierEarned: false, // TODO when Supabase: read drops_balances.tier_earned_at
  };
});

interface CustomerPatchBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

// PATCH /apps/portal/api/customer  — update name/email/phone
// Splits a possible "name" field into first/last on the FE side; this endpoint
// expects firstName + lastName explicitly to avoid ambiguity.
export const PATCH = withCustomer(async (req, ctx) => {
  const body = (await req.json().catch(() => ({}))) as CustomerPatchBody;
  if (!body.firstName && !body.lastName && !body.email && !body.phone) {
    throw new ApiHttpError(400, "no_changes", "Provide at least one of firstName, lastName, email, phone");
  }
  await shopifyAdmin.updateCustomer(ctx.customerId, {
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    phone: body.phone,
  });
  return { updated: true };
});

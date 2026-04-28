import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { shopifyAdmin } from "@/lib/shopify-admin";

// PATCH /apps/portal/api/customer/language
// Persists language pref to Shopify customer metafield `lit_portal.language_pref`.
// (When Supabase comes: also write to customer_preferences table for fast reads.)
export const PATCH = withCustomer(async (req, ctx) => {
  const body = (await req.json().catch(() => ({}))) as { language?: string };
  if (body.language !== "en" && body.language !== "es") {
    throw new ApiHttpError(400, "invalid_language", "language must be 'en' or 'es'");
  }
  await shopifyAdmin.setCustomerMetafield(
    ctx.customerId,
    "lit_portal",
    "language_pref",
    body.language,
    "single_line_text_field",
  );
  return { updated: true, language: body.language };
});

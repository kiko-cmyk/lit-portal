import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

// PATCH /apps/portal/api/customer/language
// Persists the language preference to BOTH stores that read it:
//   - Shopify customer metafield `lit_portal.language_pref` (emails, /api/customer)
//   - Supabase `customer_preferences.language` (server-rendered content:
//     events, stories, moments, the Hub event card)
// The Supabase write was a long-standing TODO; without it, toggling the
// language never updated the field the content routes read, so dynamic
// content stayed in the onboarding language. (2026-06-10)
export const PATCH = withCustomer(async (req, ctx) => {
  const body = (await req.json().catch(() => ({}))) as { language?: string };
  if (body.language !== "en" && body.language !== "es") {
    throw new ApiHttpError(400, "invalid_language", "language must be 'en' or 'es'");
  }
  await Promise.all([
    shopifyAdmin.setCustomerMetafield(
      ctx.customerId,
      "lit_portal",
      "language_pref",
      body.language,
      "single_line_text_field",
    ),
    supabaseAdmin()
      .from("customer_preferences")
      .upsert(
        { customer_id: ctx.customerId, language: body.language },
        { onConflict: "customer_id" },
      ),
  ]);
  return { updated: true, language: body.language };
});

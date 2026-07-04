import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { enforceRateLimit } from "@/lib/rate-limit";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

// POST /apps/portal/api/first-login/language
// Body: { language: "en" | "es" }
export const POST = withCustomer(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "first-login-language", { limit: 10, windowMs: 60_000 });
  const body = (await req.json().catch(() => ({}))) as { language?: string };
  if (body.language !== "en" && body.language !== "es") {
    throw new ApiHttpError(400, "invalid_language", "language must be 'en' or 'es'");
  }

  const sb = supabaseAdmin();
  await sb
    .from("customer_preferences")
    .upsert({ customer_id: ctx.customerId, language: body.language }, { onConflict: "customer_id" });
  await shopifyAdmin.setCustomerMetafield(
    ctx.customerId,
    "lit_portal",
    "language_pref",
    body.language,
    "single_line_text_field",
  );

  return { language: body.language };
});

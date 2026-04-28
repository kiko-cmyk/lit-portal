import { withCustomer } from "@/lib/api-helpers";
import { klaviyo } from "@/lib/klaviyo";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

// POST /apps/portal/api/first-login/complete
// Marks the welcome takeover as dismissed regardless of opt-in choices.
export const POST = withCustomer(async (_req, ctx) => {
  const sb = supabaseAdmin();
  await sb
    .from("customer_preferences")
    .upsert({ customer_id: ctx.customerId, first_login_completed: true }, { onConflict: "customer_id" });
  await shopifyAdmin.setCustomerMetafield(
    ctx.customerId,
    "lit_portal",
    "first_login_completed",
    true,
    "boolean",
  );

  // Fire Klaviyo event so flow can pick up (e.g., welcome WhatsApp message)
  const email = await shopifyAdmin.getCustomerEmail(ctx.customerId).catch(() => null);
  if (email) {
    const { data: prefs } = await sb
      .from("customer_preferences")
      .select("whatsapp_opt_in, language")
      .eq("customer_id", ctx.customerId)
      .maybeSingle();
    klaviyo
      .trackEvent("first_login_completed", email, {
        whatsappOptIn: prefs?.whatsapp_opt_in ?? false,
        language: prefs?.language ?? "en",
      })
      .catch((err) => console.warn("[first-login/complete] klaviyo event failed:", err));
  }

  return { completed: true };
});

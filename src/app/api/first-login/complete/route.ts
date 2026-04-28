import { withCustomer } from "@/lib/api-helpers";
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
  return { completed: true };
});

import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { awardDrops, DROPS_AMOUNTS } from "@/lib/drops";
import { enforceRateLimit } from "@/lib/rate-limit";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /apps/portal/api/first-login/whatsapp
 * Body: { optIn: boolean }
 *
 * If opting in for the first time → +50 Drops one-time + write metafield.
 * If opting out → just write metafield.
 *
 * Idempotent: only awards Drops once (looks at customer_preferences for prior opt-in).
 */
export const POST = withCustomer(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "first-login-whatsapp", { limit: 10, windowMs: 60_000 });
  const body = (await req.json().catch(() => ({}))) as { optIn?: boolean };
  if (typeof body.optIn !== "boolean") {
    throw new ApiHttpError(400, "missing_opt_in", "optIn (boolean) required");
  }

  const sb = supabaseAdmin();

  const { data: prefs } = await sb
    .from("customer_preferences")
    .select("whatsapp_opt_in")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  const wasOptedIn = prefs?.whatsapp_opt_in === true;

  // Persist preference
  await sb.from("customer_preferences").upsert(
    {
      customer_id: ctx.customerId,
      whatsapp_opt_in: body.optIn,
    },
    { onConflict: "customer_id" },
  );

  // Mirror to Shopify metafield
  await shopifyAdmin.setCustomerMetafield(ctx.customerId, "lit_portal", "whatsapp_opt_in", body.optIn, "boolean");

  // First-time opt-in → +50 Drops
  let dropsAwarded = 0;
  if (body.optIn && !wasOptedIn) {
    const amount = DROPS_AMOUNTS.whatsapp_optin ?? 50;
    await awardDrops(ctx.customerId, "whatsapp_optin", amount, { source: "first_login" });
    dropsAwarded = amount;
  }

  return { optIn: body.optIn, dropsAwarded };
});

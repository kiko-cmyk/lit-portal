import { withCustomer } from "@/lib/api-helpers";
import type { TierResponse } from "@/lib/types";
import { supabaseAdmin } from "@/lib/supabase";

// GET /apps/portal/api/tier
export const GET = withCustomer<TierResponse>(async (_req, ctx) => {
  const { data, error } = await supabaseAdmin()
    .from("drops_balances")
    .select("tier_earned_at")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();

  if (error) throw new Error(`tier: ${error.message}`);

  return {
    earned: !!data?.tier_earned_at,
    earnedAt: data?.tier_earned_at ?? null,
    name: "INNER_CIRCLE",
  };
});

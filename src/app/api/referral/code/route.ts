import { withCustomer } from "@/lib/api-helpers";
import { supabaseAdmin } from "@/lib/supabase";
import type { ReferralCodeResponse } from "@/lib/types";

const SHARE_BASE_URL = "https://litsalt.com";

/**
 * Generate a stable, friendly referral code from a customer's name+id.
 * Format: "<FIRST3CHARS><RANDOM4>" — e.g. "JUA7B2K"
 */
function generateCode(seedLen = 7): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // omits 0/O/1/I confusion
  let out = "";
  for (let i = 0; i < seedLen; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// GET /apps/portal/api/referral/code
// Returns the customer's referral code (creates one on first call).
// Includes share URL + lifetime conversions + drops earned.
export const GET = withCustomer<ReferralCodeResponse>(async (_req, ctx) => {
  const sb = supabaseAdmin();

  // 1. Get or create the code
  const { data: existing } = await sb
    .from("referral_codes")
    .select("code")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();

  let code = existing?.code;
  if (!code) {
    // Generate and insert with retry on collision
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateCode();
      const { error } = await sb.from("referral_codes").insert({
        customer_id: ctx.customerId,
        code: candidate,
      });
      if (!error) {
        code = candidate;
        break;
      }
      if (error.code !== "23505") throw new Error(`referral_codes insert: ${error.message}`);
      // 23505 = unique_violation — retry with new code
    }
    if (!code) throw new Error("referral_codes: 5 collisions in a row, aborting");
  }

  // 2. Conversions + drops earned
  const { data: convs } = await sb
    .from("referral_conversions")
    .select("drops_awarded")
    .eq("referrer_customer_id", ctx.customerId);

  const conversions = convs?.length ?? 0;
  const dropsEarned = (convs ?? []).reduce((sum, r) => sum + (r.drops_awarded ?? 0), 0);

  return {
    code,
    shareUrl: `${SHARE_BASE_URL}?ref=${code}`,
    conversions,
    dropsEarned,
  };
});

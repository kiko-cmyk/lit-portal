import { withCustomer } from "@/lib/api-helpers";
import { REWARD_THRESHOLDS } from "@/lib/drops";
import { supabaseAdmin } from "@/lib/supabase";
import type { DropsBalance, RewardId } from "@/lib/types";

// GET /apps/portal/api/drops/balance
// Returns current balance + tier + claimable rewards.
// "Claimable" excludes rewards already claimed (via claimed_rewards table).
export const GET = withCustomer<DropsBalance>(async (_req, ctx) => {
  const sb = supabaseAdmin();

  const [balanceRes, claimedRes] = await Promise.all([
    sb
      .from("drops_balances")
      .select("balance, lifetime_earned, tier_earned_at, streak_months")
      .eq("customer_id", ctx.customerId)
      .maybeSingle(),
    sb.from("claimed_rewards").select("reward_id").eq("customer_id", ctx.customerId),
  ]);

  if (balanceRes.error) throw new Error(`drops/balance: ${balanceRes.error.message}`);
  if (claimedRes.error) throw new Error(`drops/balance claimed lookup: ${claimedRes.error.message}`);

  const balance = balanceRes.data?.balance ?? 0;
  const lifetime = balanceRes.data?.lifetime_earned ?? 0;
  const claimedSet = new Set((claimedRes.data ?? []).map((r) => r.reward_id as RewardId));

  const claimableRewards = (Object.entries(REWARD_THRESHOLDS) as [RewardId, number][])
    .filter(([rewardId, threshold]) => !claimedSet.has(rewardId) && balance >= threshold)
    .map(([rewardId, threshold]) => ({ rewardId, threshold }));

  return {
    balance,
    lifetimeEarned: lifetime,
    tierEarned: !!balanceRes.data?.tier_earned_at,
    tierEarnedAt: balanceRes.data?.tier_earned_at ?? null,
    streakMonths: balanceRes.data?.streak_months ?? 0,
    claimableRewards,
  };
});

import { jsonError, withCustomer } from "@/lib/api-helpers";
import { supabaseAdmin } from "@/lib/supabase";
import { computePuzzleState, getActiveRewardForCustomer, REWARD_THRESHOLDS } from "@/lib/drops";
import type { PuzzleState, RewardId } from "@/lib/types";

// GET /apps/portal/api/drops/puzzle?rewardId={id}
// If rewardId omitted, returns puzzle for active reward.
export const GET = withCustomer<PuzzleState>(async (req, ctx) => {
  const url = new URL(req.url);
  const rewardIdParam = url.searchParams.get("rewardId") as RewardId | null;

  const rewardId = rewardIdParam ?? (await getActiveRewardForCustomer(ctx.customerId));
  if (!rewardId) {
    throw new Error("All rewards claimed — no active puzzle");
  }
  if (!(rewardId in REWARD_THRESHOLDS)) {
    // We need to throw before NextResponse so the catch in withCustomer fires;
    // since withCustomer wraps everything, just throw.
    throw new Error(`Invalid rewardId ${rewardId}`);
  }

  const { data } = await supabaseAdmin()
    .from("drops_balances")
    .select("balance")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();

  return computePuzzleState(data?.balance ?? 0, rewardId);
});

// Silence unused-import warning until full impl
void jsonError;

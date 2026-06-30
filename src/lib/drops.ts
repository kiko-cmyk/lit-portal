/**
 * Drops business logic — earning rules, puzzle math, tier check.
 * Pure functions where possible; DB writes go through `awardDrops`.
 */

import { supabaseAdmin } from "./supabase";
import type { DropsAction, RewardId, PuzzleState } from "./types";

export const DROPS_AMOUNTS: Record<DropsAction, number | null> = {
  box_shipped: 100, // per box
  referral_converted: 250,
  monthly_streak: 50,
  product_review: 50,
  social_share: 25,
  whatsapp_optin: 50,
  event_checkin: 100, // Phase 2 only
  reward_claim: 0, // negative amount written explicitly
  cancel_reset: 0, // negative amount written explicitly
  manual_adjustment: null, // any
};

export const TIER_THRESHOLD = 300;

export const REWARD_THRESHOLDS: Record<RewardId, number> = {
  bottle_500: 500,
  merch_1000: 1000,
  event_2500: 2500,
};

export const REWARD_PIPELINE: RewardId[] = ["bottle_500", "merch_1000", "event_2500"];

export const PUZZLE_TOTAL_PIECES = 16 as const;

/**
 * Award Drops for an action.
 *
 * Pass `dedupKey` for awards that can be replayed (e.g. a webhook retry):
 * a second insert with the same key is a silent no-op instead of a duplicate
 * award, so handlers are safe to re-run. Relies on the unique index
 * `uq_drops_events_dedup_key`. Awards WITHOUT a dedupKey behave as before
 * (plain insert) — their idempotency, if any, is enforced elsewhere (e.g.
 * `referral_conversions.converted_order_id` gates the referral award).
 */
export async function awardDrops(
  customerId: string,
  action: DropsAction,
  amount: number,
  metadata?: Record<string, unknown>,
  dedupKey?: string,
): Promise<void> {
  const row = {
    customer_id: customerId,
    action,
    amount,
    metadata: metadata ?? null,
    dedup_key: dedupKey ?? null,
  };
  if (dedupKey) {
    // Idempotent: ON CONFLICT (dedup_key) DO NOTHING. A replay returns no rows
    // and no error, so the trigger doesn't re-fire and no duplicate is written.
    const { error } = await supabaseAdmin()
      .from("drops_events")
      .upsert(row, { onConflict: "dedup_key", ignoreDuplicates: true });
    if (error) throw new Error(`awardDrops failed: ${error.message}`);
    return;
  }
  const { error } = await supabaseAdmin().from("drops_events").insert(row);
  if (error) throw new Error(`awardDrops failed: ${error.message}`);
}

/**
 * Compute the puzzle state for the active reward.
 * Formula (Diane, 2026-04-27):
 *   pieces_revealed = floor((min(currentDrops, threshold) / threshold) * 16)
 */
export function computePuzzleState(currentDrops: number, rewardId: RewardId): PuzzleState {
  const threshold = REWARD_THRESHOLDS[rewardId];
  const clamped = Math.min(currentDrops, threshold);
  const pieces = Math.floor((clamped / threshold) * PUZZLE_TOTAL_PIECES);
  return {
    rewardId,
    rewardThreshold: threshold,
    currentDrops,
    piecesRevealed: pieces,
    totalPieces: PUZZLE_TOTAL_PIECES,
    percentComplete: Math.round((clamped / threshold) * 1000) / 10,
  };
}

/**
 * Determine which reward to show as "active" in the puzzle.
 * Pipeline is sequential — first unclaimed reward wins.
 */
export async function getActiveRewardForCustomer(customerId: string): Promise<RewardId | null> {
  const { data, error } = await supabaseAdmin()
    .from("claimed_rewards")
    .select("reward_id")
    .eq("customer_id", customerId);

  if (error) throw new Error(`getActiveRewardForCustomer failed: ${error.message}`);

  const claimedSet = new Set((data ?? []).map((r) => r.reward_id as RewardId));
  for (const reward of REWARD_PIPELINE) {
    if (!claimedSet.has(reward)) return reward;
  }
  return null;
}

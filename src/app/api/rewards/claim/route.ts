import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { REWARD_THRESHOLDS, awardDrops } from "@/lib/drops";
import { klaviyo } from "@/lib/klaviyo";
import { seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";
import type { ClaimResponse, MerchOption, RewardId } from "@/lib/types";

interface ClaimBody {
  rewardId: RewardId;
  merchOption?: MerchOption;
}

// Variant IDs for reward fulfillment — set these once Shopify products exist
// and add to .env.local. They're separate from the regular subscription items.
const REWARD_VARIANT_IDS: Record<RewardId, string | undefined> = {
  bottle_500: process.env.REWARD_VARIANT_BOTTLE,
  merch_1000: undefined, // chosen at claim time
  event_2500: undefined, // not a Shopify product (seat reservation)
};

const MERCH_VARIANT_IDS: Record<MerchOption, string | undefined> = {
  socks: process.env.REWARD_VARIANT_MERCH_SOCKS,
  tee: process.env.REWARD_VARIANT_MERCH_TEE,
  hoodie: process.env.REWARD_VARIANT_MERCH_HOODIE,
};

// POST /apps/portal/api/rewards/claim
export const POST = withCustomer<ClaimResponse>(async (req, ctx) => {
  const body = (await req.json().catch(() => ({}))) as ClaimBody;
  if (!body.rewardId || !(body.rewardId in REWARD_THRESHOLDS)) {
    throw new ApiHttpError(400, "invalid_reward", "Unknown rewardId");
  }
  const threshold = REWARD_THRESHOLDS[body.rewardId];

  const sb = supabaseAdmin();

  // Idempotency: check if already claimed
  const { data: existing } = await sb
    .from("claimed_rewards")
    .select("id")
    .eq("customer_id", ctx.customerId)
    .eq("reward_id", body.rewardId)
    .maybeSingle();
  if (existing) {
    throw new ApiHttpError(409, "already_claimed", "This reward has already been claimed");
  }

  // Validate balance
  const { data: bal } = await sb
    .from("drops_balances")
    .select("balance")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  const balance = bal?.balance ?? 0;
  if (balance < threshold) {
    throw new ApiHttpError(400, "insufficient_drops", `Need ${threshold}, have ${balance}`);
  }

  // Resolve fulfillment method + side-effect
  let fulfillmentMethod: "next_shipment" | "seat_reserved";
  let fulfillmentMetadata: Record<string, unknown> = {};

  if (body.rewardId === "bottle_500") {
    fulfillmentMethod = "next_shipment";
    const variantId = REWARD_VARIANT_IDS.bottle_500;
    if (!variantId) {
      throw new ApiHttpError(503, "reward_misconfigured", "Bottle variant ID not configured (set REWARD_VARIANT_BOTTLE)");
    }
    // Add bottle to next Seal charge — needs sub lookup first
    const email = await shopifyAdmin.getCustomerEmail(ctx.customerId);
    if (!email) throw new ApiHttpError(404, "customer_not_found", "");
    const subs = await seal.getSubscriptionsByEmail(email);
    const sub = subs.find((s) => s.status === "ACTIVE");
    if (!sub) throw new ApiHttpError(409, "no_active_subscription", "Need active subscription to receive bottle");
    await seal.addOneTimeProduct(sub.id, variantId, 1);
    fulfillmentMetadata = { sealSubscriptionId: sub.id, variantId };
  } else if (body.rewardId === "merch_1000") {
    fulfillmentMethod = "next_shipment";
    if (!body.merchOption) {
      throw new ApiHttpError(400, "missing_merch_option", "merchOption (socks/tee/hoodie) required for merch reward");
    }
    const variantId = MERCH_VARIANT_IDS[body.merchOption];
    if (!variantId) {
      throw new ApiHttpError(503, "reward_misconfigured", `Merch variant for ${body.merchOption} not configured`);
    }
    const email = await shopifyAdmin.getCustomerEmail(ctx.customerId);
    if (!email) throw new ApiHttpError(404, "customer_not_found", "");
    const subs = await seal.getSubscriptionsByEmail(email);
    const sub = subs.find((s) => s.status === "ACTIVE");
    if (!sub) throw new ApiHttpError(409, "no_active_subscription", "Need active subscription to receive merch");
    await seal.addOneTimeProduct(sub.id, variantId, 1);
    fulfillmentMetadata = { sealSubscriptionId: sub.id, variantId, option: body.merchOption };
  } else {
    // event_2500 — TODO: pick which event. For MVP, attach to the next active Madrid event.
    fulfillmentMethod = "seat_reserved";
    const { data: nextEvent } = await sb
      .from("events")
      .select("id")
      .eq("city", "madrid")
      .eq("status", "active")
      .gte("datetime", new Date().toISOString())
      .order("datetime", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!nextEvent) {
      throw new ApiHttpError(503, "no_event_available", "No upcoming event to reserve seat for");
    }
    fulfillmentMetadata = { eventId: nextEvent.id };
  }

  // Atomic-ish: insert claim row + deduct drops via event log
  const { data: claim, error: claimErr } = await sb
    .from("claimed_rewards")
    .insert({
      customer_id: ctx.customerId,
      reward_id: body.rewardId,
      threshold,
      merch_option: body.merchOption ?? null,
      fulfillment_method: fulfillmentMethod,
      fulfillment_status: "pending",
      fulfillment_metadata: fulfillmentMetadata,
    })
    .select("id")
    .single();
  if (claimErr) throw new Error(`claim insert failed: ${claimErr.message}`);

  // If event reward, also insert event_reservation
  if (body.rewardId === "event_2500" && claim) {
    await sb.from("event_reservations").insert({
      customer_id: ctx.customerId,
      event_id: fulfillmentMetadata.eventId,
      reward_claim_id: claim.id,
    });
  }

  // Deduct Drops via negative event (drops_balances trigger handles balance recompute)
  await awardDrops(ctx.customerId, "reward_claim", -threshold, {
    rewardId: body.rewardId,
    claimId: claim?.id,
  });

  // Re-read balance for response
  const { data: refreshed } = await sb
    .from("drops_balances")
    .select("balance")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();

  // Fire Klaviyo event for the reward flow (sends confirmation email)
  const customerEmail = await shopifyAdmin.getCustomerEmail(ctx.customerId).catch(() => null);
  if (customerEmail) {
    klaviyo
      .trackEvent("reward_claimed", customerEmail, {
        rewardId: body.rewardId,
        merchOption: body.merchOption,
        fulfillmentMethod,
        remainingDrops: refreshed?.balance ?? balance - threshold,
      })
      .catch((err) => console.warn("[claim] klaviyo event failed:", err));
  }

  return {
    claimed: true,
    fulfillmentMethod,
    remainingDrops: refreshed?.balance ?? balance - threshold,
  };
});

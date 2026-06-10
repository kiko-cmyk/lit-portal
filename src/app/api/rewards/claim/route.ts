import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { REWARD_THRESHOLDS, awardDrops } from "@/lib/drops";
import { klaviyo } from "@/lib/klaviyo";
import { enforceRateLimit } from "@/lib/rate-limit";
import { seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
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
  await enforceRateLimit(ctx.customerId, "rewards-claim", { limit: 10, windowMs: 60_000 });

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

  // Audit 2026-05-18 [CRIT]: previously the Seal side-effect (addOneTimeProduct)
  // ran BEFORE inserting the claimed_rewards row. If the insert failed (RLS,
  // constraint, network), the customer got the bottle without being debited.
  // Two rapid clicks also raced the insert and could double-fulfill. Now:
  //   1. Resolve dependencies (variant ID, active sub for product rewards;
  //      event slot for event rewards). No side-effects yet.
  //   2. Insert claimed_rewards as `pending` — uniqueness check stops double
  //      claims at the DB layer.
  //   3. Deduct drops (negative event) tagged with claimId for idempotency.
  //   4. Trigger Seal side-effect.
  //   5. Promote row to `confirmed` or mark `failed_rollback` if Seal fails.

  type Resolved = {
    fulfillmentMethod: "next_shipment" | "seat_reserved";
    fulfillmentMetadata: Record<string, unknown>;
    pendingSideEffect: (() => Promise<void>) | null;
  };

  const resolveSideEffect = async (): Promise<Resolved> => {
    if (body.rewardId === "bottle_500") {
      const variantId = REWARD_VARIANT_IDS.bottle_500;
      if (!variantId) {
        throw new ApiHttpError(503, "reward_misconfigured", "Bottle variant ID not configured (set REWARD_VARIANT_BOTTLE)");
      }
      const email = await shopifyAdmin.getCustomerEmail(ctx.customerId);
      if (!email) throw new ApiHttpError(404, "customer_not_found", "");
      const subs = await seal.getSubscriptionsByEmail(email);
      const sub = subs.find((s) => s.status === "ACTIVE");
      if (!sub) throw new ApiHttpError(409, "no_active_subscription", "Need active subscription to receive bottle");
      assertSubscriptionBelongsToCustomer(sub, email, "rewards/claim:bottle");
      return {
        fulfillmentMethod: "next_shipment",
        fulfillmentMetadata: { sealSubscriptionId: sub.id, variantId },
        pendingSideEffect: () => seal.addOneTimeProduct(sub.id, variantId, 1),
      };
    }
    if (body.rewardId === "merch_1000") {
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
      assertSubscriptionBelongsToCustomer(sub, email, "rewards/claim:merch");
      return {
        fulfillmentMethod: "next_shipment",
        fulfillmentMetadata: { sealSubscriptionId: sub.id, variantId, option: body.merchOption },
        pendingSideEffect: () => seal.addOneTimeProduct(sub.id, variantId, 1),
      };
    }
    // event_2500 — pick the next active Madrid event.
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
    return {
      fulfillmentMethod: "seat_reserved",
      fulfillmentMetadata: { eventId: nextEvent.id },
      pendingSideEffect: null,
    };
  };

  const { fulfillmentMethod, fulfillmentMetadata, pendingSideEffect } = await resolveSideEffect();

  // Step 1: insert claim row as `pending`. Unique index on (customer_id, reward_id)
  // means a second concurrent click hits a 23505 and we 409 the dupe.
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
  if (claimErr) {
    if ((claimErr as { code?: string }).code === "23505") {
      throw new ApiHttpError(409, "already_claimed", "This reward has already been claimed");
    }
    throw new Error(`claim insert failed: ${claimErr.message}`);
  }

  // Step 2: deduct drops (negative event tagged with claimId — idempotent if
  // the awardDrops helper checks metadata.claimId in its unique index).
  await awardDrops(ctx.customerId, "reward_claim", -threshold, {
    rewardId: body.rewardId,
    claimId: claim?.id,
  });

  // Step 3: event reservation (also persisted before Seal side-effect).
  if (body.rewardId === "event_2500" && claim) {
    await sb.from("event_reservations").insert({
      customer_id: ctx.customerId,
      event_id: fulfillmentMetadata.eventId,
      reward_claim_id: claim.id,
    });
  }

  // Step 4: Seal side-effect (the only step that mutates external state).
  if (pendingSideEffect && claim) {
    try {
      await pendingSideEffect();
      await sb
        .from("claimed_rewards")
        .update({ fulfillment_status: "confirmed" })
        .eq("id", claim.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[claim] seal side-effect failed for claim ${claim.id}: ${msg}`);
      await sb
        .from("claimed_rewards")
        .update({
          fulfillment_status: "failed_rollback",
          fulfillment_metadata: { ...fulfillmentMetadata, sealError: msg },
        })
        .eq("id", claim.id);
      throw new ApiHttpError(502, "seal_side_effect_failed", msg);
    }
  } else if (claim) {
    // event_2500 had no external side-effect — already complete.
    await sb
      .from("claimed_rewards")
      .update({ fulfillment_status: "confirmed" })
      .eq("id", claim.id);
  }

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

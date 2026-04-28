import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { computePuzzleState, getActiveRewardForCustomer } from "@/lib/drops";
import { mapToSubscription, seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";
import type { EventListItem, HubDashboard, PuzzleState } from "@/lib/types";

// GET /apps/portal/api/hub/dashboard
// Aggregates everything the Hub needs in one round-trip.
export const GET = withCustomer<HubDashboard>(async (req, ctx) => {
  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) throw new ApiHttpError(404, "customer_not_found", "");

  const sb = supabaseAdmin();

  // Parallel fetches
  const [subsRes, balanceRes, prefsRes] = await Promise.all([
    seal.getSubscriptionsByEmail(email),
    sb
      .from("drops_balances")
      .select("balance, tier_earned_at")
      .eq("customer_id", ctx.customerId)
      .maybeSingle()
      .then((r) => r.data),
    sb
      .from("customer_preferences")
      .select("language")
      .eq("customer_id", ctx.customerId)
      .maybeSingle()
      .then((r) => r.data),
  ]);

  const sub = subsRes.find((s) => s.status === "ACTIVE");
  if (!sub) {
    throw new ApiHttpError(404, "subscription_not_found", "No active subscription");
  }
  const subscription = mapToSubscription(sub, ctx.customerId);

  const balance = balanceRes?.balance ?? 0;
  const tierEarned = !!balanceRes?.tier_earned_at;

  // Active reward + puzzle (if any reward still unclaimed)
  let activeReward: PuzzleState | null = null;
  try {
    const rewardId = await getActiveRewardForCustomer(ctx.customerId);
    if (rewardId) {
      activeReward = computePuzzleState(balance, rewardId);
    }
  } catch (err) {
    console.warn("[hub-dashboard] active reward lookup failed:", err);
  }

  // Next event for the customer's preferred city (TODO: derive from address; default Madrid for MVP)
  const lang = (prefsRes?.language as "en" | "es") ?? "en";
  let nextEvent: EventListItem | null = null;
  const { data: ev } = await sb
    .from("events")
    .select("id, city, title_en, title_es, description_en, description_es, datetime, hero_image, ticket_url")
    .eq("city", "madrid")
    .eq("status", "active")
    .gte("datetime", new Date().toISOString())
    .order("datetime", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (ev) {
    const { data: bookmark } = await sb
      .from("event_bookmarks")
      .select("event_id")
      .eq("customer_id", ctx.customerId)
      .eq("event_id", ev.id)
      .maybeSingle();
    nextEvent = {
      id: ev.id,
      city: ev.city as "madrid" | "barcelona",
      title: lang === "es" ? ev.title_es : ev.title_en,
      description: lang === "es" ? ev.description_es ?? "" : ev.description_en ?? "",
      datetime: ev.datetime,
      heroImage: ev.hero_image,
      ticketUrl: ev.ticket_url,
      saved: !!bookmark,
    };
  }

  return {
    subscription,
    drops: { balance, tierEarned, activeReward },
    nextEvent,
  };
});

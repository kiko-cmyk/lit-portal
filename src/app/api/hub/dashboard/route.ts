import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { langFromRequest } from "@/lib/request-lang";
import { computePuzzleState, getActiveRewardForCustomer } from "@/lib/drops";
import { mapToSubscription, seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { supabaseAdmin } from "@/lib/supabase";
import type {
  EventListItem,
  HubDashboard,
  PuzzleState,
  UpcomingShipment,
} from "@/lib/types";

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
  assertSubscriptionBelongsToCustomer(sub, email, "hub/dashboard");
  const subscription = mapToSubscription(sub, ctx.customerId);

  // Cache the customer → seal_subscription_id mapping so the plan route
  // can skip the ~3-5 s pagination scan when verifying ownership. Fire
  // and forget — we don't block the dashboard response on this write.
  // The mapping is also used by other routes that need a fast lookup.
  sb.from("subscriptions")
    .upsert(
      {
        customer_id: ctx.customerId,
        seal_subscription_id: String(sub.id),
        box_count: subscription.boxCount,
        frequency: subscription.frequency,
        flavor: subscription.flavor,
        next_ship_date: subscription.nextShipDate,
        next_box_number: subscription.nextBoxNumber,
        status: subscription.status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "customer_id" },
    )
    .then((r) => {
      if (r.error) console.warn("[hub-dashboard] subscriptions cache upsert failed:", r.error);
    });

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
  // Prefer the URL locale (forwarded by the api-client as `?lang=`) so the
  // event card follows the language toggle; fall back to the persisted pref.
  const lang = langFromRequest(req) ?? (prefsRes?.language as "en" | "es") ?? "en";
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

  // All upcoming shipments Seal has pre-scheduled. The "next" one is already
  // surfaced via subscription.nextShipDate; everything after that goes into
  // upcomingShipments so the Hub can render the full delivery calendar.
  const completedCount = (sub.billing_attempts ?? []).filter(
    (ba) => ba.completed_at,
  ).length;
  const upcomingShipments: UpcomingShipment[] = (sub.billing_attempts ?? [])
    .filter((ba) => !ba.completed_at && !ba.status && !ba.skipped_on && ba.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(1) // drop the first — that's subscription.nextShipDate
    .map((ba, idx) => ({
      date: ba.date,
      boxNumber: completedCount + 2 + idx,
    }));

  return {
    subscription,
    drops: { balance, tierEarned, activeReward },
    nextEvent,
    upcomingShipments,
  };
});

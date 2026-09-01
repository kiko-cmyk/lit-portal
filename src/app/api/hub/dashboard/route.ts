import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { langFromRequest } from "@/lib/request-lang";
import { computePuzzleState, getActiveRewardForCustomer } from "@/lib/drops";
import { profileSurveyEnabledFor } from "@/lib/flags";
import { getNextBillingAttempt, mapToSubscription, seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { resolveActiveSubFast } from "@/lib/sub-resolve";
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
  const requestedSubId = url.searchParams.get("seal_subscription_id"); // multi-sub selector
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) throw new ApiHttpError(404, "customer_not_found", "");

  const sb = supabaseAdmin();

  // Parallel fetches. Sub resolution tries the fast path (cached Seal id →
  // 1 by-id call) instead of the full multi-page email scan; balance + prefs
  // load alongside it.
  const [fastSub, balanceRes, prefsRes] = await Promise.all([
    resolveActiveSubFast(ctx.customerId, email, requestedSubId),
    sb
      .from("drops_balances")
      .select("balance, tier_earned_at")
      .eq("customer_id", ctx.customerId)
      .maybeSingle()
      .then((r) => r.data),
    sb
      .from("customer_preferences")
      .select("language, cancel_count, last_cancelled_at")
      .eq("customer_id", ctx.customerId)
      .maybeSingle()
      .then((r) => r.data),
  ]);

  // Fallback to the full scan on a cache miss (cold first load, or stale id).
  let sub: SealSubscription | null = fastSub;
  if (!sub && requestedSubId) {
    // Explicit selection not resolvable/owned → 404, don't silently show another sub.
    throw new ApiHttpError(404, "subscription_not_found", `No subscription ${requestedSubId}`);
  }
  if (!sub) {
    const subsRes = await seal.getSubscriptionsByEmail(email);
    sub = subsRes.find((s) => s.status === "ACTIVE") ?? null;
    // Resume surface (2026-07-28): a PAUSED sub matched NOTHING here — not the
    // ACTIVE pick above, not the CANCELLED fallback below — so all 86 paused
    // customers hit the 404 and were shown the "buy a subscription" EmptyState,
    // the same orphan-sub trap the reactivation surface below was built to fix.
    // Their only working resume button was the one inside Seal's own portal.
    // mapStatus turns this into "paused" and the Hub renders the resume card.
    // No eligibility gate: a pause is not a cancel, there is no hold window and
    // nothing to restore, so a paused sub is always resumable.
    if (!sub) {
      // Status ONLY, not `paused_on`. A resume does clear that timestamp (probed
      // 2026-07-29), but a sub that goes PAUSED -> CANCELLED keeps it forever, and
      // two such subs exist today. Filtering on it would shadow the reactivation
      // branch below and show a cancelled customer a resume button that bypasses
      // the cancel policy.
      sub =
        subsRes
          .filter((s) => s.status === "PAUSED")
          .sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0] ?? null;
    }
    // Reactivation surface (audit 2026-07-08): portal cancels are IMMEDIATE
    // in Seal (no cancellation_scheduled_for), so a cancelled customer who
    // comes back has no ACTIVE sub and used to 404 here — the Hub then showed
    // the "buy a new subscription" EmptyState, never the ReactivateCard, even
    // inside the 90-day drops-hold window (the "sub orfana 13635794" pattern:
    // they buy a SECOND sub instead of reactivating). If they're still
    // eligible to reactivate (first cancel, within the window — mirrors
    // /api/subscription/reactivate), surface the most recent cancelled sub;
    // mapStatus turns it into "expired" and the Hub renders the ReactivateCard.
    if (!sub) {
      const HOLD_DAYS = 90;
      const eligibleToReactivate =
        (prefsRes?.cancel_count ?? 0) === 1 &&
        !!prefsRes?.last_cancelled_at &&
        Date.now() - new Date(prefsRes.last_cancelled_at as string).getTime() <=
          HOLD_DAYS * 24 * 60 * 60 * 1000;
      if (eligibleToReactivate) {
        sub =
          subsRes
            .filter((s) => s.status === "CANCELLED" || !!s.cancellation_scheduled_for)
            .sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0] ?? null;
      }
    }
  }
  if (!sub) {
    throw new ApiHttpError(404, "subscription_not_found", "No active subscription");
  }
  assertSubscriptionBelongsToCustomer(sub, email, "hub/dashboard");

  // Opportunistic re-anchor drain. After a plan change, the FE silently
  // re-polls this dashboard every 5 s for 60 s — by then Seal has usually
  // finished regenerating billing_attempts. If a "preserve next-ship date"
  // intent is still pending, apply it now: shift the regenerated schedule
  // forward so the next charge holds on the preserved date and the new cadence
  // runs from there. This makes the fix work even without the Seal webhook /
  // sub-daily cron firing first. seal.reanchorCadence is idempotent.
  let reanchorPending = false;
  try {
    const { data: intent } = await sb
      .from("subscription_reanchor_intents")
      .select("preserve_date, seal_subscription_id")
      .eq("customer_id", ctx.customerId)
      .eq("seal_subscription_id", String(sub.id))
      .eq("status", "pending")
      .maybeSingle();
    if (intent && String(intent.seal_subscription_id) === String(sub.id)) {
      const preserve = String(intent.preserve_date).slice(0, 10);
      const firstDay = getNextBillingAttempt(sub)?.date?.slice(0, 10) ?? null;
      if (isWithinCutoff(`${preserve}T13:00:00Z`)) {
        await sb
          .from("subscription_reanchor_intents")
          .delete()
          .eq("customer_id", ctx.customerId)
          .eq("seal_subscription_id", String(sub.id));
      } else if (firstDay && firstDay < preserve) {
        await seal.reanchorCadence(Number(sub.id), preserve);
        const refreshed = await seal.getSubscriptionById(Number(sub.id));
        if (refreshed) sub = refreshed;
        await sb
          .from("subscription_reanchor_intents")
          .delete()
          .eq("customer_id", ctx.customerId)
          .eq("seal_subscription_id", String(sub.id));
      } else if (firstDay && firstDay >= preserve) {
        // Already on/after preserve — converged, clear the intent.
        await sb
          .from("subscription_reanchor_intents")
          .delete()
          .eq("customer_id", ctx.customerId)
          .eq("seal_subscription_id", String(sub.id));
      } else {
        // firstDay null → Seal still regenerating; leave intent for next poll.
        // The Hub keeps the "updating your calendar" banner up while this holds.
        reanchorPending = true;
      }
    }
  } catch (err) {
    console.warn("[hub-dashboard] reanchor drain failed:", err);
  }

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
        // Mix summary, not the dominant label — see the seal webhook for why.
        flavor: subscription.flavorSummary,
        composition: subscription.composition,
        shape: subscription.shape,
        line_count: subscription.lines.length,
        charge_total_cents: subscription.chargeTotalCents,
        next_ship_date: subscription.nextShipDate,
        next_box_number: subscription.nextBoxNumber,
        status: subscription.status,
        updated_at: new Date().toISOString(),
      },
      // Multi-sub: cache one row per (customer, sub). Composite matches the
      // subscriptions PK after the flip. (customer,seal_subscription_id).
      { onConflict: "customer_id,seal_subscription_id" },
    )
    .then((r) => {
      if (r.error) console.warn("[hub-dashboard] subscriptions cache upsert failed:", r.error);
    });

  const balance = balanceRes?.balance ?? 0;
  const tierEarned = !!balanceRes?.tier_earned_at;
  const tierEarnedAt = (balanceRes?.tier_earned_at as string | null) ?? null;

  // Post-cancel: expose the drops-hold deadline so the ReactivateCard can say
  // "X drops held N more days". The FE line existed since the hi-fi but the
  // field was never sent, so the 90-day urgency never rendered (audit
  // 2026-07-08). Null for 2nd+ cancels / retained-active-sub cancels (no hold).
  let dropsReleaseAt: string | null = null;
  if (subscription.status === "post_cancel" || subscription.status === "expired") {
    try {
      const { data: lastCancel } = await sb
        .from("cancellations")
        .select("drops_release_at")
        .eq("customer_id", ctx.customerId)
        .eq("seal_subscription_id", String(sub.id))
        .eq("status", "confirmed")
        .order("confirmed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      dropsReleaseAt = (lastCancel?.drops_release_at as string | null) ?? null;
    } catch (err) {
      console.warn("[hub-dashboard] drops hold lookup failed:", err);
    }
  }

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

  // Perfilado. Va DENTRO de esta respuesta y no en una llamada aparte: el Hub
  // ya hace varias en paralelo y añadir un round-trip para pintar una tarjeta
  // retrasa la pantalla entera. `answered` sale de la lápida además de la fila,
  // para que a quien pidió el borrado no se le vuelva a ofrecer como si nunca
  // hubiera contestado.
  let profileSurvey = { enabled: false, answered: false };
  try {
    if (profileSurveyEnabledFor(ctx.customerId)) {
      const { data: psRow } = await sb
        .from("profile_survey_answers")
        .select("answers, deleted_at")
        .eq("customer_id", ctx.customerId)
        .maybeSingle();
      const answered =
        !!psRow && !psRow.deleted_at && Object.keys(psRow.answers ?? {}).length > 0;
      profileSurvey = { enabled: true, answered };
    }
  } catch (err) {
    // Si la tabla aún no existe en este entorno, la tarjeta no se enseña y el
    // Hub carga igual. Nunca al revés: un formulario opcional no puede tumbar
    // la pantalla principal del área personal.
    console.warn("[hub-dashboard] profile survey lookup failed:", err);
  }

  return {
    subscription,
    drops: { balance, tierEarned, activeReward, tierEarnedAt, dropsReleaseAt },
    nextEvent,
    upcomingShipments,
    reanchorPending,
    profileSurvey,
  };
});

import { NextResponse, type NextRequest } from "next/server";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { awardDrops, DROPS_AMOUNTS } from "@/lib/drops";
import { mapStatus, seal } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/cron/monthly-streak
 * Monthly (1st of each month): awards +50 Drops to every active subscriber,
 * and bumps `customer_preferences.streak_months` (or maintains based on
 * subscription status).
 *
 * Idempotency: two layers. (1) tag each drops_event with
 * `metadata.streakMonth: 'YYYY-MM'` and skip candidates already tagged this
 * month; (2) pass a `dedupKey` (`streak:<customer>:<month>`) to awardDrops so a
 * retry/overlap is a no-op at the DB level via the `uq_drops_events_dedup_key`
 * unique index (added in #12). Either alone is enough; together they make the
 * cron safe to re-run within the month.
 *
 * Source of "active subscriber": Supabase `subscriptions.status = 'active'`
 * (synced via Seal webhook subscription.created/updated). That cache is the
 * ONLY writer of subscriptions.status, so a lost cancel/pause webhook can leave
 * a row stale-'active' and we'd award a streak to a sub Seal no longer treats
 * as active. C2 (Juan's review): re-verify each candidate against Seal LIVE
 * before awarding. We only skip on an AFFIRMATIVE non-active status; if Seal is
 * unreachable (null/throw) we fall back to the cache and award, so a transient
 * Seal blip never denies a legitimate streak.
 *
 * Scale (Juan's review): that live check is one Seal round-trip per active sub
 * (~1300 today). Running them serially would blow the `maxDuration: 60` cap and
 * cut the cron off mid-list — head subs paid, tail subs unpaid until next month
 * (Vercel Cron doesn't retry within the month). So candidates are processed in
 * bounded-concurrency waves of POOL, the same pattern as
 * `seal.listAllSubscriptions`. ~1300 checks fit in ~30-40s under the cap. If the
 * book keeps growing, the next step is to paginate the cron across invocations
 * (the dedupKey makes overlapping invocations safe).
 */
const POOL = 12;

type Outcome = "awarded" | "skipped" | "staleSkipped" | "errored";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireCron(req);
  } catch (err) {
    if (err instanceof CronAuthError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const sb = supabaseAdmin();
  const monthTag = new Date().toISOString().slice(0, 7); // "YYYY-MM"

  // List active subscribers (per the Supabase cache)
  const { data: subs, error } = await sb
    .from("subscriptions")
    .select("customer_id, seal_subscription_id")
    .eq("status", "active");
  if (error) throw new Error(`monthly-streak: ${error.message}`);

  const amount = DROPS_AMOUNTS.monthly_streak ?? 50;
  const targets = subs ?? [];

  // Process one candidate: skip if already awarded this month, re-verify the
  // status against Seal live, then award. Logic is unchanged from the serial
  // version — only the surrounding execution is concurrent.
  const processOne = async (sub: (typeof targets)[number]): Promise<Outcome> => {
    // Already awarded this month? (also spares a wasted Seal call on a re-run)
    const { data: prior } = await sb
      .from("drops_events")
      .select("id")
      .eq("customer_id", sub.customer_id)
      .eq("action", "monthly_streak")
      .filter("metadata->>streakMonth", "eq", monthTag)
      .maybeSingle();
    if (prior) return "skipped";

    // C2: re-verify status against Seal live before awarding. Closes the
    // stale-'active' leak (a lost cancel/pause webhook). Only skip on a
    // definitive non-active status; on null/error fall back to the cache so a
    // transient Seal failure never denies a legitimate streak.
    if (sub.seal_subscription_id) {
      try {
        const live = await seal.getSubscriptionById(Number(sub.seal_subscription_id));
        if (live && mapStatus(live) !== "active") return "staleSkipped";
      } catch (err) {
        console.warn(
          `[monthly-streak] Seal status check failed for ${sub.customer_id}, falling back to cache:`,
          err,
        );
      }
    }

    try {
      await awardDrops(
        sub.customer_id,
        "monthly_streak",
        amount,
        { streakMonth: monthTag },
        `streak:${sub.customer_id}:${monthTag}`,
      );
      return "awarded";
    } catch (err) {
      console.warn(`[monthly-streak] awardDrops failed for ${sub.customer_id}:`, err);
      return "errored";
    }
  };

  const tally: Record<Outcome, number> = { awarded: 0, skipped: 0, staleSkipped: 0, errored: 0 };
  for (let start = 0; start < targets.length; start += POOL) {
    const wave = targets.slice(start, start + POOL).map(processOne);
    for (const outcome of await Promise.all(wave)) {
      tally[outcome]++;
    }
  }

  return NextResponse.json({
    ok: true,
    monthTag,
    candidates: targets.length,
    awarded: tally.awarded,
    skipped: tally.skipped,
    staleSkipped: tally.staleSkipped,
    errored: tally.errored,
  });
}

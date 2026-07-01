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
 * Scale (Juan's review, round 2): that live check is one Seal round-trip per
 * active sub (~1300 today). Serially that blows the `maxDuration: 60` cap and
 * cuts the cron off mid-list — head subs paid, tail subs unpaid until next month
 * (Vercel Cron doesn't retry within the month). So the checks run through a
 * sliding pool of POOL workers that each pull the next candidate off a shared
 * cursor. This beats fixed waves (`Promise.all` over slices): with waves every
 * worker idles until its batch's slowest Seal call returns (head-of-line
 * blocking), so a POOL=12 wave run is ~62s typical (the earlier "~30-40s" was
 * best-case, not typical) and brushes the cap. The sliding pool has no per-batch
 * barrier, so wall-clock tracks the average call (~41s typical at POOL=12), and
 * `AbortSignal.timeout` bounds any single hung call so it can't stall its worker.
 * If the book keeps growing, the next step is to paginate the cron across
 * invocations (the dedupKey makes overlapping invocations safe).
 */
const POOL = 12;
// Cap a single Seal status check so one hung call can't stall its pool worker.
// On timeout getSubscriptionById throws AbortError → caught below → we fall back
// to the cache and award (the same fail-open posture as any other Seal failure).
const SEAL_CALL_TIMEOUT_MS = 6000;

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
        const live = await seal.getSubscriptionById(
          Number(sub.seal_subscription_id),
          AbortSignal.timeout(SEAL_CALL_TIMEOUT_MS),
        );
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

  // Sliding pool: POOL workers each pull the next candidate off a shared cursor
  // and keep going until the list drains — no per-batch barrier, so no worker
  // idles behind another's slow Seal call. `cursor++` needs no lock: JS is
  // single-threaded and there's no await between reading and incrementing it, so
  // no two workers ever grab the same index (same for `tally[...]++`, which runs
  // synchronously right after each await resolves).
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const outcome = await processOne(targets[cursor++]);
      tally[outcome]++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, targets.length) }, worker));

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

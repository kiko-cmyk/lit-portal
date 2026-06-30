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
 * Idempotency: tag each drops_event with `metadata.streakMonth: 'YYYY-MM'`.
 * Inserting twice for the same customer + same month is harmless because the
 * event log is append-only and the trigger recomputes balance.
 *
 * Source of "active subscriber": Supabase `subscriptions.status = 'active'`
 * (synced via Seal webhook subscription.created/updated). That cache is the
 * ONLY writer of subscriptions.status, so a lost cancel/pause webhook can leave
 * a row stale-'active' and we'd award a streak to a sub Seal no longer treats
 * as active. C2 (Juan's review): re-verify each candidate against Seal LIVE
 * before awarding. We only skip on an AFFIRMATIVE non-active status; if Seal is
 * unreachable (null/throw) we fall back to the cache and award, so a transient
 * Seal blip never denies a legitimate streak.
 */
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
  let awarded = 0;
  let skipped = 0;
  let staleSkipped = 0;

  for (const sub of subs ?? []) {
    // Check if we already awarded this month
    const { data: prior } = await sb
      .from("drops_events")
      .select("id")
      .eq("customer_id", sub.customer_id)
      .eq("action", "monthly_streak")
      .filter("metadata->>streakMonth", "eq", monthTag)
      .maybeSingle();

    if (prior) {
      skipped++;
      continue;
    }

    // C2: re-verify status against Seal live before awarding. Closes the
    // stale-'active' leak (a lost cancel/pause webhook). Only skip on a
    // definitive non-active status; on null/error fall back to the cache so a
    // transient Seal failure never denies a legitimate streak.
    if (sub.seal_subscription_id) {
      try {
        const live = await seal.getSubscriptionById(Number(sub.seal_subscription_id));
        if (live && mapStatus(live) !== "active") {
          staleSkipped++;
          continue;
        }
      } catch (err) {
        console.warn(
          `[monthly-streak] Seal status check failed for ${sub.customer_id}, falling back to cache:`,
          err,
        );
      }
    }

    try {
      await awardDrops(sub.customer_id, "monthly_streak", amount, { streakMonth: monthTag });
      awarded++;
    } catch (err) {
      console.warn(`[monthly-streak] awardDrops failed for ${sub.customer_id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, monthTag, awarded, skipped, staleSkipped });
}

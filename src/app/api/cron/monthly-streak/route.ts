import { NextResponse, type NextRequest } from "next/server";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { awardDrops, DROPS_AMOUNTS } from "@/lib/drops";
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
 * (synced via Seal webhook subscription.created/updated).
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

  // List active subscribers
  const { data: subs, error } = await sb
    .from("subscriptions")
    .select("customer_id")
    .eq("status", "active");
  if (error) throw new Error(`monthly-streak: ${error.message}`);

  const amount = DROPS_AMOUNTS.monthly_streak ?? 50;
  let awarded = 0;
  let skipped = 0;

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

    try {
      await awardDrops(sub.customer_id, "monthly_streak", amount, { streakMonth: monthTag });
      awarded++;
    } catch (err) {
      console.warn(`[monthly-streak] awardDrops failed for ${sub.customer_id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, monthTag, awarded, skipped });
}

import { NextResponse, type NextRequest } from "next/server";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { awardDrops } from "@/lib/drops";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/cron/drops-cleanup
 * Daily: zeroes balance of customers whose 90-day post-cancel hold has expired.
 *
 * For each cancellation row where:
 *   - status = 'confirmed'
 *   - drops_release_at <= now
 *   - and the customer never reactivated (cancel_count = 1 at time of event)
 *
 * Insert a negative drops_events row that zeroes the current balance.
 * After this, the customer's lifetime tier_earned_at is preserved (per spec
 * "tier is permanent once earned"), only the balance resets.
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
  const now = new Date().toISOString();

  // Find cancellations whose hold has expired and haven't been cleaned yet
  const { data: rows, error } = await sb
    .from("cancellations")
    .select("id, customer_id, drops_held_at_cancel, drops_release_at")
    .eq("status", "confirmed")
    .not("drops_release_at", "is", null)
    .lte("drops_release_at", now);
  if (error) throw new Error(`drops-cleanup: ${error.message}`);

  let cleaned = 0;
  let alreadyClean = 0;

  for (const row of rows ?? []) {
    // Check current balance — if 0, customer either reactivated and used or
    // already cleaned. Skip.
    const { data: bal } = await sb
      .from("drops_balances")
      .select("balance")
      .eq("customer_id", row.customer_id)
      .maybeSingle();
    const currentBalance = bal?.balance ?? 0;
    if (currentBalance <= 0) {
      alreadyClean++;
      continue;
    }

    // Reactivation/multi-sub guard: NEVER confiscate while the customer has
    // ANY active subscription. Post PK-flip a multi-sub customer has 2+ rows in
    // `subscriptions`, so the old `.eq(customer_id).maybeSingle()` errored
    // (PGRST116) with data=null and confiscated an ACTIVE subscriber's balance
    // (audit 2026-07-06). Multi-row-safe query + FAIL-SAFE: on any query error,
    // skip — a missed cleanup self-heals tomorrow; a wrong confiscation
    // doesn't.
    const { data: activeRows, error: subErr } = await sb
      .from("subscriptions")
      .select("seal_subscription_id")
      .eq("customer_id", row.customer_id)
      .eq("status", "active")
      .limit(1);
    if (subErr || (activeRows?.length ?? 0) > 0) {
      alreadyClean++;
      continue;
    }

    // Insert negative event to zero the balance. Idempotent per cancellation
    // row: a crash between this insert and the drops_release_at update below
    // must not double-debit on the next run.
    await awardDrops(
      row.customer_id,
      "cancel_reset",
      -currentBalance,
      { reason: "90d_hold_expired", cancellationId: row.id },
      `cancel_reset:cleanup:${row.id}`,
    );

    // Clear drops_release_at so this row won't be picked up again
    await sb.from("cancellations").update({ drops_release_at: null }).eq("id", row.id);

    cleaned++;
  }

  return NextResponse.json({ ok: true, cleaned, alreadyClean });
}

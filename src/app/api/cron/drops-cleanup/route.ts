import { NextResponse, type NextRequest } from "next/server";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
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

    // Check if this customer reactivated AFTER this cancellation. If so, skip
    // (their balance was restored, no cleanup applies).
    const { data: prefs } = await sb
      .from("customer_preferences")
      .select("cancel_count, last_cancelled_at")
      .eq("customer_id", row.customer_id)
      .maybeSingle();
    const subStatus = await sb
      .from("subscriptions")
      .select("status")
      .eq("customer_id", row.customer_id)
      .maybeSingle();
    if (subStatus.data?.status === "active") {
      // Reactivated — leave balance alone
      alreadyClean++;
      continue;
    }
    void prefs;

    // Insert negative event to zero the balance
    await sb.from("drops_events").insert({
      customer_id: row.customer_id,
      action: "cancel_reset",
      amount: -currentBalance,
      metadata: { reason: "90d_hold_expired", cancellationId: row.id },
    });

    // Clear drops_release_at so this row won't be picked up again
    await sb.from("cancellations").update({ drops_release_at: null }).eq("id", row.id);

    cleaned++;
  }

  return NextResponse.json({ ok: true, cleaned, alreadyClean });
}

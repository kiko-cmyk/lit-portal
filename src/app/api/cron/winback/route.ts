import { NextResponse, type NextRequest } from "next/server";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { klaviyo } from "@/lib/klaviyo";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/cron/winback
 * Daily: scans confirmed cancellations, fires `winback_d14` and `winback_d30`
 * events for those reaching their 14th/30th day post-cancellation.
 *
 * Idempotency: Klaviyo dedupes events by metric+profile+timestamp+properties
 * but we also tag with `windowDay` so each customer fires each day at most once.
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
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  // Dedup: each winback event fires at most ONCE per customer. The window below
  // is deliberately 2 days wide (resilient to a missed daily run), which WITHOUT
  // dedup double-sent the same event on two consecutive runs. Mirror the
  // renewal-reminder pattern: one upfront email_logs lookup + a row written after
  // each successful fire (template_id = the event name).
  const { data: sentRows, error: dedupErr } = await sb
    .from("email_logs")
    .select("customer_id, template_id")
    .in("template_id", ["winback_d14", "winback_d30"])
    .gte("sent_at", new Date(now - 45 * day).toISOString());
  if (dedupErr) throw new Error(`winback dedup query failed: ${dedupErr.message}`);
  const alreadySent = new Set<string>(
    ((sentRows ?? []) as Array<{ customer_id: string; template_id: string }>).map(
      (r) => `${r.customer_id}:${r.template_id}`,
    ),
  );

  // Window: cancellations confirmed between (today-15) and (today-13) → fire D14
  // Window: cancellations confirmed between (today-31) and (today-29) → fire D30
  const fireFor = async (offset: 14 | 30): Promise<number> => {
    const lower = new Date(now - (offset + 1) * day).toISOString();
    const upper = new Date(now - (offset - 1) * day).toISOString();
    const { data, error } = await sb
      .from("cancellations")
      .select("customer_id, confirmed_at")
      .eq("status", "confirmed")
      .gte("confirmed_at", lower)
      .lt("confirmed_at", upper);
    if (error) throw new Error(`winback ${offset}: ${error.message}`);
    let fired = 0;
    const event = offset === 14 ? "winback_d14" : "winback_d30";
    for (const row of data ?? []) {
      // Already sent this event to this customer → skip (dedup).
      if (alreadySent.has(`${row.customer_id}:${event}`)) continue;
      // Multi-sub / reactivation guard (audit 2026-07-06): never "win back" a
      // customer who still pays — cancelled 1 of 2 subs, or cancelled and
      // reactivated. Cache check (multi-row safe); on query error err toward
      // NOT emailing a paying customer.
      const { data: activeRows, error: activeErr } = await sb
        .from("subscriptions")
        .select("seal_subscription_id")
        .eq("customer_id", row.customer_id)
        .eq("status", "active")
        .limit(1);
      if (activeErr || (activeRows?.length ?? 0) > 0) continue;
      const email = await shopifyAdmin.getCustomerEmail(row.customer_id).catch(() => null);
      if (!email) continue;
      try {
        await klaviyo.trackEvent(event, email, {
          cancelledAt: row.confirmed_at,
          windowDay: offset,
        });
      } catch (err) {
        // PII sweep 2026-05-22: log customer_id not email.
        console.warn(`[winback ${offset}] klaviyo failed for customer ${row.customer_id}:`, err);
        continue;
      }
      // Persist the dedup marker right after the successful fire so the 2-day
      // window never double-sends. A lost marker (insert error) is logged and at
      // worst risks one resend, never a crash.
      const { error: logErr } = await sb
        .from("email_logs")
        .insert({ customer_id: row.customer_id, template_id: event, metadata: { windowDay: offset } });
      if (logErr) {
        console.warn(`[winback ${offset}] email_logs insert failed for customer ${row.customer_id}:`, logErr.message);
      }
      alreadySent.add(`${row.customer_id}:${event}`);
      fired++;
    }
    return fired;
  };

  const d14 = await fireFor(14);
  const d30 = await fireFor(30);

  return NextResponse.json({ ok: true, fired: { d14, d30 } });
}

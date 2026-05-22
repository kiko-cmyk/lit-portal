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
    for (const row of data ?? []) {
      const email = await shopifyAdmin.getCustomerEmail(row.customer_id).catch(() => null);
      if (!email) continue;
      const event = offset === 14 ? "winback_d14" : "winback_d30";
      try {
        await klaviyo.trackEvent(event, email, {
          cancelledAt: row.confirmed_at,
          windowDay: offset,
        });
        fired++;
      } catch (err) {
        // PII sweep 2026-05-22: log customer_id not email.
        console.warn(`[winback ${offset}] klaviyo failed for customer ${row.customer_id}:`, err);
      }
    }
    return fired;
  };

  const d14 = await fireFor(14);
  const d30 = await fireFor(30);

  return NextResponse.json({ ok: true, fired: { d14, d30 } });
}

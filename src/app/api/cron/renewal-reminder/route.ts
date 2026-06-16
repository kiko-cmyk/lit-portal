import { NextResponse, type NextRequest } from "next/server";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { klaviyo } from "@/lib/klaviyo";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/cron/renewal-reminder
 * Daily: fires `subscription_renewal_reminder` for active subscriptions whose
 * next charge is ~2 days away (48h email) and ~1 day away (24h email). The
 * Klaviyo flow keyed on this metric branches on `hoursBefore` (48 vs 24) and
 * sends the email; its primary CTA deep-links to /apps/portal/{locale}/skip.
 *
 * Why a cron and not a Seal webhook: Seal only emits POST-charge webhooks
 * (billing_attempt.succeeded/failed), never a pre-charge "upcoming" event, so
 * the only way to remind BEFORE the charge is to scan the cached ship dates.
 * We read `subscriptions.next_ship_date` (kept current by the Seal webhook
 * sync) instead of hitting Seal — same approach as the winback cron.
 *
 * Windows (24h-wide so a single daily run tiles them without gaps/overlaps):
 *   48h bucket → next_ship_date in [now+36h, now+60h)
 *   24h bucket → next_ship_date in [now+12h, now+36h)
 * A box shipping Wed lands in the 48h bucket on Mon's run and the 24h bucket
 * on Tue's run, so each customer gets one of each, roughly 2 days / 1 day out.
 *
 * Idempotency: before firing we check `email_logs` for an existing
 * (customer_id, template_id, metadata.shipDate) row, and write one after — so
 * re-running the cron the same day never double-sends.
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
  const H = 60 * 60 * 1000;

  const buckets = [
    { hoursBefore: 48, templateId: "renewal_reminder_48h", lowerH: 36, upperH: 60 },
    { hoursBefore: 24, templateId: "renewal_reminder_24h", lowerH: 12, upperH: 36 },
  ] as const;

  const fireFor = async (bucket: (typeof buckets)[number]): Promise<number> => {
    const lower = new Date(now + bucket.lowerH * H).toISOString();
    const upper = new Date(now + bucket.upperH * H).toISOString();

    const { data, error } = await sb
      .from("subscriptions")
      .select("customer_id, seal_subscription_id, box_count, frequency, flavor, next_ship_date")
      .eq("status", "active")
      .gte("next_ship_date", lower)
      .lt("next_ship_date", upper);
    if (error) throw new Error(`renewal-reminder ${bucket.hoursBefore}h: ${error.message}`);

    let fired = 0;
    for (const row of data ?? []) {
      if (!row.next_ship_date) continue;
      // Dedup key: one reminder per (customer, bucket, ship occurrence).
      const shipDate = String(row.next_ship_date).slice(0, 10); // YYYY-MM-DD

      const { data: already } = await sb
        .from("email_logs")
        .select("id")
        .eq("customer_id", row.customer_id)
        .eq("template_id", bucket.templateId)
        .eq("metadata->>shipDate", shipDate)
        .limit(1);
      if (already && already.length > 0) continue;

      const email = await shopifyAdmin
        .getCustomerEmail(row.customer_id)
        .catch(() => null);
      if (!email) continue;

      const { data: pref } = await sb
        .from("customer_preferences")
        .select("language")
        .eq("customer_id", row.customer_id)
        .maybeSingle();
      const locale = pref?.language === "en" ? "en" : "es";

      try {
        await klaviyo.trackEvent("subscription_renewal_reminder", email, {
          hoursBefore: bucket.hoursBefore,
          sealSubscriptionId: String(row.seal_subscription_id),
          nextShipDate: row.next_ship_date,
          boxCount: row.box_count,
          frequency: row.frequency,
          flavor: row.flavor,
          locale,
        });
        await sb.from("email_logs").insert({
          customer_id: row.customer_id,
          template_id: bucket.templateId,
          metadata: { shipDate, hoursBefore: bucket.hoursBefore },
        });
        fired++;
      } catch (err) {
        // PII sweep: log customer_id, not email.
        console.warn(
          `[renewal-reminder ${bucket.hoursBefore}h] klaviyo failed for customer ${row.customer_id}:`,
          err,
        );
      }
    }
    return fired;
  };

  const h48 = await fireFor(buckets[0]);
  const h24 = await fireFor(buckets[1]);

  return NextResponse.json({ ok: true, fired: { h48, h24 } });
}

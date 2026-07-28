import { NextResponse, type NextRequest } from "next/server";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { klaviyo } from "@/lib/klaviyo";
import { alertSlackError } from "@/lib/alert";
import { type FlavorComposition, shortLabel } from "@/lib/mix";
import { priceForBoxCount } from "@/lib/pricing";
import {
  extractFlavorSummary,
  getBoxCount,
  getChargeTotalCents,
  getComposition,
  getLines,
  getNextBillingAttempt,
  getShape,
  mapStatus,
  normalizeFrequency,
  seal,
} from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/cron/renewal-reminder
 * Daily: fires `subscription_renewal_reminder` (hoursBefore=48) for every
 * active subscription whose next charge is ~2 days away. The Klaviyo flow keyed
 * on this metric sends the 48h email; its primary CTA deep-links to
 * /apps/portal/{locale}/mi-lit?action=skip.
 *
 * SOURCE OF TRUTH = SEAL, NOT THE SUPABASE CACHE.
 * Earlier this cron scanned `subscriptions.next_ship_date` in Supabase, but that
 * table is only a webhook-populated cache: it held ~20% of the live book (the
 * subs that happened to fire a webhook since the webhook was wired up) and went
 * stale when a `billing_attempt.succeeded` was missed (active rows stuck on a
 * past ship date). Result: it fired ~1-2 events/day against a real ~12-26/day of
 * renewals, so almost no reminders went out. We now scan Seal's full book
 * (`seal.listAllSubscriptions`) and read the real next pending billing attempt.
 *
 * Why a cron and not a Seal webhook: Seal only emits POST-charge webhooks
 * (billing_attempt.succeeded/failed), never a pre-charge "upcoming" event, so the
 * only way to remind BEFORE the charge is to scan upcoming billing attempts.
 *
 * 48h ONLY: the 24h bucket was removed (Juan, 2026-06-24) — the 24h branch was
 * deleted from the Klaviyo flow, so a 24h event sent nothing. A sub first enters
 * the window when its charge is 36-60h out, so the primary reminder lands ~48h
 * before. The window extends down to +12h as a self-healing catch-up tail:
 *   next charge in [now+12h, now+60h)  → fire once (dedup handles the overlap).
 *
 * Idempotency: a single `email_logs` lookup over the last 5 days builds the set
 * of sealSubscriptionIds already reminded (sub-id alone, so a mid-window
 * reschedule across a day boundary doesn't re-send); we skip those and write a
 * row immediately after each successful fire. Re-running the cron the same day,
 * a missed run, or a transient single-fire failure never double-sends — and the
 * catch-up tail re-fires anything that was dropped on the next daily run.
 */

const TEMPLATE_ID = "renewal_reminder_48h";

type Candidate = {
  sealId: string;
  email: string;
  shipDate: string; // YYYY-MM-DD (dedup key + merge tag)
  nextShipDate: string; // full ISO with tz
  boxCount: number;
  frequency: string;
  /** Mix summary when split; the plain flavor label otherwise. */
  flavor: string;
  /** Boxes per flavor, so the 48h email can list a mix. */
  composition: FlavorComposition[];
};

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
  // Primary reminder fires ~48h out: a sub first enters the window when its
  // charge is 36-60h away. The lower bound extends to +12h purely as a
  // self-healing catch-up tail — the same sub reappears on the NEXT daily run
  // (12-36h out), so a missed cron run or a transient Klaviyo failure re-fires
  // the next day instead of being lost forever. Sub-id dedup (below) still
  // guarantees exactly one reminder per renewal.
  const lower = now + 12 * H;
  const upper = now + 60 * H;

  // 1. Scan the whole Seal book and keep ACTIVE subs whose next pending charge
  //    lands in the 48h window. (A failed page propagates → we fail loud rather
  //    than remind a truncated slice of the book.)
  const subs = await seal.listAllSubscriptions();

  const candidates: Candidate[] = [];
  for (const s of subs) {
    if (mapStatus(s) !== "active") continue; // skips paused / post_cancel / cancelled
    const next = getNextBillingAttempt(s);
    if (!next?.date) continue;
    const t = Date.parse(next.date);
    if (Number.isNaN(t) || t < lower || t >= upper) continue;
    const email = s.email?.trim();
    if (!email) continue;
    const boxCount = getBoxCount(s);
    const composition = getComposition(s);

    // ── THE MONEY ASSERTION (flavor mix, 2026-07-28) ──
    //
    // A split subscription carries a CUSTOM per-unit price so a mix costs the same as
    // the equivalent pure plan. If Seal ever refreshes item prices from Shopify (the
    // merchant "propagate product price changes" action, an app update, a price edit),
    // that override is silently replaced by the catalogue price and the customer is
    // over-charged by ~25% with no signal anywhere in the portal.
    //
    // This cron is the only thing that already reads the WHOLE Seal book ~48h before
    // every charge, so it is the cheapest possible early-warning: check the split subs
    // and alert while there is still time to fix it before the card is hit.
    if (getShape(s) === "split") {
      try {
        const expected = Math.round((await priceForBoxCount(boxCount, composition[0].flavor)) * 100);
        const actual = getChargeTotalCents(s);
        // Tolerance = one cent per line: the tier split can legitimately land a cent
        // under (4 boxes as 2+2 is mathematically impossible to hit exactly).
        if (Math.abs(actual - expected) > getLines(s).length) {
          console.error("[renewal-reminder 48h] mix price drift", {
            sealId: s.id, actual, expected, boxCount, charge: next.date,
          });
          alertSlackError({
            path: "/api/cron/renewal-reminder",
            code: "mix_price_drift",
            msg:
              `sub ${s.id}: charge total ${actual}c but the ${boxCount}-box tier is ${expected}c. ` +
              `Seal may have refreshed the item prices and dropped our per-unit price. ` +
              `THE CHARGE LANDS ${next.date.slice(0, 10)} — fix before then.`,
          });
        }
      } catch (e) {
        // Never let the price check stop the reminder from going out.
        console.warn(`[renewal-reminder 48h] price check failed for sub ${s.id}:`, e);
      }
    }

    candidates.push({
      sealId: String(s.id),
      email,
      shipDate: next.date.slice(0, 10),
      nextShipDate: next.date,
      boxCount,
      frequency: normalizeFrequency(s.delivery_interval),
      // The mix summary, so the 48h email names both flavors. A single flavor yields
      // the same string extractFlavor always returned.
      flavor: extractFlavorSummary(s),
      composition,
    });
  }

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, scanned: subs.length, candidates: 0, fired: 0 });
  }

  const sealIds = candidates.map((c) => c.sealId);

  // 2. Dedup: one query for everything reminded in the last 5 days, keyed on
  //    sealSubscriptionId alone (stored in metadata) — so dedup never depends on
  //    a Shopify customer id, and a legitimate reschedule that moves the charge
  //    across a calendar day mid-window does not re-send. The 5-day lookback
  //    bounds it to one reminder per renewal cycle.
  //    FAIL LOUD on a query error: a silent empty dedup set would re-fire the
  //    whole in-window book (up to the ~130-customer month-end spike).
  const { data: sentRows, error: dedupErr } = await sb
    .from("email_logs")
    .select("metadata")
    .eq("template_id", TEMPLATE_ID)
    .gte("sent_at", new Date(now - 5 * 24 * H).toISOString());
  if (dedupErr) {
    throw new Error(`renewal-reminder dedup query failed: ${dedupErr.message}`);
  }
  const alreadySent = new Set<string>(
    ((sentRows ?? []) as Array<{ metadata: { sealSubscriptionId?: string } | null }>)
      .map((r) => r.metadata?.sealSubscriptionId)
      .filter((id): id is string => Boolean(id)),
  );

  // 3. Best-effort enrichment from the Supabase cache (no Shopify calls): a real
  //    customer_id and the persisted language. Subs not in the cache get a
  //    `seal:<id>` placeholder id and Spanish (the only live template language).
  const { data: cacheRows } = await sb
    .from("subscriptions")
    .select("seal_subscription_id, customer_id")
    .in("seal_subscription_id", sealIds);
  const customerBySeal = new Map<string, string>();
  for (const r of (cacheRows ?? []) as Array<{ seal_subscription_id: string | null; customer_id: string | null }>) {
    if (r.seal_subscription_id && r.customer_id) {
      customerBySeal.set(String(r.seal_subscription_id), String(r.customer_id));
    }
  }
  const customerIds = [...new Set(customerBySeal.values())];
  const langByCustomer = new Map<string, string>();
  if (customerIds.length > 0) {
    const { data: prefRows } = await sb
      .from("customer_preferences")
      .select("customer_id, language")
      .in("customer_id", customerIds);
    for (const r of (prefRows ?? []) as Array<{ customer_id: string | null; language: string | null }>) {
      if (r.customer_id) langByCustomer.set(String(r.customer_id), r.language === "en" ? "en" : "es");
    }
  }

  // 4. Fire the event for the not-yet-reminded candidates (bounded concurrency).
  //    Write each dedup row IMMEDIATELY after its successful fire — not in one
  //    bulk insert at the end — so a transient insert failure only loses dedup
  //    for that single row (which the catch-up tail re-fires next run) instead
  //    of letting the whole batch double-send tomorrow.
  const pending = candidates.filter((c) => !alreadySent.has(c.sealId));
  const POOL = 6;
  let fired = 0;
  let logFailures = 0;

  for (let start = 0; start < pending.length; start += POOL) {
    const wave = pending.slice(start, start + POOL).map(async (c) => {
      const customerId = customerBySeal.get(c.sealId);
      const locale = customerId ? langByCustomer.get(customerId) ?? "es" : "es";
      try {
        await klaviyo.trackEvent("subscription_renewal_reminder", c.email, {
          hoursBefore: 48,
          sealSubscriptionId: c.sealId,
          nextShipDate: c.nextShipDate,
          boxCount: c.boxCount,
          frequency: c.frequency,
          flavor: c.flavor,
          is_mix: c.composition.length > 1,
          flavor_mix: c.composition.map((x) => ({ flavor: shortLabel(x.flavor), boxes: x.boxes })),
          locale,
        });
      } catch (err) {
        // PII sweep: log the Seal sub id, not the email. No dedup row is written,
        // so the catch-up tail re-fires this sub on the next daily run.
        console.warn(`[renewal-reminder 48h] klaviyo failed for seal sub ${c.sealId}:`, err);
        return;
      }
      fired++;
      const { error: logErr } = await sb.from("email_logs").insert({
        customer_id: customerId ?? `seal:${c.sealId}`,
        template_id: TEMPLATE_ID,
        metadata: { shipDate: c.shipDate, hoursBefore: 48, sealSubscriptionId: c.sealId },
      });
      if (logErr) {
        // Event already fired but we couldn't record it → may re-send next run.
        logFailures++;
        console.error(
          `[renewal-reminder 48h] FIRED but email_logs insert failed for seal sub ${c.sealId} (ship ${c.shipDate}) — may re-send next run:`,
          logErr.message,
        );
      }
    });
    await Promise.all(wave);
  }

  return NextResponse.json({
    ok: true,
    scanned: subs.length,
    candidates: candidates.length,
    skippedDedup: candidates.length - pending.length,
    fired,
    logFailures,
  });
}

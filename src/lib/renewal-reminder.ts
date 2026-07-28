/**
 * Engine behind the pre-charge reminder crons. One scan, one dedup, one fire
 * loop — parameterised per bucket (48h, 7d) by {@link RenewalReminderConfig}.
 *
 * Every bucket fires the SAME Klaviyo metric (`subscription_renewal_reminder`)
 * and is told apart by `hoursBefore`, which each flow filters on. Buckets exist
 * as separate crons (not branches of one) so a failure in one never costs the
 * other its send.
 *
 * SOURCE OF TRUTH = SEAL, NOT THE SUPABASE CACHE.
 * Earlier this scanned `subscriptions.next_ship_date` in Supabase, but that
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
 * WINDOW SHAPE. Each bucket's window is TWICE the cron interval (48h wide for a
 * daily cron) on purpose. A sub's lead time only ever decreases, so the FIRST run
 * that sees it is always in the window's top 24h — i.e. the reminder normally
 * lands at the bucket's nominal lead. The lower half is a self-healing catch-up
 * tail: a missed cron run or a transient Klaviyo failure re-fires the next day
 * instead of being lost forever. A window only as wide as the interval would give
 * each renewal exactly one shot and no recovery.
 *
 * IDEMPOTENCY. A single `email_logs` lookup over the last 5 days builds the set
 * of sealSubscriptionIds already reminded FOR THIS bucket (`template_id` is the
 * dedup partition, so buckets never eat each other's sends), keyed on sub id
 * alone so a mid-window reschedule across a day boundary doesn't re-send. We skip
 * those and write a row immediately after each successful fire. Re-running the
 * cron the same day, a missed run, or a transient single-fire failure never
 * double-sends — and the catch-up tail re-fires anything that was dropped.
 * NOTE: the 5-day lookback is shared by every bucket. Two buckets whose windows
 * sit closer than the lookback are still safe (dedup filters by template_id), but
 * if the lookback ever grows, re-check it against every bucket's cadence.
 */

import { NextResponse, type NextRequest } from "next/server";
import { alertSlackError } from "./alert";
import { isDryRunRequest } from "./api-helpers";
import { CronAuthError, requireCron } from "./cron-auth";
import { klaviyo } from "./klaviyo";
import { type FlavorComposition, shortLabel } from "./mix";
import { priceForBoxCount } from "./pricing";
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
  type SealSubscription,
} from "./seal";
import { formatShipDateEs } from "./ship-date-label";
import { supabaseAdmin } from "./supabase";

const H = 60 * 60 * 1000;

/** Dedup lookback — bounds a bucket to one reminder per renewal cycle. */
const DEDUP_LOOKBACK_DAYS = 5;

/** Klaviyo fan-out concurrency. */
const POOL = 6;

export type RenewalReminderConfig = {
  /**
   * `email_logs.template_id` — ALSO the dedup partition. MUST be unique per
   * bucket: two buckets sharing it would make one mark the sub as reminded and
   * the other skip it.
   */
  templateId: string;
  /** Event property every Klaviyo flow filters on. Identifies the bucket. */
  hoursBefore: number;
  /** Window, hours from now: `[fromH, toH)`. Keep it 2x the cron interval. */
  fromH: number;
  toH: number;
  /** Log prefix, e.g. "renewal-reminder 48h". */
  label: string;
  /** Route path, for Slack alerts. */
  path: string;
  /**
   * Send the saved shipping address in the event. Only the 7d email prints it
   * (its whole point is "confirm your address before we ship"); the 48h email
   * doesn't, and shipping it there would copy a postal address into twice as
   * many Klaviyo event payloads for nothing.
   */
  withShippingAddress?: boolean;
  /** Run the mix price-drift assertion. 48h only — see the check itself. */
  checkMixPrice?: boolean;
};

/** Shipping address exactly as the 7d template reads it (`event.shippingAddress.*`). */
export type ReminderAddress = {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string;
  postalCode: string;
  city: string;
  country: string;
};

type Candidate = {
  sealId: string;
  email: string;
  shipDate: string; // YYYY-MM-DD (dedup key + merge tag)
  nextShipDate: string; // full ISO with tz
  nextShipDateLabel: string; // "30 de julio"
  boxCount: number;
  frequency: string;
  /** Mix summary when split; the plain flavor label otherwise. */
  flavor: string;
  /** Boxes per flavor, so the email can list a mix. */
  composition: FlavorComposition[];
  shippingAddress: ReminderAddress;
};

/**
 * Address for the email. Seal stores whatever checkout sent, and every ES record
 * in the book says "Spain" — which reads wrong in a Spanish email — while the
 * portal's own address form writes "España". Normalise by country code so both
 * origins print the same thing.
 */
function addressOf(s: SealSubscription): ReminderAddress {
  const code = (s.s_country_code ?? "").trim().toUpperCase();
  return {
    firstName: (s.s_first_name ?? "").trim(),
    lastName: (s.s_last_name ?? "").trim(),
    address1: (s.s_address1 ?? "").trim(),
    address2: (s.s_address2 ?? "").trim(),
    postalCode: (s.s_zip ?? "").trim(),
    city: (s.s_city ?? "").trim(),
    country: code === "ES" ? "España" : (s.s_country ?? "").trim(),
  };
}

/**
 * THE MONEY ASSERTION (flavor mix, 2026-07-28).
 *
 * A split subscription carries a CUSTOM per-unit price so a mix costs the same as
 * the equivalent pure plan. If Seal ever refreshes item prices from Shopify (the
 * merchant "propagate product price changes" action, an app update, a price edit),
 * that override is silently replaced by the catalogue price and the customer is
 * over-charged by ~25% with no signal anywhere in the portal.
 *
 * The 48h cron is the last scan of the WHOLE Seal book before every charge, so it
 * is the cheapest possible early-warning: check the split subs and alert while
 * there is still time to fix it before the card is hit. Deliberately NOT run by
 * the 7d bucket — it would only double the Slack alerts for the same drift.
 */
async function assertMixPrice(
  s: SealSubscription,
  cfg: RenewalReminderConfig,
  boxCount: number,
  composition: FlavorComposition[],
  chargeDate: string,
): Promise<void> {
  try {
    const expected = Math.round((await priceForBoxCount(boxCount, composition[0].flavor)) * 100);
    const actual = getChargeTotalCents(s);
    // Tolerance = one cent per line: the tier split can legitimately land a cent
    // under (4 boxes as 2+2 is mathematically impossible to hit exactly).
    if (Math.abs(actual - expected) > getLines(s).length) {
      console.error(`[${cfg.label}] mix price drift`, {
        sealId: s.id, actual, expected, boxCount, charge: chargeDate,
      });
      alertSlackError({
        path: cfg.path,
        code: "mix_price_drift",
        msg:
          `sub ${s.id}: charge total ${actual}c but the ${boxCount}-box tier is ${expected}c. ` +
          `Seal may have refreshed the item prices and dropped our per-unit price. ` +
          `THE CHARGE LANDS ${chargeDate.slice(0, 10)} — fix before then.`,
      });
    }
  } catch (e) {
    // Never let the price check stop the reminder from going out.
    console.warn(`[${cfg.label}] price check failed for sub ${s.id}:`, e);
  }
}

export async function runRenewalReminder(
  req: NextRequest,
  cfg: RenewalReminderConfig,
): Promise<NextResponse> {
  try {
    requireCron(req);
  } catch (err) {
    if (err instanceof CronAuthError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  // Dry run (non-prod only, see api-helpers.dryRunAllowed): scan and build the
  // exact payloads, fire nothing, write nothing. This is how you verify a bucket
  // against the real book without emailing anyone or burning its dedup rows.
  const dryRun = isDryRunRequest(req);

  const sb = supabaseAdmin();
  const now = Date.now();
  const lower = now + cfg.fromH * H;
  const upper = now + cfg.toH * H;

  // 1. Scan the whole Seal book and keep ACTIVE subs whose next pending charge
  //    lands in this bucket's window. (A failed page propagates → we fail loud
  //    rather than remind a truncated slice of the book.)
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

    if (cfg.checkMixPrice && getShape(s) === "split") {
      await assertMixPrice(s, cfg, boxCount, composition, next.date);
    }

    candidates.push({
      sealId: String(s.id),
      email,
      shipDate: next.date.slice(0, 10),
      nextShipDate: next.date,
      nextShipDateLabel: formatShipDateEs(next.date),
      boxCount,
      frequency: normalizeFrequency(s.delivery_interval),
      // The mix summary, so the email names both flavors. A single flavor yields
      // the same string extractFlavor always returned.
      flavor: extractFlavorSummary(s),
      composition,
      shippingAddress: addressOf(s),
    });
  }

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, dryRun, scanned: subs.length, candidates: 0, fired: 0 });
  }

  const sealIds = candidates.map((c) => c.sealId);

  // 2. Dedup: one query for everything this bucket reminded in the last 5 days,
  //    keyed on sealSubscriptionId alone (stored in metadata) — so dedup never
  //    depends on a Shopify customer id, and a legitimate reschedule that moves
  //    the charge across a calendar day mid-window does not re-send.
  //    FAIL LOUD on a query error: a silent empty dedup set would re-fire the
  //    whole in-window book (up to the ~130-customer month-end spike).
  const { data: sentRows, error: dedupErr } = await sb
    .from("email_logs")
    .select("metadata")
    .eq("template_id", cfg.templateId)
    .gte("sent_at", new Date(now - DEDUP_LOOKBACK_DAYS * 24 * H).toISOString());
  if (dedupErr) {
    throw new Error(`${cfg.label} dedup query failed: ${dedupErr.message}`);
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

  const localeFor = (c: Candidate): string => {
    const customerId = customerBySeal.get(c.sealId);
    return customerId ? langByCustomer.get(customerId) ?? "es" : "es";
  };

  const eventProps = (c: Candidate, locale: string): Record<string, unknown> => ({
    hoursBefore: cfg.hoursBefore,
    sealSubscriptionId: c.sealId,
    // RAW ISO, NEVER FORMATTED. This field stopped being a presentation field:
    // the Klaviyo flow's WhatsApp webhook forwards it to Permut as
    // `expected_date`, which matches the exact Seal billing attempt when a
    // customer asks to skip. Format it here and the skip stops finding the
    // charge — silently: it falls to human handoff and the delivery that the
    // customer asked to skip ships anyway. Presentation goes in
    // `nextShipDateLabel`.
    nextShipDate: c.nextShipDate,
    nextShipDateLabel: c.nextShipDateLabel,
    boxCount: c.boxCount,
    frequency: c.frequency,
    flavor: c.flavor,
    is_mix: c.composition.length > 1,
    flavor_mix: c.composition.map((x) => ({ flavor: shortLabel(x.flavor), boxes: x.boxes })),
    locale,
    ...(cfg.withShippingAddress ? { shippingAddress: c.shippingAddress } : {}),
  });

  const pending = candidates.filter((c) => !alreadySent.has(c.sealId));

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      scanned: subs.length,
      candidates: candidates.length,
      skippedDedup: candidates.length - pending.length,
      wouldFire: pending.length,
      events: pending.map((c) => ({ email: c.email, properties: eventProps(c, localeFor(c)) })),
    });
  }

  // 4. Fire the event for the not-yet-reminded candidates (bounded concurrency).
  //    Write each dedup row IMMEDIATELY after its successful fire — not in one
  //    bulk insert at the end — so a transient insert failure only loses dedup
  //    for that single row (which the catch-up tail re-fires next run) instead
  //    of letting the whole batch double-send tomorrow.
  let fired = 0;
  let logFailures = 0;

  for (let start = 0; start < pending.length; start += POOL) {
    const wave = pending.slice(start, start + POOL).map(async (c) => {
      try {
        await klaviyo.trackEvent("subscription_renewal_reminder", c.email, eventProps(c, localeFor(c)));
      } catch (err) {
        // PII sweep: log the Seal sub id, not the email. No dedup row is written,
        // so the catch-up tail re-fires this sub on the next daily run.
        console.warn(`[${cfg.label}] klaviyo failed for seal sub ${c.sealId}:`, err);
        return;
      }
      fired++;
      const { error: logErr } = await sb.from("email_logs").insert({
        customer_id: customerBySeal.get(c.sealId) ?? `seal:${c.sealId}`,
        template_id: cfg.templateId,
        metadata: { shipDate: c.shipDate, hoursBefore: cfg.hoursBefore, sealSubscriptionId: c.sealId },
      });
      if (logErr) {
        // Event already fired but we couldn't record it → may re-send next run.
        logFailures++;
        console.error(
          `[${cfg.label}] FIRED but email_logs insert failed for seal sub ${c.sealId} (ship ${c.shipDate}) — may re-send next run:`,
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

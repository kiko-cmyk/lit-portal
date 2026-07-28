/**
 * Dunning: what we do when a Seal billing attempt fails.
 *
 * WHY THIS EXISTS (incident 2026-07-28)
 * ------------------------------------
 * Until today the `billing_attempt.failed` case in the Seal webhook was a bare
 * `break` with a TODO, so in the single most critical retention moment the only
 * party talking to the customer was Seal, through an email we don't control,
 * whose CTA is a magic link into Seal's OWN customer portal.
 *
 * Measured on live Seal data (2026-07-28):
 *  - Seal retries a failed charge 4 times on consecutive days, emails the
 *    customer each time, and then auto-cancels the subscription.
 *  - July 2026: 35 subscriptions auto-cancelled that way (≈987 €/month of MRR),
 *    plus 3 of the 4 customer-side pauses happened 23 min to 7 h after one of
 *    those Seal emails.
 *  - So we get 4 signals across a ~3 day window and used none of them.
 *
 * This module is the reply: on the FIRST failure of a dunning cycle we fire a
 * Klaviyo event so OUR email lands before Seal's, with a CTA into the portal
 * where the customer can fix the payment method (inline for cards, "email me a
 * link" for Shop Pay / PayPal).
 *
 * DESIGN NOTES
 *  - Never throws. The Seal webhook must keep returning 200; a Klaviyo hiccup
 *    can't be allowed to fail the whole event (same policy as
 *    consumeRetentionDiscountSafe).
 *  - One event per dunning cycle, not per retry. Seal's 4 retries would
 *    otherwise become 4 duplicate triggers. The guard is an `email_logs` row
 *    keyed by Seal subscription id inside a 5-day window, exactly the pattern
 *    the 48 h renewal reminder uses.
 *  - No payment URL travels in the event. Shopify's single-use update URL would
 *    end up stored in Klaviyo event data and can expire before the customer
 *    clicks; the portal handles both instrument families and keeps the customer
 *    inside litsalt.com.
 */

import { klaviyo } from "@/lib/klaviyo";
import type { SealSubscription } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

/** `email_logs.template_id` for the dunning trigger. Also the dedup key. */
export const DUNNING_TEMPLATE_ID = "payment_failed";

/**
 * One dunning cycle is 4 daily retries, so a 5-day window covers the whole
 * cycle and re-arms in time for the next month's charge.
 */
const DEDUP_WINDOW_DAYS = 5;

export interface DunningOutcome {
  fired: boolean;
  /** Machine-readable reason, for logs. */
  reason:
    | "fired"
    | "already_fired_this_cycle"
    | "no_email"
    | "no_subscription"
    | "klaviyo_failed"
    | "dedup_query_failed";
}

/**
 * Best-effort: fire the payment-failed trigger for a subscription whose charge
 * just failed. Safe to call from a webhook — resolves to an outcome, never
 * rejects.
 */
export async function fireDunningTrigger(
  sub: SealSubscription | undefined,
  attempt?: { date?: string; error_message?: string | null },
): Promise<DunningOutcome> {
  try {
    return await fireDunningTriggerInner(sub, attempt);
  } catch (err) {
    // Catch-all: this function is called from the webhook switch and must not
    // be able to fail it.
    console.error("[dunning] unexpected failure", {
      sealSubscriptionId: sub?.id,
      msg: err instanceof Error ? err.message : String(err),
    });
    return { fired: false, reason: "klaviyo_failed" };
  }
}

async function fireDunningTriggerInner(
  sub: SealSubscription | undefined,
  attempt?: { date?: string; error_message?: string | null },
): Promise<DunningOutcome> {
  if (!sub?.id) return { fired: false, reason: "no_subscription" };
  const sealId = String(sub.id);
  const email = (sub.email ?? "").trim().toLowerCase();
  if (!email) {
    console.warn("[dunning] Seal payload has no email", { sealId });
    return { fired: false, reason: "no_email" };
  }

  const sb = supabaseAdmin();

  // ---- Dedup: one trigger per dunning cycle -------------------------------
  // Query by template + window and filter in JS on the jsonb field, mirroring
  // the renewal reminder (Supabase's jsonb filters are awkward through the JS
  // client and the row count in a 5-day window is tiny).
  const since = new Date(Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: sentRows, error: dedupErr } = await sb
    .from("email_logs")
    .select("metadata")
    .eq("template_id", DUNNING_TEMPLATE_ID)
    .gte("sent_at", since);
  if (dedupErr) {
    // Fail CLOSED on purpose: a dedup query we can't trust must not be allowed
    // to turn Seal's 4 retries into 4 emails to a customer whose card just
    // failed. The next retry (tomorrow) tries again.
    console.error("[dunning] dedup query failed, skipping to avoid duplicates", {
      sealId,
      msg: dedupErr.message,
    });
    return { fired: false, reason: "dedup_query_failed" };
  }
  const alreadyFired = ((sentRows ?? []) as Array<{ metadata: { sealSubscriptionId?: string } | null }>)
    .some((r) => r.metadata?.sealSubscriptionId === sealId);
  if (alreadyFired) {
    console.log("[dunning] already fired this cycle, skipping", { sealId });
    return { fired: false, reason: "already_fired_this_cycle" };
  }

  // ---- Enrichment (all best-effort, never fatal) --------------------------
  const { data: cacheRow } = await sb
    .from("subscriptions")
    .select("customer_id")
    .eq("seal_subscription_id", sealId)
    .maybeSingle();
  const customerId = (cacheRow?.customer_id as string | undefined) ?? null;

  let locale = "es";
  if (customerId) {
    const { data: prefs } = await sb
      .from("customer_preferences")
      .select("language")
      .eq("customer_id", customerId)
      .maybeSingle();
    if (prefs?.language === "en") locale = "en";
  }

  // Instrument family drives the copy: a card can be replaced inline in the
  // portal, Shop Pay / PayPal need the "email me a link" fallback (Shopify
  // rejects the inline update URL with INVALID_INSTRUMENT_TYPE). 2 of the 3
  // pause-after-failure cases were Shop Pay, so this distinction matters.
  let paymentType: string | null = null;
  if (customerId) {
    try {
      const { shopifyAdmin } = await import("@/lib/shopify-admin");
      const instrument = await shopifyAdmin.getCustomerPaymentMethod(customerId);
      paymentType = instrument?.type ?? null;
    } catch (err) {
      console.warn("[dunning] payment instrument lookup failed (non-fatal)", {
        sealId,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- Fire ---------------------------------------------------------------
  try {
    await klaviyo.trackEvent("payment_failed", email, {
      sealSubscriptionId: sealId,
      attemptDate: attempt?.date ?? null,
      // Seal's message is generic ("There was an error performing the
      // payment.") but it does separate a gateway error from an expired card,
      // so pass it through for segmentation.
      gatewayMessage: attempt?.error_message ?? null,
      paymentType,
      cardExpiryMonth: sub.card_expiry_month || null,
      cardExpiryYear: sub.card_expiry_year || null,
      amount: sub.total_value ?? null,
      currency: sub.currency ?? "EUR",
      locale,
      // How many days the customer has before Seal auto-cancels. Measured on
      // live data: 4 daily retries then cancel, so ~3 days from the first
      // failure. Drives the urgency copy in the flow.
      daysUntilCancel: 3,
    });
  } catch (err) {
    // No email_logs row → the next Seal retry (tomorrow) re-fires.
    console.warn("[dunning] klaviyo event failed for seal sub", sealId, err);
    return { fired: false, reason: "klaviyo_failed" };
  }

  const { error: logErr } = await sb.from("email_logs").insert({
    customer_id: customerId ?? `seal:${sealId}`,
    template_id: DUNNING_TEMPLATE_ID,
    metadata: {
      sealSubscriptionId: sealId,
      attemptDate: attempt?.date ?? null,
      paymentType,
      locale,
    },
  });
  if (logErr) {
    // Fired but not recorded: the next retry may re-send. Loud, not fatal.
    console.error(
      `[dunning] FIRED but email_logs insert failed for seal sub ${sealId} — may re-send on the next retry:`,
      logErr.message,
    );
  }

  console.log("[dunning] payment_failed fired", { sealId, paymentType, locale });
  return { fired: true, reason: "fired" };
}

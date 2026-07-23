import { alertSlackError } from "@/lib/alert";
import { findAppliedDiscountCodeId, seal } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Cancel-flow retention discount ("15% a la desesperada") consumption.
 *
 * The discount is a ONE-charge promise: applied to the customer's NEXT charge
 * and removed right after, so it never rides a later renewal (Juan,
 * IMPORTANTÍSIMO). A Seal discount code recurs on every charge, so SOMETHING
 * has to remove it after the first discounted charge.
 *
 * Incident 2026-07-23: the only remover was the `billing_attempt.succeeded`
 * webhook — but that topic was never subscribed in Seal (only
 * `subscription/updated` reached the portal), so removal NEVER ran and every
 * accepted 15% stayed applied on every renewal. And LITSTAY15 has no usable
 * Shopify cap: `usageLimit` is null and Seal's recurring charges don't count
 * against `appliesOncePerCustomer` / `asyncUsageCount`, so there is no
 * Shopify-side backstop either.
 *
 * Fix: this trigger-agnostic consumer is called from the webhook topics we can
 * rely on (`subscription/updated`, and `billing_attempt/succeeded` now that it
 * is subscribed) AND a daily cron sweep — the guaranteed backstop, since the
 * minimum charge interval is 15 days, so a daily sweep always removes the code
 * well before the second charge.
 *
 * MONEY-SAFETY INVARIANT (audit 2026-07-23, round 2): the row is closed to
 * `removed` ONLY when we have just successfully removed a code we could SEE on
 * the sub, or when it has aged past a full billing cycle. It is NEVER closed on
 * an inference that "the code looks gone" (e.g. from total_value): a lagging or
 * mid-plan-change Seal read could false-close a row whose 15% is still live,
 * which — because every backstop filters status='pending_charge' — would leak
 * that discount forever, untracked. Leaving such a row pending is harmless (the
 * next trigger retries); false-closing it is the exact failure we are fixing.
 */

// Stop retrying once the row is older than a full cycle: the code is certainly
// gone (a genuine invisible carry-over is detected + alerted at its source in
// /api/subscription/plan), so closing then only tidies the tracking table.
const CLOSE_AFTER_MS = 35 * 24 * 60 * 60 * 1000;

export type ConsumeResult =
  | "no-row"
  | "no-charge-yet"
  | "transient"
  | "removed"
  | "no-visible-code"
  | "aged-out";

/**
 * Retire the retention discount for a subscription once its ONE discounted
 * charge has landed. Idempotent and safe to call from any trigger:
 *
 *   - no pending_charge row                    → "no-row"
 *   - Seal read failed (transient)             → "transient" (retry next trigger)
 *   - no completed charge since applied_at      → "no-charge-yet" (keep the code:
 *                                                 the customer is still owed the
 *                                                 discounted charge they accepted)
 *   - charge landed, code visible              → remove it, close row → "removed"
 *   - charge landed, code NOT visible, recent  → leave pending → "no-visible-code"
 *   - charge landed, code NOT visible, aged out → close row → "aged-out"
 */
export async function consumeRetentionDiscountIfCharged(
  sealSubId: number | string,
): Promise<ConsumeResult> {
  const sb = supabaseAdmin();
  const { data: row } = await sb
    .from("retention_discounts")
    .select("customer_id, discount_code_id, code, applied_at, updated_at")
    .eq("seal_subscription_id", String(sealSubId))
    .eq("status", "pending_charge")
    .maybeSingle();
  if (!row) return "no-row";

  // Read fresh Seal state — a webhook payload can be a mid-regeneration snapshot.
  const fresh = await seal.getSubscriptionById(Number(sealSubId));
  if (!fresh) return "transient"; // Seal blip → retry on the next trigger / cron run.

  const appliedAtMs = row.applied_at ? Date.parse(row.applied_at as string) : 0;

  // Has the ONE discounted charge already happened? The first completed billing
  // attempt on/after applied_at IS that charge. Until it lands, keep the code so
  // the customer actually receives the 15% they accepted.
  //
  // completed_at carries a tz offset (verified against live Seal: "...+00:00"),
  // so Date.parse is timezone-safe here. KNOWN LIMITATION (audit 2026-07-23): a
  // charge already IN FLIGHT at the old price when the customer accepts can
  // settle a few minutes AFTER applied_at and satisfy this guard, removing the
  // code before the promised discounted charge lands. Rare (needs acceptance
  // during a charge's capture window) and customer-unfavourable, not a company
  // leak; support re-applies on request.
  const chargedSinceApply = (fresh.billing_attempts ?? []).some(
    (ba) => ba.completed_at && Date.parse(ba.completed_at) >= appliedAtMs,
  );
  if (!chargedSinceApply) return "no-charge-yet";

  const storedId = (row.discount_code_id as string | null) ?? null;

  // Close guarded by status AND an optimistic token on updated_at (verified to
  // round-trip exactly through PostgREST). status guards a peer consumer that
  // already closed it; updated_at guards a plan-change reattach that REVIVED the
  // row since we read it: the revive always bumps updated_at — even when it
  // re-captures a null UUID — so a stale consumer that removed the OLD code can
  // never close a row a reattach just re-armed onto a live NEW code (the
  // permanent-leak class; audit 2026-07-23 rounds 3-4). If the row changed since
  // our read, this matches 0 rows and no-ops, and the next trigger/cron removes
  // the current code. (updated_at is preferred over discount_code_id as the token
  // because a null-UUID revive would collapse a discount_code_id IS NULL guard.)
  const closeRow = () =>
    sb
      .from("retention_discounts")
      .update({
        status: "removed",
        removed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("customer_id", row.customer_id)
      .eq("status", "pending_charge")
      .eq("updated_at", row.updated_at as string);

  // Resolve the code's CURRENT UUID: the stored one only if it is still actually
  // attached (a plan-change reattach mints a new UUID), else re-scan fresh state.
  const attachedIds = new Set(
    (fresh.items ?? []).flatMap((it) => (it.discount_codes ?? []).map((dc) => dc.id)),
  );
  const discountCodeId =
    storedId && attachedIds.has(storedId)
      ? storedId
      : findAppliedDiscountCodeId(fresh, row.code as string);

  if (discountCodeId) {
    // The code is VISIBLE → remove it, then close (token-guarded). This is the
    // only close that coincides with a real removal.
    await seal.removeDiscountCode(Number(sealSubId), discountCodeId);
    await closeRow();
    console.log("[retention-discount] removed after first charge", { sealSubId });
    return "removed";
  }

  // Code not visible at item level. Do NOT infer "gone" and close (a lagging or
  // mid-swap read would false-close a still-live 15% → permanent leak). Leave it
  // pending for the next trigger/cron — unless it has aged past a full cycle. At
  // that point close it, but ALERT first: if the code were somehow still live yet
  // invisible (a Seal item-swap carry-over the API won't expose), closing is the
  // last silent step, so a human must get a chance to remove it in Seal.
  if (Date.now() - appliedAtMs > CLOSE_AFTER_MS) {
    alertSlackError({
      path: "lib/retention-discount",
      code: "retention_discount_aged_out",
      msg: `sub ${sealSubId}: retention 15% (${row.code}) row aged out with no code visible via API — closing tracking; verify in Seal that no invisible carry-over is still discounting the sub`,
      customerId: String(row.customer_id),
    });
    await closeRow();
    console.warn("[retention-discount] no visible code after full cycle, row closed", { sealSubId });
    return "aged-out";
  }
  return "no-visible-code";
}

import { type NextResponse, type NextRequest } from "next/server";
import { runRenewalReminder } from "@/lib/renewal-reminder";

/**
 * GET /apps/portal/api/cron/renewal-reminder
 * Daily: fires `subscription_renewal_reminder` (hoursBefore=48) for every
 * active subscription whose next charge is ~2 days away. The Klaviyo flow keyed
 * on this metric sends the 48h email; its primary CTA deep-links to
 * /apps/portal/{locale}/mi-lit?action=skip.
 *
 * The scan, the dedup and the fire loop live in `@/lib/renewal-reminder` and are
 * shared with the 7d bucket (`renewal-reminder-7d`) — read that module for the
 * why of the window shape, the Seal-as-source-of-truth decision and the
 * idempotency contract.
 *
 * 48h ONLY: the 24h bucket was removed (Juan, 2026-06-24) — the 24h branch was
 * deleted from the Klaviyo flow, so a 24h event sent nothing. A sub first enters
 * the window when its charge is 36-60h out, so the primary reminder lands ~48h
 * before. The window extends down to +12h as a self-healing catch-up tail:
 *   next charge in [now+12h, now+60h)  → fire once (dedup handles the overlap).
 *
 * This bucket also carries the mix price-drift assertion: it is the last full
 * scan of the Seal book before the card is hit.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return runRenewalReminder(req, {
    templateId: "renewal_reminder_48h",
    hoursBefore: 48,
    fromH: 12,
    toH: 60,
    label: "renewal-reminder 48h",
    path: "/api/cron/renewal-reminder",
    checkMixPrice: true,
  });
}

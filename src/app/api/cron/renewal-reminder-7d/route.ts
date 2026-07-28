import { type NextResponse, type NextRequest } from "next/server";
import { runRenewalReminder } from "@/lib/renewal-reminder";

/**
 * GET /apps/portal/api/cron/renewal-reminder-7d
 * Daily: fires `subscription_renewal_reminder` (hoursBefore=168) for every
 * active subscription whose next charge is ~7 days away.
 *
 * NOT a second renewal reminder. This email exists to give a customer who has
 * moved (or wants to change flavor / boxes / date) time to tell us BEFORE the
 * order is picked: it prints the shipping address we have saved and asks whether
 * it is still good. That is why `withShippingAddress` is on — without the
 * address the email has no reason to exist. (The template degrades to the
 * Klaviyo profile address, then to a generic line, so a sub with no address in
 * Seal still gets a coherent email.)
 *
 * The scan, the dedup and the fire loop live in `@/lib/renewal-reminder`, shared
 * with the 48h bucket. Two things are load-bearing here:
 *
 *  - `templateId` MUST differ from the 48h one. `email_logs.template_id` is the
 *    dedup partition, so sharing it would make whichever bucket ran first mark
 *    the sub as reminded and silently swallow the other's send.
 *  - Window `[now+156h, now+180h)` = 6.5-7.5 days out, and it extends down to
 *    +132h (5.5 days) purely as the self-healing catch-up tail. A sub's lead time
 *    only decreases, so the first run that sees it is always in the 6.5-7.5d slice
 *    and the email lands ~7 days out as the copy says; the tail only ever fires
 *    when the previous day's run (or its Klaviyo call) failed, in which case a
 *    reminder at 5.5-6.5 days beats no reminder at all.
 *
 * No mix price assertion here on purpose: the 48h bucket already runs it, closer
 * to the charge. Running it twice would just double the Slack alerts.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return runRenewalReminder(req, {
    templateId: "renewal_reminder_168h",
    hoursBefore: 168,
    fromH: 132,
    toH: 180,
    label: "renewal-reminder 7d",
    path: "/api/cron/renewal-reminder-7d",
    withShippingAddress: true,
  });
}

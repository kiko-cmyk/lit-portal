import { isDryRunRequest, withCustomer } from "@/lib/api-helpers";
import { runWithRequestDeadline } from "@/lib/http-timeout";
import { changePlan, type PlanChangeBody } from "@/lib/plan-core";
import type { Subscription } from "@/lib/types";

// El núcleo (todo lo que había aquí dentro de `patchPlan`) vive en `@/lib/plan-core` desde el
// 2026-10-26 (LIT-625), compartido con la entrada máquina a máquina del cambio de sabor.

/**
 * PATCH /apps/portal/api/subscription/plan
 *
 * Body: { boxCount?: 1..6, frequency?: Frequency }
 *
 * Rewrite 2026-05-14: mutates via Seal Merchant API using `add_items +
 * remove_items` (confirmed by Seal support as the only API path for swapping
 * a subscription's products). Prior attempt to mutate Shopify contracts
 * directly was blocked by the `_own` scope limitation — our app cannot see
 * Seal-owned contracts.
 *
 * Order of operations:
 *   1. add_items(new variant)  — must come FIRST. If it fails we abort
 *      cleanly with the sub still containing the original item.
 *   2. remove_items(old item)  — only runs after add succeeds.
 *   3. (optional) edit { delivery_interval } when frequency changed —
 *      Seal stores cadence at the subscription level too, separate from
 *      each item's selling_plan_id.
 *
 * Open questions to validate empirically:
 *   - Does add_items respect selling_plan_id, or does Seal force the new
 *     item to inherit the sub's existing cadence?
 *   - Does Seal's `edit` with delivery_interval actually mutate, or is it
 *     the same silent no-op we saw on item edits?
 */
/**
 * Whole-request wall-clock budget, shared by every upstream call inside.
 *
 * Why (incident 2026-09-04): this route makes THREE Seal calls back to back
 * (edit_items → add_items → remove_items), each with its own 9 s total budget,
 * plus two 500 ms settle sleeps and a ~4 s verification read. Nothing bounded
 * the sum, so a slow Seal day reached ~28 s while Shopify's App Proxy stops
 * waiting at ~10 s: the customer got `gateway_timeout` and the invocation was
 * killed BETWEEN add_items and remove_items, leaving the old and the new lines
 * both live and the next charge too high. Three subscriptions were left
 * overcharging by 113.40 EUR/cycle before anyone noticed.
 *
 * This REVERSES a deliberate decision documented in address/route.ts:29-31,
 * which excluded /plan on the grounds that "being killed early is worse than
 * being slow (partial state)" and that per-call deadlines were protection
 * enough. The premise was right; the conclusion did not hold. Per-call budgets
 * never bound the SUM, so the route was killed anyway — just later, at Vercel's
 * 60 s, on a request nobody was listening to, and precisely between add_items
 * and remove_items. "Slow" was never on the menu; the real choice was between
 * dying early with a compensation and dying late without one.
 *
 * What makes early death safe now is the pre-armed repair intent below plus the
 * recovery paths running under `runWithoutRequestDeadline`: an aborted swap
 * leaves a row the cron converges, instead of a silent double charge. Without
 * that half of the fix, the original objection would still stand.
 *
 * 9.5 s, same as the address route, sized just under the proxy's patience.
 */
const REQUEST_BUDGET_MS = 9_500;

/**
 * Hard ceiling, above REQUEST_BUDGET_MS so the deadline is what normally stops
 * us, not the kill. The extra room is for the compensation work that runs
 * outside the budget (repair intent, remove retry, snapshot restore) once the
 * customer's response is already lost. The 60 s default let a doomed request
 * mutate Seal for another ~50 s with nobody listening.
 */
export const maxDuration = 60;

export const PATCH = withCustomer<Subscription>((req, ctx) =>
  runWithRequestDeadline(REQUEST_BUDGET_MS, () => patchPlan(req, ctx)),
);

const patchPlan = async (
  req: Parameters<Parameters<typeof withCustomer<Subscription>>[0]>[0],
  ctx: Parameters<Parameters<typeof withCustomer<Subscription>>[0]>[1],
) => {
  const body = (await req.json().catch(() => ({}))) as PlanChangeBody;
  return changePlan(
    body,
    { customerId: ctx.customerId, requestUrl: req.url },
    { dryRun: isDryRunRequest(req, body, ctx.customerId) },
  );
};

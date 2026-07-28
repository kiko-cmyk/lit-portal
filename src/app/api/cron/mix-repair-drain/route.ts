import { NextResponse, type NextRequest } from "next/server";
import { alertSlackError } from "@/lib/alert";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { diffLines, type TargetLine } from "@/lib/mix";
import { getChargeTotalCents, getLines, seal } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/cron/mix-repair-drain
 *
 * Safety net for "the subscription's lines didn't converge on the target".
 *
 * /api/subscription/plan converges lines with edit_items → add_items → remove_items.
 * If the remove fails AND the snapshot can't be restored, the subscription keeps both
 * the old and the new line and **the next charge is too HIGH**. That exact failure
 * overcharged 7 subscriptions between June and July 2026 and went unnoticed until the
 * whole Seal book was audited (see scripts/repair-duplicate-lines.mjs). The route now
 * records the desired end state in `subscription_line_repairs` and this cron
 * reconciles it.
 *
 * Idempotent by construction: it re-reads live Seal state and applies
 * `diffLines(live, desired)`. If the state already matches, the diff is empty and the
 * row closes. Running twice is harmless.
 *
 * Cadence: every 5 min via the external cron on n8n.drinklit.com (same
 * `Authorization: Bearer CRON_SECRET` as reanchor-drain); vercel.json keeps a daily
 * run as fallback because Vercel Hobby only allows daily crons.
 */

const MAX_ATTEMPTS = 5;
/** 6h, same as the re-anchor drain. A money-affecting intent is never dropped
 *  silently: past the TTL it is marked `failed`, kept for reconciliation, and
 *  alerted. */
const INTENT_TTL_MS = 6 * 60 * 60_000;

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
  const { data: intents, error } = await sb
    .from("subscription_line_repairs")
    .select("customer_id, seal_subscription_id, desired, snapshot, attempts, created_at")
    .eq("status", "pending");
  if (error) throw new Error(`mix-repair-drain: ${error.message}`);

  let done = 0;
  let alreadyOk = 0;
  let deferred = 0;
  let failed = 0;
  let expired = 0;

  for (const intent of intents ?? []) {
    const subId = Number(intent.seal_subscription_id);
    const desired = intent.desired as TargetLine[];
    const key = { customer_id: intent.customer_id, seal_subscription_id: intent.seal_subscription_id };

    const close = (status: "done" | "failed", lastError?: string) =>
      sb
        .from("subscription_line_repairs")
        .update({ status, last_error: lastError ?? null, updated_at: new Date().toISOString() })
        .eq("customer_id", key.customer_id)
        .eq("seal_subscription_id", key.seal_subscription_id);

    const bump = (lastError: string) =>
      sb
        .from("subscription_line_repairs")
        .update({
          attempts: (intent.attempts ?? 0) + 1,
          last_error: lastError,
          updated_at: new Date().toISOString(),
        })
        .eq("customer_id", key.customer_id)
        .eq("seal_subscription_id", key.seal_subscription_id);

    if (Date.now() - new Date(intent.created_at).getTime() > INTENT_TTL_MS) {
      await close("failed", "expired unconverged");
      expired++;
      const msg =
        `sub ${subId}: line repair expired without converging. The subscription may still ` +
        `hold extra lines and OVERCHARGE on its next renewal. desired=${JSON.stringify(desired)}`;
      console.error("[mix-repair-drain] expired unconverged", { subId, customerId: intent.customer_id });
      alertSlackError({
        path: "/api/cron/mix-repair-drain",
        code: "mix_repair_expired",
        msg,
        customerId: intent.customer_id,
      });
      continue;
    }

    const sub = await seal.getSubscriptionById(subId);
    if (!sub) {
      // Transient Seal failure — leave pending, retry next run.
      await bump("could not read subscription");
      deferred++;
      continue;
    }

    const live = getLines(sub);
    const diff = diffLines(live, desired);
    if (diff.noop) {
      // Someone (a retry, support, the customer) already got it right.
      await close("done");
      alreadyOk++;
      continue;
    }

    try {
      if (diff.edits.length) {
        await seal.editItems(
          subId,
          diff.edits.map((e) => ({ itemId: e.itemId, quantity: e.quantity, price: e.unitPrice })),
        );
        await sleep(500);
      }
      if (diff.adds.length) {
        // Re-adding needs Shopify line details we don't have here. This only happens
        // when the original add never landed; the customer is then UNDER-charged
        // rather than over-charged, so it is safe to hand to support instead of
        // guessing a payload from the cron.
        await bump(`needs ${diff.adds.length} add(s) — not done from the cron`);
        deferred++;
        console.warn("[mix-repair-drain] repair needs adds, deferring to support", {
          subId,
          adds: diff.adds.map((a) => a.variantId),
        });
        continue;
      }
      if (diff.removes.length) {
        await seal.removeItems(subId, diff.removes);
      }

      // Verify by reading back, never by trusting the mutation response.
      await sleep(800);
      const after = await seal.getSubscriptionById(subId);
      const afterDiff = after ? diffLines(getLines(after), desired) : null;
      if (afterDiff?.noop) {
        await close("done");
        done++;
        console.log("[mix-repair-drain] converged", {
          subId,
          chargeCents: after ? getChargeTotalCents(after) : null,
        });
      } else {
        await bump("still not converged after applying the diff");
        deferred++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const attempts = (intent.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await close("failed", msg);
        failed++;
        console.error("[mix-repair-drain] gave up after max attempts", { subId, msg });
        alertSlackError({
          path: "/api/cron/mix-repair-drain",
          code: "mix_repair_failed",
          msg: `sub ${subId}: line repair gave up after ${attempts} attempts (${msg}). Fix in Seal by hand: desired=${JSON.stringify(desired)}`,
          customerId: intent.customer_id,
        });
      } else {
        await bump(msg);
        deferred++;
      }
    }
  }

  return NextResponse.json({ ok: true, done, alreadyOk, deferred, failed, expired });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

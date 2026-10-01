import { NextResponse, type NextRequest } from "next/server";
import { alertSlackNoticeAwaited } from "@/lib/alert";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { isWithinCutoff } from "@/lib/cutoff";
import { getNextBillingAttempt, seal } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/cron/reanchor-drain
 *
 * Safety net for "preserve the prior next-ship date after a plan change".
 *
 * The plan-change route (/api/subscription/plan) skips the regenerated early
 * billing attempts in-request when Seal finishes regenerating quickly. When it
 * doesn't (Seal still regenerating past the in-request poll budget — rare, can
 * take minutes), the route leaves a row in `subscription_reanchor_intents` and
 * this cron finishes the job.
 *
 * For each pending intent:
 *   - Re-read live Seal state (regeneration is done by the time we run).
 *   - If the next charge is already on/after preserve_date → done.
 *   - Else shift the WHOLE regenerated schedule forward by a uniform offset so
 *     the first charge lands on preserve_date (seal.reanchorCadence — idempotent,
 *     so retrying is safe). It RESCHEDULES the pending attempts; it does not skip
 *     them. (The first design did skip them, via skipIntermediateAttempts, and
 *     this line outlived it — corrected 2026-10-01 after it misled a reader.)
 *   - On Seal error → bump attempts, leave pending; after MAX_ATTEMPTS → failed.
 *
 * Cadence: every 5 min via external cron on n8n.drinklit.com (curl with
 * `Authorization: Bearer CRON_SECRET`) — Vercel Hobby only allows daily
 * crons, so vercel.json keeps a daily run as fallback only.
 */

const MAX_ATTEMPTS = 5;
// 6h — Seal billing_attempt regeneration can take a while (minutes, occasionally
// longer). Don't drop a money-affecting intent too eagerly (see TTL branch).
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
    .from("subscription_reanchor_intents")
    .select("customer_id, seal_subscription_id, preserve_date, attempts, created_at")
    .eq("status", "pending");
  if (error) throw new Error(`reanchor-drain: ${error.message}`);

  let done = 0;
  // Intents we gave up on because the preserved date is already inside the cutoff.
  // Counted apart from `done`: nothing converged, a human may have to reschedule.
  let droppedInCutoff = 0;
  let skippedTotal = 0;
  let deferred = 0;
  let failed = 0;
  let expired = 0;

  for (const intent of intents ?? []) {
    const subId = Number(intent.seal_subscription_id);
    const preserve = String(intent.preserve_date).slice(0, 10);

    // TTL: an intent that never converged. NEVER silently DELETE it — dropping it
    // unapplied lets Seal's early regenerated attempt stand and the customer gets
    // billed BEFORE the preserved next-ship date. Mark it 'failed' (kept for
    // reconciliation, and the cron stops chasing it) and log loudly.
    if (Date.now() - new Date(intent.created_at).getTime() > INTENT_TTL_MS) {
      await sb
        .from("subscription_reanchor_intents")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("customer_id", intent.customer_id)
        .eq("seal_subscription_id", intent.seal_subscription_id);
      expired++;
      console.error(
        "[reanchor-drain] intent expired unconverged — marked failed (customer may be billed early)",
        {
          customerId: intent.customer_id,
          subId,
          preserve,
          ageMin: Math.round((Date.now() - new Date(intent.created_at).getTime()) / 60000),
        },
      );
      continue;
    }

    // Never re-anchor onto a date already inside the 24h cutoff: that shipment is
    // already being picked. Harmless for a normal plan change (the preserved date is
    // the one the customer already had), NOT harmless for a `fromNext` change from
    // the WhatsApp bot, where this intent is the only thing holding the schedule to
    // the date the bot promised. Same reasoning as the webhook's guard; see
    // applyReanchorIfPending in api/webhooks/seal.
    if (isWithinCutoff(`${preserve}T13:00:00Z`)) {
      await sb
        .from("subscription_reanchor_intents")
        .delete()
        .eq("customer_id", intent.customer_id)
        .eq("seal_subscription_id", intent.seal_subscription_id);
      console.warn("[reanchor-drain] intent dropped inside the 24h cutoff", {
        customerId: intent.customer_id,
        subId,
        preserve,
      });
      await alertSlackNoticeAwaited({
        title: "Re-anclaje descartado por el corte de 24h",
        icon: ":warning:",
        channel: "incidents",
        fields: {
          suscripcion: String(subId),
          cliente: intent.customer_id,
          "fecha prometida": preserve,
          origen: "cron reanchor-drain",
          "que revisar":
            "Seal puede cobrar antes de esa fecha. Comprobar el proximo cobro y reprogramarlo a mano si hace falta.",
        },
      });
      droppedInCutoff++;
      continue;
    }

    const sub = await seal.getSubscriptionById(subId);
    if (!sub) {
      // Transient — leave pending, retry next run.
      await bumpAttempt(sb, intent.customer_id, intent.seal_subscription_id, intent.attempts);
      deferred++;
      continue;
    }

    // Cancelled/paused: there is no pending attempt to move, so there is nothing to
    // preserve. Without this the intent spun 72 times (once every 5 min for the whole
    // 6h TTL) and then fired the "customer may be billed early" error, which is FALSE
    // for a sub that isn't charging at all. Found 8 such intents on 2026-07-28, all
    // for CANCELLED subs. Close it quietly.
    if (sub.status !== "ACTIVE") {
      await sb
        .from("subscription_reanchor_intents")
        .delete()
        .eq("customer_id", intent.customer_id)
        .eq("seal_subscription_id", intent.seal_subscription_id);
      done++;
      continue;
    }

    const firstPending = getNextBillingAttempt(sub);
    const firstDay = firstPending?.date.slice(0, 10) ?? null;

    // No pending yet → Seal still regenerating; retry next run.
    if (!firstDay) {
      await bumpAttempt(sb, intent.customer_id, intent.seal_subscription_id, intent.attempts);
      deferred++;
      continue;
    }

    // Already on/after preserve → cadence shifted, converged → done.
    if (firstDay >= preserve) {
      await sb
        .from("subscription_reanchor_intents")
        .delete()
        .eq("customer_id", intent.customer_id)
        .eq("seal_subscription_id", intent.seal_subscription_id);
      done++;
      continue;
    }

    try {
      const moved = await seal.reanchorCadence(subId, preserve);
      skippedTotal += moved;
      await sb
        .from("subscription_reanchor_intents")
        .delete()
        .eq("customer_id", intent.customer_id)
        .eq("seal_subscription_id", intent.seal_subscription_id);
      done++;
    } catch (e) {
      const attempts = (intent.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await sb
          .from("subscription_reanchor_intents")
          .update({ status: "failed", attempts, updated_at: new Date().toISOString() })
          .eq("customer_id", intent.customer_id)
        .eq("seal_subscription_id", intent.seal_subscription_id);
        failed++;
        console.error("[reanchor-drain] gave up after max attempts", {
          customerId: intent.customer_id,
          subId,
          preserve,
          msg: e instanceof Error ? e.message : String(e),
        });
      } else {
        await bumpAttempt(sb, intent.customer_id, intent.seal_subscription_id, intent.attempts);
        deferred++;
      }
    }
  }

  return NextResponse.json({ ok: true, done, droppedInCutoff, skippedTotal, deferred, failed, expired });
}

async function bumpAttempt(
  sb: ReturnType<typeof supabaseAdmin>,
  customerId: string,
  sealSubscriptionId: string,
  attempts: number | null,
): Promise<void> {
  await sb
    .from("subscription_reanchor_intents")
    .update({ attempts: (attempts ?? 0) + 1, updated_at: new Date().toISOString() })
    .eq("customer_id", customerId)
    .eq("seal_subscription_id", sealSubscriptionId);
}

import { after } from "next/server";
import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { addDaysUtc } from "@/lib/charge-now-recovery";
import { runAsBackgroundJob } from "@/lib/http-timeout";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  findExternalCancel,
  notifyFollowup,
  REACTIVATION_HOLD_DAYS,
  recordFollowup,
  type FollowupKind,
} from "@/lib/reactivation";
import { seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /apps/portal/api/subscription/reactivate
 *
 * Dos caminos (2026-10-14, ver lib/reactivation.ts):
 *
 *  - Baja por impago o hecha por atención desde el admin de Seal, la más
 *    reciente y de hace 90 días o menos, sin otra sub activa: se reactiva esa.
 *    No hay Drops que devolver (estas bajas no los retienen). Si fue por impago,
 *    el siguiente cobro se trae a mañana en cuanto Seal regenera el calendario.
 *  - Baja desde el portal (la regla de siempre):
 *      - cancel_count === 1 (already cancelled once but never twice)
 *      - within 90 days of last_cancelled_at
 *    Restores Drops balance from the snapshot (cancellations.drops_held_at_cancel)
 *    by inserting a positive drops_event so the trigger recomputes the balance.
 *
 * El aviso a Klaviyo sale cuando Seal ha regenerado el calendario, con la fecha
 * de la próxima caja ya buena (seguimiento en reactivation_followups).
 *
 * No cooldown (per locked decision 2026-04-27 — same-day reactivation OK).
 */
export const POST = withCustomer(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "reactivate", { limit: 5, windowMs: 60_000 });

  const sb = supabaseAdmin();

  // Email y subs primero: hacen falta para saber quién hizo la última baja.
  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) throw new ApiHttpError(404, "customer_not_found", "");

  const body = (await req.json().catch(() => ({}))) as { sealSubscriptionId?: number | string };
  const subs = await seal.getSubscriptionsByEmail(email);
  const subSel = url.searchParams.get("seal_subscription_id") ?? body.sealSubscriptionId;

  // ── Baja por impago o por atención ──
  const external = await findExternalCancel(subs);
  if (external && (!subSel || String(subSel) === String(external.sub.id))) {
    const sub = external.sub;
    assertSubscriptionBelongsToCustomer(sub, email, "subscription/reactivate");
    await seal.reactivateSubscription(sub.id);
    const pullTo = external.actor === "unpaid" ? addDaysUtc(new Date().toISOString().slice(0, 10), 1) : null;
    await followUp(sub, external.actor, ctx.customerId, { dropsRestored: 0 }, pullTo);
    return { reactivated: true, sealSubscriptionId: String(sub.id), dropsRestored: 0 };
  }

  // ── Baja desde el portal ──
  const { data: prefs } = await sb
    .from("customer_preferences")
    .select("cancel_count, last_cancelled_at")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  if (!prefs || !prefs.last_cancelled_at) {
    throw new ApiHttpError(400, "no_cancellation", "No prior cancellation to reactivate from");
  }
  if (prefs.cancel_count > 1) {
    throw new ApiHttpError(410, "second_cancel_no_reactivation", "Already cancelled twice — Drops were reset");
  }

  const cancelledAt = new Date(prefs.last_cancelled_at).getTime();
  if (Date.now() - cancelledAt > REACTIVATION_HOLD_DAYS * 24 * 60 * 60 * 1000) {
    throw new ApiHttpError(410, "reactivation_window_expired", "Beyond 90-day hold window");
  }

  // Multi-sub: if the selector named a specific sub, reactivate that one (subs
  // are email-owned, so matching by id here is ownership-safe). Otherwise:
  // reactivation targets a CANCELLED subscription — for multi-sub customers
  // "most recent" alone could pick a still-ACTIVE sub and reactivate the wrong
  // one, so prefer a cancelled (or scheduled-to-cancel) sub, falling back to
  // most-recent only if none is found. Single-sub customers are unaffected.
  const requested = subSel
    ? subs.find((s) => String(s.id) === String(subSel))
    : null;
  // Requested-but-unresolved must 404, never silently fall back to a different
  // sub (audit 2026-07-06 — same policy as every other route). And reactivating
  // a sub that is plainly ACTIVE is a client-state bug: reject it instead of
  // poking Seal.
  if (subSel && !requested) {
    throw new ApiHttpError(404, "subscription_not_found", `No subscription ${subSel}`);
  }
  if (requested && requested.status === "ACTIVE" && !requested.cancellation_scheduled_for) {
    throw new ApiHttpError(400, "subscription_not_cancelled", "Subscription is already active");
  }
  const cancelled = subs.filter(
    (s) => s.status === "CANCELLED" || !!s.cancellation_scheduled_for,
  );
  const sub =
    requested ??
    [...(cancelled.length ? cancelled : subs)].sort((a, b) =>
      b.order_placed.localeCompare(a.order_placed),
    )[0];
  if (!sub) throw new ApiHttpError(404, "subscription_not_found", "");
  assertSubscriptionBelongsToCustomer(sub, email, "subscription/reactivate");

  // Reactivate in Seal — Seal asynchronously regenerates billing_attempts
  await seal.reactivateSubscription(sub.id);

  // Restore Drops balance: read snapshot from cancellations row
  const { data: lastCancel } = await sb
    .from("cancellations")
    .select("drops_held_at_cancel, id")
    .eq("customer_id", ctx.customerId)
    .eq("status", "confirmed")
    .order("confirmed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const heldBalance = lastCancel?.drops_held_at_cancel ?? 0;
  if (heldBalance > 0) {
    // Read current balance to compute delta (in case partial activity happened)
    const { data: bal } = await sb
      .from("drops_balances")
      .select("balance")
      .eq("customer_id", ctx.customerId)
      .maybeSingle();
    const currentBalance = bal?.balance ?? 0;
    const restore = heldBalance - currentBalance;
    if (restore > 0) {
      await sb.from("drops_events").insert({
        customer_id: ctx.customerId,
        action: "manual_adjustment",
        amount: restore,
        metadata: { reason: "reactivation_restore", cancellationId: lastCancel?.id },
      });
    }
  }

  await followUp(sub, "portal", ctx.customerId, { dropsRestored: heldBalance }, null);

  return {
    reactivated: true,
    sealSubscriptionId: String(sub.id),
    dropsRestored: heldBalance,
  };
});

/**
 * Apunta el seguimiento (aviso con la fecha buena y, si fue impago, el cobro a
 * mañana). Si no se puede apuntar, el aviso sale ya, con lo que haya.
 */
async function followUp(
  sub: SealSubscription,
  kind: FollowupKind,
  customerId: string,
  extra: Record<string, unknown>,
  pullTo: string | null,
): Promise<void> {
  const ok = await recordFollowup({ sealSubscriptionId: String(sub.id), customerId, kind, pullTo, extra });
  if (!ok) {
    after(() => runAsBackgroundJob(() => notifyFollowup(sub, kind, customerId, extra)));
  }
}

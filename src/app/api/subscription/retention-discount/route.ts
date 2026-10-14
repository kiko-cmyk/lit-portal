import { ApiHttpError, isDryRunRequest, withCustomer } from "@/lib/api-helpers";
import { alertSlackError } from "@/lib/alert";
import { klaviyo } from "@/lib/klaviyo";
import { sealWriteDefinitelyRejected } from "@/lib/line-repair";
import { enforceRateLimit } from "@/lib/rate-limit";
import { findAppliedDiscountCodeId, seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertNoPendingLineRepair } from "@/lib/line-repair-runner";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { verifyOwnershipFast } from "@/lib/sub-ownership";
import { pickRequestedSub, requestedSubIdFrom } from "@/lib/sub-resolve";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /apps/portal/api/subscription/retention-discount
 *
 * Cancel-flow "15% a la desesperada": apply a 15% discount to the customer's
 * NEXT charge (and none after). It applies a Shopify discount code to the Seal
 * subscription; a Seal code recurs on every charge, so the "next charge only"
 * guarantee is enforced by REMOVING it right after the first discounted charge.
 *
 * Removal is driven by lib/retention-discount (consumeRetentionDiscountIfCharged),
 * called from the seal webhook (subscription/updated — and billing_attempt/succeeded
 * if ever subscribed) AND a daily cron sweep (/api/cron/retention-discount-sweep)
 * as the guaranteed backstop. NOTE: there is NO Shopify-side cap — LITSTAY15 has
 * usageLimit=null and Seal's recurring charges do not count against
 * appliesOncePerCustomer/asyncUsageCount, so removal is the ONLY thing that stops
 * the recurrence (incident 2026-07-23, when the only trigger — a
 * billing_attempt/succeeded webhook that was never subscribed in Seal — meant no
 * discount was ever removed).
 *
 * Guardrails (Juan): only on the customer's FIRST cancellation, and only ONCE
 * ever per customer (retention_discounts.customer_id is the primary key). So the
 * discount can't be "farmed" by cancelling repeatedly.
 *
 * The code name is configurable via RETENTION_DISCOUNT_CODE (must already exist
 * in Shopify as a subscription-eligible percentage code).
 */
export const POST = withCustomer<{ applied: boolean; code: string }>(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "retention-discount", { limit: 5, windowMs: 60_000 });

  const url = new URL(req.url);
  const devEmail =
    process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const body = (await req.json().catch(() => ({}))) as {
    sealSubscriptionId?: number | string;
    reason?: string;
    dryRun?: boolean;
  };
  const dryRun = isDryRunRequest(req, body);
  const CODE = process.env.RETENTION_DISCOUNT_CODE ?? "LITSTAY15";

  const sb = supabaseAdmin();

  // ── Guardrail 1: once ever per customer. ──
  const { data: existing } = await sb
    .from("retention_discounts")
    .select("customer_id")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  if (existing) {
    throw new ApiHttpError(409, "already_used", "Retention discount already used for this customer");
  }

  // ── Guardrail 2: only on the FIRST cancellation (never cancelled before). ──
  const { data: prefs } = await sb
    .from("customer_preferences")
    .select("cancel_count")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  if ((prefs?.cancel_count ?? 0) >= 1) {
    throw new ApiHttpError(409, "not_first_cancel", "Retention discount is only offered on the first cancellation");
  }

  // ── Resolve the subscription (fast-path, slow-path fallback — like /skip). ──
  let sub: SealSubscription | null = null;
  let email: string | null = null;
  const requestedSubId = requestedSubIdFrom(req, body.sealSubscriptionId);
  if (requestedSubId) {
    const owns = await verifyOwnershipFast(Number(requestedSubId), ctx.customerId);
    if (owns) {
      sub = await seal.getSubscriptionById(Number(requestedSubId));
      if (sub) {
        email = sub.email ?? null;
        assertSubscriptionBelongsToCustomer(sub, email ?? "", "retention-discount:fast");
      }
    }
  }
  if (!sub) {
    email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
    if (!email) throw new ApiHttpError(404, "customer_not_found", "");
    const subs = await seal.getSubscriptionsByEmail(email);
    // Multi-sub: never discount a DIFFERENT sub than the one requested.
    sub = pickRequestedSub(subs, requestedSubId);
    if (!sub) throw new ApiHttpError(404, "subscription_not_found", "No active subscription");
    assertSubscriptionBelongsToCustomer(sub, email, "retention-discount");
  }
  if (!email) email = sub.email ?? null;

  // Dry-run ("simulación"): no Seal/DB/Klaviyo mutation, just report success.
  if (dryRun) {
    return { applied: true, code: CODE };
  }

  // Con un cambio de plan a medio aplicar no se pone el 15% (14-oct-2026): Seal lo pondría
  // en todas las líneas, también en las que hay que quitar, y quien termine el cambio
  // tendría que soltarlo y reponerlo por encima.
  await assertNoPendingLineRepair(ctx.customerId, sub.id, "retention-discount");

  // ── Reserve the once-per-customer slot BEFORE applying. This guarantees the
  //    webhook can always find + remove the code after the first charge (no
  //    apply-without-tracking → no accidental recurring discount). ──
  const ins = await sb
    .from("retention_discounts")
    .insert({
      customer_id: ctx.customerId,
      seal_subscription_id: String(sub.id),
      code: CODE,
      status: "pending_charge",
      reason: body.reason ?? null,
    });
  if (ins.error) {
    // 23505 = someone raced us to the single slot → already used.
    if (ins.error.code === "23505") {
      throw new ApiHttpError(409, "already_used", "Retention discount already used for this customer");
    }
    throw new Error(`retention_discounts insert failed: ${ins.error.message}`);
  }

  // ── Apply the code in Seal. ──
  try {
    await seal.applyDiscountCode(sub.id, CODE);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[retention-discount] apply failed for sub ${sub.id}: ${msg}`);
    // UN FALLO NO ES "NO SE APLICÓ" (14-oct-2026). Antes, cualquier error borraba la fila de
    // seguimiento para no gastarle al cliente su única oportunidad. Pero si fue un timeout y
    // Seal SÍ lo aplicó, el 15% quedaba puesto sin fila: el webhook y el barrido solo quitan
    // los que siguen, así que se descontaba en TODOS los cobros, para siempre y sin rastro.
    if (sealWriteDefinitelyRejected(e)) {
      // Seal dijo que no: no se aplicó. Se libera la reserva para que pueda reintentarlo.
      await sb
        .from("retention_discounts")
        .delete()
        .eq("customer_id", ctx.customerId)
        .eq("seal_subscription_id", String(sub.id));
      throw new ApiHttpError(409, "discount_apply_failed", msg);
    }
    const seen = await seal.getSubscriptionById(sub.id).catch(() => null);
    const seenId = seen ? findAppliedDiscountCodeId(seen, CODE) : null;
    if (!seenId) {
      // No se ve, pero puede entrar tarde. La fila SE QUEDA: si el código aparece, se quita
      // tras su cobro como cualquier otro; si no aparece, lo cierra el barrido. A una
      // persona, para que lo mire, y al cliente que no lo repita.
      alertSlackError({
        path: "/api/subscription/retention-discount",
        code: `retention_apply_unknown:${sub.id}`,
        msg: `sub ${sub.id}: no se sabe si ${CODE} se aplicó (${msg}). La fila de seguimiento se mantiene. Comprobar en Seal en unos minutos que el código está UNA vez, o que no está y avisar al cliente.`,
        customerId: ctx.customerId,
      });
      throw new ApiHttpError(409, "discount_apply_unconfirmed", msg);
    }
    console.warn(`[retention-discount] apply "failed" but ${CODE} is on sub ${sub.id}: treated as applied`);
  }

  // ── Capture the applied code's UUID for a clean webhook removal (best-effort;
  //    the webhook falls back to matching by code string if this is null). ──
  const fresh = await seal.getSubscriptionById(sub.id).catch(() => null);
  const discountCodeId = fresh ? findAppliedDiscountCodeId(fresh, CODE) : null;
  if (discountCodeId) {
    await sb
      .from("retention_discounts")
      .update({ discount_code_id: discountCodeId, updated_at: new Date().toISOString() })
      .eq("customer_id", ctx.customerId);
  }

  // Fire-and-forget analytics.
  if (email) {
    klaviyo
      .trackEvent("retention_discount_accepted", email, {
        sealSubscriptionId: String(sub.id),
        code: CODE,
        reason: body.reason,
      })
      .catch((err) => console.warn("[retention-discount] klaviyo event failed:", err));
  }

  return { applied: true, code: CODE };
});

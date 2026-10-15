import { NextResponse, type NextRequest } from "next/server";
import { alertSlackErrorAwaited } from "@/lib/alert";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import {
  applyDiscoveryRenewalCreditForOrder,
  consumeDiscoveryRenewalCreditIfCharged,
  PENDING_APPLY_ALERT_MS,
  recoverStaleApplying,
  STALE_APPLYING_MS,
} from "@/lib/discovery-renewal-credit";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/cron/discovery-renewal-credit-sweep
 *
 * Red diaria del crédito del Discovery Set en la renovación (Discovery +
 * suscripción en el mismo pedido, ver lib/discovery-renewal-credit).
 *
 * El crédito se aplica normalmente desde el webhook de Seal en cuanto crea la
 * sub, y se retira tras el cobro desde el mismo webhook. Pero los webhooks se
 * pierden (incidente 2026-07-23: un topic sin suscribir dejó sin retirar todos
 * los 15 % de retención). Este barrido hace las tres cosas por su cuenta:
 *
 *   - `pending_apply`  → busca la sub del pedido en Seal y aplica.
 *   - `applying` viejo → un proceso murió a medias: mira en Seal si llegó a
 *                        aplicarse y la cierra o la libera.
 *   - `pending_charge` → si ya se cobró la renovación, retira el código.
 *
 * Diario basta: la renovación más corta es a 15 días, así que el crédito
 * siempre se aplica antes de su cobro y se retira mucho antes del segundo.
 */
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
  const { data: rows, error } = await sb
    .from("discovery_set_coupons")
    .select("customer_id, order_id, status, seal_subscription_id, created_at, updated_at")
    .eq("mode", "renewal")
    .in("status", ["pending_apply", "applying", "pending_charge"]);
  if (error) throw new Error(`discovery-renewal-credit-sweep: ${error.message}`);

  const tally: Record<string, number> = {};
  const count = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);

  for (const row of rows ?? []) {
    const customerId = String(row.customer_id);
    try {
      if (row.status === "pending_apply") {
        const email = await shopifyAdmin.getCustomerEmail(customerId);
        if (!email) {
          count("apply:no-email");
          continue;
        }
        const result = await applyDiscoveryRenewalCreditForOrder(String(row.order_id), email);
        count(`apply:${result}`);
        // Dos días sin sub de Seal para ese pedido no es una carrera, es un
        // problema (el pedido no generó sub, o el email no casa): que lo vea
        // una persona antes de que llegue la renovación sin descuento.
        if (
          result === "no-sub-yet" &&
          Date.now() - Date.parse(String(row.created_at)) > PENDING_APPLY_ALERT_MS
        ) {
          await alertSlackErrorAwaited({
            path: "/api/cron/discovery-renewal-credit-sweep",
            code: "discovery_credit_no_sub",
            msg: `Crédito Discovery del pedido ${row.order_id}: sigue sin encontrarse en Seal la sub de ese pedido (email ${email}). Aplicar a mano o revisar.`,
            customerId,
          });
        }
      } else if (row.status === "applying") {
        if (Date.now() - Date.parse(String(row.updated_at)) < STALE_APPLYING_MS) {
          count("applying:in-flight");
          continue;
        }
        count(`applying:${await recoverStaleApplying(customerId)}`);
      } else if (row.status === "pending_charge" && row.seal_subscription_id) {
        count(`consume:${await consumeDiscoveryRenewalCreditIfCharged(String(row.seal_subscription_id))}`);
      }
    } catch (e) {
      count("error");
      console.error("[discovery-renewal-credit-sweep] row failed", {
        customerId,
        status: row.status,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({ ok: true, scanned: rows?.length ?? 0, ...tally });
}

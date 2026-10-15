import { NextResponse, type NextRequest } from "next/server";
import { alertSlackErrorAwaited } from "@/lib/alert";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { consumeRetentionDiscountIfCharged } from "@/lib/retention-discount";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/cron/retention-discount-sweep
 *
 * Guaranteed backstop for the cancel-flow 15% "next charge only" promise.
 *
 * The discount is meant to apply to exactly ONE charge and then be removed. The
 * webhook does this in near-real-time, but webhooks can be missed (topic not
 * subscribed, downtime, transient Seal errors). Incident 2026-07-23: the
 * billing_attempt/succeeded topic was never subscribed, so NO discount was ever
 * removed and every accepted 15% recurred on every renewal.
 *
 * This sweep closes that gap deterministically. The minimum charge interval is
 * 15 days, so a DAILY sweep always removes the code within ~24h of the first
 * (discounted) charge — long before the second charge — no matter what the
 * webhook did. For each pending_charge row it runs the same idempotent consumer
 * the webhook uses (lib/retention-discount): removes the code only once the
 * discounted charge has actually landed, leaves it otherwise.
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
    .from("retention_discounts")
    .select("seal_subscription_id, customer_id")
    .eq("status", "pending_charge");
  if (error) throw new Error(`retention-discount-sweep: ${error.message}`);

  const tally: Record<string, number> = {};
  for (const row of rows ?? []) {
    try {
      const result = await consumeRetentionDiscountIfCharged(row.seal_subscription_id as string);
      tally[result] = (tally[result] ?? 0) + 1;
    } catch (e) {
      tally["error"] = (tally["error"] ?? 0) + 1;
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[retention-discount-sweep] consume threw", {
        sealSubscriptionId: row.seal_subscription_id,
        customerId: row.customer_id,
        msg,
      });
      // Desde 2026-10-10 el consumidor lanza si tras retirar QUEDA alguna copia del
      // 15% en la sub (multi-línea). Eso es dinero: tiene que verse, no solo
      // loguearse. Con el id en el código para que el dedupe de 60 s no funda dos.
      await alertSlackErrorAwaited({
        path: "/api/cron/retention-discount-sweep",
        code: `retention_discount_consume_failed:${row.seal_subscription_id}`,
        msg: `sub ${row.seal_subscription_id}: no se pudo retirar el 15% tras su cobro (${msg}). Se reintenta mañana; si persiste, quitarlo a mano en Seal.`,
        customerId: String(row.customer_id),
      });
    }
  }

  return NextResponse.json({ ok: true, scanned: rows?.length ?? 0, ...tally });
}

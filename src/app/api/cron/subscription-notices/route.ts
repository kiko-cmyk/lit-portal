import { NextResponse, type NextRequest } from "next/server";
import { alertSlackErrorAwaited } from "@/lib/alert";
import { runCancelNotices } from "@/lib/cancel-notice";
import { sweepChargeNowAttempts } from "@/lib/charge-now-recovery";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { runAsBackgroundJob } from "@/lib/http-timeout";

/**
 * GET /apps/portal/api/cron/subscription-notices
 *
 * Diario (2026-10-14). Dos repasos independientes; si uno falla, el otro sigue:
 *
 *  1. «Adelantar» rechazados: la red del rescate que hace el webhook de Seal
 *     (ver lib/charge-now-recovery.ts). Cierra los que cobraron bien y rescata los
 *     que fallaron sin que el webhook llegara a verlos.
 *  2. Avisos de baja fuera del portal: impago y atención desde el admin de Seal
 *     (ver lib/cancel-notice.ts). Diario a propósito: espera a que soporte haya
 *     podido deshacer la baja antes de decirle nada al cliente.
 *
 * `?dry_run=1` no escribe nada en Seal, Klaviyo ni Supabase y devuelve lo que haría.
 */

export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireCron(req);
  } catch (err) {
    if (err instanceof CronAuthError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";

  // runAsBackgroundJob: sin proxy esperando al otro lado, los clientes de Seal
  // usan su plazo largo y no el de 6 s de las rutas del portal.
  let chargeNow: unknown;
  try {
    chargeNow = await runAsBackgroundJob(() => sweepChargeNowAttempts({ dryRun }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    chargeNow = { error: msg };
    await alertSlackErrorAwaited({
      path: "/api/cron/subscription-notices",
      code: "charge_now_sweep_failed",
      msg: `Falló el repaso diario de Adelantar rechazados: ${msg}`,
    });
  }

  let cancels: unknown;
  try {
    cancels = await runAsBackgroundJob(() => runCancelNotices({ dryRun }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cancels = { error: msg };
    await alertSlackErrorAwaited({
      path: "/api/cron/subscription-notices",
      code: "cancel_notices_failed",
      msg: `Falló el aviso diario de bajas fuera del portal: ${msg}`,
    });
  }

  console.log("[subscription-notices]", JSON.stringify({ dryRun, chargeNow, cancels }));
  return NextResponse.json({ ok: true, dryRun, chargeNow, cancels });
}

import { NextResponse, type NextRequest } from "next/server";
import { alertSlackErrorAwaited, alertSlackNoticeAwaited } from "@/lib/alert";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { runAsBackgroundJob } from "@/lib/http-timeout";
import { runPickupReminders } from "@/lib/pickup-reminder";

/**
 * GET /apps/portal/api/cron/pickup-reminder
 *
 * Diario (2026-10-20). Avisa a quien lleva 3 días sin recoger su pedido en un punto
 * de GLS (evento `pickup_point_reminder`, email SUB-08). Ver lib/pickup-reminder.ts.
 *
 * Sin claves de Sendcloud no hace nada. Con PICKUP_REMINDER apagado lo decide todo y
 * devuelve lo que mandaría, sin mandarlo. `?dry_run=1` no escribe nada en Klaviyo ni
 * en Supabase, con el flag como esté.
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

  try {
    const result = await runAsBackgroundJob(() => runPickupReminders({ dryRun }));
    console.log("[pickup-reminder]", JSON.stringify({ dryRun, ...result }));
    // Mientras el envío está apagado, lo que mandaría va a #server-errors: así se
    // compara con el seguimiento de GLS sin tener que leer los logs de Vercel.
    const unsent = result.preview.filter((p) => !p.sent);
    if (!dryRun && result.mode !== "on" && unsent.length > 0) {
      await alertSlackNoticeAwaited({
        icon: ":package:",
        title: `Aviso de punto de recogida (PICKUP_REMINDER=${result.mode}): ${unsent.length} sin mandar`,
        fields: Object.fromEntries(
          unsent
            .slice(0, 15)
            .map((p) => [p.orderNumber, `${p.pickupName} · ${p.days} días · llegó ${p.arrivedAt} · ${p.trackingNumber}`]),
        ),
      });
    }
    return NextResponse.json({ ok: true, dryRun, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await alertSlackErrorAwaited({
      path: "/api/cron/pickup-reminder",
      code: "pickup_reminder_failed",
      msg: `Falló el aviso diario de pedidos sin recoger en el punto: ${msg}`,
    });
    return NextResponse.json({ ok: false, dryRun, error: msg }, { status: 500 });
  }
}

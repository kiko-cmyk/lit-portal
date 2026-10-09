import { NextResponse, type NextRequest } from "next/server";
import { alertSlackErrorAwaited, alertSlackNoticeAwaited } from "@/lib/alert";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { runAsBackgroundJob } from "@/lib/http-timeout";
import {
  issuePendingCodes,
  qualifyPendingBacklog,
  runRewardSweep,
  type IssueSummary,
  type SweepTally,
} from "@/lib/referral-reward";

/**
 * GET /apps/portal/api/cron/referral-sweep — referidos, fase 0 (2026-10-10).
 *
 * La pasada cada 4 h, desde el cron EXTERNO del VPS de LIT (crontab del usuario
 * `kiko`, con el mismo `Authorization: Bearer CRON_SECRET`, como mix-repair-drain).
 * Vercel es Hobby: solo admite crons diarios y RECHAZA EL DESPLIEGUE ENTERO si hay
 * uno más frecuente (pasó con uno cada 5 min en junio y con este el 9-oct), así que
 * `vercel.json` lo lanza una vez al día (06:50 UTC) como red. Con la ventana de
 * 48 h antes de cada cobro, cada 4 h son una docena de pasadas por cobro; solo con
 * la diaria quedan una o dos. Tres fases, en este orden y cada una con su trozo
 * del presupuesto (la ruta tiene 60 s de maxDuration):
 *
 *   1. Recompensas (no empieza ninguna nueva pasados 30 s): consumir, revocar,
 *      retirar, caducar, limpiar las fallidas y APLICAR. Va primero porque es la
 *      que mueve dinero con fecha. Es el ÚNICO sitio que aplica un código en Seal,
 *      siempre 1-48 h antes del cobro. Una aplicación ya empezada puede seguir
 *      después de los 30 s: su presupuesto se mide contra el final de la función
 *      (55 s), no contra el corte de la fase.
 *   2. Conversiones (hasta los 38 s): cualifica las que se quedaron pendientes y
 *      repara las cualificadas que se quedaron sin recompensa.
 *   3. Códigos (hasta los 46 s): da de alta en Shopify los `pending` (como mucho
 *      40 por pasada; el backfill grande va por script).
 *
 * Parámetros, para el E2E (los dos siguen exigiendo CRON_SECRET):
 *   ?dry_run=1     decide y devuelve las decisiones, sin escribir NADA.
 *   ?only_sub=ID   solo las recompensas de esa sub de Seal (y las de la cola de su dueño).
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

  const url = new URL(req.url);
  const dryRun = ["1", "true"].includes(url.searchParams.get("dry_run") ?? "");
  const onlySubId = url.searchParams.get("only_sub")?.trim() || undefined;
  const started = Date.now();

  // Solo después de requireCron: nadie interactivo espera esta respuesta.
  return runAsBackgroundJob(async () => {
    const errors: string[] = [];
    let rewards: SweepTally = {};
    let qualify: SweepTally = {};
    let issue: IssueSummary | null = null;
    let decisions: unknown[] = [];

    try {
      const res = await runRewardSweep({
        dryRun,
        onlySubId,
        deadlineMs: started + 30_000,
        hardDeadlineMs: started + 55_000,
      });
      rewards = res.tally;
      if (dryRun) decisions = res.decisions;
    } catch (e) {
      errors.push(`rewards: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!dryRun && !onlySubId) {
      try {
        qualify = await qualifyPendingBacklog(20, started + 38_000);
      } catch (e) {
        errors.push(`qualify: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (!onlySubId) {
      try {
        issue = await issuePendingCodes({ max: 40, dryRun, deadlineMs: started + 46_000 });
      } catch (e) {
        errors.push(`codes: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (errors.length) {
      await alertSlackErrorAwaited({
        path: "/api/cron/referral-sweep",
        code: "referral_sweep_failed",
        msg: errors.join(" | ").slice(0, 280),
      });
    }

    // Resumen solo si pasó algo que importa: no se avisa de las pasadas tranquilas.
    // `deadline_left` y `apply_deferred_time` SÍ se enseñan: son la señal de que la
    // pasada no da abasto.
    const notable = (t: SweepTally) =>
      Object.entries(t)
        .filter(([k, v]) => v > 0 && !k.startsWith("wait:") && k !== "noop" && !k.startsWith("dry:"))
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
    const rewardLine = notable(rewards);
    const qualifyLine = notable(qualify);
    if (!dryRun && (rewardLine || qualifyLine || (issue?.activated ?? 0) > 0 || (issue?.failed ?? 0) > 0)) {
      await alertSlackNoticeAwaited({
        title: "Referidos: pasada del cron",
        icon: ":handshake:",
        fields: {
          recompensas: rewardLine || "-",
          conversiones: qualifyLine || "-",
          codigos_activados: issue?.activated ?? 0,
          codigos_pendientes: issue?.stillPending ?? 0,
          codigos_fallidos: issue?.failed ?? 0,
        },
      });
    }

    return NextResponse.json({
      ok: errors.length === 0,
      dryRun,
      onlySubId: onlySubId ?? null,
      ms: Date.now() - started,
      rewards,
      conversions: qualify,
      codes: issue,
      ...(dryRun ? { decisions } : {}),
      ...(errors.length ? { errors } : {}),
    });
  });
}

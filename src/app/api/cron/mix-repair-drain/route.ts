import { NextResponse, type NextRequest } from "next/server";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { processRepairIntent, type RepairIntentRow } from "@/lib/line-repair-runner";
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
 * Idempotent by construction: it re-reads live Seal state and decides from THAT what is
 * left to do (`planLineRepair`). If the state is already coherent, the row closes.
 * Running twice is harmless.
 *
 * QUÉ CAMBIÓ EL 2-OCT-2026, Y POR QUÉ. Hasta hoy la guarda de entrada comparaba el nº
 * de cajas vivas con el del intento y, si no coincidían, cerraba como "alguien le cambió
 * el plan entremedias". Pero un add sin su remove, que es EL fallo para el que existe
 * este cron, siempre tiene más cajas que el objetivo: la guarda rechazaba justo el caso
 * a reparar. Ahora se mira si lo vivo lo explica la propia intención (foto + objetivo,
 * línea a línea): si sí, es nuestra escritura a medias y se converge; si no, lo ha
 * tocado otro y no se pisa, como antes. Ver src/lib/line-repair.ts.
 *
 * Y cada cierre deja su fila en `subscription_changes`. Sin ella, el ledger se quedaba
 * con un `intent` sin cierre para siempre aunque la sub ya estuviera bien, y el detector
 * de reprecios lo cantaba como "el cliente pidió algo y no se le hizo" (la 13416998).
 *
 * Cadence: every 5 min via the external cron on n8n.drinklit.com (same
 * `Authorization: Bearer CRON_SECRET` as reanchor-drain); vercel.json keeps a daily
 * run as fallback because Vercel Hobby only allows daily crons.
 */

/**
 * Una fila recién escrita puede seguir siendo de una petición VIVA: la ruta la arma antes
 * de su primer cambio en Seal y la borra al converger, y desde el 14-oct-2026 su `after()`
 * la sigue trabajando tras contestar (y la refresca: `updated_at`). Leer en ese hueco
 * daría la foto intacta y cerraría como "no entró nada" justo antes de que la ruta empiece
 * a mutar, dejándola sin red.
 */
const MIN_AGE_MS = 60_000;

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
    .select("customer_id, seal_subscription_id, desired, snapshot, attempts, created_at, updated_at")
    .eq("status", "pending");
  if (error) throw new Error(`mix-repair-drain: ${error.message}`);

  const counts = { done: 0, alreadyOk: 0, deferred: 0, failed: 0, expired: 0 };
  for (const intent of (intents ?? []) as RepairIntentRow[]) {
    const lastTouch = new Date(intent.updated_at ?? intent.created_at).getTime();
    if (Date.now() - lastTouch < MIN_AGE_MS) {
      counts.deferred++;
      continue;
    }
    // Una fila que revienta no tumba la pasada entera: las demás también tienen dinero en juego.
    let outcome;
    try {
      // El cron SÍ puede añadir: para cuando llega aquí, Seal está en reposo o la pasada se
      // espera (lo mira `processRepairIntent`), así que una línea que falta es una que Seal
      // perdió, no una que va lenta.
      outcome = await processRepairIntent(intent, { allowAdds: true, source: "mix-repair-drain" });
    } catch (e) {
      console.error("[mix-repair-drain] intent threw", {
        subId: intent.seal_subscription_id,
        msg: e instanceof Error ? e.message : String(e),
      });
      counts.deferred++;
      continue;
    }
    if (outcome === "done") counts.done++;
    else if (outcome === "already_ok") counts.alreadyOk++;
    else if (outcome === "failed") counts.failed++;
    else if (outcome === "expired") counts.expired++;
    else if (outcome === "deferred") counts.deferred++;
  }

  return NextResponse.json({ ok: true, ...counts });
}

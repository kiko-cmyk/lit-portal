import { NextResponse, type NextRequest } from "next/server";
import { alertSlackErrorAwaited } from "@/lib/alert";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import {
  discountedItemIds,
  LINE_REPAIR_TTL_MS,
  planLineRepair,
} from "@/lib/line-repair";
import { compositionFromLines, shapeFor, type SubscriptionLine, type TargetLine } from "@/lib/mix";
import {
  getChargeTotalCents,
  getLines,
  normalizeFrequency,
  seal,
  type SealSubscription,
} from "@/lib/seal";
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

const MAX_ATTEMPTS = 5;
/** Una intención con dinero en juego nunca se suelta en silencio: pasado el TTL se
 *  marca `failed`, se conserva para conciliar y se avisa. */
const INTENT_TTL_MS = LINE_REPAIR_TTL_MS;
/**
 * Una fila recién escrita puede seguir siendo de una petición VIVA: la ruta la arma antes
 * de su primer cambio en Seal y la borra al converger. Leer en ese hueco daría la foto
 * intacta y cerraría como "no entró nada" justo antes de que la ruta empiece a mutar,
 * dejándola sin red. La ruta vive como mucho 20 s (`maxDuration`) y su cerrojo 30 s.
 */
const MIN_AGE_MS = 60_000;
/** Los avisos de un caso atascado: al primer intento y luego una vez por hora (el cron
 *  pasa cada 5 min y `alertSlackError` solo deduplica 60 s dentro de la misma instancia). */
const ALERT_EVERY_ATTEMPTS = 12;

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

  let done = 0;
  let alreadyOk = 0;
  let deferred = 0;
  let failed = 0;
  let expired = 0;

  for (const intent of intents ?? []) {
    const subId = Number(intent.seal_subscription_id);
    const desired = intent.desired as TargetLine[];
    const snapshot = (intent.snapshot ?? []) as SubscriptionLine[];
    const attempts = intent.attempts ?? 0;
    const key = { customer_id: intent.customer_id, seal_subscription_id: intent.seal_subscription_id };
    const shouldAlert = attempts === 0 || attempts % ALERT_EVERY_ATTEMPTS === 0;

    // SOLO LA FILA QUE SE LEYÓ (2-oct-2026). La clave es una por sub, y la ruta del plan
    // la reescribe (upsert) cada vez que arma una red. Si una petición nueva la rearma
    // mientras esta pasada trabaja con la vieja, cerrar por clave marcaría `failed` la red
    // NUEVA y esa petición se quedaría sin ella. `created_at` cambia en cada rearme, así
    // que filtrar también por él hace que la pasada vieja no toque nada.
    const close = async (status: "done" | "failed", lastError?: string): Promise<boolean> => {
      const { data } = await sb
        .from("subscription_line_repairs")
        .update({ status, last_error: lastError ?? null, updated_at: new Date().toISOString() })
        .eq("customer_id", key.customer_id)
        .eq("seal_subscription_id", key.seal_subscription_id)
        .eq("created_at", intent.created_at)
        .select("created_at");
      const matched = (data?.length ?? 0) > 0;
      if (!matched) console.warn("[mix-repair-drain] la fila se rearmó durante la pasada; no se toca", { subId });
      return matched;
    };

    const bump = (lastError: string) =>
      sb
        .from("subscription_line_repairs")
        .update({
          attempts: attempts + 1,
          last_error: lastError,
          updated_at: new Date().toISOString(),
        })
        .eq("customer_id", key.customer_id)
        .eq("seal_subscription_id", key.seal_subscription_id)
        .eq("created_at", intent.created_at);

    const ledger = (outcome: DrainLedgerOutcome, sub: SealSubscription | null, note: string) =>
      writeDrainLedger(intent.customer_id, subId, outcome, sub, note);
    /** Cierra la fila y, solo si era la que se leyó, deja su apunte en el ledger. */
    const closeAndRecord = async (
      status: "done" | "failed",
      lastError: string | undefined,
      outcome: DrainLedgerOutcome,
      sub: SealSubscription | null,
      note: string,
    ): Promise<boolean> => {
      const matched = await close(status, lastError);
      if (matched) await ledger(outcome, sub, note);
      return matched;
    };

    const lastTouch = new Date(intent.updated_at ?? intent.created_at).getTime();
    if (Date.now() - lastTouch < MIN_AGE_MS) {
      deferred++;
      continue;
    }

    if (Date.now() - new Date(intent.created_at).getTime() > INTENT_TTL_MS) {
      if (!(await closeAndRecord("failed", "expired unconverged", "repair_failed", null, "expirada sin converger"))) {
        continue;
      }
      expired++;
      const msg =
        `sub ${subId}: line repair expired without converging. The subscription may still ` +
        `hold extra lines and OVERCHARGE on its next renewal. desired=${JSON.stringify(desired)}`;
      console.error("[mix-repair-drain] expired unconverged", { subId, customerId: intent.customer_id });
      await alertSlackErrorAwaited({
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
    const plan = planLineRepair(live, snapshot, desired);

    // Cancelled/paused: nothing will be charged, so there is nothing to repair. Close it
    // instead of retrying to the TTL and alerting about an over-charge that can't happen
    // (the same trap the re-anchor drain fell into: 8 dead intents, all cancelled subs).
    //
    // PERO SI SE QUEDA A MEDIAS, `failed` Y NO `done` (2-oct-2026). Una sub cancelada o
    // pausada vuelve con sus líneas tal cual si se reactiva o se reanuda, y la guarda de la
    // ruta del plan no mira las filas `done`: cerrada así, el siguiente cambio tarificaría
    // sobre las cajas de más, que es la 12798642 otra vez.
    if (sub.status !== "ACTIVE") {
      const coherent = plan.kind === "nothing_to_do";
      await closeAndRecord(
        coherent ? "done" : "failed",
        coherent
          ? `subscription is ${sub.status}, nothing to repair`
          : `subscription is ${sub.status} and still half-written: check it if it comes back`,
        "closed_inactive",
        sub,
        coherent
          ? `la sub está ${sub.status}: no se cobra, no hay nada que reparar`
          : `la sub está ${sub.status} y A MEDIAS: si se reactiva vuelve con las líneas de más`,
      );
      alreadyOk++;
      continue;
    }

    // LO AJENO NO SE PISA (4-sep-2026, refinado el 2-oct). `desired` se congela cuando se
    // arma la intención y puede aplicarse hasta 6h más tarde. En ese hueco el cliente
    // puede haber cambiado su plan por otra vía (soporte, el admin de Seal). Aplicar
    // entonces un line-set viejo no es reparar, es revertirle un cambio que sí pidió.
    if (plan.kind === "foreign") {
      if (!(await closeAndRecord("failed", `cambio ajeno: ${plan.reason}`, "repair_failed", sub, `cambio ajeno: ${plan.reason}`))) {
        continue;
      }
      failed++;
      console.warn("[mix-repair-drain] intento obsoleto, la sub la ha tocado otro", { subId, reason: plan.reason });
      await alertSlackErrorAwaited({
        path: "/api/cron/mix-repair-drain",
        code: "mix_repair_stale_boxes",
        msg:
          `sub ${subId}: la reparación no se aplica porque la suscripción la ha tocado otro ` +
          `(${plan.reason}). Habría revertido ese cambio. Revisar a mano si la sub quedó bien.`,
        customerId: intent.customer_id,
      });
      continue;
    }

    if (plan.kind === "nothing_to_do") {
      // Ya está coherente: o el cambio entró entero (la petición lo dio por fallido y no
      // lo era, la 13416998) o no entró nada. En los dos casos el ledger se cierra con
      // la verdad, que es lo único que el detector puede contrastar.
      const atTarget = plan.state === "at_target";
      const closed = await closeAndRecord(
        "done",
        atTarget ? undefined : "no entró nada: la sub sigue como la foto",
        atTarget ? "applied" : "rolled_back",
        sub,
        atTarget ? "el cambio había entrado entero" : "no entró nada: la sub sigue como la foto",
      );
      if (closed && atTarget) await clearStalePreservation(intent.customer_id, subId, desired);
      alreadyOk++;
      continue;
    }

    if (plan.kind === "needs_adds") {
      // Ni el objetivo ni la foto se alcanzan sin añadir, y añadir pide datos de línea de
      // Shopify que aquí no hay. La ruta no produce este estado (ver planLineRepair), así
      // que es para una persona. Si además quedan líneas por quitar, cobra de MÁS.
      const alsoRemoves = plan.removes.length;
      await bump(`needs ${plan.adds.length} add(s) — not done from the cron`);
      deferred++;
      console.warn("[mix-repair-drain] repair needs adds, deferring to support", {
        subId,
        adds: plan.adds.map((a) => a.variantId),
        pendingRemoves: alsoRemoves,
      });
      if (shouldAlert) {
        await alertSlackErrorAwaited({
          path: "/api/cron/mix-repair-drain",
          code: alsoRemoves ? "mix_repair_needs_adds_overcharging" : "mix_repair_needs_adds",
          msg:
            `sub ${subId}: la reparación necesita ${plan.adds.length} add(s) y el cron no sabe hacerlos ` +
            `(faltan los datos de línea de Shopify). ` +
            (alsoRemoves
              ? `ADEMÁS quedan ${alsoRemoves} línea(s) por quitar, así que AHORA MISMO COBRA DE MÁS: arreglar a mano ya.`
              : `No cobra de más (le faltan líneas, no le sobran), pero no se va a arreglar solo.`) +
            ` Variantes a añadir: ${plan.adds.map((a) => a.variantId).join(", ")}.`,
          customerId: intent.customer_id,
        });
      }
      continue;
    }

    // plan.kind === "converge": solo edits y removes, que el cron sí sabe hacer.
    const discounted = discountedItemIds(sub, plan.removes);
    if (discounted.length) {
      await bump(`línea(s) ${discounted.join(", ")} con descuento: no se quitan desde el cron`);
      deferred++;
      if (shouldAlert) {
        await alertSlackErrorAwaited({
          path: "/api/cron/mix-repair-drain",
          code: "mix_repair_discount_on_removed_line",
          msg:
            `sub ${subId}: escritura a medias y la(s) línea(s) a quitar (${discounted.join(", ")}) llevan un ` +
            `código de descuento. Quitarlas desde aquí haría que Seal lo arrastre invisible a otra línea. ` +
            (plan.towards === "target"
              ? `AHORA MISMO COBRA DE MÁS: quitar a mano ${plan.removes.join(", ")} y comprobar que el código sigue en la línea que queda.`
              : `Volver a mano a la foto: ${JSON.stringify(snapshot.map((l) => `${l.variantId}×${l.quantity}@${l.unitPrice}`))}.`),
          customerId: intent.customer_id,
        });
      }
      continue;
    }

    try {
      if (plan.edits.length) {
        await seal.editItems(
          subId,
          plan.edits.map((e) => ({ itemId: e.itemId, quantity: e.quantity, price: e.unitPrice })),
        );
        await sleep(500);
      }
      if (plan.removes.length) {
        await seal.removeItems(subId, plan.removes);
      }

      // Verify by reading back, never by trusting the mutation response.
      await sleep(800);
      const after = await seal.getSubscriptionById(subId);
      const afterPlan = after ? planLineRepair(getLines(after), snapshot, desired) : null;
      const reached =
        afterPlan?.kind === "nothing_to_do" &&
        afterPlan.state === (plan.towards === "target" ? "at_target" : "at_snapshot");
      if (reached) {
        const closed = await closeAndRecord(
          "done",
          plan.towards === "target" ? undefined : "devuelta a la foto",
          plan.towards === "target" ? "applied" : "rolled_back",
          after,
          plan.towards === "target"
            ? "escritura a medias completada por el cron"
            : "escritura a medias devuelta a la foto por el cron",
        );
        if (closed && plan.towards === "target") await clearStalePreservation(intent.customer_id, subId, desired);
        done++;
        console.log("[mix-repair-drain] converged", {
          subId,
          towards: plan.towards,
          chargeCents: after ? getChargeTotalCents(after) : null,
        });
      } else {
        await bump("still not converged after applying the diff");
        deferred++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempts + 1 >= MAX_ATTEMPTS) {
        await closeAndRecord("failed", msg, "repair_failed", sub, `se rinde tras ${attempts + 1} intentos: ${msg}`);
        failed++;
        console.error("[mix-repair-drain] gave up after max attempts", { subId, msg });
        await alertSlackErrorAwaited({
          path: "/api/cron/mix-repair-drain",
          code: "mix_repair_failed",
          msg: `sub ${subId}: line repair gave up after ${attempts + 1} attempts (${msg}). Fix in Seal by hand: desired=${JSON.stringify(desired)}`,
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

/**
 * Fila de cierre en `subscription_changes` (2-oct-2026). Best effort, nunca fatal: un
 * apunte de auditoría no puede tumbar una reparación.
 *
 * `applied` y `rolled_back` llevan `chargedCents` leído de Seal DESPUÉS de converger,
 * sobre la misma base que la ruta (Σ cantidad × precio, sin descuentos), así que el
 * detector de reprecios las puede contrastar como el recibo que son.
 */
type DrainLedgerOutcome = "applied" | "rolled_back" | "repair_failed" | "closed_inactive";

async function writeDrainLedger(
  customerId: string,
  subId: number,
  outcome: DrainLedgerOutcome,
  sub: SealSubscription | null,
  note: string,
): Promise<void> {
  try {
    const lines = sub ? getLines(sub) : [];
    const composition = compositionFromLines(lines);
    const { error } = await supabaseAdmin().from("subscription_changes").insert({
      customer_id: customerId,
      change_type: shapeFor(composition) === "split" ? "mix" : "plan",
      payload: {
        sealSubscriptionId: String(subId),
        outcome,
        source: "mix-repair-drain",
        to: sub
          ? {
              composition,
              shape: shapeFor(composition),
              frequency: normalizeFrequency(sub.delivery_interval ?? ""),
            }
          : null,
        chargedCents:
          sub && (outcome === "applied" || outcome === "rolled_back") ? getChargeTotalCents(sub) : null,
        note,
      },
    });
    if (error) console.warn(`[mix-repair-drain] ledger-write-failed sub=${subId}: ${error.message}`);
  } catch (e) {
    console.warn(`[mix-repair-drain] ledger-write-threw sub=${subId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Al completar una escritura hacia su OBJETIVO, el precio preservado que ya no corresponde
 * a esas cajas se limpia (2-oct-2026), igual que hace la ruta al verificar.
 *
 * Sin esto, un cambio de cajas que muere a medias y termina el cron deja
 * `preserved_box_count` con las cajas de ANTES, y el siguiente cambio del cliente choca
 * con `contract_box_count_mismatch` (409) aunque la sub esté perfecta. Solo se LIMPIA,
 * nunca se escribe: escribir un preservado que falta es inocuo dejarlo para la ruta, y
 * borrar uno que sí corresponde es justo el error del 11-sep, así que la condición es la
 * misma que la de la ruta: las cajas que quedan escritas difieren de las del contrato.
 */
async function clearStalePreservation(customerId: string, subId: number, desired: TargetLine[]): Promise<void> {
  const desiredBoxes = desired.reduce((s, l) => s + (Number(l.boxes) || 0), 0);
  if (!desiredBoxes) return;
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("subscriptions")
      .select("preserved_box_count")
      .eq("customer_id", customerId)
      .eq("seal_subscription_id", String(subId))
      .maybeSingle();
    if (error || data?.preserved_box_count == null) return;
    if (Number(data.preserved_box_count) === desiredBoxes) return;
    const { error: clearErr } = await sb
      .from("subscriptions")
      .update({ preserved_charge_cents: null, preserved_box_count: null })
      .eq("customer_id", customerId)
      .eq("seal_subscription_id", String(subId));
    if (clearErr) console.warn(`[mix-repair-drain] preserved-clear-failed sub=${subId}: ${clearErr.message}`);
    else console.log("[mix-repair-drain] preserved cleared", { subId, from: data.preserved_box_count, to: desiredBoxes });
  } catch (e) {
    console.warn(`[mix-repair-drain] preserved-clear-threw sub=${subId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

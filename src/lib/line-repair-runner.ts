import { alertSlackErrorAwaited } from "./alert";
import { ApiHttpError } from "./api-helpers";
import { ensureDiscoveryCreditAttached, pendingDiscoveryCreditForSub } from "./discovery-renewal-credit";
import {
  classifyLineState,
  discountedItemIds,
  isRemoveAllItemsRejection,
  LINE_REPAIR_TTL_MS,
  planDiscountForRemoval,
  planLineRepair,
  sealBusyReason,
  type RemovalDiscountPlan,
  type TrackedDiscount,
} from "./line-repair";
import { compositionFromLines, shapeFor, type SubscriptionLine, type TargetLine } from "./mix";
import {
  findAllAppliedDiscountCodeIds,
  getChargeTotalCents,
  getLines,
  normalizeFrequency,
  projectPendingTarget,
  seal,
  type SealSubscription,
} from "./seal";
import type { Subscription } from "./types";
import { supabaseAdmin } from "./supabase";

/**
 * Terminar UNA intención de `subscription_line_repairs` (14-oct-2026).
 *
 * Antes vivía dentro de `/api/cron/mix-repair-drain`. Sale aquí para que la use también
 * la ruta de plan, en su `after()`: cuando Seal tarda en enseñar las líneas recién
 * añadidas, la ruta contesta al cliente y termina el cambio en segundo plano con la misma
 * lógica que el cron, que es la que ya sabe soltar y reponer descuentos, no pisar cambios
 * ajenos y cerrar el ledger.
 *
 * Idempotente: relee Seal y decide desde lo vivo (`planLineRepair`). Si ya está coherente,
 * cierra la fila. Dos pasadas seguidas no hacen daño.
 *
 * LO NUEVO DEL 14-OCT, medido en la sub de prueba 16923672:
 *   - Seal puede PERDER una escritura que contestó con 200 y apuntó en su log (un add
 *     pocos segundos después de un cambio de intervalo; un cambio de intervalo justo
 *     después de quitar líneas). Así que la reparación ya no "vuelve a la foto" cuando le
 *     faltan líneas: las AÑADE, si la intención trae los datos de alta (`sealAdd`) y si
 *     Seal está en reposo (`sealBusyReason`), para no duplicar un add que solo va lento.
 *   - Seal rechaza quitar lo viejo mientras no ve lo nuevo ("You can't remove all items"):
 *     tras añadir, se espera a verlo antes de quitar.
 */

const MAX_ATTEMPTS = 5;
/** Los avisos de un caso atascado: al primer intento y luego una vez por hora (el cron
 *  pasa cada 5 min y `alertSlackError` solo deduplica 60 s dentro de la misma instancia). */
const ALERT_EVERY_ATTEMPTS = 12;
/** Cuánto se espera a que Seal enseñe una línea recién añadida antes de quitar la vieja. */
const ADD_VISIBLE_MS = 20_000;
const POLL_EVERY_MS = 1_000;

export interface RepairIntentRow {
  customer_id: string;
  seal_subscription_id: string;
  desired: unknown;
  snapshot: unknown;
  attempts: number | null;
  created_at: string;
  updated_at: string | null;
}

export type RepairOutcome = "done" | "already_ok" | "deferred" | "failed" | "expired" | "skipped";

export interface RepairRunOptions {
  /** Permitir AÑADIR líneas (solo con Seal en reposo). El cron sí; el `after()` de la ruta no. */
  allowAdds: boolean;
  /**
   * No mirar si Seal está ocupado. Solo para la ruta de plan, cuyas escrituras recientes son
   * las suyas y que ya ha visto las líneas nuevas en Seal antes de llamar.
   */
  ignoreBusy?: boolean;
  /** Quién la termina, para el ledger y los avisos. */
  source: "mix-repair-drain" | "plan-route-after";
}

export async function processRepairIntent(intent: RepairIntentRow, opts: RepairRunOptions): Promise<RepairOutcome> {
  const sb = supabaseAdmin();
  const subId = Number(intent.seal_subscription_id);
  const desired = (intent.desired ?? []) as TargetLine[];
  const snapshot = (intent.snapshot ?? []) as SubscriptionLine[];
  const attempts = intent.attempts ?? 0;
  const key = { customer_id: intent.customer_id, seal_subscription_id: intent.seal_subscription_id };
  const shouldAlert = attempts === 0 || attempts % ALERT_EVERY_ATTEMPTS === 0;
  const path = opts.source === "mix-repair-drain" ? "/api/cron/mix-repair-drain" : "/api/subscription/plan#after";

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
    if (!matched) console.warn("[line-repair] la fila se rearmó durante la pasada; no se toca", { subId });
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
    writeDrainLedger(intent.customer_id, subId, outcome, sub, note, opts.source);
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

  if (Date.now() - new Date(intent.created_at).getTime() > LINE_REPAIR_TTL_MS) {
    if (!(await closeAndRecord("failed", "expired unconverged", "repair_failed", null, "expirada sin converger"))) {
      return "skipped";
    }
    console.error("[line-repair] expired unconverged", { subId, customerId: intent.customer_id });
    await alertSlackErrorAwaited({
      path,
      // El id de la sub en el código: la deduplicación de avisos va por `path|code`, y con
      // varias subs atascadas en la misma pasada solo salía el primero (14-oct-2026).
      code: `mix_repair_expired:${subId}`,
      msg:
        `sub ${subId}: line repair expired without converging. The subscription may still ` +
        `hold extra lines and OVERCHARGE on its next renewal. desired=${JSON.stringify(desired)}`,
      customerId: intent.customer_id,
    });
    return "expired";
  }

  const sub = await seal.getSubscriptionById(subId);
  if (!sub) {
    // Transient Seal failure — leave pending, retry next run.
    await bump("could not read subscription");
    return "deferred";
  }

  const live = getLines(sub);
  const plan = planLineRepair(live, snapshot, desired, { allowAdds: opts.allowAdds });

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
    if (!coherent) {
      // A una persona (14-oct-2026): si la reactivan, vuelve cobrando las líneas de más.
      await alertSlackErrorAwaited({
        path,
        code: `mix_repair_inactive_half_written:${subId}`,
        msg: `sub ${subId}: está ${sub.status} y con las líneas a medias. Si se reactiva o se reanuda, vuelve cobrando de más: dejarla como desired=${JSON.stringify(desired)}.`,
        customerId: intent.customer_id,
      });
    }
    return "already_ok";
  }

  // LO AJENO NO SE PISA (4-sep-2026, refinado el 2-oct). `desired` se congela cuando se
  // arma la intención y puede aplicarse hasta 6h más tarde. En ese hueco el cliente
  // puede haber cambiado su plan por otra vía (soporte, el admin de Seal). Aplicar
  // entonces un line-set viejo no es reparar, es revertirle un cambio que sí pidió.
  if (plan.kind === "foreign") {
    if (!(await closeAndRecord("failed", `cambio ajeno: ${plan.reason}`, "repair_failed", sub, `cambio ajeno: ${plan.reason}`))) {
      return "skipped";
    }
    console.warn("[line-repair] intento obsoleto, la sub la ha tocado otro", { subId, reason: plan.reason });
    await alertSlackErrorAwaited({
      path,
      code: `mix_repair_stale_boxes:${subId}`,
      msg:
        `sub ${subId}: la reparación no se aplica porque la suscripción la ha tocado otro ` +
        `(${plan.reason}). Habría revertido ese cambio. Revisar a mano si la sub quedó bien.`,
      customerId: intent.customer_id,
    });
    return "failed";
  }

  if (plan.kind === "nothing_to_do") {
    // Ya está coherente: o el cambio entró entero (la petición lo dio por fallido y no
    // lo era, la 13416998) o no entró nada. En los dos casos el ledger se cierra con
    // la verdad, que es lo único que el detector puede contrastar.
    const atTarget = plan.state === "at_target";
    // Desde el `after()` de la ruta, "no entró nada" NO se cierra (14-oct-2026): la ruta
    // acaba de ver lo añadido, así que una lectura sin ello es Seal yendo por detrás. Se
    // deja la fila para el cron, que decide con Seal en reposo.
    if (!atTarget && opts.source === "plan-route-after") {
      await bump("el after() leyó la foto justo después de ver lo añadido: decide el cron");
      return "deferred";
    }
    const closed = await closeAndRecord(
      "done",
      atTarget ? undefined : "no entró nada: la sub sigue como la foto",
      atTarget ? "applied" : "rolled_back",
      sub,
      atTarget ? "el cambio había entrado entero" : "no entró nada: la sub sigue como la foto",
    );
    if (closed && atTarget) await clearStalePreservation(intent.customer_id, subId, desired);
    if (closed && !atTarget) {
      // Se le dijo al cliente que su cambio se estaba aplicando (`change_applying`) y no ha
      // entrado: que lo sepa una persona (14-oct-2026). Solo pasa con intenciones viejas,
      // sin datos de alta; las nuevas se completan añadiendo.
      await alertSlackErrorAwaited({
        path,
        code: `mix_repair_rolled_back:${subId}`,
        msg: `sub ${subId}: la reparación se cerró sin aplicar el cambio que pidió el cliente (la sub sigue como antes). Avisarle o aplicarlo a mano: desired=${JSON.stringify(desired)}.`,
        customerId: intent.customer_id,
      });
    }
    return "already_ok";
  }

  if (plan.kind === "needs_adds") {
    // Ni el objetivo ni la foto se alcanzan sin añadir, y la intención no trae los datos
    // de alta (intenciones anteriores al 14-oct) o no se permite añadir en esta pasada.
    const alsoRemoves = plan.removes.length;
    await bump(`needs ${plan.adds.length} add(s) — not done from here`);
    console.warn("[line-repair] repair needs adds", {
      subId,
      adds: plan.adds.map((a) => a.variantId),
      pendingRemoves: alsoRemoves,
      allowAdds: opts.allowAdds,
    });
    if (shouldAlert && opts.source === "mix-repair-drain") {
      await alertSlackErrorAwaited({
        path,
        code: `${alsoRemoves ? "mix_repair_needs_adds_overcharging" : "mix_repair_needs_adds"}:${subId}`,
        msg:
          `sub ${subId}: la reparación necesita ${plan.adds.length} add(s) y no tiene los datos para hacerlos. ` +
          (alsoRemoves
            ? `ADEMÁS quedan ${alsoRemoves} línea(s) por quitar, así que AHORA MISMO COBRA DE MÁS: arreglar a mano ya.`
            : `No cobra de más (le faltan líneas, no le sobran), pero no se va a arreglar solo.`) +
          ` Variantes a añadir: ${plan.adds.map((a) => a.variantId).join(", ")}.`,
        customerId: intent.customer_id,
      });
    }
    return "deferred";
  }

  // plan.kind === "converge".
  //
  // Desde el `after()` de la ruta nunca se vuelve a la foto: deshacer el cambio del cliente
  // sobre una lectura que puede ir por detrás de Seal es justo lo que no se hace. El cron.
  if (plan.towards === "snapshot" && opts.source === "plan-route-after") {
    await bump("el after() no devuelve a la foto: decide el cron");
    return "deferred";
  }
  //
  // SEAL EN REPOSO ANTES DE ESCRIBIR (14-oct-2026). Con escrituras recientes en su log o el
  // calendario a medio regenerar, Seal puede perder la nuestra aunque conteste 200. Y un add
  // que todavía no se ve puede ser uno que va lento: volver a añadirlo lo duplicaría.
  if (!opts.ignoreBusy) {
    const busy = sealBusyReason(sub);
    if (busy) {
      await bump(`Seal ocupado, se espera: ${busy}`);
      return "deferred";
    }
  }

  const adds = plan.adds ?? [];
  // EL 15% DE RETENCIÓN YA NO BLOQUEA (8-oct-2026, sub 15950195). Antes, cualquier código
  // en la línea a quitar mandaba el caso a una persona, y la ruta deja SIEMPRE el 15%
  // puesto antes de pasarle el caso al cron. Ahora, si el único código es el que seguimos
  // en `retention_discounts`, se suelta, se quita la línea y se repone, como en la ruta.
  //
  // Lo mismo con el crédito Discovery de la primera renovación (9-oct-2026): si se queda en
  // una línea que se quita, Seal lo arrastra invisible y los 4,99 € se repetirían en cada envío.
  //
  // Y AL AÑADIR, TODAS LAS LÍNEAS (14-oct-2026): `add_items` arrastra a la línea nueva los
  // códigos que ya hay en la sub (ver `seal.addItems`), así que si se añade se mira el
  // descuento de cualquier línea, no solo de las que se quitan.
  const discountScope = adds.length ? live.map((l) => Number(l.itemId)) : plan.removes;
  const tracked: TrackedDiscount[] = [];
  if (discountedItemIds(sub, discountScope).length) {
    const retentionCode = await trackedRetentionCode(intent.customer_id, subId);
    if (retentionCode) tracked.push({ kind: "retention", code: retentionCode });
    const discoveryCode = await trackedDiscoveryCode(subId);
    if (discoveryCode) tracked.push({ kind: "discovery", code: discoveryCode });
  }
  const discountPlan = planDiscountForRemoval(sub, discountScope, tracked);
  if (discountPlan.kind === "foreign") {
    const discounted = discountPlan.itemIds;
    await bump(`línea(s) ${discounted.join(", ")} con descuento: no se tocan desde aquí`);
    if (shouldAlert && opts.source === "mix-repair-drain") {
      await alertSlackErrorAwaited({
        path,
        code: `mix_repair_discount_on_removed_line:${subId}`,
        msg:
          `sub ${subId}: escritura a medias y la(s) línea(s) (${discounted.join(", ")}) llevan un ` +
          `código de descuento que no seguimos. Tocarlas desde aquí haría que Seal lo arrastre invisible a otra línea. ` +
          (plan.towards === "target"
            ? `Dejarla a mano como desired=${JSON.stringify(desired)} y comprobar que el código sigue UNA vez.`
            : `Volver a mano a la foto: ${JSON.stringify(snapshot.map((l) => `${l.variantId}×${l.quantity}@${l.unitPrice}`))}.`),
        customerId: intent.customer_id,
      });
    }
    return "deferred";
  }

  // Soltar el 15% ANTES de tocar líneas. Si falla, no se toca nada en esta pasada: quitar
  // la línea con el código puesto es justo el arrastre invisible que esto evita. El código
  // puede haberse soltado aunque la llamada falle, así que se asegura igual.
  if (discountPlan.kind === "tracked") {
    try {
      for (const c of discountPlan.codes) {
        for (const id of c.ids) await seal.removeDiscountCode(subId, id);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ensureTrackedDiscounts(subId, intent.customer_id, discountPlan, path);
      await bump(`no se pudo soltar ${discountPlan.codes.map((c) => c.code).join(" + ")} antes de tocar líneas: ${msg}`);
      return "deferred";
    }
  }

  try {
    let addsVisible = true;
    try {
      if (plan.edits.length) {
        await seal.editItems(
          subId,
          plan.edits.map((e) => ({ itemId: e.itemId, quantity: e.quantity, price: e.unitPrice })),
        );
        await sleep(500);
      }
      if (adds.length) {
        await seal.addItems(
          subId,
          adds.map((a) => ({
            productId: a.productId,
            variantId: a.variantId,
            quantity: a.quantity,
            title: a.sealAdd!.title,
            sku: a.sealAdd!.sku || a.sku,
            taxable: a.sealAdd!.taxable,
            requiresShipping: a.sealAdd!.requiresShipping,
            price: centsToPrice(a.unitPriceCents),
          })),
        );
        // No se quita nada hasta VER lo añadido: si no, Seal contesta "You can't remove all
        // items" o, peor, la sub se queda corta si el add se pierde.
        addsVisible = await waitUntilSeal(subId, (s) => hasAll(getLines(s), adds), ADD_VISIBLE_MS);
      }
      if (addsVisible && plan.removes.length) {
        await removeWhenVisible(subId, plan.removes, adds);
      }
    } finally {
      // Se repone pase lo que pase con las líneas: el cliente nunca se queda sin su 15%
      // ni sin su crédito Discovery (este, solo si se le sigue debiendo).
      if (discountPlan.kind === "tracked") {
        await sleep(500);
        await ensureTrackedDiscounts(subId, intent.customer_id, discountPlan, path);
      }
    }
    if (!addsVisible) {
      await bump("añadido, pero Seal todavía no lo enseña: se termina en la pasada siguiente");
      return "deferred";
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
          ? `escritura a medias completada (${opts.source})`
          : `escritura a medias devuelta a la foto (${opts.source})`,
      );
      if (closed && plan.towards === "target") await clearStalePreservation(intent.customer_id, subId, desired);
      console.log("[line-repair] converged", {
        subId,
        towards: plan.towards,
        source: opts.source,
        chargeCents: after ? getChargeTotalCents(after) : null,
      });
      return "done";
    }
    await bump("still not converged after applying the diff");
    return "deferred";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (attempts + 1 >= MAX_ATTEMPTS) {
      await closeAndRecord("failed", msg, "repair_failed", sub, `se rinde tras ${attempts + 1} intentos: ${msg}`);
      console.error("[line-repair] gave up after max attempts", { subId, msg });
      await alertSlackErrorAwaited({
        path,
        code: `mix_repair_failed:${subId}`,
        msg: `sub ${subId}: line repair gave up after ${attempts + 1} attempts (${msg}). Fix in Seal by hand: desired=${JSON.stringify(desired)}`,
        customerId: intent.customer_id,
      });
      return "failed";
    }
    await bump(msg);
    return "deferred";
  }
}

/** ¿Están ya en Seal todas las líneas a añadir (variante, cantidad y precio)? */
function hasAll(live: SubscriptionLine[], adds: TargetLine[]): boolean {
  return adds.every((a) =>
    live.some(
      (l) =>
        String(l.variantId) === String(a.variantId) &&
        Number(l.quantity) === Number(a.quantity) &&
        Math.round(parseFloat(l.unitPrice) * 100) === a.unitPriceCents,
    ),
  );
}

/** Relee Seal hasta que `ok` se cumpla o se acabe el tiempo. Una lectura fallida no corta. */
export async function waitUntilSeal(
  subId: number,
  ok: (s: SealSubscription) => boolean,
  maxMs: number,
  everyMs: number = POLL_EVERY_MS,
): Promise<boolean> {
  const until = Date.now() + maxMs;
  for (;;) {
    try {
      const s = await seal.getSubscriptionById(subId);
      if (s && ok(s)) return true;
    } catch {
      // una lectura que falla no decide nada: se vuelve a mirar
    }
    if (Date.now() + everyMs > until) return false;
    await sleep(everyMs);
  }
}

/**
 * Quita `removeIds`. Si Seal contesta que no puede quitarlo todo (todavía no ve lo
 * añadido), espera a verlo y lo vuelve a intentar una vez. Cualquier otro error, arriba.
 */
async function removeWhenVisible(subId: number, removeIds: number[], adds: TargetLine[]): Promise<void> {
  try {
    await seal.removeItems(subId, removeIds);
  } catch (e) {
    if (!isRemoveAllItemsRejection(e)) throw e;
    const visible = await waitUntilSeal(subId, (s) => hasAll(getLines(s), adds), ADD_VISIBLE_MS);
    if (!visible) throw e;
    await seal.removeItems(subId, removeIds);
  }
}

const centsToPrice = (c: number) => (c / 100).toFixed(2);

/**
 * Fila de cierre en `subscription_changes` (2-oct-2026). Best effort, nunca fatal: un
 * apunte de auditoría no puede tumbar una reparación.
 *
 * `applied` y `rolled_back` llevan `chargedCents` leído de Seal DESPUÉS de converger,
 * sobre la misma base que la ruta (Σ cantidad × precio, sin descuentos), así que el
 * detector de reprecios las puede contrastar como el recibo que son.
 */
export type DrainLedgerOutcome = "applied" | "rolled_back" | "repair_failed" | "closed_inactive";

export async function writeDrainLedger(
  customerId: string,
  subId: number,
  outcome: DrainLedgerOutcome,
  sub: SealSubscription | null,
  note: string,
  source: RepairRunOptions["source"] = "mix-repair-drain",
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
        source,
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
    if (error) console.warn(`[line-repair] ledger-write-failed sub=${subId}: ${error.message}`);
  } catch (e) {
    console.warn(`[line-repair] ledger-write-threw sub=${subId}: ${e instanceof Error ? e.message : String(e)}`);
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
    if (clearErr) console.warn(`[line-repair] preserved-clear-failed sub=${subId}: ${clearErr.message}`);
    else console.log("[line-repair] preserved cleared", { subId, from: data.preserved_box_count, to: desiredBoxes });
  } catch (e) {
    console.warn(`[line-repair] preserved-clear-threw sub=${subId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * El código del 15% de retención que seguimos para esta sub, o null. Ante cualquier fallo
 * de lectura, null: se trata entonces el código como ajeno y no se toca la línea.
 */
async function trackedRetentionCode(customerId: string, subId: number): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("retention_discounts")
      .select("code")
      .eq("customer_id", customerId)
      .eq("seal_subscription_id", String(subId))
      .eq("status", "pending_charge")
      .maybeSingle();
    if (error) {
      console.warn(`[line-repair] retention-read-failed sub=${subId}: ${error.message}`);
      return null;
    }
    return (data?.code as string | undefined) ?? null;
  } catch (e) {
    console.warn(`[line-repair] retention-read-threw sub=${subId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * El código del crédito Discovery pendiente de cobro para esta sub, o null. Ante cualquier
 * fallo de lectura, null: igual que con la retención, se trata entonces el código como
 * ajeno y no se toca la línea.
 */
async function trackedDiscoveryCode(subId: number): Promise<string | null> {
  try {
    return (await pendingDiscoveryCreditForSub(subId))?.code ?? null;
  } catch (e) {
    console.warn(`[line-repair] discovery-read-failed sub=${subId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Repone cada código que se soltó, cada uno con su lógica. */
async function ensureTrackedDiscounts(
  subId: number,
  customerId: string,
  discountPlan: Extract<RemovalDiscountPlan, { kind: "tracked" }>,
  path: string,
): Promise<void> {
  for (const c of discountPlan.codes) {
    if (c.kind === "retention") await ensureRetentionDiscount(subId, customerId, c.code, path);
    else await ensureDiscoveryCreditAttached(subId, c.code, path);
  }
}

/**
 * Deja el 15% de retención puesto y su fila de seguimiento apuntando al UUID vivo, como
 * `reattachRetentionDiscountNow` en la ruta del plan (8-oct-2026).
 *
 * Mira antes de poner: si el código sigue visible (el "soltar" falló de verdad) no se
 * aplica encima, solo se refresca el UUID. Se reaviva la fila a `pending_charge` por lo
 * mismo que en la ruta: un consumidor que leyó el hueco sin código puede haberla cerrado,
 * y sin la fila viva nadie quitaría el 15% después de su cobro.
 */
async function ensureRetentionDiscount(subId: number, customerId: string, code: string, path: string): Promise<void> {
  try {
    let fresh = await seal.getSubscriptionById(subId);
    if (!fresh) throw new Error("no se pudo releer la sub");
    let ids = findAllAppliedDiscountCodeIds(fresh, code);
    if (!ids.length) {
      await seal.applyDiscountCode(subId, code);
      fresh = await seal.getSubscriptionById(subId);
      ids = fresh ? findAllAppliedDiscountCodeIds(fresh, code) : [];
    }
    const { error } = await supabaseAdmin()
      .from("retention_discounts")
      .update({
        discount_code_id: ids[0] ?? null,
        status: "pending_charge",
        removed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("customer_id", customerId)
      .eq("seal_subscription_id", String(subId));
    if (error || !ids.length) {
      await alertSlackErrorAwaited({
        path,
        code: `retention_discount_revive_failed:${subId}`,
        msg:
          `sub ${subId}: ${code} repuesto tras reparar las líneas, pero ` +
          (ids.length ? `la fila de seguimiento no se actualizó (${error?.message})` : "Seal no lo enseña al releer") +
          `. Comprobar en Seal que el código está UNA vez y que retention_discounts apunta a su UUID.`,
        customerId,
      });
    }
    console.log("[line-repair] retention discount ensured", { subId, uuid: ids[0] ?? null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[line-repair] retention discount lost", { subId, msg });
    await alertSlackErrorAwaited({
      path,
      code: `retention_discount_lost:${subId}`,
      msg: `sub ${subId}: se soltó ${code} para reparar las líneas y no se pudo reponer (${msg}). Reponer ${code} a mano en Seal.`,
      customerId,
    });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 409 `change_applying` si esta sub tiene un cambio de líneas a medio aplicar (14-oct-2026).
 *
 * Para las rutas que ESCRIBEN en Seal y no son la de plan: "Adelantar envío", saltar y el
 * 15% de retención. Mientras la intención está pendiente, la sub puede tener a la vez las
 * líneas viejas y las nuevas (el estado del 14-oct: Pack de 4 + 3 sueltas, 170,10 por
 * envío), y un Adelantar en ese hueco cobraría las dos al momento. Lo mismo un descuento
 * aplicado ahí: Seal lo pone en todas las líneas y el `after()`/cron tendría que soltarlo.
 *
 * Si Supabase falla, se deja pasar (como el cerrojo de plan): bloquear todos los
 * Adelantar por un parpadeo de la base es peor que el caso raro de coincidir con una
 * reparación justo en ese momento.
 */
export async function assertNoPendingLineRepair(
  customerId: string,
  sealSubscriptionId: number | string,
  route: string,
): Promise<void> {
  let row: { created_at: string } | null = null;
  try {
    const { data, error } = await supabaseAdmin()
      .from("subscription_line_repairs")
      .select("created_at")
      .eq("customer_id", customerId)
      .eq("seal_subscription_id", String(sealSubscriptionId))
      .eq("status", "pending")
      .maybeSingle();
    if (error) {
      console.warn(`[${route}] no se pudo mirar si hay un cambio a medias (se deja pasar): ${error.message}`);
      return;
    }
    row = data as { created_at: string } | null;
  } catch (e) {
    console.warn(`[${route}] no se pudo mirar si hay un cambio a medias (se deja pasar): ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (row && Date.now() - Date.parse(row.created_at) < LINE_REPAIR_TTL_MS) {
    throw new ApiHttpError(
      409,
      "change_applying",
      "A plan change on this subscription is still being applied; try again in a few minutes",
    );
  }
}

/**
 * Lo que el Hub y Cuenta enseñan mientras un cambio de líneas se termina de aplicar
 * (14-oct-2026). El 14-oct, durante los 5 minutos que la sub tuvo el Pack de 4 junto a las
 * 3 sueltas, el Hub pintó "6 cajas por envío · 170,10€" como si fuera el plan del cliente.
 *
 *   - Pendiente y a medias (o como la foto): se enseña lo PEDIDO (`projectPendingTarget`)
 *     con `pendingChange`, para que la pantalla diga que se está aplicando y bloquee las
 *     acciones que escriben (plan, sabor, saltar, adelantar) hasta que termine.
 *   - Pendiente pero ajena (otro tocó la sub): no se inventa nada, se enseña lo vivo y
 *     `stalled`, porque lo va a revisar una persona.
 *   - Ya en el objetivo: nada que enmascarar; el cron cerrará la fila.
 * Ante cualquier fallo de lectura, lo vivo tal cual: es lo que había antes de esto.
 */
export async function maskPendingLineRepair(
  customerId: string,
  sub: SealSubscription,
  current: Subscription,
): Promise<Subscription> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("subscription_line_repairs")
      .select("desired, snapshot, created_at")
      .eq("customer_id", customerId)
      .eq("seal_subscription_id", String(sub.id))
      .eq("status", "pending")
      .maybeSingle();
    if (error || !data) return current;
    if (Date.now() - Date.parse(data.created_at as string) > LINE_REPAIR_TTL_MS) return current;
    const desired = (data.desired ?? []) as TargetLine[];
    const state = classifyLineState(getLines(sub), (data.snapshot ?? []) as SubscriptionLine[], desired);
    if (state.kind === "at_target") return current;
    if (state.kind === "foreign") {
      return { ...current, pendingChange: { since: data.created_at as string, stalled: true } };
    }
    return {
      ...projectPendingTarget(current, desired),
      pendingChange: { since: data.created_at as string, stalled: false },
    };
  } catch (e) {
    console.warn(`[line-repair] mask failed sub=${sub.id}: ${e instanceof Error ? e.message : String(e)}`);
    return current;
  }
}

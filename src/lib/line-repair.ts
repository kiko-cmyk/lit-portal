/**
 * Escrituras a medias en Seal: qué sabemos, qué no, y cómo se cierran.
 *
 * POR QUÉ EXISTE (incidente 2-oct-2026, sub 12798642). Un cambio de sabor que conservaba
 * el precio de la escalera vieja (3 cajas a 67,93) murió entre `add_items` y
 * `remove_items`: Seal añadió las tres líneas nuevas a las 07:26:23 y nunca quitó la
 * vieja, así que la sub pasó a tener 6 cajas. La red de seguridad no estaba: el `add`
 * había "fallado" en nuestro lado, `restoreSnapshot` releyó Seal antes de que el add se
 * viera, no encontró nada que deshacer y la ruta DESARMÓ la intención de reparación. La
 * clienta vio 6 cajas, pidió sus 3, y como desde 6 eso es "cambiar de cantidad", la ruta
 * le aplicó catálogo: 85,05 por las mismas 3 cajas que pagaba a 67,93.
 *
 * No fue un caso aislado. Del 30-ago al 2-oct, 22 de 448 cambios dejaron un `intent` sin
 * fila de cierre en el ledger. En 15 de ellos el log de Seal enseña el `add` sin su
 * `remove`, y solo 3 conservaban la fila de reparación. La 14345379 (17-sep) sigue hoy
 * con las dos líneas, cobrando 48,20 en vez de 24,10.
 *
 * Dos verdades que este módulo hace explícitas, porque el código de antes asumía lo
 * contrario de las dos:
 *
 *   1. Que una escritura a Seal FALLE en nuestro lado no dice que Seal no la aplicara.
 *      Solo un 4xx es Seal diciendo "no". Nuestro deadline, un abort, la red o un 5xx
 *      son "no sé". Ver `sealWriteDefinitelyRejected`.
 *
 *   2. Un estado a medias se reconoce comparando lo vivo contra la FOTO y el OBJETIVO
 *      de la propia intención, nunca contando cajas. Contar cajas es lo que hizo la ruta
 *      el 2-oct (6 cajas vivas contra 3 pedidas = "cambia de cantidad"), y es también por
 *      lo que el cron de reparación rechazaba el caso para el que existe: un add sin su
 *      remove SIEMPRE tiene más cajas que el objetivo, y su guarda del 4-sep lo leía como
 *      "alguien le cambió el plan entremedias". Ver `classifyLineState`.
 *
 * Todo lo de aquí es puro (sin red ni base de datos) para poder probarlo entero en
 * scripts/test-line-repair.ts.
 */

import { diffLines, type LineDiff, type SubscriptionLine, type TargetLine } from "./mix";
import { findAllAppliedDiscountCodeIds, SealApiError, type SealSubscription } from "./seal";

const priceToCents = (p: string): number => Math.round(parseFloat(p) * 100);

/**
 * Cuánto vive una intención de reparación pendiente antes de que el cron la dé por
 * perdida y avise. Lo comparten el cron (que la expira) y la ruta del plan (que mientras
 * tanto no deja tarificar encima), para que no se desincronicen.
 */
export const LINE_REPAIR_TTL_MS = 6 * 60 * 60_000;

/**
 * ¿Podemos afirmar que Seal NO aplicó la escritura que acaba de fallar?
 *
 * Solo cuando el propio Seal la rechazó: un 4xx (validación, item inexistente, throttle
 * de borde) o un 200 con `success: false`, que es como Seal contesta "no" a add, edit y
 * remove de items y que `seal.ts` convierte en `SealApiError(200, …)`. La petición llegó y
 * Seal dijo que no. Todo lo demás es "no sé", y hay que tratarlo como "puede haber entrado":
 *
 *   - nuestro deadline (`UpstreamTimeoutError`) o un abort: cortamos NOSOTROS la espera,
 *     pero Seal sigue procesando. La 14345379 (17-sep) y la 13109864 (19-sep) tienen en
 *     su log el `add` que la ruta dio por fallido, y ninguna conservó su reparación.
 *   - un fallo de red: no sabemos si la petición llegó a salir.
 *   - un 5xx o un 408: falló Seal (o su borde) a mitad, con la escritura quizá hecha.
 */
export function sealWriteDefinitelyRejected(e: unknown): boolean {
  if (!(e instanceof SealApiError)) return false;
  if (e.status === 200) return true; // `success: false`: rechazo explícito con HTTP 200
  // Un 5xx con el cuerpo de Seal y `success: false` también es un NO (14-oct-2026): Seal
  // contesta 503 cuando se niega ("You can't remove all items…", "Could not edit the
  // subscription.", su limitador de 10 peticiones a la vez). Un 5xx sin ese cuerpo (HTML
  // de un borde, cuerpo vacío) sigue siendo "no sé".
  if (e.status >= 500 && e.sealRejection() !== null) return true;
  return e.status >= 400 && e.status < 500 && e.status !== 408;
}

/**
 * Seal se niega a quitar las líneas porque, según SU lectura, la sub se quedaría vacía:
 * todavía no ve las que acabamos de añadir (14-oct-2026, medido en la sub de prueba
 * 16923672: tras un cambio de intervalo, el add tarda de 5 a 17 s en verse, y mientras
 * tanto cada remove vuelve con 503 "You can't remove all items from the subscription.").
 * No es un fallo: es "todavía no". Se espera a ver las líneas nuevas y se vuelve a quitar.
 */
export function isRemoveAllItemsRejection(e: unknown): boolean {
  return e instanceof SealApiError && /can't remove all items/i.test(e.sealRejection() ?? "");
}

/** Cuánto hay que dejar pasar desde la última escritura de una sub para volver a escribir. */
export const SEAL_SETTLE_MS = 60_000;
/** Tras un cambio de intervalo Seal regenera el calendario: de 30 s a 4,5 min, medido. */
const SEAL_REGEN_WINDOW_MS = 15 * 60_000;

/** "2026-10-14 13:12:14" (UTC, sin zona) → epoch ms, o NaN. */
function sealLogTime(created: string): number {
  return Date.parse(`${created.replace(" ", "T")}Z`);
}

/**
 * ¿Está Seal todavía procesando una escritura reciente de esta sub? Devuelve el motivo, o
 * null si se puede escribir.
 *
 * POR QUÉ (14-oct-2026, sub de prueba 16923672). Seal acepta una escritura, la apunta en
 * su log, contesta 200… y un proceso suyo posterior la PISA con un estado anterior. Medido:
 *   - un `add_items` 8 s después de un cambio de intervalo: "Items were added", en el log, y
 *     el Pack no apareció nunca (4 minutos después seguía sin estar);
 *   - un cambio de intervalo 3-4 s después de quitar líneas: "Subscription was edited", en
 *     el log, y la sub siguió en 5 meses (2 de 2 veces).
 * Con Seal en reposo, en cambio, cada escritura entra. Así que no se empieza un cambio de
 * plan mientras la sub tenga escrituras recientes o el calendario a medio regenerar: se le
 * dice al cliente que lo intente en un par de minutos, sin haber tocado nada.
 */
export function sealBusyReason(sub: SealSubscription, now: number = Date.now()): string | null {
  const log = sub.log ?? [];
  const times = log.map((e) => sealLogTime(e.created)).filter((t) => Number.isFinite(t));
  const latest = times.length ? Math.max(...times) : NaN;
  if (Number.isFinite(latest) && now - latest < SEAL_SETTLE_MS) {
    return `escritura en Seal hace ${Math.round((now - latest) / 1000)} s`;
  }
  if (sub.status === "ACTIVE") {
    const pending = (sub.billing_attempts ?? []).some(
      (ba) => !ba.completed_at && !ba.status && !ba.skipped_on && ba.date,
    );
    const recentInterval = log.some(
      (e) => /changed the (billing )?interval/i.test(e.content) && now - sealLogTime(e.created) < SEAL_REGEN_WINDOW_MS,
    );
    if (!pending && recentInterval) return "calendario regenerándose tras un cambio de intervalo";
  }
  return null;
}

export type LineState =
  /** Seal tiene exactamente el objetivo de la intención. */
  | { kind: "at_target" }
  /** Seal sigue exactamente como la foto: no entró nada, o se deshizo entero. */
  | { kind: "at_snapshot" }
  /** A medias, y todo lo vivo lo explica ESTA intención: es seguro converger. */
  | { kind: "partial" }
  /** Hay algo que esta intención no explica: alguien más ha tocado la sub. */
  | { kind: "foreign"; reason: string };

const sameLineValues = (a: SubscriptionLine, b: SubscriptionLine): boolean =>
  String(a.variantId) === String(b.variantId) &&
  Number(a.quantity) === Number(b.quantity) &&
  priceToCents(a.unitPrice) === priceToCents(b.unitPrice);

/** Mismas líneas (por item id) con los mismos valores. */
function sameLines(a: SubscriptionLine[], b: SubscriptionLine[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((l) => {
    const other = b.find((o) => Number(o.itemId) === Number(l.itemId));
    return !!other && sameLineValues(l, other);
  });
}

/**
 * En qué punto está una sub respecto a UNA intención concreta (su foto y su objetivo).
 *
 * Una línea viva está explicada por la intención si es:
 *   - una línea de la foto (mismo item id y variante) sin tocar, o editada en sitio a
 *     los valores que el objetivo le pedía para esa variante; o
 *   - una línea nueva cuya variante, cantidad y precio son los de un add del objetivo.
 *     `diffLines` edita en sitio cualquier variante que ya estaba, así que un add nunca
 *     comparte variante con la foto: si la comparte, la ha puesto otro.
 *
 * Y una línea de la foto que ya no está solo es nuestra si el objetivo la quitaba.
 *
 * Si todo encaja y no es ni la foto ni el objetivo, es una escritura NUESTRA a medias.
 * Si algo no encaja, lo ha tocado alguien más (soporte, el admin de Seal, otra pestaña)
 * y no se debe converger por encima: sería revertirle un cambio que sí pidió.
 */
export function classifyLineState(
  live: SubscriptionLine[],
  snapshot: SubscriptionLine[],
  target: TargetLine[],
): LineState {
  if (diffLines(live, target).noop) return { kind: "at_target" };
  if (sameLines(live, snapshot)) return { kind: "at_snapshot" };

  const snapById = new Map(snapshot.map((s) => [Number(s.itemId), s]));
  const snapVariants = new Set(snapshot.map((s) => String(s.variantId)));
  const targetsFor = (variantId: string) =>
    target.filter((t) => String(t.variantId) === String(variantId));
  const matchesTarget = (l: SubscriptionLine) =>
    targetsFor(l.variantId).some(
      (t) => Number(l.quantity) === t.quantity && priceToCents(l.unitPrice) === t.unitPriceCents,
    );

  for (const l of live) {
    const s = snapById.get(Number(l.itemId));
    if (s) {
      if (String(s.variantId) !== String(l.variantId)) {
        return { kind: "foreign", reason: `la línea ${l.itemId} ha cambiado de variante` };
      }
      if (!sameLineValues(l, s) && !matchesTarget(l)) {
        return {
          kind: "foreign",
          reason:
            `la línea ${l.itemId} está a ${l.quantity}×${l.unitPrice}, que no es ni la foto ` +
            `(${s.quantity}×${s.unitPrice}) ni el objetivo`,
        };
      }
      continue;
    }
    if (snapVariants.has(String(l.variantId)) || !matchesTarget(l)) {
      return {
        kind: "foreign",
        reason: `la línea ${l.itemId} (variante ${l.variantId}, ${l.quantity}×${l.unitPrice}) no la ha puesto esta intención`,
      };
    }
  }

  for (const s of snapshot) {
    const stillThere = live.some((l) => Number(l.itemId) === Number(s.itemId));
    if (!stillThere && targetsFor(s.variantId).length) {
      return { kind: "foreign", reason: `falta la línea ${s.itemId}, que el objetivo conservaba` };
    }
  }

  return { kind: "partial" };
}

/** La foto como objetivo, para poder volver a ella con el mismo `diffLines`. */
export function snapshotAsTargets(snapshot: SubscriptionLine[]): TargetLine[] {
  return snapshot.map((s) => ({
    productId: s.productId,
    variantId: s.variantId,
    flavor: s.flavor,
    quantity: Number(s.quantity),
    unitPriceCents: priceToCents(s.unitPrice),
    boxes: s.boxes,
    sku: "",
    ...(s.composition ? { composition: s.composition } : {}),
  }));
}

export type LineRepairPlan =
  | { kind: "nothing_to_do"; state: "at_target" | "at_snapshot" }
  | {
      kind: "converge";
      towards: "target" | "snapshot";
      edits: LineDiff["edits"];
      removes: number[];
      /** Líneas a añadir ANTES de quitar nada. Solo hacia el objetivo y con `allowAdds`. */
      adds?: TargetLine[];
    }
  | { kind: "needs_adds"; adds: TargetLine[]; removes: number[] }
  | { kind: "foreign"; reason: string };

export interface LineRepairOptions {
  /**
   * Se pueden AÑADIR líneas para llegar al objetivo (14-oct-2026), siempre que cada una
   * traiga `sealAdd`. Quien lo pide tiene que haber comprobado antes que Seal está en
   * reposo (`sealBusyReason`): un add que todavía no se ve no es un add perdido, y volver
   * a añadirlo duplicaría la línea.
   */
  allowAdds?: boolean;
}

/**
 * Cómo dejar coherente una sub a medias usando SOLO `edit_items` y `remove_items`, que
 * es lo único que el cron sabe hacer (añadir pide datos de línea de Shopify).
 *
 * Prefiere el OBJETIVO, que es lo que pidió el cliente. Si llegar a él exige añadir
 * líneas, vuelve a la FOTO, que es lo que tenía. El orden de la ruta (edits, luego adds,
 * luego removes) garantiza que uno de los dos está siempre al alcance:
 *   - murió tras los edits y antes de los adds: la foto se recupera reeditando.
 *   - murió tras los adds y antes de los removes: el objetivo se alcanza quitando.
 * `needs_adds` solo puede salir de un estado que la ruta no produce (faltan adds Y
 * faltan líneas de la foto), así que es para una persona.
 */
export function planLineRepair(
  live: SubscriptionLine[],
  snapshot: SubscriptionLine[],
  target: TargetLine[],
  opts: LineRepairOptions = {},
): LineRepairPlan {
  const state = classifyLineState(live, snapshot, target);
  if (state.kind === "at_target") return { kind: "nothing_to_do", state: "at_target" };
  if (state.kind === "foreign") return state;

  const toTarget = diffLines(live, target);
  // TERMINAR EL CAMBIO, NO DESHACERLO (14-oct-2026). Seal puede perder un add en silencio
  // (lo acepta, lo apunta y no aparece), y entonces lo vivo es la foto o la foto a medias.
  // Antes eso se cerraba como "no entró nada" o se devolvía a la foto, y el cliente, al que
  // se le había dicho "tu plan nuevo se está terminando de aplicar", se quedaba con el plan
  // viejo. Con los datos de alta guardados y Seal en reposo, se completa hacia el objetivo:
  // primero se añade y, solo cuando Seal lo enseña, se quita lo viejo.
  //
  // Y no solo cuando faltan líneas: un cambio de solo ediciones (cantidades o precios) que
  // Seal perdió también deja la sub como la foto, y se completa igual, con `edit_items`.
  const reachable = toTarget.adds.every((a) => !!a.sealAdd?.title);
  if (opts.allowAdds === true && reachable) {
    return {
      kind: "converge",
      towards: "target",
      edits: toTarget.edits,
      removes: toTarget.removes,
      ...(toTarget.adds.length ? { adds: toTarget.adds } : {}),
    };
  }
  if (state.kind === "at_snapshot") return { kind: "nothing_to_do", state: "at_snapshot" };
  if (!toTarget.adds.length) {
    return { kind: "converge", towards: "target", edits: toTarget.edits, removes: toTarget.removes };
  }
  const toSnapshot = diffLines(live, snapshotAsTargets(snapshot));
  if (!toSnapshot.adds.length) {
    return { kind: "converge", towards: "snapshot", edits: toSnapshot.edits, removes: toSnapshot.removes };
  }
  return { kind: "needs_adds", adds: toTarget.adds, removes: toTarget.removes };
}

/**
 * Las líneas de `itemIds` que llevan un código de descuento puesto.
 *
 * Quitar una línea con descuento hace que Seal arrastre el código, INVISIBLE, a otra
 * línea (incidente 2026-06-02, ver `seal.addItems`), y ese 15% de "un solo cobro" se
 * repite para siempre. La ruta lo evita soltando el código antes del swap y volviéndolo
 * a poner después. El cron hace lo mismo SOLO con los códigos que seguimos: el 15% de
 * retención (`retention_discounts`) y el crédito Discovery (`discovery_set_coupons`),
 * ver `planDiscountForRemoval`; cualquier otro código lo deja para una persona.
 */
export function discountedItemIds(sub: SealSubscription, itemIds: number[]): number[] {
  const wanted = new Set(itemIds.map(Number));
  return (sub.items ?? [])
    .filter((it) => wanted.has(Number(it.id)) && (it.discount_codes ?? []).length > 0)
    .map((it) => Number(it.id));
}

/**
 * Qué hacer con los descuentos de las líneas que el cron tiene que quitar.
 *
 * POR QUÉ (8-oct-2026, sub 15950195). Un cambio de mezcla murió entre `add_items` y
 * `remove_items` y la sub se quedó con los dos packs de 4 cajas: 144,59 por ciclo en vez
 * de 72,29. La ruta, como hace en todo resultado desconocido, volvió a poner LITSTAY15
 * antes de dejarle el caso al cron, y Seal enseña ese código en TODAS las líneas. Con eso
 * la línea a quitar llevaba descuento y el cron se negó 72 veces hasta caducar. Es decir:
 * cualquier sub con el 15% de retención que se quedara a medias no tenía arreglo
 * automático, y la retención es justo la gente que más toca su plan.
 *
 *   - `clear`: ninguna línea a quitar lleva código. Se quita sin más.
 *   - `tracked`: todos los códigos de esas líneas son de los que seguimos (el 15% de
 *     `retention_discounts` y, desde el 9-oct-2026, el crédito Discovery de
 *     `discovery_set_coupons`). Se sueltan todos, se quitan las líneas y se reponen,
 *     igual que en la ruta.
 *   - `foreign`: hay algún otro código (o no sabemos cuál seguimos). No se toca: para
 *     una persona.
 */
export interface TrackedDiscount {
  kind: "retention" | "discovery";
  code: string;
}

export type RemovalDiscountPlan =
  | { kind: "clear" }
  | { kind: "tracked"; codes: Array<TrackedDiscount & { ids: string[] }> }
  | { kind: "foreign"; itemIds: number[] };

export function planDiscountForRemoval(
  sub: SealSubscription,
  removeIds: number[],
  tracked: TrackedDiscount[],
): RemovalDiscountPlan {
  const discounted = discountedItemIds(sub, removeIds);
  if (!discounted.length) return { kind: "clear" };
  const norm = (c: string | null | undefined) => (c ?? "").trim().toLowerCase();
  const byCode = new Map(tracked.filter((t) => norm(t.code)).map((t) => [norm(t.code), t]));
  const onRemoved = new Set<string>();
  for (const it of sub.items ?? []) {
    if (!discounted.includes(Number(it.id))) continue;
    for (const dc of it.discount_codes ?? []) onRemoved.add(norm(dc.code));
  }
  const codes: Array<TrackedDiscount & { ids: string[] }> = [];
  for (const c of onRemoved) {
    const t = byCode.get(c);
    if (!t) return { kind: "foreign", itemIds: discounted };
    const ids = findAllAppliedDiscountCodeIds(sub, t.code);
    // Sin UUID no se puede soltar, y quitar la línea con el código puesto es el arrastre.
    if (!ids.length) return { kind: "foreign", itemIds: discounted };
    codes.push({ ...t, ids });
  }
  return { kind: "tracked", codes };
}

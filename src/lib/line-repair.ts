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
  return e.status >= 400 && e.status < 500 && e.status !== 408;
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
    }
  | { kind: "needs_adds"; adds: TargetLine[]; removes: number[] }
  | { kind: "foreign"; reason: string };

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
): LineRepairPlan {
  const state = classifyLineState(live, snapshot, target);
  if (state.kind === "at_target" || state.kind === "at_snapshot") {
    return { kind: "nothing_to_do", state: state.kind };
  }
  if (state.kind === "foreign") return state;

  const toTarget = diffLines(live, target);
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
 * a poner después. El cron hace lo mismo SOLO con el 15% de retención que seguimos en
 * `retention_discounts` (ver `planDiscountForRemoval`); cualquier otro código lo deja
 * para una persona.
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
 *   - `retention`: el único código es el 15% que seguimos. Se suelta, se quitan las
 *     líneas y se vuelve a poner, igual que en la ruta.
 *   - `foreign`: hay otro código (o no sabemos cuál seguimos). No se toca: para una persona.
 */
export type RemovalDiscountPlan =
  | { kind: "clear" }
  | { kind: "retention"; code: string; ids: string[] }
  | { kind: "foreign"; itemIds: number[] };

export function planDiscountForRemoval(
  sub: SealSubscription,
  removeIds: number[],
  trackedRetentionCode: string | null,
): RemovalDiscountPlan {
  const discounted = discountedItemIds(sub, removeIds);
  if (!discounted.length) return { kind: "clear" };
  const norm = (c: string | null | undefined) => (c ?? "").trim().toLowerCase();
  const tracked = norm(trackedRetentionCode);
  const onRemoved = new Set<string>();
  for (const it of sub.items ?? []) {
    if (!discounted.includes(Number(it.id))) continue;
    for (const dc of it.discount_codes ?? []) onRemoved.add(norm(dc.code));
  }
  if (!tracked || onRemoved.size !== 1 || !onRemoved.has(tracked)) {
    return { kind: "foreign", itemIds: discounted };
  }
  const ids = findAllAppliedDiscountCodeIds(sub, trackedRetentionCode as string);
  // Sin UUID no se puede soltar, y quitar la línea con el código puesto es el arrastre.
  if (!ids.length) return { kind: "foreign", itemIds: discounted };
  return { kind: "retention", code: trackedRetentionCode as string, ids };
}

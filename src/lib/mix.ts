/**
 * Flavor MIX — pure model for splitting a subscription's boxes across flavors.
 *
 * ESCALERA WEB (2026-08-22, decisión de Juan: "los precios de la web mandan"):
 * todo a PRECIO DE CATÁLOGO, nunca precios custom por línea.
 *
 *   1-3 cajas → una línea de la variante de 1 CAJA por sabor, quantity = cajas
 *               de ese sabor, a 28,35 catálogo (n × 28,35: 28,35 / 56,70 / 85,05).
 *   4 cajas   → UNA línea del producto PACK4 (pagas 3, la 4ª gratis) con la
 *               variante de la mezcla (PACK4-4L … PACK4-4W) a 85,05 catálogo.
 *   5-6 cajas → la línea del pack + líneas de 1 caja para el resto. Reparto
 *               canónico: las sueltas salen del sabor con MÁS cajas (empate →
 *               orden del registro, Lemon primero). 5 = 113,40 · 6 = 141,75.
 *
 * Los modelos VIEJOS siguen siendo legibles y diff-noop mientras el cliente no
 * edite: la variante-por-tramo (SL90 ×1 @67.93) y el split con precio custom
 * (SL30 ×2 @22.64 + W30 ×1 @22.65) existen en contratos vivos y solo se
 * reescriben al nuevo modelo cuando el cliente cambia cajas, sabor o mezcla.
 * Un cambio de SOLO frecuencia usa planFromCurrentLines (espejo de las líneas
 * vivas) y no toca nada.
 *
 * Verified E2E against Seal 2026-07-27 (scripts/probe-mix.mjs on sub 14692586):
 * add_items creates N lines in one call, honours a custom per-unit `price`, and
 * `edit_items` changes quantity+price in place WITHOUT changing item ids — which is
 * why `diffLines` prefers edits and only falls back to add/remove when the set of
 * variants actually changes. edit_items NO puede cambiar la variante: un cambio
 * de mezcla dentro del pack es siempre add+remove (el route añade ANTES de quitar).
 *
 * NO I/O in this file: it is imported by client components so the mix preview the
 * customer sees and the mix the server applies come from the SAME function.
 */

import {
  BOX_COUNT_BY_VARIANT,
  FLAVOR_KEYS,
  FLAVORS,
  PACK4_BOXES,
  PACK4_PRODUCT_ID,
  pack4VariantForComposition,
  type BoxCount,
  type FlavorKey,
  isFlavorKey,
  variantForFlavorBox,
} from "./seal-plans";

/** Max boxes per shipment. Matches the registry, the 1..6 route validation and the
 *  `subscriptions.box_count` CHECK. */
export const MAX_BOXES = 6;

/** One flavor's share of the shipment. `boxes` is always >= 1 after normalizeMix. */
export interface FlavorComposition {
  flavor: FlavorKey;
  boxes: number;
}

/** A recurring Seal line as it exists right now. */
export interface SubscriptionLine {
  /** Seal item id — what remove_items and edit_items key on. */
  itemId: number;
  productId: string;
  variantId: string;
  /** Dominant flavor (back-compat display). A PACK4 line's truth is `composition`. */
  flavor: FlavorKey;
  /** Boxes this line contributes = variant's box count × quantity. */
  boxes: number;
  quantity: number;
  /** Per-unit price exactly as Seal has it, for drift detection. */
  unitPrice: string;
  sellingPlanId: string;
  /** Multi-flavor contribution of a PACK4 line (boxes per flavor, quantity
   *  included). Absent on single-flavor lines — `flavor`+`boxes` suffice. */
  composition?: FlavorComposition[];
}

/** A line we intend to create or edit. */
export interface TargetLine {
  productId: string;
  variantId: string;
  flavor: FlavorKey;
  quantity: number;
  unitPriceCents: number;
  /** Boxes this line contributes. */
  boxes: number;
  sku: string;
  /** Multi-flavor contribution of a PACK4 line. Absent on single-flavor lines. */
  composition?: FlavorComposition[];
}

export type SubscriptionShape = "packed" | "split";

export interface MixPlan {
  shape: SubscriptionShape;
  lines: TargetLine[];
  /** Σ quantity × unitPriceCents — what Seal will actually charge. */
  totalCents: number;
  /** The canonical tier price for this box count. */
  tierTotalCents: number;
  /** tierTotal − total. ALWAYS >= 0: we never charge above the tier. */
  residualCents: number;
  boxCount: number;
}

export type MixErrorCode =
  | "mix_invalid_shape"
  | "mix_invalid_flavor"
  | "mix_not_integer"
  | "mix_duplicate_flavor"
  | "mix_empty"
  | "mix_box_count_out_of_range";

// ─── composición ──────────────────────────────────────────────────────────────

/** Total boxes in a composition. */
export function mixBoxCount(mix: FlavorComposition[]): number {
  return mix.reduce((s, c) => s + c.boxes, 0);
}

/** 2+ flavors → the subscription needs one line per flavor. */
export function isMixed(mix: FlavorComposition[]): boolean {
  return mix.length >= 2;
}

export function shapeFor(mix: FlavorComposition[]): SubscriptionShape {
  return isMixed(mix) ? "split" : "packed";
}

/**
 * Canonical ordering: most boxes first, then registry order. Deterministic so the
 * serialized composition (and therefore the Supabase row and every label) is stable
 * when only counts change.
 */
function sortMix(mix: FlavorComposition[]): FlavorComposition[] {
  return [...mix].sort(
    (a, b) => b.boxes - a.boxes || FLAVOR_KEYS.indexOf(a.flavor) - FLAVOR_KEYS.indexOf(b.flavor),
  );
}

/**
 * Validate + normalize an UNTRUSTED composition (HTTP body, localStorage).
 *
 * Unknown flavor keys are REJECTED, never dropped: silently ignoring
 * `[{peach,2},{salty-lemon,1}]` would ship 1 box to someone who asked for 3.
 * Zero counts are dropped (a stepper at 0 means "not in the mix").
 */
export function validateMix(
  raw: unknown,
): { ok: true; mix: FlavorComposition[] } | { ok: false; code: MixErrorCode } {
  if (!Array.isArray(raw)) return { ok: false, code: "mix_invalid_shape" };

  const seen = new Set<FlavorKey>();
  const out: FlavorComposition[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false, code: "mix_invalid_shape" };
    const { flavor, boxes } = entry as { flavor?: unknown; boxes?: unknown };
    if (!isFlavorKey(flavor)) return { ok: false, code: "mix_invalid_flavor" };
    if (typeof boxes !== "number" || !Number.isInteger(boxes) || boxes < 0) {
      return { ok: false, code: "mix_not_integer" };
    }
    if (seen.has(flavor)) return { ok: false, code: "mix_duplicate_flavor" };
    seen.add(flavor);
    if (boxes > 0) out.push({ flavor, boxes });
  }

  if (!out.length) return { ok: false, code: "mix_empty" };
  const total = mixBoxCount(out);
  if (total < 1 || total > MAX_BOXES) return { ok: false, code: "mix_box_count_out_of_range" };
  return { ok: true, mix: sortMix(out) };
}

/** Boxes a Seal line contributes: the variant's box count × quantity.
 *
 *  Handles all four shapes that exist in production: pack + qty 1 (every pure sub),
 *  1-box + qty N (the mixes Shopify checkout creates), pack + qty N (`SL90 ×2` = 6
 *  boxes, 90 active subs) and ours. Unmapped/legacy variants fall back to quantity,
 *  same as getBoxCount always did. */
export function boxesForVariantQuantity(variantId: string, quantity: number): number {
  const perUnit = BOX_COUNT_BY_VARIANT[String(variantId)] ?? 1;
  return perUnit * Math.max(1, quantity || 1);
}

/** Aggregate recurring lines into a composition, summing MANY lines of the same
 *  flavor. Duplicate-flavor lines are legitimate output of a partial failure or a
 *  repair, and are exactly how the corrupted subs look, so this must never assume
 *  one line per flavor. A PACK4 line contributes its multi-flavor `composition`
 *  (a 3L+1W pack adds 3 lemon + 1 watermelon, not "4 of the dominant"). */
export function compositionFromLines(lines: SubscriptionLine[]): FlavorComposition[] {
  const byFlavor = new Map<FlavorKey, number>();
  for (const l of lines) {
    const parts = l.composition ?? [{ flavor: l.flavor, boxes: l.boxes }];
    for (const p of parts) byFlavor.set(p.flavor, (byFlavor.get(p.flavor) ?? 0) + p.boxes);
  }
  return sortMix([...byFlavor].map(([flavor, boxes]) => ({ flavor, boxes })));
}

/** True when two compositions are the same multiset of (flavor, boxes). The plan
 *  route uses this to detect a frequency-only change: PlanOverlay always sends
 *  `boxCount`, so "did the items change" must be answered semantically, never by
 *  which body fields are present. */
export function sameComposition(a: FlavorComposition[], b: FlavorComposition[]): boolean {
  const sa = sortMix(a);
  const sb = sortMix(b);
  return sa.length === sb.length && sa.every((c, i) => c.flavor === sb[i].flavor && c.boxes === sb[i].boxes);
}

/**
 * Customer-facing label.
 *
 * A single flavor MUST return the flavor's plain label byte-for-byte ("Salty Lemon"):
 * `subscriptions.flavor` is written from this and Klaviyo segments + the confirmation
 * email read it, so a "1× " prefix would churn every cached row.
 */
export function compositionLabel(mix: FlavorComposition[], sep = " · "): string {
  if (!mix.length) return FLAVORS[FLAVOR_KEYS[0]].label;
  if (mix.length === 1) return FLAVORS[mix[0].flavor].label;
  return sortMix(mix)
    .map((c) => `${c.boxes}× ${shortLabel(c.flavor)}`)
    .join(sep);
}

/** "Lemon" / "Watermelon" — the range prefix "Salty " lives only in `label`.
 *  Explicit rather than `label.split(" ").slice(1)`, which is what account/page.tsx
 *  does today and which turns a mix label into garbage. */
export function shortLabel(flavor: FlavorKey): string {
  return FLAVORS[flavor].label.replace(/^Salty\s+/i, "");
}

// ─── precio ───────────────────────────────────────────────────────────────────

/**
 * LEGACY — reparto de precios custom del modelo viejo (splits 2026). Ya no lo usa
 * ninguna escritura nueva (la escalera web es todo catálogo, residual 0), pero se
 * conserva: los tests documentan el comportamiento y las líneas con precio custom
 * siguen vivas en contratos que solo se reescriben cuando su dueño edita.
 *
 * Split `tierTotalCents` across lines so the customer pays exactly the pure-plan
 * price. Largest-remainder: floor the per-box unit, then hand the leftover cents to
 * the SMALLEST lines (cheapest way to place them without exceeding the tier).
 *
 * Guarantee asserted here, not just tested: Σ quantity × unit <= tierTotal. Rounding
 * can only ever favour the customer.
 */
export function distributeUnitPrices(
  tierTotalCents: number,
  boxesPerLine: number[],
): { units: number[]; chargedCents: number; residualCents: number } {
  const total = boxesPerLine.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("distributeUnitPrices: sin cajas");

  const unit = Math.floor(tierTotalCents / total);
  let residual = tierTotalCents - unit * total;

  const units = boxesPerLine.map(() => unit);
  const bySmallest = boxesPerLine
    .map((boxes, i) => ({ i, boxes }))
    .sort((a, b) => a.boxes - b.boxes);
  for (const { i, boxes } of bySmallest) {
    if (residual >= boxes) {
      units[i] = unit + 1;
      residual -= boxes;
    }
  }

  const chargedCents = units.reduce((s, u, i) => s + u * boxesPerLine[i], 0);
  if (chargedCents > tierTotalCents) {
    throw new Error(`distributeUnitPrices cobraría de más: ${chargedCents} > ${tierTotalCents}`);
  }
  return { units, chargedCents, residualCents: tierTotalCents - chargedCents };
}

/**
 * Los dos precios de catálogo de los que se deriva TODA la escalera web. Siempre
 * en céntimos ENTEROS: 3 × 28.35 en float es 85.05000000000001 y un céntimo de
 * divergencia entre el tier y las líneas dispara mix_price_mismatch en cada edición.
 */
export interface LadderPrices {
  /** Variante de 1 caja, catálogo (2835 = 28,35 €). */
  oneBoxCents: number;
  /** Variante del PACK4, catálogo (8505 = 85,05 €). */
  pack4Cents: number;
}

/**
 * LA escalera web, en un único sitio (pricing.ts y planTargetLines la comparten):
 *   1-3 cajas → n × 1 caja        (28,35 / 56,70 / 85,05)
 *   4 cajas   → el pack           (85,05 — mismo total que 3: la 4ª es gratis)
 *   5-6 cajas → pack + (n−4) × 1  (113,40 / 141,75)
 */
export function ladderTotalCents(boxCount: number, prices: LadderPrices): number {
  assertLadderPrices(prices);
  if (!Number.isInteger(boxCount) || boxCount < 1 || boxCount > MAX_BOXES) {
    throw new Error(`ladderTotalCents: boxCount inválido (${boxCount})`);
  }
  if (boxCount < PACK4_BOXES) return boxCount * prices.oneBoxCents;
  return prices.pack4Cents + (boxCount - PACK4_BOXES) * prices.oneBoxCents;
}

function assertLadderPrices(prices: LadderPrices): void {
  if (
    !Number.isInteger(prices.oneBoxCents) || prices.oneBoxCents <= 0 ||
    !Number.isInteger(prices.pack4Cents) || prices.pack4Cents <= 0
  ) {
    throw new Error(
      `LadderPrices inválido (oneBox ${prices.oneBoxCents}, pack4 ${prices.pack4Cents})`,
    );
  }
}

/**
 * Reparto canónico pack ↔ sueltas para 4-6 cajas. Las sueltas (n − 4) salen del
 * sabor con MÁS cajas mientras pueda cederlas (con ≤ 2 sabores siempre puede);
 * empate → orden del registro (Lemon primero). Determinista, y diseñado para la
 * estabilidad de líneas: 3L+2W → pack 2L+2W + 1×SL30 y 4L+2W → pack 2L+2W +
 * 2×SL30, así que pasar de 5 a 6 cajas es un edit de cantidad, no un swap.
 */
export function packSplit(
  mix: FlavorComposition[],
): { pack: FlavorComposition[]; singles: FlavorComposition[] } {
  const normalized = sortMix(mix);
  const total = mixBoxCount(normalized);
  if (total < PACK4_BOXES) return { pack: [], singles: normalized };

  let singlesLeft = total - PACK4_BOXES;
  const remaining = normalized.map((c) => ({ ...c }));
  const singles = new Map<FlavorKey, number>();
  while (singlesLeft > 0) {
    remaining.sort(
      (a, b) => b.boxes - a.boxes || FLAVOR_KEYS.indexOf(a.flavor) - FLAVOR_KEYS.indexOf(b.flavor),
    );
    const donor = remaining[0];
    const take = Math.min(singlesLeft, donor.boxes);
    donor.boxes -= take;
    singles.set(donor.flavor, (singles.get(donor.flavor) ?? 0) + take);
    singlesLeft -= take;
  }
  return {
    pack: sortMix(remaining.filter((c) => c.boxes > 0)),
    singles: sortMix([...singles].map(([flavor, boxes]) => ({ flavor, boxes }))),
  };
}

/**
 * Turn a composition into the exact lines Seal should hold — escalera web, todo
 * a precio de catálogo (residual 0 estructural). Los precios llegan como
 * LadderPrices desde pricing.ts (precios vivos de Shopify), así que un cambio de
 * precio de marketing se propaga sin tocar código.
 */
export function planTargetLines(
  mix: FlavorComposition[],
  prices: LadderPrices,
): MixPlan {
  assertLadderPrices(prices);
  const normalized = sortMix(mix);
  const boxCount = mixBoxCount(normalized);
  const tierTotalCents = ladderTotalCents(boxCount, prices);

  const lines: TargetLine[] = [];
  if (boxCount >= PACK4_BOXES) {
    const { pack, singles } = packSplit(normalized);
    const packVariant = pack4VariantForComposition(pack);
    if (!packVariant) {
      throw new Error(
        `sin variante de pack para ${pack.map((c) => `${c.boxes}×${c.flavor}`).join(" + ")}`,
      );
    }
    lines.push({
      productId: PACK4_PRODUCT_ID,
      variantId: packVariant.variantId,
      flavor: pack[0].flavor, // dominante, solo display back-compat
      quantity: 1,
      unitPriceCents: prices.pack4Cents,
      boxes: PACK4_BOXES,
      sku: packVariant.sku,
      composition: pack.map((c) => ({ ...c })),
    });
    for (const c of singles) lines.push(oneBoxLine(c, prices.oneBoxCents));
  } else {
    for (const c of normalized) lines.push(oneBoxLine(c, prices.oneBoxCents));
  }

  const totalCents = lines.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
  // Por construcción total == tier; si divergen es un bug de esta función y vale
  // más reventar aquí que dejar que la verificación del route lo convierta en 502.
  if (totalCents !== tierTotalCents) {
    throw new Error(`planTargetLines: total ${totalCents} != tier ${tierTotalCents}`);
  }
  return { shape: shapeFor(normalized), lines, totalCents, tierTotalCents, residualCents: 0, boxCount };
}

function oneBoxLine(c: FlavorComposition, oneBoxCents: number): TargetLine {
  const variantId = variantForFlavorBox(c.flavor, 1);
  if (!variantId) throw new Error(`sin variante de 1 caja para ${c.flavor}`);
  return {
    productId: FLAVORS[c.flavor].productId,
    variantId,
    flavor: c.flavor,
    quantity: c.boxes,
    unitPriceCents: oneBoxCents,
    boxes: c.boxes,
    sku: skuFor(c.flavor, 1),
  };
}

/**
 * Target plan that MIRRORS the live lines byte for byte. El camino de
 * solo-frecuencia usa esto: diffLines contra él es noop ESTRUCTURAL para
 * cualquier sub — escalera vieja (SL90 @67,93), split con precio custom
 * (22,64/22,65) o PACK4 — así que tocar la cadencia no puede repreciar ni
 * reescribir líneas jamás. tierTotalCents = el total vivo, para que la money
 * assertion del route cuadre contra lo que el contrato ya cobra.
 */
export function planFromCurrentLines(lines: SubscriptionLine[]): MixPlan {
  const targets: TargetLine[] = lines.map((l) => ({
    productId: l.productId,
    variantId: l.variantId,
    flavor: l.flavor,
    quantity: l.quantity,
    unitPriceCents: priceToCents(l.unitPrice),
    boxes: l.boxes,
    sku: "", // solo los adds necesitan SKU y este plan no genera adds
    composition: l.composition?.map((c) => ({ ...c })),
  }));
  const totalCents = targets.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
  const composition = compositionFromLines(lines);
  return {
    shape: shapeFor(composition),
    lines: targets,
    totalCents,
    tierTotalCents: totalCents,
    residualCents: 0,
    boxCount: mixBoxCount(composition),
  };
}

/** SKU we send to Seal. Seal stores it verbatim on the line and it reaches the
 *  Shopify order, which is what Hive reads, so it must match the real variant SKU. */
function skuFor(flavor: FlavorKey, boxCount: number): string {
  // El prefijo sale del REGISTRO, no de un ternario. Con dos sabores el ternario
  // `flavor === "salty-lemon" ? "SL" : "W"` era correcto por accidente; al entrar
  // melocotón mandaba las cajas sueltas de peach con SKU W30 y Hive habría pickeado
  // sandía. Ver FlavorDef.skuPrefix en seal-plans.ts.
  return `${FLAVORS[flavor].skuPrefix}${boxCount * 30}`;
}

// ─── recomposición al cambiar el número de cajas ───────────────────────────────

/**
 * Proposal for "the customer changed their box count and had a mix".
 *
 * Proportional with largest remainder, deterministic. Every flavor keeps >= 1 box
 * while `target >= mix.length`; below that the SMALLEST shares are dropped (ties
 * broken by registry order), so target 1 always yields a pure composition.
 *
 * The FE pre-seeds the editable mix with this and sends the result explicitly, and
 * the server uses it only to PRESERVE a mix for legacy clients that send a bare
 * `{ boxCount }`. It is never used to silently rebalance what the customer chose.
 */
export function resplitOnBoxChange(
  mix: FlavorComposition[],
  targetBoxCount: number,
): FlavorComposition[] {
  const normalized = sortMix(mix);
  const current = mixBoxCount(normalized);
  if (targetBoxCount === current) return normalized;
  if (targetBoxCount < 1) throw new Error(`targetBoxCount inválido (${targetBoxCount})`);

  // Fewer boxes than flavors: keep the biggest shares, drop the rest.
  const kept = targetBoxCount < normalized.length
    ? normalized.slice(0, targetBoxCount)
    : normalized;
  if (kept.length === 1) return [{ flavor: kept[0].flavor, boxes: targetBoxCount }];

  const keptTotal = mixBoxCount(kept);
  const exact = kept.map((c) => (c.boxes * targetBoxCount) / keptTotal);
  const floors = exact.map((v) => Math.max(1, Math.floor(v)));

  let left = targetBoxCount - floors.reduce((a, b) => a + b, 0);
  const out = kept.map((c, i) => ({ flavor: c.flavor, boxes: floors[i] }));

  // Hand out leftovers by largest fractional part; take back from the largest share
  // if the >= 1 flooring overshot.
  const byFraction = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let pass = 0; left > 0; pass++) {
    const { i } = byFraction[pass % byFraction.length];
    out[i].boxes += 1;
    left -= 1;
  }
  while (left < 0) {
    const biggest = out.reduce((m, c, i) => (c.boxes > out[m].boxes ? i : m), 0);
    if (out[biggest].boxes <= 1) break;
    out[biggest].boxes -= 1;
    left += 1;
  }

  return sortMix(out.filter((c) => c.boxes > 0));
}

// ─── diff contra el estado vivo ───────────────────────────────────────────────

export interface LineDiff {
  /** In-place `edit_items`: same item id, new quantity and/or price. */
  edits: Array<{ itemId: number; quantity: number; unitPrice: string; variantId: string }>;
  adds: TargetLine[];
  /** Seal item ids to remove. Includes duplicate lines the sub should not have. */
  removes: number[];
  noop: boolean;
}

const centsToPrice = (c: number): string => (c / 100).toFixed(2);
const priceToCents = (p: string): number => Math.round(parseFloat(p) * 100);

/**
 * What to change to get from `current` to `target`, preferring in-place edits.
 *
 * Matching is by variant id. Because `edit_items` preserves item ids (verified
 * 2026-07-27), a change that keeps the same set of variants — a different split of
 * the same total, or a box-count change — becomes edits only: no add/remove, so no
 * invisible discount carry-over, no stale `mainItemId`, and no window where a failed
 * remove leaves the customer paying for both the old and the new lines.
 *
 * Duplicate `current` lines on the same variant are matched once and the extras land
 * in `removes`, which is how the corrupted double-charging subs get healed the first
 * time their owner touches their plan.
 */
export function diffLines(current: SubscriptionLine[], target: TargetLine[]): LineDiff {
  const unused = [...current];
  const edits: LineDiff["edits"] = [];
  const adds: TargetLine[] = [];

  for (const t of target) {
    const idx = unused.findIndex((l) => String(l.variantId) === String(t.variantId));
    if (idx === -1) {
      adds.push(t);
      continue;
    }
    const [match] = unused.splice(idx, 1);
    const sameQty = Number(match.quantity) === t.quantity;
    const samePrice = priceToCents(match.unitPrice) === t.unitPriceCents;
    if (!sameQty || !samePrice) {
      edits.push({
        itemId: match.itemId,
        quantity: t.quantity,
        unitPrice: centsToPrice(t.unitPriceCents),
        variantId: String(t.variantId),
      });
    }
  }

  const removes = unused.map((l) => l.itemId);
  return { edits, adds, removes, noop: !edits.length && !adds.length && !removes.length };
}

/**
 * PRESERVAR EL PRECIO DEL CONTRATO al cambiar de composición (3-sep-2026).
 *
 * `planTargetLines` construye el line-set al precio del CATÁLOGO. Para los 533
 * contratos activos que siguen por debajo de la escalera web (522 de ellos a 3
 * cajas por 67,93 cuando el catálogo pide 85,05) eso convertía un cambio de sabor
 * en una subida de 17,12 € por entrega que el cliente no pidió, y que la pantalla
 * de sabores le promete por escrito que no va a pasar. La contención del 24-ago lo
 * rechazaba con un 409 y una llamada pendiente por cada caso; a 522 clientes eso no
 * es una cola de migración, es un muro. Decisión de Juan (3-sep-2026): mantener el
 * precio.
 *
 * Esto reprecia las líneas OBJETIVO (las del sabor nuevo) para que Σ precio ×
 * quantity sea lo que el cliente paga HOY, en vez del catálogo. La composición, las
 * cajas y las variantes son las que toque; lo único que se conserva es el importe.
 *
 * EL REPARTO ES PROPORCIONAL AL CATÁLOGO: cada línea se escala por
 * `liveCharge / tier`. Así se conserva la FORMA del descuento (el pack 3+1 sigue
 * costando lo que cuesta un pack y las sueltas lo que cuesta una suelta) y ninguna
 * línea queda por encima de su precio de catálogo. Un reparto plano por caja también
 * daba el total correcto, pero escribía el PACK4 por ENCIMA de su propio precio de
 * venta en las subs de 5-6 cajas.
 *
 * OJO: el precio se escribe SIEMPRE por UNIDAD, porque Seal cobra
 * `unitPrice × quantity` y una línea PACK4 es quantity 1 con 4 cajas dentro. Repartir
 * pensando en cajas y escribir esa cifra tal cual cobraría 21,26 en vez de 85,05, y
 * las guardas del route lo darían por bueno porque el line-set coincide.
 *
 * Devuelve null (y el llamador se queda con el catálogo) si el reparto no es
 * aplicable: sin líneas, importe no positivo, o una línea cuyas cajas no son
 * múltiplo de su quantity — ahí no sabríamos cuántas cajas lleva cada unidad y
 * preferimos no escribir un precio inventado.
 *
 * INVARIANTE: el total escrito nunca supera `liveChargeCents`. El floor solo puede
 * dejarlo por debajo (hasta `nº de líneas` céntimos, a favor del cliente), y se
 * comprueba antes de devolver. Verificado sobre las 83 composiciones posibles de 1 a
 * 6 cajas con 3 sabores: cero subidas, peor desvío 1 céntimo.
 */
export function planPreservingCharge(
  mix: FlavorComposition[],
  prices: LadderPrices,
  liveChargeCents: number,
): MixPlan | null {
  if (!Number.isInteger(liveChargeCents) || liveChargeCents <= 0) return null;

  const catalogue = planTargetLines(mix, prices);
  if (!catalogue.lines.length) return null;

  // Cajas por línea: la base del reparto. Una línea sin cajas rompería el prorrateo.
  const boxesPerLine = catalogue.lines.map((l) => l.boxes);
  if (boxesPerLine.some((b) => !Number.isInteger(b) || b <= 0)) return null;

  // Una línea cuyas cajas no son múltiplo de su quantity no se sabe prorratear sin
  // inventarse cuántas cajas lleva cada unidad. Misma guarda que repriceInPlace.
  for (const l of catalogue.lines) {
    const quantity = Math.max(1, Number(l.quantity) || 1);
    if (l.boxes % quantity !== 0) return null;
  }

  // EL REPARTO ES PROPORCIONAL AL CATÁLOGO, NO PLANO POR CAJA.
  //
  // Un reparto plano (mismo precio a todas las cajas) descuadra la FORMA del
  // descuento: aplasta el 3+1 y reparte su regalo entre las cajas sueltas. Con las 90
  // subs de SL90×2 (6 cajas a 135,86) eso escribía el PACK4 a 90,56, o sea 5,51 por
  // encima de lo que ese mismo pack vale en catálogo (85,05), y las sueltas a 22,65,
  // por debajo de sus 28,35. El total era correcto y nunca subía, pero el contrato de
  // Seal, las líneas del pedido y el email de confirmación enseñaban un "PACK 3+1"
  // más caro que su propio precio de venta, en una pantalla que le está prometiendo al
  // cliente justo lo contrario ("incluye el pack 3+1, 1 caja gratis").
  //
  // Escalando cada línea por `liveCharge / tier` se conserva el peso relativo de cada
  // una, así que el 3+1 sigue pareciendo un 3+1 y NINGUNA línea queda por encima de su
  // precio de catálogo (el factor es < 1 por construcción: solo llegamos aquí cuando
  // el catálogo es más caro que lo que paga el cliente).
  const totalBoxes = boxesPerLine.reduce((a, b) => a + b, 0);
  if (totalBoxes <= 0) return null;

  const scaled = catalogue.lines.map((l) => {
    const quantity = Math.max(1, Number(l.quantity) || 1);
    // Precio por unidad, redondeado hacia abajo: el sobrante se reparte después, así
    // el prorrateo nunca puede pasarse del importe del contrato.
    const catalogueLineCents = l.unitPriceCents * quantity;
    const unitPriceCents = Math.floor(
      (catalogueLineCents * liveChargeCents) / (catalogue.tierTotalCents * quantity),
    );
    return { line: l, quantity, unitPriceCents };
  });
  if (scaled.some((s) => s.unitPriceCents <= 0)) return null;

  // Los céntimos que deja el floor van a las líneas con MENOS cajas primero: es la
  // forma más barata de colocarlos sin pasarse (mismo criterio que
  // distributeUnitPrices), y sube el precio por unidad lo mínimo posible.
  let residual = liveChargeCents - scaled.reduce((s, x) => s + x.unitPriceCents * x.quantity, 0);
  if (residual < 0) return null;
  const bySmallest = scaled
    .map((s, i) => ({ i, boxes: s.line.boxes }))
    .sort((a, b) => a.boxes - b.boxes);
  for (const { i } of bySmallest) {
    const s = scaled[i];
    // Nunca por encima del catálogo: es el invariante que hace que el 3+1 siga
    // leyéndose como un 3+1.
    while (
      residual >= s.quantity &&
      s.unitPriceCents + 1 <= s.line.unitPriceCents
    ) {
      s.unitPriceCents += 1;
      residual -= s.quantity;
    }
  }

  const lines: TargetLine[] = scaled.map((s) => ({ ...s.line, unitPriceCents: s.unitPriceCents }));
  if (lines.some((l) => l.unitPriceCents <= 0)) return null;
  // Ninguna línea por encima de su precio de catálogo.
  if (lines.some((l, i) => l.unitPriceCents > catalogue.lines[i].unitPriceCents)) return null;

  const totalCents = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  // `distributeUnitPrices` ya asegura Σ unidad × cajas <= objetivo, y multiplicar por
  // cajas/quantity es la misma suma reagrupada. Si aun así saliera por encima es un
  // bug de esta función y vale más no proponer nada que cobrar de más.
  if (totalCents > liveChargeCents) return null;

  return {
    shape: catalogue.shape,
    lines,
    totalCents,
    // El tramo de referencia sigue siendo el del catálogo: es lo que vale hoy esa
    // composición, y lo que la auditoría necesita para saber cuánto se preservó.
    tierTotalCents: catalogue.tierTotalCents,
    residualCents: catalogue.tierTotalCents - totalCents,
    boxCount: catalogue.boxCount,
  };
}

/**
 * Bajar el cobro de un contrato SIN reestructurar sus líneas (31-ago-2026).
 *
 * `planTargetLines` construye el line-set del CATÁLOGO, así que curar con él una sub
 * del modelo viejo significa add + remove: exactamente la ventana que cobró doble a 7
 * subs en junio-julio. Esto hace lo contrario: mantiene las líneas y las cantidades
 * que hay, y solo BAJA los precios por unidad hasta que Σ precio × quantity cuadra
 * con el objetivo. Todo edit_items, cero adds, cero removes, mismos item ids.
 *
 * El precio se reparte por CAJA y se convierte a precio por UNIDAD multiplicando por
 * las cajas que lleva cada unidad de esa línea (SL30 = 1, SL60 = 2, SL90 = 3,
 * PACK4 = 4). Repartir por caja y escribirlo como precio por unidad es el error que
 * cobraría 21,26 en vez de 85,05 en una línea de pack.
 *
 * EL INVARIANTE DE DINERO, que es el que pidió Kiko: esto solo puede BAJAR hacia el
 * contrato. Se comprueba sobre el TOTAL, no línea a línea: el total propuesto tiene
 * que quedar en o por debajo del objetivo Y estrictamente por debajo de lo que se
 * cobra hoy. Una línea suelta SÍ puede subir de precio unitario dentro de eso (una
 * SL90 a 22,64 por caja junto a sueltas a 28,35 se promedia a 23,62 y esa línea sube
 * mientras el total baja de 152,98 a 141,72), y eso es correcto: lo que el cliente
 * paga es el total. Bloquearlo línea a línea dejaba sin curar a 1 de las 5.
 *
 * Devuelve null si algo no cuadra: sin líneas, objetivo no positivo, una línea cuyas
 * cajas no son múltiplo de su quantity (no sabríamos cuántas cajas lleva cada unidad),
 * o si el total no bajaría.
 */
export interface InPlaceEdit {
  itemId: number;
  quantity: number;
  unitPriceCents: number;
}

export function repriceInPlace(
  lines: SubscriptionLine[],
  targetTotalCents: number,
): { edits: InPlaceEdit[]; totalCents: number; raisesAnyLine: boolean } | null {
  if (!lines.length) return null;
  if (!Number.isInteger(targetTotalCents) || targetTotalCents <= 0) return null;

  const totalBoxes = lines.reduce((sum, l) => sum + l.boxes, 0);
  if (totalBoxes <= 0) return null;

  const perBoxCents = Math.floor(targetTotalCents / totalBoxes);
  if (perBoxCents <= 0) return null;

  const proposed: Array<{ line: SubscriptionLine; quantity: number; unitPriceCents: number }> = [];
  for (const l of lines) {
    const quantity = Math.max(1, Number(l.quantity) || 1);
    if (l.boxes <= 0 || l.boxes % quantity !== 0) return null;
    const boxesPerUnit = l.boxes / quantity;
    const unitPriceCents = perBoxCents * boxesPerUnit;
    if (unitPriceCents <= 0) return null;
    proposed.push({ line: l, quantity, unitPriceCents });
  }

  const totalCents = proposed.reduce((sum, p) => sum + p.unitPriceCents * p.quantity, 0);
  // El floor solo puede dejarlo por debajo del objetivo, nunca por encima; si sale
  // por encima es un bug de esta función y vale más no proponer nada.
  if (totalCents > targetTotalCents) return null;
  // Y tiene que bajar de verdad: si no baja, esta función no es la herramienta.
  const liveTotalCents = chargeTotalCents(lines);
  if (totalCents >= liveTotalCents) return null;

  const raisesAnyLine = proposed.some((p) => p.unitPriceCents > priceToCents(p.line.unitPrice));

  const edits = proposed
    .filter((p) => p.unitPriceCents !== priceToCents(p.line.unitPrice))
    .map((p) => ({ itemId: p.line.itemId, quantity: p.quantity, unitPriceCents: p.unitPriceCents }));

  return { edits, totalCents, raisesAnyLine };
}

/** Σ quantity × unit price over lines, in cents. The money assertion compares this
 *  against the tier total. Deliberately NOT Seal's `total_value`, which nets out
 *  discount codes and would false-positive for anyone on the retention 15%. */
export function chargeTotalCents(lines: Array<{ quantity: number; unitPrice: string }>): number {
  return lines.reduce((s, l) => s + priceToCents(l.unitPrice) * Math.max(1, l.quantity || 1), 0);
}

export { centsToPrice, priceToCents };

/** Box counts are typed 1..6 in the registry; narrow once, here. */
export function asBoxCount(n: number): BoxCount | null {
  return Number.isInteger(n) && n >= 1 && n <= MAX_BOXES ? (n as BoxCount) : null;
}

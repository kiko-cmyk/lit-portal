/**
 * Flavor MIX — pure model for splitting a subscription's boxes across flavors.
 *
 * A LIT subscription used to be ONE recurring Seal line with `quantity: 1`, the
 * variant encoding both box count and flavor (SL90 = 3 boxes of lemon). A mix needs
 * one recurring line PER FLAVOR, so this module owns two shapes:
 *
 *   packed  1 flavor  → the pack variant, quantity 1, catalogue price
 *                       (SL90 ×1 @67.93). What every single-flavor sub uses, so
 *                       1560 of 1571 active subs need no migration and carry NO
 *                       custom price.
 *   split   2+ flavors → the 1-BOX variant per flavor, quantity = that flavor's
 *                       boxes, with a per-unit `price` that distributes the tier
 *                       total (SL30 ×2 @22.64 + W30 ×1 @22.65 = 67.93 = SL90).
 *
 * Verified E2E against Seal 2026-07-27 (scripts/probe-mix.mjs on sub 14692586):
 * add_items creates N lines in one call, honours a custom per-unit `price`, and
 * `edit_items` changes quantity+price in place WITHOUT changing item ids — which is
 * why `diffLines` prefers edits and only falls back to add/remove when the set of
 * variants actually changes.
 *
 * NO I/O in this file: it is imported by client components so the mix preview the
 * customer sees and the mix the server applies come from the SAME function.
 */

import {
  BOX_COUNT_BY_VARIANT,
  FLAVOR_KEYS,
  FLAVORS,
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
  flavor: FlavorKey;
  /** Boxes this line contributes = variant's box count × quantity. */
  boxes: number;
  quantity: number;
  /** Per-unit price exactly as Seal has it, for drift detection. */
  unitPrice: string;
  sellingPlanId: string;
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
 *  one line per flavor. */
export function compositionFromLines(lines: SubscriptionLine[]): FlavorComposition[] {
  const byFlavor = new Map<FlavorKey, number>();
  for (const l of lines) byFlavor.set(l.flavor, (byFlavor.get(l.flavor) ?? 0) + l.boxes);
  return sortMix([...byFlavor].map(([flavor, boxes]) => ({ flavor, boxes })));
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
 * Split `tierTotalCents` across lines so the customer pays exactly the pure-plan
 * price. Largest-remainder: floor the per-box unit, then hand the leftover cents to
 * the SMALLEST lines (cheapest way to place them without exceeding the tier).
 *
 * Guarantee asserted here, not just tested: Σ quantity × unit <= tierTotal. Rounding
 * can only ever favour the customer. Over the live catalogue the only inexact case is
 * 4 boxes split 2+2 → €90.56 vs €90.57 (one cent down).
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
 * Turn a composition + the tier price into the exact lines Seal should hold.
 *
 * `tierTotalCents` must be the price of the PURE pack variant for this box count
 * (from pricing.ts, i.e. live Shopify prices), so a marketing price change
 * propagates to mixes with no code change.
 */
export function planTargetLines(
  mix: FlavorComposition[],
  tierTotalCents: number,
): MixPlan {
  const normalized = sortMix(mix);
  const boxCount = mixBoxCount(normalized);
  if (!Number.isFinite(tierTotalCents) || tierTotalCents <= 0) {
    throw new Error(`planTargetLines: tierTotalCents inválido (${tierTotalCents})`);
  }

  // ── packed: one flavor keeps today's pack variant at the catalogue price, so no
  // custom price and nothing to migrate for the 1560 single-flavor subs.
  if (!isMixed(normalized)) {
    const { flavor } = normalized[0];
    const variantId = variantForFlavorBox(flavor, boxCount);
    if (!variantId) throw new Error(`sin variante para ${flavor} × ${boxCount} cajas`);
    return {
      shape: "packed",
      lines: [{
        productId: FLAVORS[flavor].productId,
        variantId,
        flavor,
        quantity: 1,
        unitPriceCents: tierTotalCents,
        boxes: boxCount,
        sku: skuFor(flavor, boxCount),
      }],
      totalCents: tierTotalCents,
      tierTotalCents,
      residualCents: 0,
      boxCount,
    };
  }

  // ── split: the 1-box variant per flavor, quantity = that flavor's boxes.
  const boxesPerLine = normalized.map((c) => c.boxes);
  const { units, chargedCents, residualCents } = distributeUnitPrices(tierTotalCents, boxesPerLine);

  const lines: TargetLine[] = normalized.map((c, i) => {
    const variantId = variantForFlavorBox(c.flavor, 1);
    if (!variantId) throw new Error(`sin variante de 1 caja para ${c.flavor}`);
    return {
      productId: FLAVORS[c.flavor].productId,
      variantId,
      flavor: c.flavor,
      quantity: c.boxes,
      unitPriceCents: units[i],
      boxes: c.boxes,
      sku: skuFor(c.flavor, 1),
    };
  });

  return { shape: "split", lines, totalCents: chargedCents, tierTotalCents, residualCents, boxCount };
}

/** SKU we send to Seal. Seal stores it verbatim on the line and it reaches the
 *  Shopify order, which is what Hive reads, so it must match the real variant SKU. */
function skuFor(flavor: FlavorKey, boxCount: number): string {
  const prefix = flavor === "salty-lemon" ? "SL" : "W";
  return `${prefix}${boxCount * 30}`;
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

/**
 * Tests de src/lib/mix.ts. Sin framework (el repo no tiene ninguno): aserciones a mano.
 *
 *   npx tsx scripts/test-mix.ts
 *
 * ESCALERA WEB (2026-08-22): 1-3 cajas = n × 28,35 · 4 = pack 3+1 a 85,05 ·
 * 5-6 = pack + sueltas (113,40 / 141,75). Todo a precio de catálogo. El bloque
 * importante es el exhaustivo de planTargetLines: para CADA composición alcanzable
 * de 1-2 sabores y 1-6 cajas comprueba que las líneas cuadran el tramo exacto, que
 * el pack lleva la variante de mezcla correcta y que las sueltas salen del sabor
 * con más cajas (empate → Lemon). Los modelos VIEJOS (variante por tramo, split
 * con precio custom) se siguen probando como LECTURA: contratos vivos los llevan
 * y solo se reprecian cuando su dueño edita.
 */

import {
  boxesForVariantQuantity,
  chargeTotalCents,
  compositionFromLines,
  compositionLabel,
  diffLines,
  distributeUnitPrices,
  isMixed,
  ladderTotalCents,
  type LadderPrices,
  mixBoxCount,
  packSplit,
  planFromCurrentLines,
  planTargetLines,
  resplitOnBoxChange,
  sameComposition,
  shapeFor,
  shortLabel,
  validateMix,
  type FlavorComposition,
  type SubscriptionLine,
  type TargetLine,
  repriceInPlace,
  planPreservingCharge,
} from "../src/lib/mix";
import {
  FLAVORS,
  PACK4_BY_VARIANT,
  PACK4_PRODUCT_ID,
  PACK4_VARIANTS,
  pack4VariantForComposition,
  type FlavorKey,
} from "../src/lib/seal-plans";
import { boxCountFromOrderLines, compositionFromOrderLines } from "../src/lib/order-lines";

/** La escalera web, en céntimos. 4 cajas cuestan lo mismo que 3: la 4ª es gratis. */
const LADDER: LadderPrices = { oneBoxCents: 2835, pack4Cents: 8505 };
const TIER_NEW: Record<number, number> = { 1: 2835, 2: 5670, 3: 8505, 4: 8505, 5: 11340, 6: 14175 };

/** La escalera VIEJA (variantes por tramo), solo para fixtures de lectura legacy. */
const TIER_OLD: Record<number, number> = { 1: 2835, 2: 5670, 3: 6793, 4: 9057, 5: 10395, 6: 12474 };

const L: FlavorKey = "salty-lemon";
const W: FlavorKey = "salty-watermelon";
const P: FlavorKey = "salty-peach";

let passed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(msg);
}
function eq<T>(actual: T, expected: T, msg: string) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg}\n      esperado: ${JSON.stringify(expected)}\n      obtenido: ${JSON.stringify(actual)}`,
  );
}
function throws(fn: () => unknown, msg: string) {
  try { fn(); failures.push(`${msg} (no lanzó)`); } catch { passed++; }
}

/** Todas las particiones de n en exactamente k partes >= 1, en orden descendente. */
function partitions(n: number, k: number): number[][] {
  if (k === 1) return n >= 1 ? [[n]] : [];
  const out: number[][] = [];
  for (let first = n - (k - 1); first >= 1; first--) {
    for (const rest of partitions(n - first, k - 1)) out.push([first, ...rest]);
  }
  return out;
}

/** Composición agregada de un array de TargetLine (el pack aporta su composition). */
function targetComposition(lines: TargetLine[]): FlavorComposition[] {
  const byFlavor = new Map<FlavorKey, number>();
  for (const l of lines) {
    const parts = l.composition ?? [{ flavor: l.flavor, boxes: l.boxes }];
    for (const p of parts) byFlavor.set(p.flavor, (byFlavor.get(p.flavor) ?? 0) + p.boxes);
  }
  return [...byFlavor].map(([flavor, boxes]) => ({ flavor, boxes }));
}

/** Simula el estado vivo tras aplicar un target (para probar idempotencia). */
function appliedLines(lines: TargetLine[], firstItemId = 900): SubscriptionLine[] {
  return lines.map((l, i) => ({
    itemId: firstItemId + i,
    productId: l.productId,
    variantId: l.variantId,
    flavor: l.flavor,
    boxes: l.boxes,
    quantity: l.quantity,
    unitPrice: (l.unitPriceCents / 100).toFixed(2),
    sellingPlanId: "691259900253",
    ...(l.composition ? { composition: l.composition.map((c) => ({ ...c })) } : {}),
  }));
}

// ── 0. ladderTotalCents: LA escalera, en un solo sitio ───────────────────────
console.log("\n=== ladderTotalCents (escalera web) ===");
for (let n = 1; n <= 6; n++) {
  eq(ladderTotalCents(n, LADDER), TIER_NEW[n], `escalera ${n} cajas = ${TIER_NEW[n]}c`);
}
eq(ladderTotalCents(3, LADDER), ladderTotalCents(4, LADDER), "3 y 4 cajas cuestan lo mismo: la 4ª es gratis");
throws(() => ladderTotalCents(0, LADDER), "0 cajas lanza");
throws(() => ladderTotalCents(7, LADDER), "7 cajas lanza");
throws(() => ladderTotalCents(3, { oneBoxCents: 28.35, pack4Cents: 8505 }), "céntimos no enteros lanzan");
throws(() => ladderTotalCents(3, { oneBoxCents: 0, pack4Cents: 8505 }), "precio 0 lanza");

// ── 1. packSplit: reparto canónico pack ↔ sueltas ────────────────────────────
console.log("\n=== packSplit (reparto canónico) ===");
eq(packSplit([{ flavor: L, boxes: 3 }, { flavor: W, boxes: 2 }]),
   { pack: [{ flavor: L, boxes: 2 }, { flavor: W, boxes: 2 }], singles: [{ flavor: L, boxes: 1 }] },
   "3L+2W → pack 2L+2W + 1 suelta de Lemon (el sabor con más cajas)");
eq(packSplit([{ flavor: L, boxes: 3 }, { flavor: W, boxes: 3 }]),
   { pack: [{ flavor: W, boxes: 3 }, { flavor: L, boxes: 1 }], singles: [{ flavor: L, boxes: 2 }] },
   "3L+3W → empate: las sueltas salen de Lemon → pack 1L+3W + SL30×2");
eq(packSplit([{ flavor: L, boxes: 6 }]),
   { pack: [{ flavor: L, boxes: 4 }], singles: [{ flavor: L, boxes: 2 }] },
   "6L → pack 4L + SL30×2");
eq(packSplit([{ flavor: L, boxes: 1 }, { flavor: W, boxes: 4 }]),
   { pack: [{ flavor: W, boxes: 3 }, { flavor: L, boxes: 1 }], singles: [{ flavor: W, boxes: 1 }] },
   "1L+4W → pack 1L+3W + W30×1");
eq(packSplit([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 2 }]),
   { pack: [{ flavor: L, boxes: 2 }, { flavor: W, boxes: 2 }], singles: [] },
   "4 cajas exactas → todo al pack, sin sueltas");
eq(packSplit([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }]),
   { pack: [], singles: [{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }] },
   "menos de 4 cajas → sin pack");
// Propiedad de estabilidad: pasar de 5 a 6 manteniendo el dominante conserva la
// variante del pack (el cambio será un edit de cantidad, no un swap).
eq(packSplit([{ flavor: L, boxes: 3 }, { flavor: W, boxes: 2 }]).pack,
   packSplit([{ flavor: L, boxes: 4 }, { flavor: W, boxes: 2 }]).pack,
   "5→6 con el mismo dominante: misma variante de pack");

// ── 2. planTargetLines: exhaustivo sobre la escalera web ─────────────────────
console.log("\n=== planTargetLines (exhaustivo, escalera web) ===");
const allCompositions: FlavorComposition[][] = [];
for (let n = 1; n <= 6; n++) {
  allCompositions.push([{ flavor: L, boxes: n }], [{ flavor: W, boxes: n }]);
  for (const [a, b] of partitions(n, 2)) {
    allCompositions.push([{ flavor: L, boxes: a }, { flavor: W, boxes: b }]);
  }
}
for (const mix of allCompositions) {
  const n = mixBoxCount(mix);
  const label = mix.map((c) => `${c.boxes}${c.flavor === L ? "L" : "W"}`).join("+");
  const plan = planTargetLines(mix, LADDER);
  eq(plan.totalCents, TIER_NEW[n], `${label}: cobra el tramo exacto ${TIER_NEW[n]}c`);
  eq(plan.residualCents, 0, `${label}: residual 0 (todo catálogo)`);
  ok(plan.lines.every((l) => Number.isInteger(l.unitPriceCents) && l.unitPriceCents > 0),
     `${label}: precios enteros positivos`);
  ok(sameComposition(targetComposition(plan.lines), mix),
     `${label}: las líneas reconstruyen la composición pedida`);
  const packLines = plan.lines.filter((l) => l.productId === PACK4_PRODUCT_ID);
  if (n < 4) {
    eq(packLines.length, 0, `${label}: sin pack por debajo de 4 cajas`);
    ok(plan.lines.every((l) => l.variantId === FLAVORS[l.flavor].variantByBoxCount[1]),
       `${label}: solo variantes de 1 caja`);
    ok(plan.lines.every((l) => l.unitPriceCents === LADDER.oneBoxCents),
       `${label}: 1 caja a 28,35 de catálogo`);
  } else {
    eq(packLines.length, 1, `${label}: exactamente UNA línea de pack`);
    const pk = packLines[0];
    eq(pk.quantity, 1, `${label}: pack qty 1`);
    eq(pk.unitPriceCents, LADDER.pack4Cents, `${label}: pack a 85,05`);
    eq(mixBoxCount(pk.composition ?? []), 4, `${label}: la composición del pack suma 4`);
    const def = pack4VariantForComposition(pk.composition ?? []);
    eq(def?.variantId, pk.variantId, `${label}: variante de mezcla correcta`);
    eq(def?.sku, pk.sku, `${label}: SKU PACK4-* real (Hive lo descompone)`);
    const singles = plan.lines.filter((l) => l.productId !== PACK4_PRODUCT_ID);
    eq(singles.reduce((s, l) => s + l.boxes, 0), n - 4, `${label}: sueltas = n − 4`);
    ok(singles.every((l) => l.variantId === FLAVORS[l.flavor].variantByBoxCount[1]),
       `${label}: sueltas en variante de 1 caja`);
  }
  // Idempotencia del retry: aplicar el target y volver a diffear es noop.
  ok(diffLines(appliedLines(plan.lines), plan.lines).noop, `${label}: retry = noop`);
}
console.log(`  ${allCompositions.length} composiciones, todas cuadran el tramo con residual 0`);

// Casos con nombre (los del reparto canónico).
const p32 = planTargetLines([{ flavor: L, boxes: 3 }, { flavor: W, boxes: 2 }], LADDER);
eq(p32.lines.map((l) => `${l.sku}x${l.quantity}@${(l.unitPriceCents / 100).toFixed(2)}`),
   ["PACK4-2L2W" + "x1@85.05", "SL30x1@28.35"], "3L+2W → pack 2L+2W + SL30×1 = 113,40");
const p22 = planTargetLines([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 2 }], LADDER);
eq(p22.lines[0].variantId, "65636234690909", "2L+2W → variante 65636234690909 a 85,05");
const p4L = planTargetLines([{ flavor: L, boxes: 4 }], LADDER);
eq(p4L.lines.map((l) => `${l.sku}x${l.quantity}`), ["PACK4-4Lx1"], "4L → una línea PACK4-4L");
eq(p4L.shape, "packed", "4 cajas de un sabor: shape packed (sin migración de BD)");
eq(p22.shape, "split", "4 cajas mezcladas: shape split (una línea, dos sabores)");
const p3L = planTargetLines([{ flavor: L, boxes: 3 }], LADDER);
eq(p3L.lines.map((l) => `${l.sku}x${l.quantity}@${(l.unitPriceCents / 100).toFixed(2)}`),
   ["SL30x3@28.35"], "3 limón ya NO es SL90: es SL30×3 a 28,35 = 85,05");
const p21 = planTargetLines([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }], LADDER);
eq(p21.lines.map((l) => `${l.sku}x${l.quantity}@${(l.unitPriceCents / 100).toFixed(2)}`),
   ["SL30x2@28.35", "W30x1@28.35"], "2L+1W → catálogo puro (desaparecen 22,64/22,65)");

throws(() => planTargetLines([{ flavor: L, boxes: 9 }], LADDER), "9 cajas lanza");
throws(() => planTargetLines([{ flavor: L, boxes: 3 }], { oneBoxCents: 0, pack4Cents: 8505 }),
       "precios inválidos lanzan");

// ── 3. distributeUnitPrices (LEGACY, solo lectura de splits viejos) ──────────
console.log("\n=== distributeUnitPrices (legacy, propiedad del dinero) ===");
let splitCases = 0;
for (let boxes = 1; boxes <= 6; boxes++) {
  for (let k = 1; k <= 4; k++) {
    for (const part of partitions(boxes, k)) {
      const { units, chargedCents, residualCents } = distributeUnitPrices(TIER_OLD[boxes], part);
      const label = `${boxes} cajas ${part.join("+")}`;
      ok(chargedCents <= TIER_OLD[boxes], `${label}: cobra ${chargedCents} > tramo ${TIER_OLD[boxes]}`);
      ok(residualCents >= 0, `${label}: residuo negativo ${residualCents}`);
      ok(units.every((u) => u > 0), `${label}: unidad no positiva`);
      if (k >= 2) splitCases++;
    }
  }
}
console.log(`  ${splitCases} particiones legacy, todas con Σ qty×unit <= tramo`);

// ── 4. Etiquetas ──────────────────────────────────────────────────────────────
console.log("\n=== etiquetas ===");
eq(compositionLabel([{ flavor: L, boxes: 3 }]), "Salty Lemon",
   "un solo sabor devuelve la etiqueta EXACTA de hoy (sin prefijo 3×)");
eq(compositionLabel([{ flavor: L, boxes: 1 }]), "Salty Lemon", "1 caja de un sabor: igual");
eq(compositionLabel([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }]),
   "2× Lemon · 1× Watermelon", "mezcla: etiqueta compuesta");
eq(compositionLabel([{ flavor: W, boxes: 1 }, { flavor: L, boxes: 2 }]),
   "2× Lemon · 1× Watermelon", "mezcla: el orden de entrada no cambia la etiqueta");
eq(compositionLabel([{ flavor: L, boxes: 3 }, { flavor: W, boxes: 1 }]),
   "3× Lemon · 1× Watermelon", "mezcla del pack 3L+1W: etiqueta compuesta");
eq(shortLabel(L), "Lemon", "shortLabel quita el prefijo Salty");
eq(shortLabel(W), "Watermelon", "shortLabel sandía");

// ── 5. validateMix ────────────────────────────────────────────────────────────
console.log("\n=== validateMix ===");
const okMix = validateMix([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }]);
ok(okMix.ok && mixBoxCount(okMix.mix) === 3, "mezcla válida");
ok(!validateMix("nope").ok, "no-array rechazado");
ok(!validateMix([]).ok, "vacío rechazado");
ok(!validateMix([{ flavor: L, boxes: 0 }]).ok, "todo a cero rechazado");
eq((validateMix([{ flavor: "peach", boxes: 2 }, { flavor: L, boxes: 1 }]) as { code: string }).code,
   "mix_invalid_flavor", "sabor desconocido se RECHAZA (no se ignora)");
eq((validateMix([{ flavor: L, boxes: 1.5 }]) as { code: string }).code,
   "mix_not_integer", "cajas no entero rechazado");
eq((validateMix([{ flavor: L, boxes: -1 }]) as { code: string }).code,
   "mix_not_integer", "cajas negativas rechazado");
eq((validateMix([{ flavor: L, boxes: 1 }, { flavor: L, boxes: 2 }]) as { code: string }).code,
   "mix_duplicate_flavor", "sabor duplicado rechazado");
eq((validateMix([{ flavor: L, boxes: 4 }, { flavor: W, boxes: 3 }]) as { code: string }).code,
   "mix_box_count_out_of_range", "suma 7 rechazada");
const dropped = validateMix([{ flavor: L, boxes: 3 }, { flavor: W, boxes: 0 }]);
ok(dropped.ok && dropped.mix.length === 1 && !isMixed(dropped.mix),
   "un cero se descarta y queda composición pura");
const hostile = JSON.parse('[{"flavor":"__proto__","boxes":2}]');
ok(!validateMix(hostile).ok, "__proto__ como sabor rechazado");

// ── 6. resplitOnBoxChange ─────────────────────────────────────────────────────
console.log("\n=== resplitOnBoxChange ===");
const base: FlavorComposition[] = [{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }];
for (let target = 1; target <= 6; target++) {
  const r = resplitOnBoxChange(base, target);
  eq(mixBoxCount(r), target, `resplit 2L+1W → ${target}: suma ${target}`);
  ok(r.every((c) => c.boxes >= 1), `resplit → ${target}: ninguna línea a 0`);
  ok(target === 1 ? r.length === 1 : r.length === 2, `resplit → ${target}: nº de sabores correcto`);
  eq(r, resplitOnBoxChange(base, target), `resplit → ${target}: determinista`);
}
eq(resplitOnBoxChange(base, 1), [{ flavor: L, boxes: 1 }], "resplit → 1 caja queda puro (limón, el mayoritario)");
eq(resplitOnBoxChange(base, 6), [{ flavor: L, boxes: 4 }, { flavor: W, boxes: 2 }], "resplit 2L+1W → 6 = 4L+2W");
eq(resplitOnBoxChange(base, 3), base, "resplit al mismo total es identidad");
const three: FlavorComposition[] = [{ flavor: L, boxes: 3 }, { flavor: W, boxes: 2 }];
eq(mixBoxCount(resplitOnBoxChange(three, 2)), 2, "resplit 3L+2W → 2 suma 2");

// ── 7. diffLines: transiciones de la escalera web ─────────────────────────────
console.log("\n=== diffLines (transiciones con pack) ===");
const line = (itemId: number, flavor: FlavorKey, boxCountOfVariant: number, qty: number, price: string): SubscriptionLine => ({
  itemId,
  productId: FLAVORS[flavor].productId,
  variantId: FLAVORS[flavor].variantByBoxCount[boxCountOfVariant as 1 | 2 | 3 | 4 | 5 | 6],
  flavor,
  boxes: boxCountOfVariant * qty,
  quantity: qty,
  unitPrice: price,
  sellingPlanId: "691259900253",
});
const packLine = (itemId: number, variantId: string, qty: number, price: string): SubscriptionLine => {
  const def = PACK4_BY_VARIANT[variantId];
  return {
    itemId,
    productId: PACK4_PRODUCT_ID,
    variantId,
    flavor: def.composition[0].flavor,
    boxes: 4 * qty,
    quantity: qty,
    unitPrice: price,
    sellingPlanId: "691259900253",
    composition: def.composition.map((c) => ({ flavor: c.flavor, boxes: c.boxes * qty })),
  };
};

// (a) 3 cajas modelo nuevo → 4: un add (pack) + remove de las 1-caja.
const cur3new = appliedLines(planTargetLines([{ flavor: L, boxes: 3 }], LADDER).lines, 100);
const to4 = planTargetLines([{ flavor: L, boxes: 4 }], LADDER);
const dA = diffLines(cur3new, to4.lines);
eq(dA.adds.map((a) => a.sku), ["PACK4-4L"], "3→4: un add del pack");
eq(dA.removes, [100], "3→4: remove de la línea de 1 caja");
eq(dA.edits.length, 0, "3→4: sin edits (cambia el producto)");

// (b) cambio de mezcla DENTRO del pack: variante distinta → add + remove, nunca edit.
const cur3L1W = [packLine(200, "65636234658141", 1, "85.05")];
const to2L2W = planTargetLines([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 2 }], LADDER);
const dB = diffLines(cur3L1W, to2L2W.lines);
eq(dB.adds.map((a) => a.sku), ["PACK4-2L2W"], "mezcla del pack: un add");
eq(dB.removes, [200], "mezcla del pack: un remove");
eq(dB.edits.length, 0, "mezcla del pack: sin edits (edit_items no cambia variante)");

// (c) 5 → 6 manteniendo el dominante: SOLO edits (estabilidad del reparto canónico).
const cur5 = appliedLines(planTargetLines([{ flavor: L, boxes: 3 }, { flavor: W, boxes: 2 }], LADDER).lines, 300);
const to6 = planTargetLines([{ flavor: L, boxes: 4 }, { flavor: W, boxes: 2 }], LADDER);
const dC = diffLines(cur5, to6.lines);
eq(dC.adds.length + dC.removes.length, 0, "5→6 mismo dominante: sin add/remove");
eq(dC.edits.map((e) => `${e.itemId}:${e.quantity}`), ["301:2"], "5→6: solo sube la cantidad de la suelta");

// (d) split viejo con precio custom + el cliente EDITA (mismas variantes) → reprecia a catálogo.
const curOldSplit = [line(1, L, 1, 2, "22.64"), line(2, W, 1, 1, "22.65")];
const dD = diffLines(curOldSplit, p21.lines);
eq(dD.adds.length + dD.removes.length, 0, "split viejo editado: mismas variantes, sin add/remove");
eq(dD.edits.map((e) => `${e.itemId}@${e.unitPrice}`).sort(), ["1@28.35", "2@28.35"],
   "split viejo editado: reprecia a catálogo 28,35 (solo con intención del cliente)");

// (e) variante por tramo vieja → pack (el cliente pasa de SL120 a editar): add + remove.
const curSL120 = [line(9, L, 4, 1, "90.57")];
const dE = diffLines(curSL120, to4.lines);
eq(dE.adds.map((a) => a.sku), ["PACK4-4L"], "SL120 → pack: un add");
eq(dE.removes, [9], "SL120 → pack: remove de la variante vieja");

// (f) líneas DUPLICADAS se curan: la extra va a removes.
const dupes = [packLine(11, "65636234625373", 1, "85.05"), packLine(12, "65636234625373", 1, "85.05")];
const dF = diffLines(dupes, to4.lines);
eq(dF.removes, [12], "pack duplicado: la línea extra se elimina");
eq(dF.adds.length, 0, "pack duplicado: la primera se reutiliza");

// ── 8. planFromCurrentLines: el contrato del camino solo-frecuencia ──────────
console.log("\n=== planFromCurrentLines (solo-frecuencia = espejo, diff noop) ===");
const freqOnlyFixtures: Array<[string, SubscriptionLine[]]> = [
  ["legacy packed SL90 @67.93", [line(21, L, 3, 1, "67.93")]],
  ["legacy split custom 22.64/22.65", [line(22, L, 1, 2, "22.64"), line(23, W, 1, 1, "22.65")]],
  ["legacy SL120 @90.57", [line(24, L, 4, 1, "90.57")]],
  ["PACK4 migrado 3L+1W @85.05", [packLine(25, "65636234658141", 1, "85.05")]],
  ["modelo nuevo 5 cajas (pack+suelta)", cur5],
];
for (const [label, lines] of freqOnlyFixtures) {
  const mirror = planFromCurrentLines(lines);
  ok(diffLines(lines, mirror.lines).noop, `${label}: diff contra el espejo es noop`);
  eq(mirror.totalCents, chargeTotalCents(lines), `${label}: tier del espejo = cobro vivo`);
}

// ── 9. sameComposition (la condición del cortocircuito) ───────────────────────
console.log("\n=== sameComposition ===");
ok(sameComposition([{ flavor: L, boxes: 3 }], [{ flavor: L, boxes: 3 }]), "idéntica → true");
ok(sameComposition(
  [{ flavor: W, boxes: 1 }, { flavor: L, boxes: 3 }],
  [{ flavor: L, boxes: 3 }, { flavor: W, boxes: 1 }],
), "el orden no importa");
ok(!sameComposition([{ flavor: L, boxes: 3 }], [{ flavor: L, boxes: 4 }]), "distinto nº de cajas → false");
ok(!sameComposition([{ flavor: L, boxes: 3 }], [{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }]),
   "distinta mezcla → false");

// ── 10. Lectura: las formas de producción, PACK4 incluido ─────────────────────
console.log("\n=== lectura: boxesForVariantQuantity y fixtures reales ===");
const V = FLAVORS;
eq(boxesForVariantQuantity(V[L].variantByBoxCount[3], 1), 3, "pack + qty 1 (sub pura SL90) = 3 cajas");
eq(boxesForVariantQuantity(V[L].variantByBoxCount[1], 2), 2, "1-caja + qty 2 (mezcla del checkout) = 2 cajas");
eq(boxesForVariantQuantity(V[L].variantByBoxCount[3], 2), 6, "pack + qty 2 (SL90 ×2, 90 subs activas) = 6 cajas");
eq(boxesForVariantQuantity("999999999", 3), 3, "variante legacy sin mapear cae a quantity");
eq(boxesForVariantQuantity("65636234658141", 1), 4, "variante PACK4 = 4 cajas");
eq(boxesForVariantQuantity("65636236853597", 2), 8, "PACK4 compra única × 2 = 8 cajas (lectura de pedidos)");

// Fixtures de subs reales del escaneo del libro de Seal (LECTURA legacy intacta).
// 14978152: SL30 x2 + W30 x1 = 3 cajas mezcladas (creada en el checkout)
const f14978152 = [line(30559851, L, 1, 2, "28.35"), line(30559852, W, 1, 1, "28.35")];
eq(compositionFromLines(f14978152), [{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }],
   "sub 14978152 (checkout): 2 limón + 1 sandía");
eq(chargeTotalCents(f14978152), 8505, "sub 14978152: cobra 85.05");
eq(shapeFor(compositionFromLines(f14978152)), "split", "sub 14978152: shape split");

// 14924018: W90 + SL90 = 6 cajas (escalera vieja, se sigue leyendo igual)
const f14924018 = [line(30473518, W, 3, 1, "67.93"), line(30473519, L, 3, 1, "67.93")];
eq(mixBoxCount(compositionFromLines(f14924018)), 6, "sub 14924018: 6 cajas");
eq(compositionLabel(compositionFromLines(f14924018)), "3× Lemon · 3× Watermelon",
   "sub 14924018: etiqueta 3+3");

// 12918887: SL120 duplicado = corrupta, 8 cajas > 6
const f12918887 = [line(30774797, L, 4, 1, "90.57"), line(30774811, L, 4, 1, "90.57")];
eq(mixBoxCount(compositionFromLines(f12918887)), 8, "sub 12918887 (corrupta): suma 8 cajas, fuera de rango");
eq(chargeTotalCents(f12918887), 18114, "sub 12918887: cobra 181.14 (el doble de 90.57)");

// PACK4 migrado (los 35 contratos): UNA línea de la variante de mezcla a 85,05.
const fPack = [packLine(31000001, "65636234658141", 1, "85.05")];
eq(compositionFromLines(fPack), [{ flavor: L, boxes: 3 }, { flavor: W, boxes: 1 }],
   "sub PACK4 migrada: composición 3 limón + 1 sandía (no '4 del dominante')");
eq(mixBoxCount(compositionFromLines(fPack)), 4, "sub PACK4: 4 cajas (el portal decía 1)");
eq(chargeTotalCents(fPack), 8505, "sub PACK4: cobra 85.05");
eq(compositionLabel(compositionFromLines(fPack)), "3× Lemon · 1× Watermelon",
   "sub PACK4: etiqueta de mezcla");
eq(shapeFor(compositionFromLines(fPack)), "split",
   "sub PACK4 mixta: shape split (una línea, dos sabores — el CHECK de BD no cambia)");
const fPack4W = [packLine(31000002, "65636234756445", 1, "85.05")];
eq(compositionLabel(compositionFromLines(fPack4W)), "Salty Watermelon",
   "sub PACK4 de un solo sabor: etiqueta plana byte-idéntica (Klaviyo intacto)");
eq(shapeFor(compositionFromLines(fPack4W)), "packed", "sub PACK4 4W: shape packed");

// ── 11. Deriva de precios (el cron 48h, semántica nueva) ─────────────────────
console.log("\n=== deriva de precios (cron 48h) ===");
// (a) Legacy split de 3 cajas a 67,93 vs escalera nueva 85,05: actual < expected →
// la rama below-tier NO toca ni alerta (estado permanente de la escalera vieja).
const legacySplit = [line(501, L, 1, 2, "22.64"), line(502, W, 1, 1, "22.65")];
ok(chargeTotalCents(legacySplit) < TIER_NEW[3], "legacy 3 cajas queda POR DEBAJO de la escalera web: no se toca");
// (b) Legacy SL120 a 90,57 > 85,05: por encima, pero el target nuevo (pack) exige
// add/remove → el heal se abstiene (line-set del modelo viejo).
const legacy120 = [line(511, L, 4, 1, "90.57")];
ok(chargeTotalCents(legacy120) > TIER_NEW[4], "legacy SL120 queda por encima de la escalera web");
const heal120 = diffLines(legacy120, planTargetLines(compositionFromLines(legacy120), LADDER).lines);
ok(heal120.adds.length > 0 || heal120.removes.length > 0,
   "…pero su reparación exigiría add/remove → el self-heal se abstiene");
// (c) Sub del modelo nuevo con el precio pisado por Seal: edits-only y cura a 85,05.
const stompedPack = [packLine(521, "65636234658141", 1, "90.57")];
const healPack = diffLines(stompedPack, planTargetLines(compositionFromLines(stompedPack), LADDER).lines);
eq(healPack.adds.length + healPack.removes.length, 0, "pack pisado: sin add/remove");
eq(healPack.edits.map((e) => `${e.itemId}@${e.unitPrice}`), ["521@85.05"],
   "pack pisado: un edit que restaura 85,05");

// ── 12. Downstream: pedidos web (email de confirmación y Drops) ───────────────
console.log("\n=== downstream: order-lines y Drops ===");
const PLAN = "691259900253";
const orderLine = (variantId: string, qty: number, plan: string | null) => ({
  title: "LIT",
  quantity: qty,
  variant_id: Number(variantId),
  ...(plan ? { selling_plan_allocation: { selling_plan: { id: plan } } } : {}),
});
// Pedido web del pack (suscripción): 4 cajas, composición poblada.
eq(boxCountFromOrderLines([orderLine("65636234658141", 1, PLAN)]), 4,
   "pedido pack sub ×1 → 4 cajas (el email decía 1)");
eq(compositionFromOrderLines([{ variant_id: 65636234658141, quantity: 1 }]),
   [{ flavor: L, boxes: 3 }, { flavor: W, boxes: 1 }],
   "pedido pack sub: composición 3L+1W (flavor_mix poblado)");
// Pedido del pack de COMPRA ÚNICA (producto OT, solo lectura).
eq(boxCountFromOrderLines([orderLine("65636236853597", 1, null)]), 4,
   "pedido pack compra única ×1 → 4 cajas");
eq(compositionFromOrderLines([{ variant_id: 65636236853597, quantity: 1 }]),
   [{ flavor: L, boxes: 2 }, { flavor: W, boxes: 2 }],
   "pedido pack OT: composición 2L+2W");
// Pack ×2 = 8 cajas.
eq(boxCountFromOrderLines([orderLine("65636234625373", 2, PLAN)]), 8,
   "pedido pack ×2 → 8 cajas");
// Pack + 2 sueltas (una sub de 6 cajas renovando).
eq(boxCountFromOrderLines([
     orderLine("65636234690909", 1, PLAN),
     orderLine(V[L].variantByBoxCount[1], 2, PLAN),
   ]), 6, "pedido pack + SL30×2 → 6 cajas");

/** Réplica de la cuenta de Drops del webhook fulfillments/create: una unidad por
 *  selling plan distinto entre las líneas del registro, más la cantidad para el
 *  resto. Los Drops son por ENVÍO, no por caja. */
const ALL_VARIANTS = new Set([
  ...[L, W].flatMap((f) => Object.values(V[f].variantByBoxCount)),
  ...PACK4_VARIANTS.map((v) => v.variantId),
]);
function dropsUnits(lines: Array<{ variantId?: string; qty: number; plan: string | null }>): number {
  const sub = lines.filter((l) => l.plan);
  const inReg = sub.filter((l) => l.variantId && ALL_VARIANTS.has(l.variantId));
  const other = sub.filter((l) => !(l.variantId && ALL_VARIANTS.has(l.variantId)));
  return new Set(inReg.map((l) => l.plan!)).size + other.reduce((s, l) => s + l.qty, 0);
}
eq(dropsUnits([{ variantId: V[L].variantByBoxCount[3], qty: 1, plan: PLAN }]), 1,
   "sub pura de 3 cajas -> 1 unidad (100 Drops), igual que hoy");
eq(dropsUnits([
     { variantId: "65636234690909", qty: 1, plan: PLAN },
     { variantId: V[L].variantByBoxCount[1], qty: 2, plan: PLAN },
   ]), 1,
   "pack + 2 sueltas en el mismo plan -> 1 unidad (100 Drops), SIN inflación");
eq(dropsUnits([{ variantId: "999", qty: 4, plan: null }]), 0, "B2B / una sola compra -> 0 Drops");
eq(dropsUnits([
     { variantId: V[L].variantByBoxCount[1], qty: 1, plan: PLAN },
     { variantId: V[L].variantByBoxCount[1], qty: 1, plan: "691259834717" },
   ]), 2,
   "dos subs con cadencias distintas en un pedido -> 2 unidades (como hoy)");

// ── repriceInPlace: bajar sin reestructurar (31-ago-2026) ────────────────────
console.log("\n=== repriceInPlace ===");

const rpSL30 = V[L].variantByBoxCount[1];
const rpSL60 = V[L].variantByBoxCount[2];
const rpSL90 = V[L].variantByBoxCount[3];
const rpPack2L2W = "65636234690909";

const rpLine = (
  itemId: number,
  variantId: string,
  quantity: number,
  unitPrice: string,
  boxes: number,
): SubscriptionLine => ({
  itemId,
  productId: "p",
  variantId,
  flavor: L,
  boxes,
  quantity,
  unitPrice,
  sellingPlanId: PLAN,
});

// La 13089232 real: 2 SL30 @28,35 + 1 SL60 @56,70 = 4 cajas, 113,40 -> tramo 85,05.
{
  const r = repriceInPlace([rpLine(1, rpSL30, 2, "28.35", 2), rpLine(2, rpSL60, 1, "56.70", 2)], 8505);
  eq(r !== null, true, "13089232: propone reparto");
  eq(r!.totalCents, 8504, "13089232: total 85,04 (un centimo a favor del cliente)");
  eq(r!.edits.length, 2, "13089232: 2 edits, cero adds y cero removes");
  eq(r!.raisesAnyLine, false, "13089232: ninguna linea sube");
  // per-UNIDAD, no per-caja: la SL60 lleva 2 cajas por unidad
  eq(r!.edits.find((e) => e.itemId === 1)!.unitPriceCents, 2126, "13089232: SL30 a 21,26 por unidad");
  eq(r!.edits.find((e) => e.itemId === 2)!.unitPriceCents, 4252, "13089232: SL60 a 42,52 por unidad (2 cajas)");
}

// LA TRAMPA DEL PACK: quantity 1 con 4 cajas. Repartir per-caja y escribirlo como
// precio de unidad cobraria 21,26 en vez de 85,05.
{
  const r = repriceInPlace([rpLine(1, rpPack2L2W, 1, "113.40", 4)], 8505);
  eq(r !== null, true, "PACK4: propone reparto");
  eq(r!.totalCents, 8504, "PACK4: el total sigue siendo el del tramo, no un cuarto");
  eq(r!.edits[0].unitPriceCents, 8504, "PACK4: precio de LINEA 85,04, no 21,26");
}

// El total tiene que bajar. Una sub ya en el tramo no se toca.
eq(repriceInPlace([rpLine(1, rpSL30, 3, "28.35", 3)], 8505), null,
   "ya al tramo: no propone nada (el total no bajaria)");
eq(repriceInPlace([rpLine(1, rpSL90, 1, "67.93", 3)], 8505), null,
   "escalera vieja por DEBAJO: no propone nada, nunca sube");

// Una linea puede subir de unitario si el TOTAL baja (la 14682293 real).
{
  const r = repriceInPlace([rpLine(1, rpSL30, 3, "28.35", 3), rpLine(2, rpSL90, 1, "67.93", 3)], 14175);
  eq(r !== null, true, "14682293: propone reparto");
  eq(r!.totalCents < 15298, true, "14682293: el total baja de 152,98");
  eq(r!.raisesAnyLine, true, "14682293: avisa de que una linea sube de unitario");
}

// Basura: nunca proponer nada.
eq(repriceInPlace([], 8505), null, "sin lineas: null");
eq(repriceInPlace([rpLine(1, rpSL30, 1, "28.35", 1)], 0), null, "objetivo 0: null");
eq(repriceInPlace([rpLine(1, rpSL30, 2, "28.35", 3)], 8505), null,
   "cajas no multiplo de quantity: null (no sabemos cajas por unidad)");


// ── planPreservingCharge: conservar el precio del contrato (3-sep-2026) ──────
console.log("\n=== planPreservingCharge ===");

// EL CASO DE LOS AVISOS: 522 subs a 3 cajas por 67,93 cuando el catalogo pide 85,05.
// Cambiar de sabor tiene que dejar el importe intacto.
{
  const r = planPreservingCharge([{ flavor: P, boxes: 3 }], LADDER, 6793);
  eq(r !== null, true, "3 cajas Lemon->Peach: propone plan");
  eq(r!.totalCents, 6792, "3 cajas: escribe 67,92 (un centimo abajo por el floor), no 85,05");
  eq(r!.totalCents <= 6793, true, "3 cajas: NUNCA por encima de lo que paga hoy");
  eq(r!.tierTotalCents, 8505, "3 cajas: el tramo de referencia sigue siendo el catalogo");
  eq(r!.lines.length, 1, "3 cajas: una sola linea de 1 caja x3");
  eq(r!.lines[0].quantity, 3, "3 cajas: quantity 3");
  eq(r!.lines[0].unitPriceCents, 2264, "3 cajas: 22,64 por unidad (= por caja aqui)");
}

// EL OTRO AVISO: mezcla 2 Watermelon + 1 Lemon, mismas 3 cajas.
{
  const r = planPreservingCharge([{ flavor: W, boxes: 2 }, { flavor: L, boxes: 1 }], LADDER, 6793);
  eq(r !== null, true, "mezcla 2W+1L: propone plan");
  eq(r!.totalCents, 6793, "mezcla 2W+1L: clava los 67,93");
  eq(r!.lines.length, 2, "mezcla 2W+1L: dos lineas");
}

// LA TRAMPA DEL PACK, otra vez: 6 cajas = PACK4 (quantity 1, 4 cajas) + 2 sueltas.
// Escribir el precio POR CAJA en la linea del pack cobraria 22,64 en vez de 90,56.
{
  const r = planPreservingCharge([{ flavor: W, boxes: 6 }], LADDER, 13586);
  eq(r !== null, true, "6 cajas: propone plan");
  eq(r!.totalCents, 13586, "6 cajas: clava los 135,86, no los 141,75 del catalogo");
  const pack = r!.lines.find((l) => l.boxes === 4)!;
  eq(pack.quantity, 1, "6 cajas: el pack es quantity 1");
  eq(pack.unitPriceCents, 9056, "6 cajas: el PACK4 va a 90,56 por unidad, NO a 22,64");
}

// Una sub ya a catalogo no se toca: el catalogo y lo que paga coinciden.
{
  const r = planPreservingCharge([{ flavor: P, boxes: 3 }], LADDER, 8505);
  eq(r !== null, true, "ya a catalogo: propone plan");
  eq(r!.totalCents, 8505, "ya a catalogo: sigue en 85,05");
}

// BARRIDO EXHAUSTIVO: las 83 composiciones de 1 a 6 cajas con 3 sabores, cada una
// contra el precio tipico de la escalera VIEJA. El invariante es uno solo: jamas
// por encima de lo que el cliente paga hoy.
{
  const FL: FlavorKey[] = [L, W, P];
  let casos = 0;
  let subidas = 0;
  let peor = 0;
  for (let n = 1; n <= 6; n++) {
    for (let a = 0; a <= n; a++) {
      for (let b = 0; b <= n - a; b++) {
        const c = n - a - b;
        const mix = [
          { flavor: FL[0], boxes: a },
          { flavor: FL[1], boxes: b },
          { flavor: FL[2], boxes: c },
        ].filter((x) => x.boxes > 0);
        if (!mix.length) continue;
        const live = TIER_OLD[n];
        const r = planPreservingCharge(mix, LADDER, live);
        casos++;
        if (!r) continue;
        if (r.totalCents > live) subidas++;
        peor = Math.min(peor, r.totalCents - live);
      }
    }
  }
  eq(casos, 83, "barrido: 83 composiciones probadas");
  eq(subidas, 0, "barrido: CERO composiciones suben el precio");
  eq(peor >= -3, true, `barrido: el desvio nunca pasa de 3 centimos a favor del cliente (fue ${peor})`);
}

// IDEMPOTENCIA: preservar dos veces converge. Si erosionara, cada edicion de sabor
// le bajaria el precio un centimo hasta el infinito.
{
  const r1 = planPreservingCharge([{ flavor: P, boxes: 3 }], LADDER, 6793)!;
  const r2 = planPreservingCharge([{ flavor: P, boxes: 3 }], LADDER, r1.totalCents)!;
  const r3 = planPreservingCharge([{ flavor: P, boxes: 3 }], LADDER, r2.totalCents)!;
  eq(r2.totalCents, r1.totalCents, "idempotencia: la segunda pasada no baja el precio");
  eq(r3.totalCents, r2.totalCents, "idempotencia: la tercera tampoco");
}

// Basura: nunca proponer nada.
eq(planPreservingCharge([{ flavor: L, boxes: 3 }], LADDER, 0), null, "importe 0: null");
eq(planPreservingCharge([{ flavor: L, boxes: 3 }], LADDER, -100), null, "importe negativo: null");

// ── resultado ─────────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(60)}`);
if (failures.length) {
  console.log(`FALLOS (${failures.length}) de ${passed + failures.length} aserciones:\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OK — ${passed} aserciones pasan`);

/**
 * Tests de src/lib/mix.ts. Sin framework (el repo no tiene ninguno): aserciones a mano.
 *
 *   npx tsx scripts/test-mix.ts
 *
 * El bloque importante es el exhaustivo del reparto de precio: para CADA número de
 * cajas 1..6 y CADA partición posible entre 2, 3 y 4 sabores, comprueba que
 * Σ qty×unit nunca supera el total del tramo. Es la propiedad que protege el dinero
 * del cliente, así que se verifica por enumeración, no con ejemplos.
 */

import {
  boxesForVariantQuantity,
  chargeTotalCents,
  compositionFromLines,
  compositionLabel,
  diffLines,
  distributeUnitPrices,
  isMixed,
  mixBoxCount,
  planTargetLines,
  resplitOnBoxChange,
  shapeFor,
  shortLabel,
  validateMix,
  type FlavorComposition,
  type SubscriptionLine,
} from "../src/lib/mix";
import { FLAVORS, type FlavorKey } from "../src/lib/seal-plans";

/** Precio del tramo por nº de cajas = precio de la variante pack pura (céntimos). */
const TIER: Record<number, number> = { 1: 2835, 2: 5670, 3: 6793, 4: 9057, 5: 10395, 6: 12474 };

const L: FlavorKey = "salty-lemon";
const W: FlavorKey = "salty-watermelon";

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

// ── 1. Reparto de precio: exhaustivo ─────────────────────────────────────────
console.log("\n=== reparto de precio (exhaustivo) ===");
// Sólo las particiones de k>=2 son alcanzables por planTargetLines: un solo sabor va
// por la rama `packed`, que cobra el precio de catálogo exacto y no reparte nada.
const inexactSplit: string[] = [];
let splitCases = 0;
for (let boxes = 1; boxes <= 6; boxes++) {
  for (let k = 1; k <= 4; k++) {
    for (const part of partitions(boxes, k)) {
      const { units, chargedCents, residualCents } = distributeUnitPrices(TIER[boxes], part);
      const label = `${boxes} cajas ${part.join("+")}`;
      // LA propiedad que protege el dinero del cliente.
      ok(chargedCents <= TIER[boxes], `${label}: cobra ${chargedCents} > tramo ${TIER[boxes]}`);
      ok(residualCents >= 0, `${label}: residuo negativo ${residualCents}`);
      ok(residualCents < boxes, `${label}: residuo ${residualCents} >= cajas ${boxes}`);
      ok(units.every((u) => u > 0), `${label}: unidad no positiva`);
      eq(chargedCents, TIER[boxes] - residualCents, `${label}: cobrado + residuo == tramo`);
      if (k >= 2) {
        splitCases++;
        if (residualCents > 0) inexactSplit.push(`${label} → ${(residualCents / 100).toFixed(2)}€ menos`);
      }
    }
  }
}
console.log(`  ${splitCases} particiones de mezcla (k>=2), todas con Σ qty×unit <= tramo`);
// El único caso inexacto del catálogo es 4 cajas en 2+2, y es IMPOSIBLE de cuadrar:
// 2·u1 + 2·u2 siempre es par y el tramo de 4 cajas (9057c) es impar. Haría falta una
// tercera línea (MIX_EXACT_CENTS), que está apagado por defecto.
eq(inexactSplit, ["4 cajas 2+2 → 0.01€ menos"],
   "el ÚNICO reparto de mezcla inexacto del catálogo es 4 cajas 2+2");
console.log(`  casos de mezcla inexactos: ${inexactSplit.length} (${inexactSplit.join(", ") || "ninguno"})`);
ok(TIER[4] % 2 === 1, "y es inevitable: el tramo de 4 cajas es impar, 2+2 solo produce pares");

// ── 2. planTargetLines ────────────────────────────────────────────────────────
console.log("\n=== planTargetLines ===");

// packed: un solo sabor se queda en la variante pack, qty 1, precio de catálogo.
const pure3 = planTargetLines([{ flavor: L, boxes: 3 }], TIER[3]);
eq(pure3.shape, "packed", "3 limón: shape packed");
eq(pure3.lines.length, 1, "3 limón: una línea");
eq(pure3.lines[0].variantId, FLAVORS[L].variantByBoxCount[3], "3 limón: variante SL90");
eq(pure3.lines[0].quantity, 1, "3 limón: quantity 1");
eq(pure3.lines[0].unitPriceCents, TIER[3], "3 limón: precio de catálogo (sin custom)");
eq(pure3.lines[0].sku, "SL90", "3 limón: sku SL90");
eq(pure3.residualCents, 0, "3 limón: sin residuo");

// split: el caso verificado en Seal (P1/P2).
const mix3 = planTargetLines([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }], TIER[3]);
eq(mix3.shape, "split", "2L+1W: shape split");
eq(mix3.lines.map((l) => `${l.sku}x${l.quantity}@${(l.unitPriceCents / 100).toFixed(2)}`),
   ["SL30x2@22.64", "W30x1@22.65"], "2L+1W: líneas exactas como en el sondeo P1");
eq(mix3.totalCents, TIER[3], "2L+1W: cobra exactamente el tramo (67.93)");
eq(mix3.boxCount, 3, "2L+1W: 3 cajas");
ok(mix3.lines.every((l) => l.variantId === FLAVORS[l.flavor].variantByBoxCount[1]),
   "2L+1W: todas las líneas usan la variante de 1 caja");

// el único caso inexacto del catálogo
const mix22 = planTargetLines([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 2 }], TIER[4]);
eq(mix22.totalCents, 9056, "2L+2W: cobra 90.56");
eq(mix22.residualCents, 1, "2L+2W: 1 céntimo de residuo (a favor del cliente)");
ok(mix22.totalCents < TIER[4], "2L+2W: nunca por encima del tramo");

throws(() => planTargetLines([{ flavor: L, boxes: 3 }], 0), "tierTotal 0 lanza");
throws(() => planTargetLines([{ flavor: L, boxes: 9 }], TIER[6]), "9 cajas sin variante lanza");

// ── 3. Etiquetas ──────────────────────────────────────────────────────────────
console.log("\n=== etiquetas ===");
eq(compositionLabel([{ flavor: L, boxes: 3 }]), "Salty Lemon",
   "un solo sabor devuelve la etiqueta EXACTA de hoy (sin prefijo 3×)");
eq(compositionLabel([{ flavor: L, boxes: 1 }]), "Salty Lemon", "1 caja de un sabor: igual");
eq(compositionLabel([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }]),
   "2× Lemon · 1× Watermelon", "mezcla: etiqueta compuesta");
eq(compositionLabel([{ flavor: W, boxes: 1 }, { flavor: L, boxes: 2 }]),
   "2× Lemon · 1× Watermelon", "mezcla: el orden de entrada no cambia la etiqueta");
eq(shortLabel(L), "Lemon", "shortLabel quita el prefijo Salty");
eq(shortLabel(W), "Watermelon", "shortLabel sandía");

// ── 4. validateMix ────────────────────────────────────────────────────────────
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
// __proto__ no puede llegar a la salida: se construye solo con claves del registro
const hostile = JSON.parse('[{"flavor":"__proto__","boxes":2}]');
ok(!validateMix(hostile).ok, "__proto__ como sabor rechazado");

// ── 5. resplitOnBoxChange ─────────────────────────────────────────────────────
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
// tres sabores bajando a dos cajas: se quedan los dos mayores
const three: FlavorComposition[] = [{ flavor: L, boxes: 3 }, { flavor: W, boxes: 2 }];
eq(mixBoxCount(resplitOnBoxChange(three, 2)), 2, "resplit 3L+2W → 2 suma 2");

// ── 6. diffLines ──────────────────────────────────────────────────────────────
console.log("\n=== diffLines ===");
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

// (a) cambiar el reparto sin cambiar el total = SOLO edits (el gran hallazgo de P3)
const cur2L1W = [line(1, L, 1, 2, "22.64"), line(2, W, 1, 1, "22.65")];
const tgt1L2W = planTargetLines([{ flavor: L, boxes: 1 }, { flavor: W, boxes: 2 }], TIER[3]);
const d1 = diffLines(cur2L1W, tgt1L2W.lines);
eq(d1.adds.length, 0, "2L+1W → 1L+2W: sin adds");
eq(d1.removes.length, 0, "2L+1W → 1L+2W: sin removes");
eq(d1.edits.length, 2, "2L+1W → 1L+2W: dos edits en sitio");
// El orden de los edits lo marca el orden del objetivo (cajas desc), así que se
// compara como conjunto: lo que importa es que reutiliza los ids 1 y 2.
eq(d1.edits.map((e) => `${e.itemId}:${e.quantity}@${e.unitPrice}`).sort(),
   ["1:1@22.65", "2:2@22.64"], "2L+1W → 1L+2W: ids de item preservados");

// (b) cambiar el número de cajas manteniendo sabores = SOLO edits
const d2 = diffLines(cur2L1W, planTargetLines([{ flavor: L, boxes: 3 }, { flavor: W, boxes: 1 }], TIER[4]).lines);
eq(d2.adds.length + d2.removes.length, 0, "3 → 4 cajas mezcladas: sin add/remove");
ok(d2.edits.length > 0, "3 → 4 cajas mezcladas: solo edits");

// (c) puro → mezcla = add + remove (cambia el conjunto de variantes)
const curPure = [line(9, L, 3, 1, "67.93")];
const d3 = diffLines(curPure, tgt1L2W.lines);
eq(d3.adds.length, 2, "puro → mezcla: dos adds");
eq(d3.removes, [9], "puro → mezcla: quita la línea de pack");
eq(d3.edits.length, 0, "puro → mezcla: sin edits");

// (d) mezcla → puro
const d4 = diffLines(cur2L1W, planTargetLines([{ flavor: L, boxes: 3 }], TIER[3]).lines);
eq(d4.adds.length, 1, "mezcla → puro: un add (SL90)");
eq(d4.removes.sort(), [1, 2], "mezcla → puro: quita las dos de componente");

// (e) sin cambios = noop
eq(diffLines(cur2L1W, planTargetLines([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }], TIER[3]).lines).noop,
   true, "misma composición = noop");

// (f) líneas DUPLICADAS (las subs corruptas) se curan: la extra va a removes
const dupes = [line(11, L, 4, 1, "90.57"), line(12, L, 4, 1, "90.57")];
const d5 = diffLines(dupes, planTargetLines([{ flavor: L, boxes: 4 }], TIER[4]).lines);
eq(d5.removes, [12], "sub duplicada: la línea extra se elimina");
eq(d5.adds.length, 0, "sub duplicada: la primera línea se reutiliza");
eq(d5.edits.length, 0, "sub duplicada: la primera ya está correcta");

// ── 7. Lectura de las cuatro formas reales de producción ──────────────────────
console.log("\n=== boxesForVariantQuantity: las 4 formas de producción ===");
const V = FLAVORS;
eq(boxesForVariantQuantity(V[L].variantByBoxCount[3], 1), 3, "pack + qty 1 (sub pura SL90) = 3 cajas");
eq(boxesForVariantQuantity(V[L].variantByBoxCount[1], 2), 2, "1-caja + qty 2 (mezcla del checkout) = 2 cajas");
eq(boxesForVariantQuantity(V[L].variantByBoxCount[3], 2), 6, "pack + qty 2 (SL90 ×2, 90 subs activas) = 6 cajas");
eq(boxesForVariantQuantity("999999999", 3), 3, "variante legacy sin mapear cae a quantity");

// Fixtures de subs reales del escaneo del libro de Seal
console.log("\n=== fixtures de subs reales ===");
// 14978152: SL30 x2 + W30 x1 = 3 cajas mezcladas (creada en el checkout)
const f14978152 = [line(30559851, L, 1, 2, "28.35"), line(30559852, W, 1, 1, "28.35")];
eq(compositionFromLines(f14978152), [{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }],
   "sub 14978152 (checkout): 2 limón + 1 sandía");
eq(mixBoxCount(compositionFromLines(f14978152)), 3, "sub 14978152: 3 cajas (el portal dice 1 hoy)");
eq(chargeTotalCents(f14978152), 8505, "sub 14978152: cobra 85.05 (sin descuento de tramo)");
eq(shapeFor(compositionFromLines(f14978152)), "split", "sub 14978152: shape split");

// 14924018: W90 + SL90 = 6 cajas
const f14924018 = [line(30473518, W, 3, 1, "67.93"), line(30473519, L, 3, 1, "67.93")];
eq(mixBoxCount(compositionFromLines(f14924018)), 6, "sub 14924018: 6 cajas");
eq(compositionLabel(compositionFromLines(f14924018)), "3× Lemon · 3× Watermelon",
   "sub 14924018: etiqueta 3+3");

// 12918887: SL120 duplicado = corrupta, 8 cajas > 6
const f12918887 = [line(30774797, L, 4, 1, "90.57"), line(30774811, L, 4, 1, "90.57")];
eq(mixBoxCount(compositionFromLines(f12918887)), 8, "sub 12918887 (corrupta): suma 8 cajas, fuera de rango");
eq(compositionFromLines(f12918887).length, 1, "sub 12918887: un solo sabor pese a las 2 líneas");
eq(chargeTotalCents(f12918887), 18114, "sub 12918887: cobra 181.14 (el doble de 90.57)");

// 15090042: W30 + SL30 = 2 cajas
const f15090042 = [line(30761197, W, 1, 1, "28.35"), line(30761198, L, 1, 1, "28.35")];
eq(mixBoxCount(compositionFromLines(f15090042)), 2, "sub 15090042: 2 cajas");
eq(chargeTotalCents(f15090042), 5670, "sub 15090042: 56.70 = el tramo de 2 cajas (aquí sí coincide)");

// 14692586 tras el sondeo: SL30 x1 @22.65 + W30 x2 @22.64
const f14692586 = [line(30833792, L, 1, 1, "22.65"), line(30833794, W, 1, 2, "22.64")];
eq(mixBoxCount(compositionFromLines(f14692586)), 3, "sub de pruebas: 3 cajas");
eq(chargeTotalCents(f14692586), TIER[3], "sub de pruebas: cobra 67.93 = tramo de 3 cajas");
eq(compositionLabel(compositionFromLines(f14692586)), "2× Watermelon · 1× Lemon",
   "sub de pruebas: 2 sandía + 1 limón");

// ── 7.bis Auto-reparación del precio: la deriva es SOLO de precios ────────────
// Si Seal refresca los precios de los items, sustituye el precio por unidad custom
// (22,64) por el de catálogo (28,35) pero NO toca variantes ni cantidades. Esa es la
// propiedad que permite repararlo con un solo edit_items, sin add/remove, que es lo que
// hace seguro hacerlo desde un cron. Es la compensación de no haber podido verificar el
// precio con un cobro real.
console.log("\n=== auto-reparación del precio (deriva solo de precios) ===");
const drifted = [
  line(501, L, 1, 2, "28.35"), // Seal "refrescó" el precio: 22.64 -> 28.35
  line(502, W, 1, 1, "28.35"), //                            22.65 -> 28.35
];
eq(chargeTotalCents(drifted), 8505, "deriva: cobraría 85.05 en vez de 67.93 (+25%)");
const healPlan = planTargetLines([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }], TIER[3]);
const healDiff = diffLines(drifted, healPlan.lines);
eq(healDiff.adds.length, 0, "reparación: sin adds");
eq(healDiff.removes.length, 0, "reparación: sin removes");
eq(healDiff.edits.length, 2, "reparación: 2 edits en sitio");
eq(healDiff.edits.map((e) => `${e.itemId}@${e.unitPrice}`).sort(), ["501@22.64", "502@22.65"],
   "reparación: mismos ids de item, precios restaurados");
// Y aplicar el plan reparado deja el cobro exacto.
eq(healPlan.totalCents, TIER[3], "reparación: vuelve a cobrar 67.93");
// Dirección: por debajo del tramo NO se toca (podría ser una promo deliberada).
const below = [line(601, L, 1, 2, "20.00"), line(602, W, 1, 1, "20.00")];
ok(chargeTotalCents(below) < TIER[3], "por debajo del tramo se detecta pero no se repara sola");

// ── 8. Downstream: Drops por ENVÍO y box_count del email ─────────────────────
console.log("\n=== downstream: Drops y box_count del email ===");

const V2 = FLAVORS;
/** Réplica de la cuenta de Drops del webhook fulfillments/create: una unidad por
 *  selling plan distinto entre las líneas del registro, más la cantidad para el
 *  resto. Los Drops son por ENVÍO, no por caja (el comentario del código miente). */
function dropsUnits(lines: Array<{ variantId?: string; qty: number; plan: string | null }>): number {
  const sub = lines.filter((l) => l.plan);
  const inReg = sub.filter((l) => l.variantId && boxesForVariantQuantity(l.variantId, 1) > 0 && BOX_IN_REGISTRY(l.variantId));
  const other = sub.filter((l) => !(l.variantId && BOX_IN_REGISTRY(l.variantId)));
  return new Set(inReg.map((l) => l.plan!)).size + other.reduce((s, l) => s + l.qty, 0);
}
function BOX_IN_REGISTRY(variantId: string): boolean {
  return ALL_VARIANTS.has(variantId);
}
const ALL_VARIANTS = new Set(
  [L, W].flatMap((f) => Object.values(V2[f].variantByBoxCount)),
);
const PLAN = "691259900253";

// La propiedad crítica: una mezcla NO puede inflar los Drops.
eq(dropsUnits([{ variantId: V2[L].variantByBoxCount[3], qty: 1, plan: PLAN }]), 1,
   "sub pura de 3 cajas -> 1 unidad (100 Drops), igual que hoy");
eq(dropsUnits([
     { variantId: V2[L].variantByBoxCount[1], qty: 2, plan: PLAN },
     { variantId: V2[W].variantByBoxCount[1], qty: 1, plan: PLAN },
   ]), 1,
   "mezcla 2L+1W -> 1 unidad (100 Drops), SIN inflación 3x");
eq(dropsUnits([{ variantId: "999", qty: 4, plan: null }]), 0, "B2B / una sola compra -> 0 Drops");
eq(dropsUnits([{ variantId: "extra-999", qty: 2, plan: null }]), 0, "solo extras -> 0 Drops");
eq(dropsUnits([
     { variantId: V2[L].variantByBoxCount[1], qty: 1, plan: PLAN },
     { variantId: V2[L].variantByBoxCount[1], qty: 1, plan: "691259834717" },
   ]), 2,
   "dos subs con cadencias distintas en un pedido -> 2 unidades (como hoy)");

/** Réplica del box_count del email: cajas de la variante × cantidad. */
function emailBoxCount(lines: Array<{ variantId: string; qty: number }>): number {
  return lines.reduce((s, l) => s + boxesForVariantQuantity(l.variantId, l.qty), 0);
}
eq(emailBoxCount([{ variantId: V2[L].variantByBoxCount[3], qty: 1 }]), 3,
   "email: SL90 x1 -> 3 cajas (antes decia 1, para TODOS los suscriptores)");
eq(emailBoxCount([{ variantId: V2[L].variantByBoxCount[6], qty: 1 }]), 6,
   "email: SL180 x1 -> 6 cajas (antes decia 1)");
eq(emailBoxCount([
     { variantId: V2[L].variantByBoxCount[1], qty: 2 },
     { variantId: V2[W].variantByBoxCount[1], qty: 1 },
   ]), 3,
   "email: mezcla 2L+1W -> 3 cajas");
eq(emailBoxCount([{ variantId: V2[L].variantByBoxCount[1], qty: 1 }]), 1,
   "email: SL30 x1 -> 1 caja (sin cambio)");

// ── resultado ─────────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(60)}`);
if (failures.length) {
  console.log(`FALLOS (${failures.length}) de ${passed + failures.length} aserciones:\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OK — ${passed} aserciones pasan`);

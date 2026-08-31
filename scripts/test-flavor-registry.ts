/**
 * Guarda del REGISTRO DE SABORES.
 *
 * Existe por un fallo real encontrado al añadir el tercer sabor (Salty Peach,
 * 2026-08-31): `mix.ts::skuFor` resolvía el prefijo del SKU con un ternario
 * binario (`flavor === "salty-lemon" ? "SL" : "W"`). Con dos sabores era correcto
 * por accidente; con tres, las cajas sueltas de melocotón salían con SKU W30 y
 * Hive habría pickeado SANDÍA — el SKU viaja verbatim Seal → pedido → Hive.
 * TypeScript no lo veía porque el ternario es total.
 *
 * Estas comprobaciones son las que habrían cazado ese fallo, y se disparan solas
 * la próxima vez que alguien añada un sabor.
 */
import {
  ALL_FLAVORS, FLAVORS, FLAVOR_KEYS, PACK4_BOXES, PACK4_VARIANTS,
  PACK4_BY_VARIANT, pack4VariantForComposition, variantForFlavorBox,
  BOX_COUNT_BY_VARIANT, FLAVOR_BY_VARIANT, type FlavorKey,
} from "../src/lib/seal-plans";
import { planTargetLines } from "../src/lib/mix";

let fails = 0;
function check(cond: boolean, msg: string) {
  console.log((cond ? "✓ " : "✗ ") + msg);
  if (!cond) fails++;
}

// 1) cada sabor completo y con prefijo de SKU propio
const prefixes = ALL_FLAVORS.map((f) => f.skuPrefix);
check(prefixes.every(Boolean), "todos los sabores tienen skuPrefix");
check(new Set(prefixes).size === prefixes.length,
  `los prefijos de SKU son distintos entre sí (${prefixes.join(", ")})`);
for (const f of ALL_FLAVORS) {
  check(Object.keys(f.variantByBoxCount).length === 6, `${f.key}: 6 variantes por nº de cajas`);
  check(!!variantForFlavorBox(f.key, 1), `${f.key}: variante de 1 caja resoluble`);
}

// 2) el SKU de 1 caja de cada sabor sale con SU prefijo, no con el de otro
const prices = { oneBoxCents: 2835, pack4Cents: 8505 };
for (const f of ALL_FLAVORS) {
  const plan = planTargetLines([{ flavor: f.key, boxes: 1 }], prices);
  check(plan.lines[0].sku === `${f.skuPrefix}30`,
    `${f.key}: 1 caja → SKU ${f.skuPrefix}30 (obtenido ${plan.lines[0].sku})`);
}

// 3) TODAS las mezclas de 4 cajas tienen variante de pack (si no, planTargetLines
//    lanza y el cliente se come un 500 al cambiar de sabor)
const mixes: FlavorKey[][] = [];
(function walk(acc: FlavorKey[], start: number) {
  if (acc.length === PACK4_BOXES) { mixes.push([...acc]); return; }
  for (let i = start; i < FLAVOR_KEYS.length; i++) walk([...acc, FLAVOR_KEYS[i]], i);
})([], 0);
let sinVariante = 0;
for (const m of mixes) {
  const comp = FLAVOR_KEYS
    .map((k) => ({ flavor: k, boxes: m.filter((x) => x === k).length }))
    .filter((c) => c.boxes > 0);
  if (!pack4VariantForComposition(comp)) {
    console.log("   sin variante:", comp.map((c) => `${c.boxes}x${c.flavor}`).join(" + "));
    sinVariante++;
  }
}
const esperadas = mixes.length;
check(sinVariante === 0, `las ${esperadas} mezclas de ${PACK4_BOXES} cajas tienen variante de pack`);
check(PACK4_VARIANTS.length === esperadas,
  `PACK4_VARIANTS tiene ${esperadas} entradas (${PACK4_VARIANTS.length})`);

// 4) variantes de pack: ids únicos, composición que suma 4, y legibles al revés
const ids = PACK4_VARIANTS.map((v) => v.variantId);
check(new Set(ids).size === ids.length, "los variantId del pack no se repiten");
for (const v of PACK4_VARIANTS) {
  const t = v.composition.reduce((s, c) => s + c.boxes, 0);
  check(t === PACK4_BOXES, `${v.sku}: la composición suma ${PACK4_BOXES}`);
  check(BOX_COUNT_BY_VARIANT[v.variantId] === PACK4_BOXES, `${v.sku}: BOX_COUNT_BY_VARIANT lo conoce`);
  check(!!PACK4_BY_VARIANT[v.variantId], `${v.sku}: PACK4_BY_VARIANT lo conoce`);
}

// 5) toda variante de 1 caja se lee de vuelta a SU sabor
for (const f of ALL_FLAVORS) {
  const vid = f.variantByBoxCount[1];
  check(FLAVOR_BY_VARIANT[vid] === f.key, `${f.key}: la variante de 1 caja se lee de vuelta a su sabor`);
}

console.log(fails === 0 ? "\nTodos OK" : `\n${fails} FALLOS`);
if (fails) process.exit(1);

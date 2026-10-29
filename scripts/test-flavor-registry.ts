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
 *
 * Salty Raw (2026-10-29) añade dos guardas: que el SKU de cada variante de pack
 * cuadre con su composición (las 40 de Raw se copiaron a mano de creadas.json, y un
 * id o una mezcla mal puestos se leen en silencio como otra cosa), y la puerta de
 * lanzamiento (Raw se lee desde ya, pero no se ofrece antes de las 17:00 de Madrid).
 */
import {
  ALL_FLAVORS, FLAVORS, FLAVOR_KEYS, PACK4_BOXES, PACK4_VARIANTS, PACK4_OT_VARIANTS,
  PACK4_BY_VARIANT, pack4VariantForComposition, variantForFlavorBox,
  BOX_COUNT_BY_VARIANT, FLAVOR_BY_VARIANT, flavorKeyForProductId, type FlavorKey,
  RAW_OFFERABLE_FROM, isFlavorOfferable, offerableFlavorKeys, flavorsNotYetOffered,
  flavorChoices,
} from "../src/lib/seal-plans";
import { planTargetLines, ladderTotalCents, MAX_BOXES } from "../src/lib/mix";
import { compositionFromOrderLines, boxCountFromOrderLines } from "../src/lib/order-lines";

type Pack4Comp = (typeof PACK4_VARIANTS)[number]["composition"];

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


// 6) TODAS las mezclas posibles de 1..MAX_BOXES cajas resuelven por el camino real
//    y cuadran con la escalera. Con k sabores son C(n+k-1, k-1) por tamaño: 83 con 3,
//    209 con 4. Es la red que caza "he añadido un sabor pero falta una variante de pack".
//    Hasta Raw recorría los 3 primeros sabores a mano ([a, b, c]): el cuarto habría
//    pasado en verde sin probarse. Ahora recorre el registro entero.
{
  const prices = { oneBoxCents: 2835, pack4Cents: 8505 };
  let probadas = 0, malas = 0;
  const k = FLAVOR_KEYS.length;
  /** Todos los repartos de `n` cajas entre los sabores desde `from` (con ceros). */
  function* repartos(n: number, from: number): Generator<number[]> {
    if (from === k - 1) { yield [n]; return; }
    for (let x = n; x >= 0; x--) for (const rest of repartos(n - x, from + 1)) yield [x, ...rest];
  }
  for (let n = 1; n <= MAX_BOXES; n++) {
    for (const counts of repartos(n, 0)) {
      const mix = FLAVOR_KEYS.map((f, i) => ({ flavor: f, boxes: counts[i] })).filter((v) => v.boxes > 0);
      probadas++;
      try {
        const plan = planTargetLines(mix, prices);
        const suma = plan.lines.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
        const cajas = plan.lines.reduce((s, l) => s + (l.boxes ?? 0), 0);
        if (suma !== ladderTotalCents(n, prices) || cajas !== n) malas++;
      } catch { malas++; }
    }
  }
  const comb = (a: number, b: number) => { let r = 1; for (let i = 1; i <= b; i++) r = (r * (a - b + i)) / i; return r; };
  const esperadas = [1, 2, 3, 4, 5, 6].reduce((s, n) => s + comb(n + k - 1, k - 1), 0);
  check(k < 4 || esperadas === 209, `con ${k} sabores son 209 mezclas de 1..6 cajas (${esperadas})`);
  check(probadas === esperadas, `se prueban las ${esperadas} mezclas de 1..${MAX_BOXES} cajas (${probadas})`);
  check(malas === 0, `las ${probadas} mezclas resuelven y cuadran con la escalera (${malas} malas)`);
}

// 7) el SKU de cada variante de pack CUADRA con su composición, en las dos listas.
//    PACK4-<n>L<n>W<n>P<n>R en orden de registro, sin ceros. La composición va en
//    orden canónico (más cajas primero, empate → registro), que es el que escribe
//    planTargetLines. Y cada gemela de compra única es la de suscripción del mismo
//    índice (misma mezcla y SKU, otro id).
{
  // Letra del sabor dentro del SKU del pack: NO es skuPrefix (Lemon es SL30 pero «L»
  // en el pack). Record<FlavorKey>, así que un sabor nuevo obliga a declararla.
  const PACK_LETTER: Record<FlavorKey, string> = {
    "salty-lemon": "L", "salty-watermelon": "W", "salty-peach": "P", "salty-raw": "R",
  };
  const skuDe = (comp: Pack4Comp) =>
    "PACK4-" + FLAVOR_KEYS.map((f) => {
      const n = comp.filter((c) => c.flavor === f).reduce((s, c) => s + c.boxes, 0);
      return n > 0 ? `${n}${PACK_LETTER[f]}` : "";
    }).join("");
  const canonica = (comp: Pack4Comp) =>
    comp.every((c, i) => i === 0 || (() => {
      const p = comp[i - 1];
      return p.boxes > c.boxes || (p.boxes === c.boxes && FLAVOR_KEYS.indexOf(p.flavor) < FLAVOR_KEYS.indexOf(c.flavor));
    })());
  let malSku = 0, malOrden = 0;
  for (const v of [...PACK4_VARIANTS, ...PACK4_OT_VARIANTS]) {
    if (skuDe(v.composition) !== v.sku) { malSku++; console.log(`   ${v.variantId}: SKU ${v.sku} y composición ${skuDe(v.composition)}`); }
    if (!canonica(v.composition)) { malOrden++; console.log(`   ${v.sku}: composición fuera del orden canónico`); }
  }
  check(malSku === 0, `las ${PACK4_VARIANTS.length + PACK4_OT_VARIANTS.length} variantes de pack: SKU = composición (${malSku} malas)`);
  check(malOrden === 0, `todas las composiciones en orden canónico (${malOrden} fuera)`);
  check(PACK4_OT_VARIANTS.length === PACK4_VARIANTS.length,
    `compra única y suscripción tienen las mismas mezclas (${PACK4_OT_VARIANTS.length}/${PACK4_VARIANTS.length})`);
  check(PACK4_OT_VARIANTS.every((v, i) => v.sku === PACK4_VARIANTS[i].sku && v.composition === PACK4_VARIANTS[i].composition),
    "cada gemela de compra única es la de suscripción del mismo índice");
  const todos = [...PACK4_VARIANTS, ...PACK4_OT_VARIANTS].map((v) => v.variantId);
  check(new Set(todos).size === todos.length, "ningún id de pack se repite entre suscripción y compra única");
}

// 8) Raw (2026-10-29): las 40 variantes nuevas de pack se LEEN, que es lo que tiene
//    que funcionar desde el despliegue aunque Raw no se ofrezca hasta las 17:00.
{
  const R: FlavorKey = "salty-raw";
  const conRaw = [...PACK4_VARIANTS, ...PACK4_OT_VARIANTS].filter((v) => v.composition.some((c) => c.flavor === R));
  check(conRaw.length === 40, `40 variantes de pack llevan Raw: 20 de suscripción y 20 de compra única (${conRaw.length})`);
  check(conRaw.every((v) => PACK4_BY_VARIANT[v.variantId] === v && BOX_COUNT_BY_VARIANT[v.variantId] === PACK4_BOXES),
    "PACK4_BY_VARIANT y BOX_COUNT_BY_VARIANT resuelven las 40 (4 cajas, su mezcla)");
  check(pack4VariantForComposition([{ flavor: R, boxes: 4 }])?.variantId === "67811579330950", "4 Raw → PACK4-4R 67811579330950");
  check(
    pack4VariantForComposition([
      { flavor: "salty-raw", boxes: 1 }, { flavor: "salty-peach", boxes: 1 },
      { flavor: "salty-watermelon", boxes: 1 }, { flavor: "salty-lemon", boxes: 1 },
    ])?.sku === "PACK4-1L1W1P1R",
    "una de cada, en cualquier orden → PACK4-1L1W1P1R",
  );
  check(pack4VariantForComposition([{ flavor: "salty-lemon", boxes: 1 }, { flavor: R, boxes: 3 }])?.variantId === "67811579003270",
    "1 Lemon + 3 Raw → PACK4-1L3R 67811579003270");
  const plan6 = planTargetLines([{ flavor: R, boxes: 4 }, { flavor: "salty-peach", boxes: 2 }], { oneBoxCents: 2835, pack4Cents: 8505 });
  // Las sueltas salen del sabor con MÁS cajas (mix.ts): aquí, de Raw.
  check(plan6.lines.map((l) => `${l.sku}×${l.quantity}`).sort().join() === "PACK4-2P2R×1,R30×2",
    `4R + 2P = pack 2P2R + R30×2 sueltas (${plan6.lines.map((l) => `${l.sku}×${l.quantity}`).join(" ")})`);
  const plan5 = planTargetLines([{ flavor: R, boxes: 5 }], { oneBoxCents: 2835, pack4Cents: 8505 });
  check(plan5.lines.map((l) => `${l.sku}×${l.quantity}`).sort().join() === "PACK4-4R×1,R30×1", "5 Raw = PACK4-4R + R30 suelta");
  check(FLAVORS[R].label === "Salty Raw" && FLAVORS[R].skuPrefix === "R", "Raw se llama «Salty Raw» y su SKU suelto es R30");
  check(flavorKeyForProductId("16272462053725") === R, "el producto de suscripción de Raw se lee como Raw");

  // Un pedido web con el pack de compra única 1L1W1P1R y una caja R30 de suscripción.
  const pedido = compositionFromOrderLines([
    { variant_id: 67811579560326, quantity: 1 },
    { variant_id: 65046837297501, quantity: 2 },
  ]);
  const raw = pedido.find((c) => c.flavor === R)?.boxes;
  check(raw === 3 && pedido.length === 4, `pedido 1L1W1P1R + R30×2 → 3 Raw y 4 sabores (${JSON.stringify(pedido)})`);
  check(boxCountFromOrderLines([{ title: "pack", quantity: 1, variant_id: 67811579560326 }]) === 4,
    "un pack de compra única con Raw cuenta 4 cajas, no 1 de Lemon");
}

// 9) puerta de lanzamiento: Raw se ofrece desde las 17:00 de Madrid del 29-oct-2026.
{
  const R: FlavorKey = "salty-raw";
  const L: FlavorKey = "salty-lemon";
  const ANTES = Date.parse("2026-10-29T15:59:59Z");
  const HORA = Date.parse("2026-10-29T16:00:00Z");
  const madrid = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(RAW_OFFERABLE_FROM));
  check(madrid.includes("29/10/2026") && madrid.includes("17:00"), `RAW_OFFERABLE_FROM es el 29-oct a las 17:00 en Madrid (${madrid})`);
  check(FLAVORS[R].offerableFrom === RAW_OFFERABLE_FROM, "Raw lleva esa fecha en el registro");
  check(!isFlavorOfferable(R, ANTES) && isFlavorOfferable(R, HORA), "Raw: no a las 16:59:59 de Madrid, sí a las 17:00:00");
  check(FLAVOR_KEYS.filter((k) => k !== R).every((k) => isFlavorOfferable(k, 0)), "los otros sabores, desde siempre");
  check(offerableFlavorKeys(ANTES).join() === "salty-lemon,salty-watermelon,salty-peach", `antes: ${offerableFlavorKeys(ANTES).join()}`);
  check(offerableFlavorKeys(HORA).join() === FLAVOR_KEYS.join(), `a la hora: ${offerableFlavorKeys(HORA).join()}`);

  check(flavorsNotYetOffered([{ flavor: L, boxes: 1 }], [{ flavor: R, boxes: 1 }], ANTES).join() === R, "antes: cambiar a Raw se bloquea");
  check(flavorsNotYetOffered([{ flavor: L, boxes: 2 }], [{ flavor: L, boxes: 1 }, { flavor: R, boxes: 1 }], ANTES).join() === R,
    "antes: meter Raw en una mezcla se bloquea");
  check(flavorsNotYetOffered([{ flavor: L, boxes: 1 }], [{ flavor: R, boxes: 1 }], HORA).length === 0, "a la hora: cambiar a Raw pasa");
  check(flavorsNotYetOffered([{ flavor: R, boxes: 1 }, { flavor: L, boxes: 1 }], [{ flavor: L, boxes: 1 }, { flavor: R, boxes: 1 }], ANTES).length === 0,
    "antes: una sub que YA lleva Raw puede cambiar la frecuencia (misma composición)");
  check(flavorsNotYetOffered([{ flavor: R, boxes: 2 }], [{ flavor: R, boxes: 1 }, { flavor: L, boxes: 1 }], ANTES).length === 0,
    "antes: quitarle cajas a Raw no es elegirlo");
  check(flavorsNotYetOffered([{ flavor: R, boxes: 1 }, { flavor: L, boxes: 1 }], [{ flavor: R, boxes: 2 }], ANTES).join() === R,
    "antes: subirle cajas a Raw sí es elegirlo");
  check(flavorsNotYetOffered([{ flavor: L, boxes: 1 }], [{ flavor: "salty-peach", boxes: 1 }], ANTES).length === 0,
    "antes: los otros sabores no se tocan");

  check(flavorChoices(offerableFlavorKeys(ANTES)).every((f) => f.key !== R), "pantalla antes: Raw no sale");
  check(flavorChoices(offerableFlavorKeys(ANTES), [R]).some((f) => f.key === R), "pantalla antes: sale si la sub ya lo lleva");
  check(flavorChoices(offerableFlavorKeys(HORA)).map((f) => f.key).join() === FLAVOR_KEYS.join(), "pantalla a la hora: los 4, en orden de registro");

  // Fallar cerrado: una fecha ilegible no ofrece el sabor.
  const real = FLAVORS[R].offerableFrom;
  FLAVORS[R].offerableFrom = "29 de octubre";
  check(!isFlavorOfferable(R, HORA + 365 * 86_400_000), "una fecha ilegible cuenta como «todavía no»");
  FLAVORS[R].offerableFrom = real;
}

console.log(fails === 0 ? "\nTodos OK" : `\n${fails} FALLOS`);
if (fails) process.exit(1);

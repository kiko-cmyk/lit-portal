/**
 * Tests de src/lib/line-repair.ts. Sin framework (el repo no tiene ninguno).
 *
 *   npx tsx scripts/test-line-repair.ts
 *
 * Los casos son los del incidente del 2-oct-2026, con las líneas tal como las enseñaba
 * Seal: lo que importa probar es que cada estado a medias que hemos visto en producción
 * se reconoce como NUESTRO y converge sin añadir nada, y que un cambio de soporte o del
 * admin de Seal se reconoce como AJENO y no se pisa.
 */

import {
  classifyLineState,
  discountedItemIds,
  planDiscountForRemoval,
  planLineRepair,
  sealWriteDefinitelyRejected,
  snapshotAsTargets,
} from "@/lib/line-repair";
import type { SubscriptionLine, TargetLine } from "@/lib/mix";
import { SealApiError, type SealSubscription } from "@/lib/seal";
import { UpstreamTimeoutError } from "@/lib/http-timeout";

const failures: string[] = [];
let passed = 0;
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

// Variantes reales (las que enseñaba Seal en las subs del incidente).
const SL90 = "63887092220253"; // Salty Lemon 3 cajas, escalera vieja (67,93)
const SL30 = "63887092154717";
const W30 = "63887092459165";
const P30 = "65046790537565";
const PACK4_4L = "65636234625373";
const PACK4_1L2W1P = "65753050775901";
const PACK4_1L3W = "65636234723677";

const line = (itemId: number, variantId: string, quantity: number, unitPrice: string, boxes = quantity): SubscriptionLine => ({
  itemId,
  productId: "p",
  variantId,
  flavor: "salty-lemon",
  boxes,
  quantity,
  unitPrice,
  sellingPlanId: "sp",
});
const target = (variantId: string, quantity: number, unitPriceCents: number, boxes = quantity): TargetLine => ({
  productId: "p",
  variantId,
  flavor: "salty-lemon",
  quantity,
  unitPriceCents,
  boxes,
  sku: "",
});

// ── sealWriteDefinitelyRejected ────────────────────────────────────────────────
{
  ok(sealWriteDefinitelyRejected(new SealApiError(400, "Item is missing price value.")), "400 de Seal = rechazo seguro");
  ok(sealWriteDefinitelyRejected(new SealApiError(404, "not found")), "404 de Seal = rechazo seguro");
  ok(sealWriteDefinitelyRejected(new SealApiError(429, "throttled")), "429 del borde = no llegó a procesarse");
  ok(
    sealWriteDefinitelyRejected(new SealApiError(200, "Seal add_items rejected: Item is missing price value.")),
    "200 con success:false = Seal dijo que no (seal.ts lo lanza como SealApiError(200))",
  );
  ok(!sealWriteDefinitelyRejected(new SealApiError(408, "timeout")), "408 = no sabemos");
  ok(!sealWriteDefinitelyRejected(new SealApiError(502, "bad gateway")), "5xx = puede haber entrado");
  ok(!sealWriteDefinitelyRejected(new SealApiError(500, "")), "500 = puede haber entrado");
  ok(
    !sealWriteDefinitelyRejected(new UpstreamTimeoutError("seal", "/subscription", 1500)),
    "nuestro deadline = Seal sigue procesando (14345379, 13109864)",
  );
  const abort = new Error("aborted");
  abort.name = "AbortError";
  ok(!sealWriteDefinitelyRejected(abort), "abort = puede haber entrado");
  ok(!sealWriteDefinitelyRejected(new TypeError("fetch failed")), "fallo de red = no sabemos si salió");
  ok(!sealWriteDefinitelyRejected(undefined), "undefined = no sabemos");
}

// ── 12798642 (2-oct): sabor 3 Lemon → 1L+1W+1P conservando 67,93 ────────────────
{
  const snapshot = [line(31000001, SL90, 1, "67.93", 3)];
  const desired = [target(SL30, 1, 2265), target(W30, 1, 2264), target(P30, 1, 2264)];
  // Lo que había en Seal a las 07:27: los tres adds dentro, la SL90 sin quitar (6 cajas).
  const partial = [
    snapshot[0],
    line(33356801, SL30, 1, "22.65"),
    line(33356802, W30, 1, "22.64"),
    line(33356803, P30, 1, "22.64"),
  ];
  eq(classifyLineState(partial, snapshot, desired).kind, "partial", "12798642: add sin remove es NUESTRO a medias");
  const plan = planLineRepair(partial, snapshot, desired);
  eq(plan.kind, "converge", "12798642: se puede converger sin añadir");
  if (plan.kind === "converge") {
    eq(plan.towards, "target", "12798642: va al objetivo (lo que pidió), no a la foto");
    eq(plan.removes, [31000001], "12798642: basta con quitar la SL90");
    eq(plan.edits, [], "12798642: sin edits");
  }
  // El objetivo cuesta lo que pagaba: la reparación conserva los 67,93.
  eq(desired.reduce((s, t) => s + t.quantity * t.unitPriceCents, 0), 6793, "12798642: el objetivo son sus 67,93");

  // Y lo que la ruta hizo a las 07:27 (repreciar las tres a 28,35) ya no es nuestro:
  // un precio que no es ni la foto ni el objetivo es la firma de otro cambio.
  const repriced = [
    snapshot[0],
    line(33356801, SL30, 1, "28.35"),
    line(33356802, W30, 1, "28.35"),
    line(33356803, P30, 1, "28.35"),
  ];
  eq(classifyLineState(repriced, snapshot, desired).kind, "foreign", "líneas a otro precio = las ha tocado otro");
}

// ── 14345379 (17-sep): Lemon → Peach, 1 caja. Sigue hoy con las dos ──────────────
{
  const snapshot = [line(29545587, SL30, 1, "28.35")];
  const desired = [target(P30, 1, 2835)];
  const partial = [snapshot[0], line(32664220, P30, 1, "28.35")];
  const plan = planLineRepair(partial, snapshot, desired);
  eq(plan.kind, "converge", "14345379: converge");
  if (plan.kind === "converge") {
    eq(plan.towards, "target", "14345379: se queda con Peach");
    eq(plan.removes, [29545587], "14345379: quita la Lemon");
  }
  // Pero la Lemon lleva LITSTAY15: el cron no la quita a ciegas.
  const sub = {
    items: [
      { id: 29545587, discount_codes: [{ id: "e4ba0d94", code: "LITSTAY15" }] },
      { id: 32664220, discount_codes: [{ id: "e4ba0d94", code: "LITSTAY15" }] },
    ],
  } as unknown as SealSubscription;
  eq(discountedItemIds(sub, [29545587]), [29545587], "14345379: la línea a quitar lleva descuento");
  eq(discountedItemIds({ items: [{ id: 1 }] } as unknown as SealSubscription, [1]), [], "sin descuento no se marca");
}

// ── 15950195 (7-oct): add sin remove con LITSTAY15 en las dos líneas ──────────────
// La ruta repone el 15% antes de pasar el caso al cron y Seal lo enseña en TODAS las
// líneas. Hasta el 8-oct el cron se negaba a quitar la vieja (72 intentos, caducada).
{
  const snapshot = [line(32286784, PACK4_1L2W1P, 1, "85.05", 4)];
  const desired = [target(PACK4_1L3W, 1, 8505, 4)];
  const live = [snapshot[0], line(33532774, PACK4_1L3W, 1, "85.05", 4)];
  const plan = planLineRepair(live, snapshot, desired);
  eq(plan.kind, "converge", "15950195: converge");
  if (plan.kind === "converge") {
    eq(plan.towards, "target", "15950195: se queda con lo que pidió (1L3W)");
    eq(plan.removes, [32286784], "15950195: quita el pack viejo");
    eq(plan.edits, [], "15950195: sin edits");
  }
  const STAY = { id: "faf45e5d-72d3-4d07-baf8-0fd8edb2288e", code: "LITSTAY15" };
  const sub = {
    items: [
      { id: 32286784, discount_codes: [STAY] },
      { id: 33532774, discount_codes: [STAY] },
    ],
  } as unknown as SealSubscription;
  const RET = { kind: "retention" as const, code: "LITSTAY15" };
  eq(
    planDiscountForRemoval(sub, [32286784], [RET]),
    { kind: "tracked", codes: [{ kind: "retention", code: "LITSTAY15", ids: [STAY.id] }] },
    "15950195: el 15% que seguimos se suelta y se repone",
  );
  eq(
    planDiscountForRemoval(sub, [32286784], [{ kind: "retention", code: "litstay15 " }]).kind,
    "tracked",
    "el código se compara sin mayúsculas ni espacios",
  );
  eq(
    planDiscountForRemoval(sub, [32286784], []),
    { kind: "foreign", itemIds: [32286784] },
    "sin fila de retención viva: para una persona",
  );
  eq(
    planDiscountForRemoval(sub, [32286784], [{ kind: "retention", code: "WELCOME10" }]).kind,
    "foreign",
    "el código de la línea no es el que seguimos: para una persona",
  );
  const twoCodes = {
    items: [{ id: 1, discount_codes: [STAY, { id: "x", code: "OTRO" }] }, { id: 2, discount_codes: [STAY] }],
  } as unknown as SealSubscription;
  eq(planDiscountForRemoval(twoCodes, [1], [RET]).kind, "foreign", "la retención y otro código juntos: para una persona");
  const noUuid = { items: [{ id: 1, discount_codes: [{ code: "LITSTAY15" }] }] } as unknown as SealSubscription;
  eq(planDiscountForRemoval(noUuid, [1], [RET]).kind, "foreign", "sin UUID no se puede soltar: para una persona");
  eq(
    planDiscountForRemoval({ items: [{ id: 1 }, { id: 2, discount_codes: [STAY] }] } as unknown as SealSubscription, [1], [RET]),
    { kind: "clear" },
    "la línea a quitar no lleva código: se quita sin más",
  );

  // Crédito Discovery de la primera renovación (9-oct-2026): mismo trato que el 15%.
  const DS = { id: "95fe36c7-775a-46f2-be11-588b19f5ff0d", code: "LIT-M6653GZE" };
  const DIS = { kind: "discovery" as const, code: "LIT-M6653GZE" };
  const dsSub = {
    items: [{ id: 1, discount_codes: [DS] }, { id: 2, discount_codes: [DS] }],
  } as unknown as SealSubscription;
  eq(
    planDiscountForRemoval(dsSub, [1], [DIS]),
    { kind: "tracked", codes: [{ kind: "discovery", code: "LIT-M6653GZE", ids: [DS.id] }] },
    "crédito Discovery seguido: se suelta y se repone (ya no deja la reparación parada)",
  );
  const both = {
    items: [{ id: 1, discount_codes: [STAY, DS] }, { id: 2, discount_codes: [STAY, DS] }],
  } as unknown as SealSubscription;
  const bothPlan = planDiscountForRemoval(both, [1], [RET, DIS]);
  eq(bothPlan.kind, "tracked", "15% y Discovery juntos, los dos seguidos: se sueltan los dos");
  eq(
    bothPlan.kind === "tracked" ? bothPlan.codes.map((c) => c.kind).sort() : [],
    ["discovery", "retention"],
    "y se reponen los dos, cada uno con su lógica",
  );
  eq(planDiscountForRemoval(both, [1], [RET]).kind, "foreign", "si el Discovery no está seguido (sin fila viva): para una persona");
  eq(
    planDiscountForRemoval({ items: [{ id: 1, discount_codes: [DS, { id: "x", code: "OTRO" }] }] } as unknown as SealSubscription, [1], [DIS]).kind,
    "foreign",
    "Discovery y otro código juntos: para una persona",
  );
}

// ── 13416998 (1-oct): el remove entró aunque la ruta lo dio por fallido ──────────
{
  const snapshot = [line(27965013, SL90, 2, "67.93", 6)];
  const desired = [target(PACK4_4L, 1, 8505, 4)];
  const live = [line(33315257, PACK4_4L, 1, "85.05", 4)];
  eq(classifyLineState(live, snapshot, desired).kind, "at_target", "13416998: ya está en el objetivo");
  eq(planLineRepair(live, snapshot, desired), { kind: "nothing_to_do", state: "at_target" }, "13416998: nada que hacer");
}

// ── nada entró: la sub sigue como la foto ─────────────────────────────────────────
{
  const snapshot = [line(1, SL90, 1, "67.93", 3)];
  const desired = [target(SL30, 1, 2835)];
  eq(planLineRepair(snapshot, snapshot, desired), { kind: "nothing_to_do", state: "at_snapshot" }, "foto intacta = nada que reparar");
}

// ── murió tras los edits y antes de los adds: se vuelve a la foto ────────────────
{
  // 3 Lemon sueltas (SL30×3) → 1L+1W+1P: edit SL30 3→1 y adds W30, P30.
  const snapshot = [line(10, SL30, 3, "22.64", 3)];
  const desired = [target(SL30, 1, 2265), target(W30, 1, 2264), target(P30, 1, 2264)];
  const partial = [line(10, SL30, 1, "22.65", 1)];
  eq(classifyLineState(partial, snapshot, desired).kind, "partial", "edit sin adds es nuestro");
  const plan = planLineRepair(partial, snapshot, desired);
  eq(plan.kind, "converge", "edit sin adds: converge");
  if (plan.kind === "converge") {
    eq(plan.towards, "snapshot", "edit sin adds: vuelve a la foto, que no pide añadir");
    eq(plan.edits.map((e) => [e.itemId, e.quantity, e.unitPrice]), [[10, 3, "22.64"]], "reedita a 3×22,64");
    eq(plan.removes, [], "sin removes");
  }
}

// ── cambios AJENOS: no se pisan ───────────────────────────────────────────────────
{
  const snapshot = [line(1, SL90, 1, "67.93", 3)];
  const desired = [target(SL30, 1, 2835)];

  // Soporte la pasa a un PACK4 desde el admin de Seal (la 15050531, 7-sep).
  const support = [line(77, PACK4_4L, 1, "85.05", 4)];
  eq(classifyLineState(support, snapshot, desired).kind, "foreign", "un PACK4 que no pedía nadie = ajeno");

  // Alguien quita la línea que el objetivo conservaba.
  const keep = [line(1, SL30, 3, "22.64", 3), line(2, W30, 1, "28.35")];
  const keepTarget = [target(SL30, 2, 2264), target(W30, 1, 2265)];
  eq(classifyLineState([line(2, W30, 1, "28.35")], keep, keepTarget).kind, "foreign", "falta una línea que el objetivo conservaba");

  // Una línea nueva con una variante que ya estaba en la foto no es un add nuestro.
  const dup = [snapshot[0], line(3, SL90, 1, "67.93", 3)];
  eq(classifyLineState(dup, snapshot, desired).kind, "foreign", "duplicado de una variante de la foto = ajeno");

  // Edición de cantidad que no es ni la foto ni el objetivo.
  eq(classifyLineState([line(1, SL90, 2, "67.93", 6)], snapshot, desired).kind, "foreign", "cantidad que nadie pidió = ajeno");

  ok(planLineRepair(support, snapshot, desired).kind === "foreign", "planLineRepair no converge sobre lo ajeno");
}

// ── snapshotAsTargets conserva cantidad y precio ──────────────────────────────────
{
  const t = snapshotAsTargets([line(1, SL90, 2, "67.93", 6)]);
  eq([t[0].variantId, t[0].quantity, t[0].unitPriceCents, t[0].boxes], [SL90, 2, 6793, 6], "foto como objetivo");
}

console.log(`\n${"=".repeat(60)}`);
if (failures.length) {
  console.log(`FALLOS (${failures.length}) de ${passed + failures.length} aserciones:\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OK — ${passed} aserciones pasan`);

/**
 * Tests de lo que se añadió el 14-oct-2026 tras el incidente del cambio de plan (sub
 * 12635109): un Pack de 4 se quedó junto a las 3 cajas sueltas que lo sustituían, y el
 * próximo envío se adelantó un mes. Sin framework (el repo no tiene ninguno).
 *
 *   npx tsx scripts/test-plan-change-safety.ts
 *
 * Los casos son los que se MIDIERON contra Seal en la sub de prueba 16923672:
 *   - Seal contesta 503 con `success: false` cuando se niega ("You can't remove all items
 *     from the subscription.", "Could not edit the subscription."): eso es un NO seguro.
 *   - Tras un cambio de intervalo, lo añadido tarda de 5 a 17 s en verse y una escritura
 *     que llega con la sub ocupada puede perderse aunque Seal diga 200: hay que saber
 *     cuándo la sub está "ocupada".
 *   - Una reparación que encuentra la sub como antes (el add se perdió) debe COMPLETAR el
 *     cambio añadiendo, si tiene los datos de alta, en vez de cerrarlo como "no entró nada".
 */

import { reanchorConverged, REANCHOR_SETTLE_MS } from "@/lib/frequency-core";
import { extendRequestDeadline, requestDeadlineLeft, runWithRequestDeadline } from "@/lib/http-timeout";
import {
  isRemoveAllItemsRejection,
  planLineRepair,
  sealBusyReason,
  sealWriteDefinitelyRejected,
} from "@/lib/line-repair";
import type { SubscriptionLine, TargetLine } from "@/lib/mix";
import { lineAnomaly } from "@/lib/renewal-reminder";
import { SealApiError, type SealSubscription } from "@/lib/seal";

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

// ── 503 de Seal: rechazo seguro o "no sé" ─────────────────────────────────────────
{
  const removeAll = new SealApiError(503, '{"success":false,"payload":[],"error":"You can\'t remove all items from the subscription."}');
  const couldNotEdit = new SealApiError(503, '{"success":false,"payload":[],"error":"Could not edit the subscription."}');
  const html = new SealApiError(503, "<html><body>Service Unavailable</body></html>");
  const empty = new SealApiError(502, "");
  ok(sealWriteDefinitelyRejected(removeAll), "503 con success:false = Seal dijo que no (no se aplicó)");
  ok(sealWriteDefinitelyRejected(couldNotEdit), "503 'Could not edit' = rechazo seguro");
  ok(!sealWriteDefinitelyRejected(html), "503 con HTML de un borde = no sé");
  ok(!sealWriteDefinitelyRejected(empty), "502 sin cuerpo = no sé");
  ok(sealWriteDefinitelyRejected(new SealApiError(200, "Seal remove_items rejected: x")), "200 con success:false sigue siendo rechazo");
  ok(isRemoveAllItemsRejection(removeAll), "reconoce 'You can't remove all items'");
  ok(!isRemoveAllItemsRejection(couldNotEdit), "'Could not edit' no es el de 'todavía no ve lo añadido'");
  ok(!isRemoveAllItemsRejection(new Error("You can't remove all items")), "solo errores de Seal");
  eq(removeAll.sealRejection(), "You can't remove all items from the subscription.", "sealRejection saca el texto de Seal");
  eq(html.sealRejection(), null, "sealRejection null si el cuerpo no es de Seal");
}

// ── ¿Seal ocupado con esta sub? ───────────────────────────────────────────────────
{
  const now = Date.parse("2026-10-14T13:20:00Z");
  const fmt = (msAgo: number) => new Date(now - msAgo).toISOString().replace("T", " ").slice(0, 19);
  const pending = [{ id: 1, date: "2027-01-20T13:00:00+00:00", status: "", skipped_on: "", completed_at: "" }];
  const sub = (over: Partial<SealSubscription>): SealSubscription =>
    ({ id: 1, status: "ACTIVE", billing_attempts: pending, log: [], items: [], ...over }) as unknown as SealSubscription;

  ok(sealBusyReason(sub({ log: [{ content: "Merchant added item \"X\" through the API.", created: fmt(30_000) }] }), now) !== null,
    "escritura hace 30 s = ocupado");
  eq(sealBusyReason(sub({ log: [{ content: "Merchant added item \"X\" through the API.", created: fmt(90_000) }] }), now), null,
    "escritura hace 90 s y calendario presente = en reposo");
  ok(
    sealBusyReason(
      sub({
        billing_attempts: [],
        log: [{ content: "Merchant changed the interval from 5 month(s) to 4 month(s) through the API.", created: fmt(5 * 60_000) }],
      }),
      now,
    ) !== null,
    "sin cobros pendientes 5 min después de cambiar el intervalo = calendario regenerándose",
  );
  eq(
    sealBusyReason(
      sub({
        billing_attempts: [],
        log: [{ content: "Merchant changed the interval from 5 month(s) to 4 month(s) through the API.", created: fmt(20 * 60_000) }],
      }),
      now,
    ),
    null,
    "sin cobros pero el cambio de intervalo fue hace 20 min: no se bloquea para siempre",
  );
  eq(
    sealBusyReason(
      sub({
        status: "PAUSED",
        billing_attempts: [],
        log: [{ content: "Merchant changed the interval from 5 month(s) to 4 month(s) through the API.", created: fmt(5 * 60_000) }],
      }),
      now,
    ),
    null,
    "una pausada no tiene cobros y no por eso está regenerando",
  );
  eq(sealBusyReason(sub({ log: undefined }), now), null, "sin log (listado) no se inventa nada");
}

// ── La reparación completa el cambio añadiendo ────────────────────────────────────
{
  const PACK = "65753051136349";
  const SL30 = "63887092154717";
  const W30 = "65046727459165";
  const P30 = "65046790537565";
  const line = (itemId: number, variantId: string, unitPrice: string, boxes = 1): SubscriptionLine => ({
    itemId,
    productId: "p",
    variantId,
    flavor: "salty-lemon",
    boxes,
    quantity: 1,
    unitPrice,
    sellingPlanId: "sp",
  });
  const t = (variantId: string, withAdd: boolean): TargetLine => ({
    productId: "p",
    variantId,
    flavor: "salty-lemon",
    quantity: 1,
    unitPriceCents: 2835,
    boxes: 1,
    sku: "SL30",
    ...(withAdd ? { sealAdd: { title: "LIT Daily Hydration", sku: "SL30", taxable: true, requiresShipping: true } } : {}),
  });
  const snapshot = [line(100, PACK, "85.05", 4)];
  const desiredWithAdd = [t(SL30, true), t(W30, true), t(P30, true)];
  const desiredOld = [t(SL30, false), t(W30, false), t(P30, false)];

  // Seal perdió el add: lo vivo es la foto.
  const lost = planLineRepair(snapshot, snapshot, desiredWithAdd, { allowAdds: true });
  ok(lost.kind === "converge" && lost.towards === "target", "add perdido + datos de alta = completar hacia el objetivo");
  if (lost.kind === "converge") {
    eq(lost.adds?.map((a) => a.variantId), [SL30, W30, P30], "vuelve a añadir las 3 sueltas");
    eq(lost.removes, [100], "y quita el Pack (después, cuando se vean)");
  }
  eq(planLineRepair(snapshot, snapshot, desiredOld, { allowAdds: true }).kind, "nothing_to_do",
    "intención vieja sin datos de alta: como antes, no se añade nada");
  eq(planLineRepair(snapshot, snapshot, desiredWithAdd, { allowAdds: false }).kind, "nothing_to_do",
    "sin permiso (el after() de la ruta) tampoco se añade: un add lento no es uno perdido");

  // Se ve una de las tres: faltan dos y sobra el Pack.
  const half = planLineRepair([line(100, PACK, "85.05", 4), line(201, SL30, "28.35")], snapshot, desiredWithAdd, { allowAdds: true });
  ok(half.kind === "converge", "a medias con datos = converge");
  if (half.kind === "converge") {
    eq(half.adds?.map((a) => a.variantId), [W30, P30], "solo añade las que faltan");
    eq(half.removes, [100], "y quita el Pack");
  }

  // Un cambio de SOLO ediciones que Seal perdió (la sub sigue como la foto): se completa
  // editando, no se cierra como "no entró nada".
  {
    const snap2 = [line(300, SL30, "28.35")];
    const wantTwo: TargetLine[] = [{ ...t(SL30, false), quantity: 2, boxes: 2 }];
    const editOnly = planLineRepair(snap2, snap2, wantTwo, { allowAdds: true });
    ok(editOnly.kind === "converge" && editOnly.towards === "target", "solo edits perdidos + completar = converge hacia el objetivo");
    if (editOnly.kind === "converge") {
      eq(editOnly.edits.map((e) => [e.itemId, e.quantity]), [[300, 2]], "edita la línea a 2");
      ok(!editOnly.adds?.length && !editOnly.removes.length, "sin añadir ni quitar");
    }
    eq(planLineRepair(snap2, snap2, wantTwo).kind, "nothing_to_do", "sin completar (comportamiento anterior): se cierra como la foto");
  }

  // El estado del incidente del 14-oct: Pack + las 3 sueltas. Solo hay que quitar.
  const incident = planLineRepair(
    [line(100, PACK, "85.05", 4), line(201, SL30, "28.35"), line(202, W30, "28.35"), line(203, P30, "28.35")],
    snapshot,
    desiredWithAdd,
    { allowAdds: true },
  );
  ok(incident.kind === "converge" && !(incident.adds?.length), "Pack + 3 sueltas: sin añadir nada");
  if (incident.kind === "converge") eq(incident.removes, [100], "quita solo el Pack");
}

// ── El re-anclaje no se da por bueno sobre una lectura atrasada ───────────────────
{
  const now = Date.parse("2026-10-14T13:20:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  ok(reanchorConverged("2027-02-01", "2027-01-20", ago(10_000), now), "primer cobro POSTERIOR = convergido");
  ok(!reanchorConverged("2026-12-20", "2027-01-20", ago(60 * 60_000), now), "primer cobro ANTERIOR = no");
  ok(!reanchorConverged("2027-01-20", "2027-01-20", ago(60_000), now),
    "igualdad exacta con la intención recién armada = puede ser el calendario viejo: no");
  ok(reanchorConverged("2027-01-20", "2027-01-20", ago(REANCHOR_SETTLE_MS + 1_000), now),
    "igualdad exacta pasados unos minutos = convergido");
  ok(!reanchorConverged("2027-01-20", "2027-01-20", null, now), "sin fecha de la intención no se borra a ciegas");
}

// ── Censo diario: firmas de líneas que no cuadran (casos reales del censo del 14-oct) ──
{
  const item = (id: number, variant_id: string, quantity: number, price: string, title: string) => ({
    id,
    variant_id,
    product_id: "p",
    quantity,
    price,
    title,
    is_one_time_item: 0,
  });
  const active = (items: ReturnType<typeof item>[]) =>
    ({
      id: 1,
      internal_id: 1,
      status: "ACTIVE",
      delivery_interval: "6 month",
      items,
      billing_attempts: [{ id: 9, date: "2027-01-28T10:00:00+00:00", status: "", skipped_on: "", completed_at: "" }],
    }) as unknown as SealSubscription;
  const SL90 = "63887092220253";
  const W90 = "65046727524701";
  const SL30 = "63887092154717";
  const W30 = "65046727459165";
  const P30 = "65046790537565";
  const PACK_4L = "65636234625373";
  const PACK_1L1W2P = "65753051136349";

  ok(lineAnomaly(active([item(1, SL90, 1, "67.93", "LIT Daily Hydration: Salty Lemon - 90"), item(2, SL30, 1, "28.35", "LIT Daily Hydration: Salty Lemon - 30")]))
    !== null, "#1558: SL90 vieja + SL30 nueva = cambio a medias");
  eq(lineAnomaly(active([item(1, W90, 1, "67.93", "W - 90"), item(2, SL90, 1, "67.93", "SL - 90")])), null,
    "#3711: dos líneas del modelo viejo (6 cajas a 135,86) es un contrato legítimo");
  eq(lineAnomaly(active([item(1, PACK_4L, 1, "85.05", "Pack"), item(2, SL30, 2, "28.35", "SL30")])), null,
    "#3527: Pack de 4 + 2 sueltas = 6 cajas, el tramo de 6 de la escalera");
  ok(
    lineAnomaly(active([
      item(1, PACK_1L1W2P, 1, "85.05", "Pack"),
      item(2, SL30, 1, "28.35", "SL30"),
      item(3, W30, 1, "28.35", "W30"),
      item(4, P30, 1, "28.35", "P30"),
    ])) !== null,
    "14-oct: Pack de 4 + 3 sueltas = 7 cajas",
  );
  ok(lineAnomaly(active([item(1, SL30, 1, "28.35", "a"), item(2, SL30, 1, "28.35", "b")])) !== null, "la misma variante en dos líneas");
  eq(lineAnomaly(active([item(1, SL90, 4, "67.93", "SL90 x4")])), null, "una sola línea de 12 cajas: contrato viejo de verdad, no se avisa");
  eq(
    lineAnomaly({ ...active([item(1, SL90, 1, "67.93", "a"), item(2, SL30, 1, "28.35", "b")]), status: "CANCELLED" } as SealSubscription),
    null,
    "una cancelada no se cobra: no entra en el censo",
  );
}

// ── El deadline se amplía al comprometerse, nunca se acorta ───────────────────────
async function deadlineChecks() {
  ok(extendRequestDeadline(5_000) === false, "fuera de una petición no hay nada que ampliar");
  await runWithRequestDeadline(1_000, async () => {
    ok((requestDeadlineLeft() ?? 0) <= 1_000, "arranca con 1 s");
    extendRequestDeadline(5_000);
    const left = requestDeadlineLeft() ?? 0;
    ok(left > 4_000 && left <= 5_000, `ampliado a ~5 s (quedan ${left} ms)`);
    extendRequestDeadline(100);
    ok((requestDeadlineLeft() ?? 0) > 4_000, "ampliar a menos NO lo acorta");
    // Lo que se lanza después (otra llamada de la misma petición) ve el deadline ampliado.
    await new Promise((r) => setTimeout(r, 10));
    ok((requestDeadlineLeft() ?? 0) > 4_000, "las llamadas siguientes de la petición lo heredan");
  });
}

deadlineChecks().then(() => {
  console.log(`\n${"=".repeat(60)}`);
  if (failures.length) {
    console.log(`FALLOS (${failures.length}) de ${passed + failures.length} aserciones:\n`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`OK — ${passed} aserciones pasan`);
});

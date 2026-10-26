/**
 * Tests del cambio de sabor del bot de WhatsApp (LIT-625): `src/lib/flavor-core.ts` y las
 * guardas de código de `api/internal/subscription/flavor/route.ts`. Sin framework, como el
 * resto de scripts de test del repo.
 *
 *   npm test
 *   npx tsx scripts/test-flavor-core.ts
 *
 * Los fixtures son SIETE suscripciones ACTIVAS reales de Seal (26-oct-2026), solo sus
 * líneas, sin datos personales: una caja de cada sabor, la trimestral retirada a 67,93,
 * un PACK4 de un sabor, un PACK4 mezclado y una mezcla en tres líneas con el precio
 * conservado (22,65 + 22,64 + 22,64). Se leen con `getComposition`, el mismo código que la
 * ruta, para que una suposición equivocada sobre la forma de Seal no pase en verde.
 *
 * Qué protege:
 *   - el bot solo cambia SABORES: una mezcla que no suma las cajas de hoy, o que pide más
 *     sabores que cajas, se rechaza antes de llegar al núcleo;
 *   - sobre una mezcla (también dentro de un PACK4) «todo de X» viaja como `mix`, nunca
 *     como `flavor`, que el núcleo rechaza en una mezcla;
 *   - con las mismas cajas el importe se conserva (la SL90 a 67,93 sigue a 67,93);
 *   - después de escribir no hay «hecho» sin ver en Seal lo pedido al mismo importe: la
 *     escritura a medias (línea vieja y nueva a la vez) y un reprecio se detectan;
 *   - la ruta no escribe en Seal por su cuenta: todo pasa por `changePlan`.
 */

import { readFileSync } from "node:fs";

import { ApiHttpError } from "@/lib/api-helpers";
import { checkFlavorWrite, flavorOptions, resolveFlavorTarget } from "@/lib/flavor-core";
import { type FlavorComposition, type LadderPrices, planPreservingCharge, planTargetLines } from "@/lib/mix";
import { getChargeTotalCents, getComposition, type SealSubscription } from "@/lib/seal";
import { FLAVOR_KEYS, type FlavorKey } from "@/lib/seal-plans";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ApiHttpError ? `${e.code}${e.code === "invalid_mix" ? `:${e.message}` : ""}` : `throw:${String(e)}`;
  }
}

const L: FlavorKey = "salty-lemon";
const W: FlavorKey = "salty-watermelon";
const P: FlavorKey = "salty-peach";
const LADDER: LadderPrices = { oneBoxCents: 2835, pack4Cents: 8505 };

const show = (c: FlavorComposition[]) => c.map((x) => `${x.boxes}${x.flavor.split("-")[1][0].toUpperCase()}`).join("+");
const sub = (raw: unknown) => raw as SealSubscription;

// Siete suscripciones ACTIVAS reales (lit_dashboard.subscriptions.raw_payload, 26-oct-2026):
// solo id, estado, intervalo y líneas.
const FX = {
  SL30_SOLA: {"id": 17185867, "status": "ACTIVE", "delivery_interval": "45 day", "items": [{"id": 34279687, "variant_id": "63887092154717", "product_id": "16008517550429", "quantity": 1, "price": "28.35", "title": "LIT Daily Hydration: Salty Lemon - 30", "variant_sku": "SL30", "is_one_time_item": 0, "selling_plan_id": "691259867485"}]},
  W30_SOLA: {"id": 17086667, "status": "ACTIVE", "delivery_interval": "45 day", "items": [{"id": 34107476, "variant_id": "65046727459165", "product_id": "16272445112669", "quantity": 1, "price": "28.35", "title": "LIT Daily Hydration: Watermelon - 30", "variant_sku": "W30", "is_one_time_item": 0, "selling_plan_id": "691259867485"}]},
  P30_SOLA: {"id": 17173987, "status": "ACTIVE", "delivery_interval": "45 day", "items": [{"id": 34256565, "variant_id": "65046790537565", "product_id": "16272456188253", "quantity": 1, "price": "28.35", "title": "LIT Daily Hydration: Peach - 30", "variant_sku": "P30", "is_one_time_item": 0, "selling_plan_id": "691259867485"}]},
  SL90_LEGACY: {"id": 15153904, "status": "ACTIVE", "delivery_interval": "3 month", "items": [{"id": 30884275, "variant_id": "63887092220253", "product_id": "16008517550429", "quantity": 1, "price": "67.93", "title": "LIT Daily Hydration: Salty Lemon - 90", "variant_sku": "SL90", "is_one_time_item": 0, "selling_plan_id": "691259933021"}]},
  PACK4_4L: {"id": 17187823, "status": "ACTIVE", "delivery_interval": "6 month", "items": [{"id": 34282846, "variant_id": "65636234625373", "product_id": "16386839445853", "quantity": 1, "price": "85.05", "title": "LIT Hydration Pack: 4 Cajas - 4 Salty Lemon", "variant_sku": "PACK4-4L", "is_one_time_item": 0, "selling_plan_id": "691260031325"}]},
  PACK4_2L1W1P: {"id": 17170787, "status": "ACTIVE", "delivery_interval": "6 month", "items": [{"id": 34251662, "variant_id": "65753050677597", "product_id": "16386839445853", "quantity": 1, "price": "85.05", "title": "LIT Hydration Pack: 4 Cajas - 2 Salty Lemon + 1 Watermelon + 1 Peach", "variant_sku": "PACK4-2L1W1P", "is_one_time_item": 0, "selling_plan_id": "691260031325"}]},
  MEZCLA_3_LINEAS: {"id": 14497411, "status": "ACTIVE", "delivery_interval": "3 month", "items": [{"id": 32422603, "variant_id": "63887092154717", "product_id": "16008517550429", "quantity": 1, "price": "22.65", "title": "LIT Daily Hydration: Salty Lemon - 30", "variant_sku": "SL30", "is_one_time_item": 0, "selling_plan_id": "691259933021"}, {"id": 32422604, "variant_id": "65046727459165", "product_id": "16272445112669", "quantity": 1, "price": "22.64", "title": "LIT Daily Hydration: Watermelon - 30", "variant_sku": "W30", "is_one_time_item": 0, "selling_plan_id": "691259933021"}, {"id": 32422605, "variant_id": "65046790537565", "product_id": "16272456188253", "quantity": 1, "price": "22.64", "title": "LIT Daily Hydration: Peach - 30", "variant_sku": "P30", "is_one_time_item": 0, "selling_plan_id": "691259933021"}]},
};

console.log("\n── lectura de las suscripciones reales ──\n");
{
  const cases: Array<[keyof typeof FX, string]> = [
    ["SL30_SOLA", "1L"],
    ["W30_SOLA", "1W"],
    ["P30_SOLA", "1P"],
    ["SL90_LEGACY", "3L"],
    ["PACK4_4L", "4L"],
    ["PACK4_2L1W1P", "2L+1W+1P"],
    ["MEZCLA_3_LINEAS", "1L+1W+1P"],
  ];
  for (const [k, want] of cases) {
    const got = show(getComposition(sub(FX[k])));
    check(`${k} se lee como ${want}`, got === want, got);
  }
}

console.log("\n── qué composición pide el bot ──\n");
{
  const sl30 = getComposition(sub(FX.SL30_SOLA));
  const r = resolveFlavorTarget(sl30, { flavor: P });
  check("1 caja de limón → melocotón: 1P, como `flavor`", show(r.target) === "1P" && r.changed && "flavor" in r.intent && r.intent.flavor === P);
  check("1 caja de limón → limón: nada que escribir", resolveFlavorTarget(sl30, { flavor: L }).changed === false);
  check(
    "1 caja no se mezcla",
    codeOf(() => resolveFlavorTarget(sl30, { mix: [{ flavor: L, boxes: 1 }, { flavor: W, boxes: 1 }] })) === "mix_needs_more_boxes",
  );
  check("un sabor que no existe se rechaza", codeOf(() => resolveFlavorTarget(sl30, { flavor: "salty-orange" })) === "invalid_flavor");
  check("sin sabor ni mezcla no hay cambio", codeOf(() => resolveFlavorTarget(sl30, { flavor: "" })) === "no_changes");
  check(
    "sabor y mezcla a la vez se rechaza",
    codeOf(() => resolveFlavorTarget(sl30, { flavor: P, mix: [{ flavor: P, boxes: 1 }] })) === "conflicting_flavor_intent",
  );

  const sl90 = getComposition(sub(FX.SL90_LEGACY));
  const w = resolveFlavorTarget(sl90, { flavor: W });
  check("SL90 → sandía: 3W, como `flavor`", show(w.target) === "3W" && "flavor" in w.intent);
  const m = resolveFlavorTarget(sl90, { mix: [{ flavor: W, boxes: 1 }, { flavor: L, boxes: 2 }] });
  check("SL90 → 2 limón + 1 sandía: como `mix`, ordenada", show(m.target) === "2L+1W" && "mix" in m.intent);
  check(
    "SL90: una mezcla de 2 cajas cambiaría las cajas",
    codeOf(() => resolveFlavorTarget(sl90, { mix: [{ flavor: L, boxes: 1 }, { flavor: W, boxes: 1 }] })) === "box_count_change_not_allowed",
  );
  check(
    "SL90: una mezcla de 4 cajas cambiaría las cajas",
    codeOf(() => resolveFlavorTarget(sl90, { mix: [{ flavor: L, boxes: 2 }, { flavor: W, boxes: 2 }] })) === "box_count_change_not_allowed",
  );
  check(
    "una mezcla con un sabor que no existe se rechaza con su código",
    codeOf(() => resolveFlavorTarget(sl90, { mix: [{ flavor: "salty-orange", boxes: 3 }] })) === "invalid_mix:mix_invalid_flavor",
  );
  check(
    "los ceros de una mezcla no cuentan (3L y 0W es «todo limón»)",
    resolveFlavorTarget(sl90, { mix: [{ flavor: L, boxes: 3 }, { flavor: W, boxes: 0 }] }).changed === false,
  );

  const pack = getComposition(sub(FX.PACK4_4L));
  const pw = resolveFlavorTarget(pack, { flavor: W });
  check("PACK4 de limón → sandía: 4W, como `flavor`", show(pw.target) === "4W" && "flavor" in pw.intent);

  const packMix = getComposition(sub(FX.PACK4_2L1W1P));
  const pm = resolveFlavorTarget(packMix, { flavor: W });
  check(
    "PACK4 mezclado → todo sandía: viaja como `mix` (el núcleo rechaza `flavor` en una mezcla)",
    show(pm.target) === "4W" && "mix" in pm.intent,
  );

  const split = getComposition(sub(FX.MEZCLA_3_LINEAS));
  const sp = resolveFlavorTarget(split, { flavor: P });
  check("mezcla de 3 líneas → todo melocotón: 3P como `mix`", show(sp.target) === "3P" && "mix" in sp.intent);
  check(
    "mezcla de 3 líneas → la misma mezcla: nada que escribir",
    resolveFlavorTarget(split, { mix: [{ flavor: P, boxes: 1 }, { flavor: W, boxes: 1 }, { flavor: L, boxes: 1 }] }).changed === false,
  );

  // La SL90×4 de 12 cajas (13007758) no está entre los fixtures: es la SL90 real con
  // quantity 4, que es su forma.
  const doce = getComposition(sub({ ...FX.SL90_LEGACY, items: FX.SL90_LEGACY.items.map((it) => ({ ...it, quantity: 4 })) }));
  check("más de 6 cajas no pasa por el bot", codeOf(() => resolveFlavorTarget(doce, { flavor: W })) === "box_count_out_of_range", show(doce));
  check("sin composición legible no se adivina", codeOf(() => resolveFlavorTarget([], { flavor: W })) === "box_count_unknown");
}

console.log("\n── el precio no cambia con las mismas cajas ──\n");
{
  const live = getChargeTotalCents(sub(FX.SL90_LEGACY));
  check("la SL90 legacy paga 67,93", live === 6793, String(live));
  // Un solo sabor son 3 cajas en UNA línea de cantidad 3, y 67,93 no se reparte en tres
  // precios iguales: el núcleo escribe 22,64 × 3 = 67,92. Un céntimo MENOS, nunca más. Es lo
  // que hace FlavorOverlay desde el 24-ago y lo que la ruta acepta (y declara).
  const toW = planPreservingCharge([{ flavor: W, boxes: 3 }], LADDER, live);
  check("SL90 → 3W: 67,92, un céntimo menos y nunca más", toW?.totalCents === 6792, String(toW?.totalCents));
  const toMix = planPreservingCharge([{ flavor: L, boxes: 2 }, { flavor: W, boxes: 1 }], LADDER, live);
  check("SL90 → 2L+1W conserva 67,93", toMix?.totalCents === 6793, String(toMix?.totalCents));
  const packLive = getChargeTotalCents(sub(FX.PACK4_2L1W1P));
  check(
    "PACK4 mezclado → 4W: el catálogo ya es su importe (85,05)",
    planTargetLines([{ flavor: W, boxes: 4 }], LADDER).totalCents === packLive,
    String(packLive),
  );
}

console.log("\n── no hay «hecho» sin verlo en Seal ──\n");
{
  const before = getChargeTotalCents(sub(FX.SL30_SOLA));
  const afterGood = sub(FX.P30_SOLA);
  check(
    "limón → melocotón bien aplicado: ok",
    checkFlavorWrite({ composition: getComposition(afterGood), chargeCents: getChargeTotalCents(afterGood) }, [{ flavor: P, boxes: 1 }], before) === "ok",
  );
  const halfWrite = sub({ ...FX.SL30_SOLA, items: [...FX.SL30_SOLA.items, ...FX.P30_SOLA.items] });
  check(
    "escritura a medias (la línea vieja y la nueva): composition_mismatch",
    checkFlavorWrite({ composition: getComposition(halfWrite), chargeCents: getChargeTotalCents(halfWrite) }, [{ flavor: P, boxes: 1 }], before) === "composition_mismatch",
    show(getComposition(halfWrite)),
  );
  const repriced = sub({ ...FX.P30_SOLA, items: FX.P30_SOLA.items.map((it) => ({ ...it, price: "37.80" })) });
  check(
    "un céntimo menos, si es lo que se escribió: ok",
    checkFlavorWrite({ composition: [{ flavor: W, boxes: 3 }], chargeCents: 6792 }, [{ flavor: W, boxes: 3 }], 6792) === "ok",
  );
  check(
    "el sabor bien pero a otro importe: charge_changed",
    checkFlavorWrite({ composition: getComposition(repriced), chargeCents: getChargeTotalCents(repriced) }, [{ flavor: P, boxes: 1 }], before) === "charge_changed",
  );
}

console.log("\n── sabores que se pueden pedir ──\n");
{
  const opts = flavorOptions();
  check("los del registro, en su orden", opts.map((o) => o.flavor).join() === FLAVOR_KEYS.join(), opts.map((o) => o.flavor).join());
  check("todos con nombre", opts.every((o) => o.label.trim().length > 0));
}

console.log("\n── guardas de código de la ruta ──\n");
{
  const route = readFileSync("src/app/api/internal/subscription/flavor/route.ts", "utf8");
  const plan = readFileSync("src/app/api/subscription/plan/route.ts", "utf8");
  const authAt = route.indexOf("requireCron(req)");
  check("el secreto se mira antes que nada", authAt > 0 && authAt < route.indexOf("handle(req, attempt)"));
  check(
    "la simulación la decide la puerta, no la lista del área personal",
    !route.includes("isDryRunRequest") && route.includes('{ dryRun: body.dryRun === true, eventSource: "whatsapp_bot" }'),
  );
  check("una escritura no nace de olvidar `dryRun`", /asksChange && typeof body\.dryRun !== "boolean"/.test(route));
  const onlyFlavor = /if \(body\.boxCount !== undefined \|\| body\.frequency !== undefined\) \{\s*throw new ApiHttpError\(400, "only_flavor"/.exec(route);
  check(
    "`boxCount` y `frequency` se rechazan antes de leer Seal",
    !!onlyFlavor && onlyFlavor.index < route.indexOf("seal.getSubscriptionById(subId, undefined, { throwTransient: true })"),
  );
  const writeAt = route.indexOf("await changePlan(");
  const verifyAt = route.indexOf("checkFlavorWrite(", writeAt);
  const unverifiedAt = route.indexOf('"flavor_unverified"', verifyAt);
  const doneAt = route.indexOf("verified: true", unverifiedAt);
  check("después de escribir se relee y sin verlo no hay «hecho»", writeAt > 0 && verifyAt > writeAt && unverifiedAt > verifyAt && doneAt > unverifiedAt);
  check(
    "la propuesta rechaza solo una SUBIDA del importe",
    /if \(projectedCents > chargeCents\) \{/.test(route) && !/projectedCents !== chargeCents/.test(route),
  );
  const unverAt = route.indexOf('"flavor_unverified"');
  const incAt = route.indexOf('"charge_increased"');
  check("la escritura más cara nunca sale como «hecho»", incAt > unverAt && incAt < route.indexOf("verified: true"));
  check(
    "la ruta no escribe en Seal por su cuenta: todo por changePlan",
    !/seal\.(addItems|removeItems|editItems|editSubscription|updateSubscription|skip\w*)\(/.test(route),
  );
  check("el área personal sigue simulando por isDryRunRequest", plan.includes("{ dryRun: isDryRunRequest(req, body, ctx.customerId) }"));
}

if (failures) {
  console.error(`\n${failures} fallo(s)`);
  process.exit(1);
}
console.log("\nOK — test-flavor-core");

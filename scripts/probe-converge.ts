/**
 * Prueba E2E del camino de escritura de la Fase 2 contra Seal real, usando el CÓDIGO
 * DE PRODUCCIÓN (importa src/lib/mix.ts y src/lib/seal.ts, no una copia).
 *
 * Lo que demuestra:
 *   1. planTargetLines + diffLines producen las llamadas correctas para cada
 *      transición (puro→mezcla, mezcla→mezcla, mezcla→puro, cambio de cajas).
 *   2. Que cambiar el reparto sin cambiar el total usa SOLO edit_items, sin tocar
 *      add/remove y sin que cambien los ids de item.
 *   3. IDEMPOTENCIA: aplicar dos veces converge una sola vez. Es la propiedad que
 *      mata el bug que cobró de más a 7 suscripciones (add sin remove + reintento).
 *
 * Uso (sobre la sub de PRUEBAS, nunca una real):
 *   npx tsx scripts/probe-converge.ts 2L+1W              # seco
 *   npx tsx scripts/probe-converge.ts 2L+1W --apply
 *   npx tsx scripts/probe-converge.ts 2L+1W --apply --twice   # prueba de idempotencia
 *
 * Env: SEAL_API_TOKEN
 */

import {
  chargeTotalCents,
  compositionLabel,
  diffLines,
  type FlavorComposition,
  mixBoxCount,
  planTargetLines,
} from "../src/lib/mix";
import { getChargeTotalCents, getLines, seal } from "../src/lib/seal";
import { type FlavorKey } from "../src/lib/seal-plans";

if (!process.env.SEAL_API_TOKEN) throw new Error("SEAL_API_TOKEN required");

const SUB_ID = Number(process.env.PROBE_SUB_ID ?? 14692586);
const FORBIDDEN = new Set([12635109]);
if (FORBIDDEN.has(SUB_ID)) {
  console.error(`REFUSED: ${SUB_ID} es una suscripción real`);
  process.exit(1);
}

/** Escalera web (céntimos). En producción sale de getLadderPrices (precios vivos de
 *  Shopify); aquí se fija para que la prueba sea sobre el diff, no sobre pricing.
 *  1-3 = n × 28,35 · 4 = pack 85,05 · 5-6 = pack + sueltas. */
const LADDER = { oneBoxCents: 2835, pack4Cents: 8505 };
const TIER: Record<number, number> = { 1: 2835, 2: 5670, 3: 8505, 4: 8505, 5: 11340, 6: 14175 };

const CODE_TO_FLAVOR: Record<string, FlavorKey> = { L: "salty-lemon", W: "salty-watermelon" };

/** "2L+1W" -> [{flavor:"salty-lemon",boxes:2},{flavor:"salty-watermelon",boxes:1}] */
function parseSpec(spec: string): FlavorComposition[] {
  return spec.split("+").map((part) => {
    const m = /^(\d+)([A-Z])$/.exec(part.trim());
    if (!m) throw new Error(`parte inválida "${part}" (formato: 2L+1W)`);
    const flavor = CODE_TO_FLAVOR[m[2]];
    if (!flavor) throw new Error(`código de sabor desconocido "${m[2]}"`);
    return { flavor, boxes: Number(m[1]) };
  });
}

const spec = process.argv[2];
const APPLY = process.argv.includes("--apply");
const TWICE = process.argv.includes("--twice");
if (!spec) {
  console.error("Uso: npx tsx scripts/probe-converge.ts <2L+1W> [--apply] [--twice]");
  process.exit(1);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const eur = (c: number) => `${(c / 100).toFixed(2)}€`;

async function readState() {
  const sub = await seal.getSubscriptionById(SUB_ID);
  if (!sub) throw new Error(`no se pudo leer la sub ${SUB_ID}`);
  return { sub, lines: getLines(sub) };
}

async function main() {
  const target = parseSpec(spec);
  const boxes = mixBoxCount(target);
  const tier = TIER[boxes];
  if (!tier) throw new Error(`sin tramo para ${boxes} cajas`);

  console.log(`objetivo: ${compositionLabel(target)}  (${boxes} cajas, tramo ${eur(tier)})`);

  const plan = planTargetLines(target, LADDER);
  console.log(`\nplan (${plan.shape}):`);
  for (const l of plan.lines) {
    console.log(`  ${l.sku} x${l.quantity} @${eur(l.unitPriceCents)}  = ${l.boxes} cajas`);
  }
  console.log(`  cobra ${eur(plan.totalCents)}  residuo ${plan.residualCents}c`);
  if (plan.totalCents > tier) throw new Error("EL PLAN COBRA DE MÁS: abortando");

  /** Una pasada de convergencia. Devuelve el diff que calculó. */
  async function converge(pass: number) {
    const { lines } = await readState();
    console.log(`\n${"─".repeat(66)}\npasada ${pass}: estado actual`);
    for (const l of lines) {
      console.log(`  item ${l.itemId}  ${l.variantId} x${l.quantity} @${l.unitPrice}  = ${l.boxes} cajas`);
    }
    console.log(`  cobra ${eur(chargeTotalCents(lines))}`);

    const diff = diffLines(lines, plan.lines);
    console.log(`  diff -> edits=${diff.edits.length} adds=${diff.adds.length} removes=${diff.removes.length} noop=${diff.noop}`);
    for (const e of diff.edits) console.log(`    EDIT item ${e.itemId} -> qty ${e.quantity} @${e.unitPrice}`);
    for (const a of diff.adds) console.log(`    ADD  ${a.sku} x${a.quantity} @${eur(a.unitPriceCents)}`);
    for (const r of diff.removes) console.log(`    REMOVE item ${r}`);

    if (diff.noop) {
      console.log(`  ya está en el objetivo, nada que hacer`);
      return diff;
    }
    if (!APPLY) {
      console.log(`  [SECO] sin --apply no se envía nada`);
      return diff;
    }

    // Mismo orden que la ruta: edits -> adds -> removes.
    if (diff.edits.length) {
      await seal.editItems(SUB_ID, diff.edits.map((e) => ({ itemId: e.itemId, quantity: e.quantity, price: e.unitPrice })));
      console.log(`  edit_items OK`);
      if (diff.adds.length || diff.removes.length) await sleep(500);
    }
    if (diff.adds.length) {
      // La ruta saca title/sku/taxable de Shopify; aquí se reusan los del registro.
      await seal.addItems(
        SUB_ID,
        diff.adds.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          title: `LIT Daily Hydration ${l.sku}`,
          sku: l.sku,
          taxable: false,
          requiresShipping: true,
          price: (l.unitPriceCents / 100).toFixed(2),
        })),
      );
      console.log(`  add_items OK`);
      if (diff.removes.length) await sleep(500);
    }
    if (diff.removes.length) {
      await seal.removeItems(SUB_ID, diff.removes);
      console.log(`  remove_items OK`);
    }
    await sleep(1500);
    return diff;
  }

  const before = await readState();
  const beforeAttempts = (before.sub.billing_attempts ?? []).map((b) => `${b.id}@${String(b.date).slice(0, 10)}`).join(" ");

  const d1 = await converge(1);
  if (TWICE && APPLY) await converge(2);

  if (!APPLY) return;

  // ── Verificación final ──
  const { sub: after, lines: afterLines } = await readState();
  const finalDiff = diffLines(afterLines, plan.lines);
  const afterAttempts = (after.billing_attempts ?? []).map((b) => `${b.id}@${String(b.date).slice(0, 10)}`).join(" ");
  const actualCents = getChargeTotalCents(after);

  console.log(`\n${"═".repeat(66)}\nVERIFICACIÓN`);
  const checks: Array<[boolean, string]> = [
    [finalDiff.noop, `converge al objetivo exacto (diff vacío)`],
    [afterLines.length === plan.lines.length, `${plan.lines.length} línea(s) recurrente(s), hay ${afterLines.length}`],
    [Math.abs(actualCents - plan.totalCents) <= 1, `cobra ${eur(actualCents)} == plan ${eur(plan.totalCents)}`],
    [actualCents <= tier, `nunca por encima del tramo (${eur(actualCents)} <= ${eur(tier)})`],
    [afterLines.every((l) => l.quantity >= 1), `ninguna línea con cantidad 0`],
    [beforeAttempts === afterAttempts, `billing_attempts intactos`],
  ];
  let bad = 0;
  for (const [ok, msg] of checks) {
    console.log(`  ${ok ? "OK   " : "FALLO"} ${msg}`);
    if (!ok) bad++;
  }

  // La propiedad clave: si el objetivo no cambiaba variantes, no debió haber add/remove.
  const variantsBefore = new Set(before.lines.map((l) => String(l.variantId)));
  const variantsTarget = new Set(plan.lines.map((l) => String(l.variantId)));
  const sameVariantSet =
    variantsBefore.size === variantsTarget.size && [...variantsTarget].every((v) => variantsBefore.has(v));
  if (sameVariantSet) {
    const editOnly = d1.adds.length === 0 && d1.removes.length === 0;
    console.log(`  ${editOnly ? "OK   " : "FALLO"} mismo conjunto de variantes -> SOLO edit_items (sin add/remove)`);
    if (!editOnly) bad++;
    const idsBefore = new Set(before.lines.map((l) => l.itemId));
    const idsKept = afterLines.every((l) => idsBefore.has(l.itemId));
    console.log(`  ${idsKept ? "OK   " : "FALLO"} los ids de item no cambiaron`);
    if (!idsKept) bad++;
  }

  console.log(`\n${bad ? `${bad} FALLO(S)` : "todo OK"}`);
  if (bad) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\nERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

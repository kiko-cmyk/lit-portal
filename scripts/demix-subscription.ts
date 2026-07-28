/**
 * Rollback de la mezcla de sabores: devuelve una suscripción `split` a `packed`.
 *
 * Apagar el flag (`MIX_FLAVORS=off`) impide mezclas NUEVAS pero deja intactas las
 * existentes, que es lo correcto: la lectura es agnóstica a la forma y `/plan` las
 * preserva. Este script es para el caso en que además se quiera deshacerlas.
 *
 * Convierte cada sub mezclada a una sola línea sobre la variante pack del sabor
 * MAYORITARIO, al precio de catálogo. Reutiliza el código de producción
 * (planTargetLines + diffLines), así que es la misma lógica ya verificada y es
 * idempotente: si la sub ya está `packed`, no hace nada.
 *
 * ⚠️ NO deshace las mezclas que el cliente compró EN EL CHECKOUT. Shopify permite meter
 * dos sabores en un mismo carrito, y hay 4 suscripciones así: convertirlas destruiría lo
 * que pidieron (la de 3 limón + 3 sandía pasaría a 6 de sandía). Solo se tocan las que
 * creó el PORTAL, identificadas por la tabla de auditoría `subscription_changes`
 * (`change_type = 'mix'`, `payload.source = 'portal'`).
 *
 * Uso:
 *   npx tsx scripts/demix-subscription.ts                    # lista y clasifica, no toca
 *   npx tsx scripts/demix-subscription.ts --apply            # solo las creadas por el portal
 *   npx tsx scripts/demix-subscription.ts --only 14692586 --apply   # una concreta, salta la clasificación
 *
 * Env: SEAL_API_TOKEN, SHOPIFY_ADMIN_TOKEN, SUPABASE_*
 */

import {
  chargeTotalCents,
  compositionLabel,
  diffLines,
  planTargetLines,
  type FlavorComposition,
} from "../src/lib/mix";
import { getChargeTotalCents, getLines, getNextBillingAttempt, seal } from "../src/lib/seal";
import { priceForBoxCount } from "../src/lib/pricing";
import { shopifyAdmin } from "../src/lib/shopify-admin";
import { supabaseAdmin } from "../src/lib/supabase";

if (!process.env.SEAL_API_TOKEN) throw new Error("SEAL_API_TOKEN required");

const APPLY = process.argv.includes("--apply");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx !== -1 ? Number(process.argv[onlyIdx + 1]) : null;

/** Nunca tocar una sub a menos de 48 h de su cobro: no merece la pena arriesgar una
 *  mutación a medias cuando el cargo está a punto de salir. */
const MIN_HOURS_TO_CHARGE = 48;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const eur = (c: number) => `${(c / 100).toFixed(2)}€`;

async function main() {
  console.log("Leyendo el libro de Seal…");
  const all = await seal.listAllSubscriptions();
  const mixed = all.filter((s) => {
    if (ONLY && s.id !== ONLY) return false;
    if (s.status !== "ACTIVE") return false;
    const lines = getLines(s);
    const flavors = new Set(lines.map((l) => l.flavor));
    return flavors.size > 1;
  });

  console.log(`${all.length} suscripciones, ${mixed.length} mezcladas y activas`);

  // ── Quién creó cada mezcla ──
  // Solo se deshacen las del PORTAL. Las que el cliente compró en el checkout no son
  // nuestras: deshacerlas le cambiaría los sabores que eligió (y en un caso el precio).
  const portalMade = new Set<string>();
  if (!ONLY) {
    const { data, error } = await supabaseAdmin()
      .from("subscription_changes")
      .select("payload")
      .eq("change_type", "mix");
    if (error) {
      console.error(`\nNo se pudo leer subscription_changes (${error.message}).`);
      console.error("Sin esa tabla no se puede distinguir una mezcla del portal de una del");
      console.error("checkout, así que se aborta. Usa --only <subId> para forzar una concreta.");
      process.exitCode = 1;
      return;
    }
    for (const row of data ?? []) {
      const p = row.payload as { sealSubscriptionId?: string; source?: string } | null;
      if (p?.sealSubscriptionId && p.source === "portal") portalMade.add(String(p.sealSubscriptionId));
    }
    console.log(`${portalMade.size} suscripción(es) con mezcla creada por el portal según la auditoría\n`);
  }
  if (!mixed.length) return;

  let converted = 0;
  let skipped = 0;
  let failed = 0;

  for (const s of mixed) {
    const lines = getLines(s);
    const boxes = lines.reduce((a, l) => a + l.boxes, 0);
    // Sabor mayoritario; empate → el de más cajas y, si siguen empatados, el primero.
    const byFlavor = new Map<string, number>();
    for (const l of lines) byFlavor.set(l.flavor, (byFlavor.get(l.flavor) ?? 0) + l.boxes);
    const dominant = [...byFlavor].sort((a, b) => b[1] - a[1])[0][0] as FlavorComposition["flavor"];
    const next = getNextBillingAttempt(s);

    console.log(`${"─".repeat(70)}`);
    const madeByPortal = ONLY !== null || portalMade.has(String(s.id));
    console.log(
      `sub ${s.id}  ${compositionLabel(lines.map((l) => ({ flavor: l.flavor, boxes: l.boxes })))}` +
        `  [${madeByPortal ? "creada por el PORTAL" : "comprada en el CHECKOUT"}]`,
    );
    console.log(`  ahora: ${lines.map((l) => `${l.variantId}x${l.quantity}@${l.unitPrice}`).join(" + ")} = ${eur(chargeTotalCents(lines))}`);
    console.log(`  proximo cobro: ${(next?.date ?? "-").slice(0, 10)}`);

    if (!madeByPortal) {
      console.log(`  SALTADA: el cliente eligió estos sabores en el checkout. Deshacerlo le`);
      console.log(`           cambiaría lo que compró. Usa --only ${s.id} si de verdad hace falta.`);
      skipped++;
      continue;
    }

    if (next) {
      const hours = (new Date(next.date).getTime() - Date.now()) / 36e5;
      if (hours < MIN_HOURS_TO_CHARGE) {
        console.log(`  SALTADA: el cobro es en ${hours.toFixed(0)}h (<${MIN_HOURS_TO_CHARGE}h)`);
        skipped++;
        continue;
      }
    }

    const target: FlavorComposition[] = [{ flavor: dominant, boxes }];
    const tier = Math.round((await priceForBoxCount(boxes, dominant)) * 100);
    const plan = planTargetLines(target, tier);
    const diff = diffLines(lines, plan.lines);

    console.log(`  -> ${plan.shape} ${plan.lines.map((l) => `${l.sku}x${l.quantity}@${eur(l.unitPriceCents)}`).join(" + ")} = ${eur(plan.totalCents)}`);
    console.log(`  diff: edits=${diff.edits.length} adds=${diff.adds.length} removes=${diff.removes.length}`);

    if (diff.noop) {
      console.log(`  ya estaba packed, nada que hacer`);
      skipped++;
      continue;
    }
    if (!APPLY) {
      console.log(`  [SECO] sin --apply no se envia nada`);
      continue;
    }

    try {
      if (diff.edits.length) {
        await seal.editItems(s.id, diff.edits.map((e) => ({ itemId: e.itemId, quantity: e.quantity, price: e.unitPrice })));
        await sleep(500);
      }
      if (diff.adds.length) {
        const details = await Promise.all(
          diff.adds.map(async (l) => {
            const d = await shopifyAdmin.getVariantForSealAddItems(l.variantId);
            if (!d) throw new Error(`Shopify no tiene la variante ${l.variantId}`);
            return { l, d };
          }),
        );
        await seal.addItems(
          s.id,
          details.map(({ l, d }) => ({
            productId: d.productId,
            variantId: d.variantId,
            quantity: l.quantity,
            title: d.title,
            sku: d.sku,
            taxable: d.taxable,
            requiresShipping: d.requiresShipping,
            price: (l.unitPriceCents / 100).toFixed(2),
          })),
        );
        await sleep(500);
      }
      if (diff.removes.length) await seal.removeItems(s.id, diff.removes);
      await sleep(1500);

      // Verificar releyendo, nunca fiándose de la respuesta de la mutación.
      const after = await seal.getSubscriptionById(s.id);
      const afterLines = after ? getLines(after) : [];
      const afterDiff = after ? diffLines(afterLines, plan.lines) : null;
      const money = after ? getChargeTotalCents(after) : -1;
      const okLines = !!afterDiff?.noop && afterLines.length === 1;
      const okMoney = Math.abs(money - tier) <= 1;
      console.log(`  ${okLines ? "OK  " : "FALLO"} queda 1 linea packed`);
      console.log(`  ${okMoney ? "OK  " : "FALLO"} cobra ${eur(money)} == tramo ${eur(tier)}`);
      if (okLines && okMoney) converted++;
      else failed++;
    } catch (e) {
      console.log(`  FALLO: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
    await sleep(800);
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`convertidas: ${converted}   saltadas: ${skipped}   fallidas: ${failed}`);
  if (!APPLY) console.log(`\nPara ejecutar: npx tsx scripts/demix-subscription.ts --apply`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\nERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

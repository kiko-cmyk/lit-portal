/**
 * Backfill post-deploy de la caché Supabase para las subs con línea PACK4.
 *
 * Los ~35 contratos migrados al pack 3+1 (2026-08-21) se cachearon ANTES de que
 * el portal conociera el pack, así que sus filas dicen box_count=1, flavor
 * "Salty Lemon", shape packed. La curación natural (siguiente webhook o visita
 * al hub) puede tardar semanas; este script la adelanta: recorre el libro de
 * Seal, y para cada sub con una línea PACK4 actualiza SU fila cacheada con el
 * mapeo nuevo (box_count 4+, composición de la mezcla, charge real).
 *
 * NO toca Seal (solo lectura) y solo escribe columnas derivadas en filas que YA
 * existen — no crea filas ni resuelve customer_id (eso es del webhook/hub).
 *
 *   SEAL_API_TOKEN=... npx tsx scripts/backfill-pack-cache.ts          # dry-run
 *   SEAL_API_TOKEN=... APPLY=1 npx tsx scripts/backfill-pack-cache.ts  # escribe
 *
 * Env (.env.local): SEAL_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env.local") });

import { getLines, mapToSubscription, normalizeFrequency, seal, mapStatus } from "../src/lib/seal";
import { PACK4_BY_VARIANT } from "../src/lib/seal-plans";
import { supabaseAdmin } from "../src/lib/supabase";

const APPLY = process.env.APPLY === "1";

if (!process.env.SEAL_API_TOKEN) throw new Error("SEAL_API_TOKEN required");

async function main() {
  console.log(`backfill-pack-cache — ${APPLY ? "APLICANDO" : "dry-run (APPLY=1 para escribir)"}\n`);
  const sb = supabaseAdmin();
  const subs = await seal.listAllSubscriptions();
  console.log(`libro de Seal: ${subs.length} subs\n`);

  let packSubs = 0;
  let updated = 0;
  let missingRow = 0;

  for (const s of subs) {
    const lines = getLines(s);
    if (!lines.some((l) => PACK4_BY_VARIANT[l.variantId])) continue;
    packSubs++;

    const { data: row, error: readErr } = await sb
      .from("subscriptions")
      .select("customer_id, box_count, flavor, shape, charge_total_cents")
      .eq("seal_subscription_id", String(s.id))
      .maybeSingle();
    if (readErr) throw new Error(`lectura de la fila de ${s.id}: ${readErr.message}`);
    if (!row) {
      // Sin fila cacheada: el primer webhook/visita la creará ya bien mapeada.
      console.log(`  sub ${s.id}: sin fila en la caché — se creará sola con el mapeo nuevo`);
      missingRow++;
      continue;
    }

    const mapped = mapToSubscription(s, String(row.customer_id));
    const next = {
      box_count: mapped.boxCount,
      frequency: normalizeFrequency(s.delivery_interval),
      flavor: mapped.flavorSummary,
      composition: mapped.composition,
      shape: mapped.shape,
      line_count: mapped.lines.length,
      charge_total_cents: mapped.chargeTotalCents,
      next_ship_date: mapped.nextShipDate,
      next_box_number: mapped.nextBoxNumber,
      status: mapStatus(s),
      updated_at: new Date().toISOString(),
    };

    const same =
      row.box_count === next.box_count &&
      row.flavor === next.flavor &&
      row.shape === next.shape &&
      row.charge_total_cents === next.charge_total_cents;
    console.log(
      `  sub ${s.id}: ${row.box_count} caja(s) "${row.flavor}" → ` +
        `${next.box_count} cajas "${next.flavor}" (${next.charge_total_cents}c)` +
        (same ? "  [ya correcta]" : APPLY ? "  [ACTUALIZADA]" : "  [se actualizaría]"),
    );
    if (same) continue;

    if (APPLY) {
      const { error: upErr } = await sb
        .from("subscriptions")
        .update(next)
        .eq("seal_subscription_id", String(s.id));
      if (upErr) throw new Error(`update de ${s.id}: ${upErr.message}`);
      updated++;
    } else {
      updated++;
    }
  }

  console.log(
    `\n${packSubs} subs con línea PACK4 · ${updated} ${APPLY ? "actualizadas" : "por actualizar"} · ` +
      `${missingRow} sin fila cacheada`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });

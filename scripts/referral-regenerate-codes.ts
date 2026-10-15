/**
 * Cambia códigos personales por otros nuevos (referidos, fase 0).
 *
 * El 2026-10-13 el formato pasó de nombre + 2 cifras (`JUAN65`, adivinable: 90
 * combinaciones por nombre) a nombre + cifra + 3 caracteres (`JUAN7KQ2`). Este
 * script pasa al formato nuevo los que se generaron antes, y sirve después para
 * cambiar un código que se haya filtrado.
 *
 * Uso (con el entorno de producción cargado):
 *   npx tsx scripts/referral-regenerate-codes.ts --legacy                  # cuenta los del formato viejo
 *   npx tsx scripts/referral-regenerate-codes.ts --legacy --apply          # los cambia
 *   npx tsx scripts/referral-regenerate-codes.ts --customer=<id> --apply   # cambia el de un cliente
 *
 * Un código ACTIVO se borra antes en Shopify (necesita REFERRAL_FRIEND_DISCOUNT_ID).
 * Los nuevos quedan `pending`: los da de alta el cron, o al momento
 * `referral-backfill-codes.ts --issue --only=<ids>`.
 */

import { isLegacyFormatCode, rotateReferralCode } from "../src/lib/referral-reward";
import { supabaseAdmin } from "../src/lib/supabase";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const legacy = args.includes("--legacy");
const customerArg = args.find((a) => a.startsWith("--customer="));

async function main() {
  let ids: string[] = [];
  if (customerArg) {
    ids = [customerArg.slice("--customer=".length).trim()];
  } else if (legacy) {
    const { data, error } = await supabaseAdmin()
      .from("referral_codes")
      .select("customer_id, code, status")
      .in("status", ["pending", "active"]);
    if (error) throw new Error(error.message);
    const old = (data ?? []).filter((r) => isLegacyFormatCode(r.code as string));
    const byStatus: Record<string, number> = {};
    for (const r of old) byStatus[r.status as string] = (byStatus[r.status as string] ?? 0) + 1;
    console.log(`Códigos del formato viejo: ${old.length}`, byStatus);
    ids = old.map((r) => r.customer_id as string);
  } else {
    console.log("Uso: --legacy [--apply] | --customer=<id> [--apply]");
    return;
  }
  if (!apply) {
    console.log(`Nada tocado (${ids.length} a cambiar). Para cambiarlos: --apply`);
    return;
  }
  let ok = 0;
  for (const id of ids) {
    try {
      const r = await rotateReferralCode(id, { dryRun: false });
      ok++;
      console.log(`${id}: ${r.from} (${r.was}) → ${r.to} (pending)`);
    } catch (e) {
      console.error(`${id}: ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`Cambiados: ${ok} de ${ids.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

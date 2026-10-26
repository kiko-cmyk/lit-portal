/**
 * Qué llega a #server-errors desde los crons del portal (26-oct-2026, LIT-614).
 *
 *   npx tsx scripts/test-alert-noise.ts
 *
 * Dos avisos que salían sin que hubiera nada que hacer: la pasada de referidos en verde
 * cada 4 h, y `retention_discount_aged_out` cuando Seal ya demostraba que no quedaba
 * descuento (y además dos veces). El censo de líneas está en test-plan-change-safety.
 */

import { notableSweepOutcomes } from "../src/lib/referral-sweep-report";
import { sealDiscountCheck } from "../src/lib/retention-discount";

let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}`);
    failed++;
  }
}

console.log("\n── Pasada de referidos ──\n");
check("una pasada sin nada no avisa", notableSweepOutcomes({}) === "");
check(
  "aplicar, consumir o reencolar recompensas es lo normal",
  notableSweepOutcomes({ applied: 2, consumed: 1, requeued: 3, noop: 9, "wait:no_charge_yet": 4 }) === "",
);
check("cualificar o rechazar conversiones también", notableSweepOutcomes({ qualified: 1, rejected: 2 }) === "");
check(
  "un fallo sale",
  notableSweepOutcomes({ applied: 1, failed: 1 }) === "failed=1",
);
check(
  "la pasada que no da abasto sale",
  notableSweepOutcomes({ deadline_left: 3, apply_deferred_time: 1 }) === "deadline_left=3, apply_deferred_time=1",
);
check("lo que pide revisión sale", notableSweepOutcomes({ review: 1 }) === "review=1");
check("un resultado que nadie ha clasificado sale", notableSweepOutcomes({ algo_nuevo: 1 }) === "algo_nuevo=1");
check("las simulaciones no avisan", notableSweepOutcomes({ "dry:apply": 2, "only_sub:expire_skipped": 1 }) === "");

console.log("\n── Retención caducada: ¿queda descuento en Seal? ──\n");
// 15049783, 26-oct: cobró su 15% (#12398 a 24,10), Seal quitó el código y la sub vuelve a 28,35.
check(
  "total igual a las líneas: no queda descuento, no hay nada que mirar",
  sealDiscountCheck({ total_value: 28.35, items: [{ price: "28.35", quantity: 1 }] }).noDiscount,
);
check(
  "total por debajo de las líneas: hay un descuento en vigor, se avisa",
  !sealDiscountCheck({ total_value: 24.1, items: [{ price: "28.35", quantity: 1 }] }).noDiscount,
);
check(
  "cuenta la cantidad de cada línea",
  sealDiscountCheck({ total_value: 85.05, items: [{ price: "28.35", quantity: 3 }] }).noDiscount,
);
check("sin total no se puede demostrar: se avisa", !sealDiscountCheck({ items: [{ price: "28.35", quantity: 1 }] }).noDiscount);
check("sin líneas tampoco", !sealDiscountCheck({ total_value: 0, items: [] }).noDiscount);

console.log(failed ? `\n${failed} FALLO(S)\n` : "\nTodo bien.\n");
process.exit(failed ? 1 : 0);

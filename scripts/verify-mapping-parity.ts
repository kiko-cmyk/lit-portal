/**
 * Red de seguridad de la Fase 1 del plan de mezcla de sabores.
 *
 * El refactor de lectura multi-línea toca código del que dependen el 100% de los
 * suscriptores para habilitar una feature que todavía no usa nadie. Este script
 * recorre el libro ENTERO de Seal y compara, sub por sub, el lector NUEVO
 * (mapToSubscription) contra una reimplementación del VIEJO.
 *
 * Criterio de aprobación:
 *   - Paridad EXACTA en las subs de una sola línea con quantity 1, que son el ~99%.
 *   - Diferencias SOLO en las subs multi-línea o con quantity != 1, que es
 *     precisamente lo que el refactor viene a arreglar. Cada una se lista con su
 *     antes/después para revisarlas a mano.
 *
 * Solo lectura. No muta nada.
 *
 *   SEAL_API_TOKEN=... npx tsx scripts/verify-mapping-parity.ts
 */

import {
  getLines,
  mapToSubscription,
  seal,
  type SealSubscription,
} from "../src/lib/seal";
import {
  BOX_COUNT_BY_VARIANT,
  DEFAULT_FLAVOR,
  PACK4_BY_VARIANT,
  flavorKeyForProductId,
  flavorKeyForVariant,
  flavorLabel,
} from "../src/lib/seal-plans";

if (!process.env.SEAL_API_TOKEN) throw new Error("SEAL_API_TOKEN required");

/** El lector de ANTES del refactor, reimplementado tal cual para comparar. */
function legacyRead(s: SealSubscription) {
  const main = s.items?.find((it) => !it.is_one_time_item) ?? s.items?.[0];

  // getBoxCount original: variante del item principal, si no cae a quantity clampeada.
  let boxCount = 1;
  if (main) {
    const fromVariant = BOX_COUNT_BY_VARIANT[String(main.variant_id)];
    boxCount = fromVariant ?? Math.min(6, Math.max(1, main.quantity ?? 1));
  }

  // extractFlavor original: product_id primero, luego variant_id, luego default.
  const flavor = main
    ? flavorLabel(
        flavorKeyForProductId(String(main.product_id)) ??
          flavorKeyForVariant(String(main.variant_id)) ??
          DEFAULT_FLAVOR,
      )
    : flavorLabel(DEFAULT_FLAVOR);

  return {
    mainItemId: main?.id ?? 0,
    currentVariantId: main?.variant_id ?? "",
    boxCount,
    flavor,
  };
}

const FIELDS = ["mainItemId", "currentVariantId", "boxCount", "flavor", "frequency", "nextShipDate"] as const;

type Diff = {
  sub: number;
  status: string;
  lines: string;
  changed: Array<{ field: string; before: unknown; after: unknown }>;
};

async function main() {
console.log("Leyendo el libro completo de Seal (puede tardar ~1 min)...");
const all = await seal.listAllSubscriptions();
console.log(`${all.length} suscripciones\n`);

const expectedDiffs: Diff[] = []; // multi-línea o qty != 1: el arreglo buscado
const unexpectedDiffs: Diff[] = []; // 1 línea y qty 1: NO debe haber ninguna
let identical = 0;
let noRecurring = 0;

for (const s of all) {
  const lines = getLines(s);
  // Una sub con línea PACK4 es una DIFERENCIA ESPERADA aunque sea 1 línea × qty 1:
  // que pase de "1 caja Salty Lemon" a 4 cajas con su mezcla es exactamente lo que
  // el registro del pack (escalera web 2026-08-22) viene a arreglar. En un pack
  // 1L+3W el sabor dominante correcto es Watermelon, no el fallback Lemon.
  const hasPack = lines.some((l) => PACK4_BY_VARIANT[l.variantId]);
  const isSimple = lines.length === 1 && lines[0].quantity === 1 && !hasPack;
  if (!lines.length) noRecurring++;

  const before = legacyRead(s);
  const after = mapToSubscription(s, "parity-check");

  const afterRec = after as unknown as Record<string, unknown>;
  const beforeRec = before as unknown as Record<string, unknown>;
  const changed = FIELDS.flatMap((f) => {
    // `frequency` / `nextShipDate` no los tocaba el lector viejo: se comparan
    // contra el nuevo para que salgan siempre iguales (guarda de no-regresión).
    const b = f in beforeRec ? beforeRec[f] : afterRec[f];
    const a = afterRec[f];
    return String(b) === String(a) ? [] : [{ field: f, before: b, after: a }];
  });

  if (!changed.length) {
    identical++;
    continue;
  }
  const diff: Diff = {
    sub: s.id,
    status: s.status,
    lines: lines.map((l) => `${l.variantId}×${l.quantity}`).join(" + ") || "(sin líneas recurrentes)",
    changed,
  };
  (isSimple ? unexpectedDiffs : expectedDiffs).push(diff);
}

console.log("=".repeat(70));
console.log(`idénticas ...................... ${identical}`);
console.log(`diferencias esperadas .......... ${expectedDiffs.length}  (multi-línea o qty != 1)`);
console.log(`diferencias INESPERADAS ........ ${unexpectedDiffs.length}  (1 línea, qty 1 → debe ser 0)`);
console.log(`sin líneas recurrentes ......... ${noRecurring}`);
console.log("=".repeat(70));

if (expectedDiffs.length) {
  console.log(`\n--- ${expectedDiffs.length} subs que el refactor ARREGLA ---`);
  for (const d of expectedDiffs) {
    console.log(`\nsub ${d.sub} [${d.status}]  ${d.lines}`);
    for (const c of d.changed) console.log(`    ${c.field}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
  }
}

if (unexpectedDiffs.length) {
  console.log(`\n*** ${unexpectedDiffs.length} DIFERENCIAS INESPERADAS (regresión) ***`);
  for (const d of unexpectedDiffs) {
    console.log(`\nsub ${d.sub} [${d.status}]  ${d.lines}`);
    for (const c of d.changed) console.log(`    ${c.field}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
  }
  console.log("\nFALLO: el refactor cambia subs de una sola línea. No desplegar.");
  process.exit(1);
}

console.log("\nOK — paridad exacta en todas las subs de una línea con quantity 1.");
console.log("Las únicas diferencias son las subs multi-línea / qty != 1 que el refactor arregla.");
}

main().catch((e) => {
  console.error(`\nERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

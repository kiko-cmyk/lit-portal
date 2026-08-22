/**
 * Auditoría de precios desfasados respecto a la ESCALERA WEB (2026-08-22).
 *
 * Solo lectura. Recorre el libro entero de Seal y, para cada sub ACTIVA o
 * PAUSADA con líneas recurrentes, compara lo que cobra hoy (Σ qty × precio de
 * línea, nunca total_value) contra la escalera web para su nº de cajas
 * (1-3 = n × 28,35 · 4 = 85,05 · 5-6 = 113,40 / 141,75).
 *
 * Clasifica:
 *   POR_DEBAJO  paga menos que la web (SL90 67,93, splits custom, SL150/180…)
 *   POR_ENCIMA  paga más que la web (SL120 90,57 > pack 85,05)
 *   ALINEADA    coincide (±1 céntimo por línea)
 *   REVISAR     lleva variantes fuera del registro (el nº de cajas no es fiable)
 *
 * Ningún contrato se toca: la migración se hará uno a uno hablando con cada
 * cliente (decisión de Juan, 2026-08-22).
 *
 *   SEAL_API_TOKEN=... npx tsx scripts/audit-ladder-drift.ts [salida.json]
 */

import { writeFileSync } from "node:fs";
import {
  getBoxCount,
  getComposition,
  getChargeTotalCents,
  getLines,
  getNextBillingAttempt,
  mapStatus,
  seal,
} from "../src/lib/seal";
import { compositionLabel, ladderTotalCents, type LadderPrices } from "../src/lib/mix";
import { BOX_COUNT_BY_VARIANT } from "../src/lib/seal-plans";

if (!process.env.SEAL_API_TOKEN) throw new Error("SEAL_API_TOKEN required");

const LADDER: LadderPrices = { oneBoxCents: 2835, pack4Cents: 8505 };
const OUT = process.argv[2] ?? "/tmp/audit-ladder-drift.json";

type Row = {
  subId: string;
  email: string;
  status: string;
  frequency: string;
  nextCharge: string | null;
  boxes: number;
  mix: string;
  lines: string;
  actualCents: number;
  expectedCents: number;
  deltaCents: number;
  bucket: "POR_DEBAJO" | "POR_ENCIMA" | "ALINEADA" | "REVISAR";
};

async function main() {
  console.log("Leyendo el libro completo de Seal...");
  const all = await seal.listAllSubscriptions();
  console.log(`${all.length} suscripciones\n`);

  const rows: Row[] = [];
  let skippedStatus = 0;
  let skippedNoLines = 0;

  for (const s of all) {
    const status = mapStatus(s);
    if (status !== "active" && status !== "paused") { skippedStatus++; continue; }
    const lines = getLines(s);
    if (!lines.length) { skippedNoLines++; continue; }

    const hasUnmapped = lines.some((l) => BOX_COUNT_BY_VARIANT[l.variantId] === undefined);
    const boxes = getBoxCount(s);
    const actual = getChargeTotalCents(s);
    const expected = ladderTotalCents(boxes, LADDER);
    const delta = actual - expected;

    let bucket: Row["bucket"];
    if (hasUnmapped) bucket = "REVISAR";
    else if (Math.abs(delta) <= lines.length) bucket = "ALINEADA";
    else bucket = delta < 0 ? "POR_DEBAJO" : "POR_ENCIMA";

    rows.push({
      subId: String(s.id),
      email: (s.email ?? "").trim(),
      status,
      frequency: s.delivery_interval ?? "",
      nextCharge: getNextBillingAttempt(s)?.date?.slice(0, 10) ?? null,
      boxes,
      mix: compositionLabel(getComposition(s)),
      lines: lines.map((l) => `${l.variantId}×${l.quantity}@${l.unitPrice}`).join(" + "),
      actualCents: actual,
      expectedCents: expected,
      deltaCents: delta,
      bucket,
    });
  }

  const by = (b: Row["bucket"]) => rows.filter((r) => r.bucket === b);
  const eur = (c: number) => (c / 100).toFixed(2).replace(".", ",");

  console.log("=".repeat(72));
  console.log(`alineadas con la escalera web ... ${by("ALINEADA").length}`);
  console.log(`POR DEBAJO (pagan menos) ........ ${by("POR_DEBAJO").length}`);
  console.log(`POR ENCIMA (pagan más) .......... ${by("POR_ENCIMA").length}`);
  console.log(`revisar a mano (fuera registro) . ${by("REVISAR").length}`);
  console.log(`saltadas (cancel/otros estados) . ${skippedStatus} · sin líneas: ${skippedNoLines}`);
  console.log("=".repeat(72));

  for (const bucket of ["POR_ENCIMA", "POR_DEBAJO", "REVISAR"] as const) {
    const list = by(bucket).sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents));
    if (!list.length) continue;
    console.log(`\n--- ${bucket} (${list.length}) ---`);
    for (const r of list) {
      console.log(
        `${r.email}  sub ${r.subId} [${r.status}]  ${r.boxes} cajas  ${r.mix}` +
          `\n    paga ${eur(r.actualCents)} · web ${eur(r.expectedCents)} · delta ${r.deltaCents > 0 ? "+" : ""}${eur(r.deltaCents)}` +
          ` · ${r.frequency} · próx. cobro ${r.nextCharge ?? "-"}\n    líneas: ${r.lines}`,
      );
    }
  }

  writeFileSync(OUT, JSON.stringify(rows, null, 1));
  console.log(`\nDetalle completo: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

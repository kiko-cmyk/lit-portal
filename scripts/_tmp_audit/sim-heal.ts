/** SOLO LECTURA. Simula assertMixPrice tal cual esta en feat/sabor-peach. */
import { writeFileSync } from "node:fs";
import {
  getBoxCount, getComposition, getChargeTotalCents, getLines,
  getNextBillingAttempt, mapStatus, seal,
} from "../../src/lib/seal";
import {
  diffLines, ladderTotalCents, MAX_BOXES, planTargetLines, repriceInPlace,
  centsToPrice, type LadderPrices,
} from "../../src/lib/mix";
import { BOX_COUNT_BY_VARIANT } from "../../src/lib/seal-plans";

const LADDER: LadderPrices = { oneBoxCents: 2835, pack4Cents: 8505 };

type Row = Record<string, unknown>;
const rows: Row[] = [];

async function main() {
  const all = await seal.listAllSubscriptions();
  console.log(`libro: ${all.length}`);
  let active = 0;
  for (const s of all) {
    if (mapStatus(s) !== "active") continue;
    active++;
    const next = getNextBillingAttempt(s);
    const lines = getLines(s);
    if (!lines.length) continue;
    const boxCount = getBoxCount(s);
    const composition = getComposition(s);
    const realBoxes = lines.reduce((a, l) => a + l.boxes, 0);

    // discount codes per line (recurring lines only)
    const dcByItem = new Map<number, string[]>();
    for (const it of (s.items ?? [])) {
      const codes = (it.discount_codes ?? []).map((d: any) => `${d.code}`);
      if (codes.length) dcByItem.set(it.id, codes);
    }
    const linesWithDc = lines.filter((l) => dcByItem.has(l.itemId)).length;

    const base: Row = {
      subId: String(s.id), email: s.email, next: next?.date ?? null,
      boxCount, realBoxes,
      mix: composition.map((c) => `${c.boxes}x${c.flavor}`).join("+"),
      lineset: lines.map((l) => `${l.variantId}x${l.quantity}@${l.unitPrice}(b${l.boxes})`).join(" | "),
      totalDcLines: dcByItem.size, recurringLinesWithDc: linesWithDc,
      allLinesHaveDc: linesWithDc === lines.length,
    };

    if (realBoxes !== boxCount || realBoxes > MAX_BOXES) {
      rows.push({ ...base, verdict: "GUARD_CLAMP" }); continue;
    }
    const unmapped = lines.map((l) => String(l.variantId)).filter((v) => BOX_COUNT_BY_VARIANT[v] === undefined);
    if (unmapped.length) { rows.push({ ...base, verdict: "GUARD_UNMAPPED", unmapped: unmapped.join(",") }); continue; }

    const expected = ladderTotalCents(boxCount, LADDER);
    const actual = getChargeTotalCents(s);
    if (Math.abs(actual - expected) <= lines.length) { continue; } // ALINEADA, no row
    if (actual < expected) { rows.push({ ...base, verdict: "BELOW_WARN", actual, expected }); continue; }

    let strategy = "catalogo";
    let editsToApply: Array<{ itemId: number; quantity: number; price: string }> = [];
    let raisesAnyLine = false;
    let proposedTotal = -1;
    try {
      const plan = planTargetLines(composition, LADDER);
      const diff = diffLines(lines, plan.lines);
      const isNew = !diff.adds.length && !diff.removes.length;
      if (isNew) {
        editsToApply = diff.edits.map((e) => ({ itemId: e.itemId, quantity: e.quantity, price: e.unitPrice }));
        proposedTotal = plan.totalCents;
      } else {
        const ip = repriceInPlace(lines, expected);
        if (!ip) { rows.push({ ...base, verdict: "HEAL_IMPOSSIBLE_ALERT", actual, expected }); continue; }
        strategy = "en-sitio";
        raisesAnyLine = ip.raisesAnyLine;
        proposedTotal = ip.totalCents;
        editsToApply = ip.edits.map((e) => ({ itemId: e.itemId, quantity: e.quantity, price: centsToPrice(e.unitPriceCents) }));
      }
    } catch (e) {
      rows.push({ ...base, verdict: "THREW", actual, expected, err: String(e) }); continue;
    }

    // paid-with-discount simulation, assuming 15% per-line codes
    const pctByItem = new Map<number, number>();
    for (const it of (s.items ?? [])) {
      for (const d of (it.discount_codes ?? []) as any[]) {
        if (d.code) pctByItem.set(it.id, 0.15);
      }
    }
    const newPriceByItem = new Map(editsToApply.map((e) => [e.itemId, Math.round(parseFloat(e.price) * 100)]));
    let paidBefore = 0, paidAfter = 0;
    for (const l of lines) {
      const q = Math.max(1, l.quantity || 1);
      const pBefore = Math.round(parseFloat(l.unitPrice) * 100);
      const pAfter = newPriceByItem.get(l.itemId) ?? pBefore;
      const disc = pctByItem.get(l.itemId) ?? 0;
      paidBefore += pBefore * q * (1 - disc);
      paidAfter += pAfter * q * (1 - disc);
    }

    rows.push({
      ...base, verdict: "WOULD_HEAL", strategy, actual, expected, proposedTotal, raisesAnyLine,
      edits: editsToApply.map((e) => `${e.itemId}:q${e.quantity}@${e.price}`).join(" | "),
      paidBefore: Math.round(paidBefore), paidAfter: Math.round(paidAfter),
      paidGoesUp: Math.round(paidAfter) > Math.round(paidBefore),
    });
  }
  console.log(`activas: ${active}`);
  const by: Record<string, number> = {};
  for (const r of rows) by[String(r.verdict)] = (by[String(r.verdict)] ?? 0) + 1;
  console.log(by);
  writeFileSync(process.argv[2] ?? "/tmp/sim-heal.json", JSON.stringify(rows, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });

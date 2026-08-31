/** SOLO LECTURA. */
import { getLines, mapStatus, getNextBillingAttempt, seal } from "../../src/lib/seal";
async function main() {
  const all = await seal.listAllSubscriptions();
  let active = 0, subsWithDc = 0, subsPartialDc = 0, oddQty = 0, zeroQty = 0;
  const partial: any[] = [], odd: any[] = [];
  for (const s of all as any[]) {
    if (mapStatus(s) !== "active") continue;
    active++;
    const rec = (s.items ?? []).filter((it: any) => !it.is_one_time_item);
    const withDc = rec.filter((it: any) => (it.discount_codes ?? []).length > 0);
    if (withDc.length) {
      subsWithDc++;
      if (withDc.length !== rec.length) {
        subsPartialDc++;
        partial.push({ sub: s.id, recLines: rec.length, dcLines: withDc.length,
          codes: withDc.map((it: any) => (it.discount_codes ?? []).map((d: any) => `${d.code}/${d.type ?? "?"}/${d.value ?? "?"}`).join(",")),
          lines: rec.map((it: any) => `${it.variant_id}x${it.quantity}@${it.price}${(it.discount_codes ?? []).length ? "*DC" : ""}`) });
      }
    }
    for (const it of rec) {
      const q = it.quantity;
      const n = Number(q);
      if (!(Number.isInteger(n) && n >= 1)) { oddQty++; odd.push({ sub: s.id, raw: q, variant: it.variant_id, price: it.price }); }
      if (n === 0) zeroQty++;
    }
  }
  console.log({ active, subsWithDc, subsPartialDc, oddQty, zeroQty });
  console.log("PARTIAL DC sample:", JSON.stringify(partial.slice(0, 15), null, 1));
  console.log("ODD QTY sample:", JSON.stringify(odd.slice(0, 15), null, 1));
  // sample a discount_codes object shape
  for (const s of all as any[]) {
    for (const it of (s.items ?? [])) {
      if ((it.discount_codes ?? []).length) { console.log("DC SHAPE:", JSON.stringify(it.discount_codes[0])); return; }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

import { planPreservingCharge, planTargetLines } from "../../src/lib/mix";
const prices = { oneBoxCents: 2835, pack4Cents: 8505 };
const cases: [number, number][] = [[5,11339],[6,13586],[4,8505],[5,11340],[6,14175],[3,6793],[4,6793]];
for (const [n, live] of cases) {
  const mix = [{ flavor: "salty-watermelon" as any, boxes: n }];
  const p = planPreservingCharge(mix, prices, live);
  const cat = planTargetLines(mix, prices);
  console.log(n, "live", live, "=>", p ? p.lines.map(l=>`${l.sku} q${l.quantity} @${l.unitPriceCents} boxes${l.boxes}`).join(" | ") : null, "total", p?.totalCents, "|| catalogue:", cat.lines.map(l=>`${l.sku}@${l.unitPriceCents}`).join(" | "), cat.totalCents);
}

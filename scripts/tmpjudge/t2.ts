import { planPreservingCharge, planTargetLines } from "../../src/lib/mix";
const prices = { oneBoxCents: 2835, pack4Cents: 8505 };
// real legacy prices: SL120 9057, SL150 10395, SL180 12474
for (const [n, live, label] of [[4,9057,"SL120"],[5,10395,"SL150"],[6,12474,"SL180"],[5,11339,"reviewer's 113.39"],[6,13586,"reviewer's 135.86"]] as any[]) {
  const mix = [{ flavor: "salty-watermelon" as any, boxes: n }];
  const cat = planTargetLines(mix, prices);
  const applies = cat.totalCents > live;
  const p = applies ? planPreservingCharge(mix, prices, live) : null;
  console.log(label, n, "boxes live", live, "cat", cat.totalCents, "applies?", applies, "=>",
    p ? p.lines.map(l=>`${l.sku} q${l.quantity} @${(l.unitPriceCents/100).toFixed(2)}`).join(" | ") : "(catalogue)", p?p.totalCents:"");
}

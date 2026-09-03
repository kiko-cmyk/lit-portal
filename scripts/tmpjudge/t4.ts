// enumerate plausible legacy 5/6-box live totals from known legacy variant prices
// legacy per-tier variants: 1=2835, 2=5670, 3=6793, 4=9057, 5=10395, 6=12474
// custom-split subs: old ladder splits, e.g. SL30*2@2264 + W30@2265 = per-box 6793/3
const combos: Record<string, number> = {
  "SL150 (5)": 10395,
  "SL180 (6)": 12474,
  "SL120+SL30 (4+1)": 9057+2835,
  "SL90+SL60 (3+2)": 6793+5670,
  "SL90+2xSL30 (3+1+1)": 6793+2835*2,
  "SL90*2 (6)": 6793*2,
  "SL120+SL60 (4+2)": 9057+5670,
  "SL120+2xSL30": 9057+2835*2,
  "SL150+SL30 (5+1)": 10395+2835,
  "5x SL30": 2835*5,
  "6x SL30": 2835*6,
  "split legacy 5 @ 6793/3 per box*5": Math.round(6793/3*5),
};
for (const [k,v] of Object.entries(combos)) {
  const n = k.includes("(5)")||k.includes("(4+1)")||k.includes("(3+2)")||k.includes("(3+1+1)")||k.includes("5x")||k.includes("*5")?5:6;
  const cat = n===5?11340:14175;
  const perBox = Math.floor(v/n);
  console.log(k.padEnd(28), "n="+n, "live", v, "cat", cat, "below?", v<cat, "packUnit", perBox*4, "exceeds8505?", perBox*4>8505);
}

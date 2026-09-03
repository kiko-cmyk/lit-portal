// For which live totals does the preserved PACK4 unit price exceed catalogue 8505?
// 5 boxes: perBox = floor(live/5); pack unit = perBox*4 (+adjust). >8505 requires perBox>2126.25 => perBox>=2127 => live>=10635
// but must also be < catalogue 11340 to trigger. Window: [10635, 11339]
// 6 boxes: perBox = floor(live/6) ; pack unit > 8505 requires perBox >= 2127 => live >= 12762; catalogue 14175. Window [12762,14174]
for (const n of [5,6]) {
  const cat = n===5?11340:14175;
  let lo=null, hi=null;
  for (let live=1; live<cat; live++) {
    const perBox = Math.floor(live/n);
    if (perBox*4 > 8505) { if (lo===null) lo=live; hi=live; }
  }
  console.log(n, "boxes: pack line exceeds catalogue for live in", lo, "..", hi, " (catalogue", cat, ")");
}

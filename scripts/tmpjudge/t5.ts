// Test the reviewer's suggested proportional fix on the SL90x2 case (6 boxes, 13586)
// catalogue lines: PACK4 8505 q1 boxes4 ; W30 2835 q2 boxes2 (total 14175)
const live = 13586, cat = 14175;
const ratio = live/cat;
const pack = Math.floor(8505*ratio);
const single = Math.floor(2835*ratio);
console.log("proportional: pack", pack, "single", single, "total", pack*1+single*2, "vs live", live, "shortfall", live-(pack+single*2));
// 5 box 11322 case
const live5=11322, cat5=11340, r5=live5/cat5;
const p5=Math.floor(8505*r5), s5=Math.floor(2835*r5);
console.log("5box: pack", p5, "single", s5, "total", p5+s5, "vs", live5);

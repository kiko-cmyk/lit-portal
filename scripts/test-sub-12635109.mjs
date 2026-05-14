// One-off: fetch Juan's sub 12635109 by scanning pages, show items + plan.
// Usage: node scripts/test-sub-12635109.mjs

const TOKEN = process.env.SEAL_API_TOKEN;
if (!TOKEN) throw new Error("SEAL_API_TOKEN required");

const TARGET_ID = 12635109;
const BASE = "https://app.sealsubscriptions.com/shopify/merchant/api";

async function fetchPage(page) {
  const url = `${BASE}/subscriptions?with-items=true&with-billing-attempts=true&page=${page}`;
  const r = await fetch(url, { headers: { "X-Seal-Token": TOKEN } });
  if (!r.ok) throw new Error(`page ${page}: ${r.status}`);
  return r.json();
}

const p1 = await fetchPage(1);
const total = p1.payload.total_pages;
console.log(`Total pages: ${total}`);

let hit = p1.payload.subscriptions.find((s) => s.id === TARGET_ID);
if (!hit) {
  for (let p = 2; p <= total && !hit; p++) {
    const d = await fetchPage(p);
    hit = d.payload.subscriptions.find((s) => s.id === TARGET_ID);
    if (hit) console.log(`Found on page ${p}`);
  }
}

if (!hit) {
  console.log(`Sub ${TARGET_ID} not found across ${total} pages.`);
  process.exit(1);
}

console.log("\n=== SUB STATE ===");
console.log(`id: ${hit.id}`);
console.log(`email: ${hit.email}`);
console.log(`status: ${hit.status}`);
console.log(`delivery_interval: ${hit.delivery_interval}`);
console.log(`billing_interval: ${hit.billing_interval}`);
console.log(`total_value: ${hit.total_value}`);
console.log(`\nITEMS (${hit.items.length}):`);
for (const it of hit.items) {
  console.log(`  - item.id=${it.id}`);
  console.log(`    product_id=${it.product_id} variant_id=${it.variant_id}`);
  console.log(`    title="${it.title}" sku="${it.variant_sku}"`);
  console.log(`    qty=${it.quantity} price=${it.price} one_time=${it.is_one_time_item}`);
  console.log(`    selling_plan_id=${it.selling_plan_id} ("${it.selling_plan_name}")`);
}

console.log(`\nNEXT BILLING ATTEMPT:`);
const next = (hit.billing_attempts ?? []).find(
  (ba) => !ba.completed_at && !ba.status && !ba.skipped_on,
);
if (next) console.log(`  id=${next.id} date=${next.date}`);
else console.log("  none pending");

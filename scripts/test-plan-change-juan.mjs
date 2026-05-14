// E2E test of the new add_items + remove_items flow against sub 12635109.
// Performs ONE swap at a time then waits — caller passes which test to run.
//
// Usage:
//   node scripts/test-plan-change-juan.mjs state    → just read current state
//   node scripts/test-plan-change-juan.mjs variant  → 1 box (SL30) → 2 boxes (SL60), keep selling plan
//   node scripts/test-plan-change-juan.mjs revert   → back to 1 box SL30

const SEAL_TOKEN = process.env.SEAL_API_TOKEN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
if (!SEAL_TOKEN) throw new Error("SEAL_API_TOKEN required");
if (!SHOPIFY_TOKEN) throw new Error("SHOPIFY_ADMIN_TOKEN required");

const SEAL_BASE = "https://app.sealsubscriptions.com/shopify/merchant/api";
const SHOPIFY_BASE = "https://lit-tienda.myshopify.com/admin/api/2026-04";

const SUB_ID = 12635109;
const SL30_VARIANT = "63887092154717";
const SL60_VARIANT = "64629025341789";
const CANONICAL_1MO = "691259834717"; // "Envío 1 mes" — universally available on all variants

const action = process.argv[2];
if (!["state", "variant", "revert"].includes(action)) {
  console.error("Usage: node scripts/test-plan-change-juan.mjs {state|variant|revert}");
  process.exit(1);
}

async function fetchSealPage(page) {
  const url = `${SEAL_BASE}/subscriptions?with-items=true&with-billing-attempts=true&page=${page}`;
  const r = await fetch(url, { headers: { "X-Seal-Token": SEAL_TOKEN } });
  if (!r.ok) throw new Error(`page ${page}: ${r.status}`);
  return r.json();
}

async function getSub() {
  const p1 = await fetchSealPage(1);
  const total = p1.payload.total_pages;
  let hit = p1.payload.subscriptions.find((s) => s.id === SUB_ID);
  for (let p = 2; p <= total && !hit; p++) {
    const d = await fetchSealPage(p);
    hit = d.payload.subscriptions.find((s) => s.id === SUB_ID);
  }
  return hit ?? null;
}

function showSub(s) {
  console.log(`\n=== sub ${s.id} ===`);
  console.log(`status=${s.status} delivery_interval="${s.delivery_interval}" billing_interval="${s.billing_interval}" total_value=${s.total_value}`);
  for (const it of s.items) {
    console.log(`  item.id=${it.id}  variant_id=${it.variant_id} (sku ${it.variant_sku}, "${it.title}")`);
    console.log(`    qty=${it.quantity} price=${it.price} selling_plan_id=${it.selling_plan_id} ("${it.selling_plan_name}")`);
  }
}

async function shopifyVariant(variantId) {
  const r = await fetch(`${SHOPIFY_BASE}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query($id: ID!) { productVariant(id: $id) {
        id title sku price taxable
        inventoryItem { requiresShipping }
        product { id title }
      } }`,
      variables: { id: `gid://shopify/ProductVariant/${variantId}` },
    }),
  });
  const data = await r.json();
  if (!data.data || data.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(data));
    throw new Error("variant lookup failed");
  }
  const v = data.data.productVariant;
  return {
    product_id: v.product.id.replace(/^gid:\/\/shopify\/Product\//, ""),
    variant_id: v.id.replace(/^gid:\/\/shopify\/ProductVariant\//, ""),
    title: v.product.title,
    sku: v.sku ?? "",
    price: v.price,
    taxable: v.taxable,
    requires_shipping: v.inventoryItem.requiresShipping,
  };
}

async function sealAddItems(subId, items) {
  const body = {
    action: "add_items",
    id: subId,
    add_items: items.map((it) => ({
      product_id: it.product_id,
      variant_id: it.variant_id,
      quantity: it.quantity,
      title: it.title,
      sku: it.sku,
      price: it.price,
      taxable: it.taxable === false ? 0 : 1,
      requires_shipping: it.requires_shipping === false ? 0 : 1,
      one_time: 0,
      ...(it.selling_plan_id !== undefined ? { selling_plan_id: it.selling_plan_id } : {}),
    })),
  };
  console.log("\n→ add_items request body:");
  console.log(JSON.stringify(body, null, 2));
  const r = await fetch(`${SEAL_BASE}/subscription`, {
    method: "PUT",
    headers: { "X-Seal-Token": SEAL_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  console.log("← add_items response:", JSON.stringify(j));
  if (j?.success === false) throw new Error(`add_items rejected: ${j.error ?? j.message ?? "unknown"}`);
  return j;
}

async function sealRemoveItems(subId, itemIds) {
  const body = { action: "remove_items", id: subId, remove_items: itemIds };
  console.log("\n→ remove_items request body:");
  console.log(JSON.stringify(body, null, 2));
  const r = await fetch(`${SEAL_BASE}/subscription`, {
    method: "PUT",
    headers: { "X-Seal-Token": SEAL_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  console.log("← remove_items response:", JSON.stringify(j));
  if (j?.success === false) throw new Error(`remove_items rejected: ${j.error ?? j.message ?? "unknown"}`);
  return j;
}

const sub = await getSub();
if (!sub) {
  console.error(`Sub ${SUB_ID} not found.`);
  process.exit(1);
}
showSub(sub);

if (action === "state") {
  process.exit(0);
}

const mainItem = sub.items.find((it) => !it.is_one_time_item) ?? sub.items[0];
const oldItemId = mainItem.id;
// Always write the canonical 1mo plan — legacy IDs are not associated
// with every variant; passing them triggers Seal to silently substitute.
const targetSellingPlan = CANONICAL_1MO;

let targetVariantId;
if (action === "variant") {
  if (mainItem.variant_id === SL60_VARIANT) {
    console.log("\nAlready on SL60 — nothing to do.");
    process.exit(0);
  }
  targetVariantId = SL60_VARIANT;
} else if (action === "revert") {
  if (mainItem.variant_id === SL30_VARIANT) {
    console.log("\nAlready on SL30 — nothing to do.");
    process.exit(0);
  }
  targetVariantId = SL30_VARIANT;
}

console.log(`\n>>> Swapping ${mainItem.variant_id} → ${targetVariantId} (qty=${mainItem.quantity}, selling_plan ${targetSellingPlan} canonical 1mo)`);

const v = await shopifyVariant(targetVariantId);
console.log(`Shopify variant resolved: title="${v.title}" sku="${v.sku}" price=${v.price}`);

await sealAddItems(SUB_ID, [{
  ...v,
  quantity: mainItem.quantity,
  // price comes from `v` (Shopify variant price), per-unit
  selling_plan_id: targetSellingPlan,
}]);

await sealRemoveItems(SUB_ID, [oldItemId]);

console.log("\nWaiting 2s for Seal to settle…");
await new Promise((r) => setTimeout(r, 2000));

const after = await getSub();
showSub(after);

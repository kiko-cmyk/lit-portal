/** SOLO LECTURA. Precios vivos de catalogo + tolerancias del heal. */
import { getLadderPrices } from "../../src/lib/pricing";
import { FLAVOR_KEYS, FLAVORS, PACK4_PRODUCT_ID } from "../../src/lib/seal-plans";
import { shopifyAdmin } from "../../src/lib/shopify-admin";
import { ladderTotalCents, repriceInPlace, type SubscriptionLine } from "../../src/lib/mix";

const Q = `query p($id: ID!){ product(id:$id){ title variants(first:50){ edges{ node{ id title sku price } } } } }`;

async function main() {
  for (const f of FLAVOR_KEYS) {
    const p = await getLadderPrices(f as any);
    console.log(f, JSON.stringify(p), "ladder:", [1,2,3,4,5,6].map(n=>ladderTotalCents(n,p)).join(" "));
  }
  const d: any = await shopifyAdmin.graphql(Q, { id: `gid://shopify/Product/${PACK4_PRODUCT_ID}` });
  console.log("PACK4 product:", d.product.title);
  for (const e of d.product.variants.edges) console.log("  ", e.node.sku, e.node.price);
  for (const f of FLAVOR_KEYS) {
    const def = (FLAVORS as any)[f];
    const dd: any = await shopifyAdmin.graphql(Q, { id: `gid://shopify/Product/${def.productId}` });
    console.log(f, "product:", dd.product.title);
    for (const e of dd.product.variants.edges) console.log("  ", e.node.sku, e.node.price);
  }

  // tolerancia: error de floor vs lines.length
  console.log("\n--- floor error vs tolerance (expected vs proposed) ---");
  const mk = (id: number, variantId: string, qty: number, boxes: number, price: string): SubscriptionLine =>
    ({ itemId: id, productId: "x", variantId, flavor: "salty-lemon", boxes, quantity: qty, unitPrice: price, sellingPlanId: "" } as any);
  const cases: Array<[string, SubscriptionLine[], number]> = [
    ["14682293 SL30x3@28.35 + SL90x1@67.93 (6 cajas)", [mk(1,"63887092154717",3,3,"28.35"), mk(2,"63887092220253",1,3,"67.93")], 14175],
    ["SL90x2@67.93 pero cobrando 170 (6 cajas, 2 lineas)", [mk(1,"63887092220253",1,3,"90.00"), mk(2,"63887092220253",1,3,"90.00")], 14175],
    ["5 cajas: SL90x1 + SL60x1 sobrecobrando", [mk(1,"63887092220253",1,3,"80.00"), mk(2,"64629025341789",1,2,"60.00")], 11340],
  ];
  for (const [label, lines, target] of cases) {
    const r = repriceInPlace(lines, target);
    if (!r) { console.log(label, "-> null"); continue; }
    const diff = Math.abs(r.totalCents - target);
    console.log(`${label} -> proposed ${r.totalCents}, expected ${target}, |diff| ${diff}, tolerance(lines.length) ${lines.length}, VERIFY=${diff <= lines.length ? "healed" : "FAILED(falso)"} raises=${r.raisesAnyLine}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

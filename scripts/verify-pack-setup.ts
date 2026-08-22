/**
 * Verificación pre-lanzamiento del registro PACK4 (lib/seal-plans) contra Shopify.
 *
 * Solo lectura. Los IDs del registro se copiaron por API el 2026-08-22; este
 * script los RE-verifica contra la tienda viva porque un dígito mal no lanza
 * ningún error: cae al fallback silencioso "variante desconocida = 1 caja
 * Salty Lemon", que es exactamente el bug que el registro arregla.
 *
 * Comprueba:
 *   1. Las 5 variantes del pack de SUSCRIPCIÓN existen, con el SKU del registro,
 *      todas al mismo precio (85,05) y `requiresSellingPlan: true`.
 *   2. El producto está en los 8 selling plans canónicos de Seal (una línea
 *      añadida a un producto fuera del plan aterriza como one-time y desaparece
 *      tras el primer envío).
 *   3. Las 5 variantes del pack de COMPRA ÚNICA existen con los mismos SKUs.
 *   4. La variante de 1 caja de cada sabor comparte precio (la escalera 1-3 = n×caja).
 *
 * Uso:
 *   npx tsx scripts/verify-pack-setup.ts
 *
 * Env (.env.local): SHOPIFY_STORE (default lit-tienda), SHOPIFY_ADMIN_TOKEN (obligatorio).
 * Exit 1 si algo falla, para poder usarlo de gate en el checklist de deploy.
 */

import { resolve } from "node:path";
import { config } from "dotenv";
import {
  ALL_FLAVORS,
  PACK4_OT_PRODUCT_ID,
  PACK4_PRODUCT_ID,
  PACK4_VARIANTS,
  SELLING_PLAN_BY_FREQUENCY,
} from "../src/lib/seal-plans";

config({ path: resolve(process.cwd(), ".env.local") });

const STORE = process.env.SHOPIFY_STORE || "lit-tienda.myshopify.com";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const ADMIN_API_VERSION = "2026-04";

if (!ADMIN_TOKEN) {
  console.error("SHOPIFY_ADMIN_TOKEN required (.env.local) — los packs son UNLISTED y no salen en products.json");
  process.exit(1);
}

let failures = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string) => { console.log(`  ✗ ${msg}`); failures++; };

interface AdminProduct {
  title: string;
  requiresSellingPlan: boolean;
  sellingPlanGroups: { edges: Array<{ node: { sellingPlans: { edges: Array<{ node: { id: string } }> } } }> };
  variants: { edges: Array<{ node: { id: string; sku: string | null; price: string } }> };
}

async function fetchProduct(productId: string): Promise<AdminProduct | null> {
  const res = await fetch(`https://${STORE}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": ADMIN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($id: ID!) {
        product(id: $id) {
          title
          requiresSellingPlan
          sellingPlanGroups(first: 20) {
            edges { node { sellingPlans(first: 20) { edges { node { id } } } } }
          }
          variants(first: 20) { edges { node { id sku price } } }
        }
      }`,
      variables: { id: `gid://shopify/Product/${productId}` },
    }),
  });
  if (!res.ok) throw new Error(`Admin GraphQL ${res.status}`);
  const json = (await res.json()) as { data?: { product: AdminProduct | null }; errors?: unknown };
  if (json.errors) throw new Error(`Admin GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data?.product ?? null;
}

const numericId = (gid: string) => gid.replace(/^gid:\/\/shopify\/(ProductVariant|SellingPlan)\//, "");

async function main() {
  // ── 1. Pack de suscripción ──
  console.log(`\n=== pack de suscripción (${PACK4_PRODUCT_ID}) ===`);
  const sub = await fetchProduct(PACK4_PRODUCT_ID);
  if (!sub) { fail("el producto no existe"); process.exit(1); }
  ok(`producto: ${sub.title}`);
  if (sub.requiresSellingPlan) ok("requiresSellingPlan: true (no se puede vender sin plan)");
  else fail("requiresSellingPlan es FALSE — el pack de sub se podría comprar sin plan");

  const liveVariants = new Map(sub.variants.edges.map((e) => [numericId(e.node.id), e.node]));
  const prices = new Set<string>();
  for (const def of PACK4_VARIANTS) {
    const v = liveVariants.get(def.variantId);
    if (!v) { fail(`variante ${def.variantId} (${def.sku}) NO existe en Shopify`); continue; }
    if ((v.sku ?? "") === def.sku) ok(`${def.sku} → ${def.variantId} @ ${v.price}`);
    else fail(`variante ${def.variantId}: SKU en Shopify "${v.sku}" != registro "${def.sku}"`);
    prices.add(v.price);
  }
  if (prices.size === 1) ok(`las 5 variantes al mismo precio (${[...prices][0]})`);
  else fail(`precios desalineados entre variantes del pack: ${[...prices].join(", ")}`);

  // ── 2. Selling plans ──
  console.log(`\n=== selling plans del pack ===`);
  const attached = new Set(
    sub.sellingPlanGroups.edges.flatMap((g) =>
      g.node.sellingPlans.edges.map((p) => numericId(p.node.id)),
    ),
  );
  for (const [freq, planId] of Object.entries(SELLING_PLAN_BY_FREQUENCY)) {
    if (attached.has(planId)) ok(`plan ${freq} (${planId}) asignado`);
    else fail(`plan ${freq} (${planId}) NO asignado — un add aterrizaría como one-time`);
  }

  // ── 3. Pack de compra única (solo lectura de pedidos) ──
  console.log(`\n=== pack de compra única (${PACK4_OT_PRODUCT_ID}) ===`);
  const otProd = await fetchProduct(PACK4_OT_PRODUCT_ID);
  if (!otProd) fail("el producto de compra única no existe");
  else {
    const otSkus = new Set(otProd.variants.edges.map((e) => e.node.sku ?? ""));
    for (const def of PACK4_VARIANTS) {
      if (otSkus.has(def.sku)) ok(`compra única tiene ${def.sku}`);
      else fail(`compra única SIN el SKU ${def.sku}`);
    }
  }

  // ── 4. Variante de 1 caja por sabor (la base de la escalera 1-3) ──
  console.log(`\n=== variantes de 1 caja ===`);
  const oneBoxPrices = new Set<string>();
  for (const f of ALL_FLAVORS) {
    const p = await fetchProduct(f.productId);
    const v = p && new Map(p.variants.edges.map((e) => [numericId(e.node.id), e.node])).get(f.variantByBoxCount[1]);
    if (!v) { fail(`${f.key}: variante de 1 caja ${f.variantByBoxCount[1]} no existe`); continue; }
    ok(`${f.key}: 1 caja @ ${v.price}`);
    oneBoxPrices.add(v.price);
  }
  if (oneBoxPrices.size <= 1) ok("todos los sabores comparten el precio de 1 caja");
  else fail(`precios de 1 caja desalineados entre sabores: ${[...oneBoxPrices].join(", ")}`);

  console.log(`\n${"=".repeat(60)}`);
  if (failures) { console.log(`FALLOS: ${failures}`); process.exit(1); }
  console.log("OK — registro PACK4 verificado contra la tienda");
}

main().catch((e) => { console.error(e); process.exit(1); });

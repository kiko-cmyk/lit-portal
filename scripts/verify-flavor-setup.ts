/**
 * Pre-launch verification for the LIT flavor registry (lib/seal-plans FLAVORS).
 *
 * Read-only. Confirms that every flavor's Shopify product + 6 box-count variants
 * in the registry actually exist with the expected prices, and (if a Shopify
 * Admin token is available) that each flavor product is attached to all 8 Seal
 * selling plans — the one thing that can silently break a flavor swap (an
 * add_items onto a product not on the selling plan lands as a one-time line).
 *
 * Usage:
 *   npx tsx scripts/verify-flavor-setup.ts
 *
 * Env (.env.local):
 *   SHOPIFY_STORE          e.g. lit-tienda.myshopify.com (has a public default)
 *   SHOPIFY_ADMIN_TOKEN    optional — enables the selling-plan attachment check.
 *                          Without it, only the public variant/price check runs.
 *
 * Exit code 1 if any check fails, so it can gate a launch checklist.
 */

import { resolve } from "node:path";
import { config } from "dotenv";
import {
  ALL_FLAVORS,
  SELLING_PLAN_BY_FREQUENCY,
} from "../src/lib/seal-plans";

config({ path: resolve(process.cwd(), ".env.local") });

const STORE = process.env.SHOPIFY_STORE || "lit-tienda.myshopify.com";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const ADMIN_API_VERSION = "2026-04";

let failures = 0;
function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg: string) {
  console.log(`  ✗ ${msg}`);
  failures++;
}
function warn(msg: string) {
  console.log(`  ! ${msg}`);
}

interface PublicVariant {
  id: number;
  sku: string | null;
  price: string;
}
interface PublicProduct {
  id: number;
  title: string;
  variants: PublicVariant[];
}

async function fetchPublicProducts(): Promise<Map<string, PublicProduct>> {
  const res = await fetch(`https://${STORE}/products.json?limit=250`);
  if (!res.ok) throw new Error(`products.json ${res.status}`);
  const json = (await res.json()) as { products: PublicProduct[] };
  const byId = new Map<string, PublicProduct>();
  for (const p of json.products) byId.set(String(p.id), p);
  return byId;
}

/** Selling-plan ids attached to a product, via Admin GraphQL (needs a token). */
async function fetchSellingPlanIds(productId: string): Promise<Set<string>> {
  const res = await fetch(
    `https://${STORE}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query($id: ID!) {
          product(id: $id) {
            sellingPlanGroups(first: 20) {
              edges { node { sellingPlans(first: 20) { edges { node { id } } } } }
            }
          }
        }`,
        variables: { id: `gid://shopify/Product/${productId}` },
      }),
    },
  );
  const json = (await res.json()) as {
    data?: {
      product?: {
        sellingPlanGroups: {
          edges: Array<{ node: { sellingPlans: { edges: Array<{ node: { id: string } }> } } }>;
        };
      } | null;
    };
    errors?: unknown;
  };
  if (json.errors) throw new Error(`Admin GraphQL: ${JSON.stringify(json.errors)}`);
  const ids = new Set<string>();
  for (const g of json.data?.product?.sellingPlanGroups.edges ?? []) {
    for (const sp of g.node.sellingPlans.edges) {
      ids.add(sp.node.id.replace(/^gid:\/\/shopify\/SellingPlan\//, ""));
    }
  }
  return ids;
}

async function main() {
  console.log(`\nVerifying flavor registry against ${STORE}\n`);
  const products = await fetchPublicProducts();
  const expectedPlanIds = Object.values(SELLING_PLAN_BY_FREQUENCY);

  for (const flavor of ALL_FLAVORS) {
    console.log(`Flavor: ${flavor.label} (${flavor.key}) — product ${flavor.productId}`);
    const product = products.get(flavor.productId);
    if (!product) {
      fail(`product ${flavor.productId} not found / not published on ${STORE}`);
      continue;
    }
    ok(`product found: "${product.title}"`);

    // Variant existence + presence of all 6 box counts.
    const variantIds = new Set(product.variants.map((v) => String(v.id)));
    for (let box = 1; box <= 6; box++) {
      const vid = flavor.variantByBoxCount[box as 1 | 2 | 3 | 4 | 5 | 6];
      if (variantIds.has(vid)) {
        const v = product.variants.find((x) => String(x.id) === vid)!;
        ok(`box ${box}: variant ${vid} (SKU ${v.sku ?? "?"}, €${v.price})`);
      } else {
        fail(`box ${box}: variant ${vid} NOT found on product ${flavor.productId}`);
      }
    }

    // Selling-plan attachment (needs an Admin token).
    if (!ADMIN_TOKEN) {
      warn(`selling-plan check skipped (set SHOPIFY_ADMIN_TOKEN to verify all 8 plans are attached)`);
    } else {
      try {
        const attached = await fetchSellingPlanIds(flavor.productId);
        const missing = expectedPlanIds.filter((id) => !attached.has(id));
        if (missing.length === 0) {
          ok(`all ${expectedPlanIds.length} selling plans attached`);
        } else {
          fail(`missing ${missing.length} selling plan(s): ${missing.join(", ")}`);
        }
      } catch (e) {
        fail(`selling-plan query failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log("");
  }

  console.log(failures === 0 ? "ALL CHECKS PASSED\n" : `${failures} CHECK(S) FAILED\n`);
  // Set exitCode (not process.exit) so Node drains cleanly — process.exit while
  // undici's keep-alive socket is closing trips a libuv assertion on Windows.
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

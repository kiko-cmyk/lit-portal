/**
 * Pricing — dynamic from Shopify variants.
 *
 * As of 2026-05-06, prices are read from Shopify variant prices (with bulk
 * discount baked in). Cached in-memory for 5 minutes to avoid hitting
 * Shopify Admin on every Plan overlay open.
 *
 * Frequency does NOT affect per-shipment price (LIT-Portal-Master-Spec § 4) —
 * cadence is independent. Discount is per variant (1-2: -25%, 3-4: -40%, 5-6: -45%).
 */

import { LIT_PRODUCT_ID, VARIANT_BY_BOX_COUNT } from "./seal-plans";
import { shopifyAdmin } from "./shopify-admin";

export const CURRENCY = "EUR" as const;
export const PRICING_LAST_UPDATED = "2026-05-06";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface PricingCache {
  perBox: number[];
  compareAtPerBox: (number | null)[];
  fetchedAt: number;
}

let _cache: PricingCache | null = null;

/**
 * Fetch the 6 variant prices from Shopify Admin GraphQL. Returns an array
 * indexed by box count (index 0 = 1 box, index 5 = 6 boxes).
 */
async function fetchPrices(): Promise<{ perBox: number[]; compareAtPerBox: (number | null)[] }> {
  const data = await shopifyAdmin.graphql<{
    product: {
      variants: {
        edges: Array<{
          node: { id: string; price: string; compareAtPrice: string | null };
        }>;
      };
    } | null;
  }>(
    `query litPricing($id: ID!) {
       product(id: $id) {
         variants(first: 50) {
           edges { node { id price compareAtPrice } }
         }
       }
     }`,
    { id: `gid://shopify/Product/${LIT_PRODUCT_ID}` },
  );

  if (!data.product) throw new Error(`Product ${LIT_PRODUCT_ID} not found`);

  // Map by variant ID, ordered by box count (1..6)
  const variantPrice = new Map<string, { price: number; compareAtPrice: number | null }>();
  for (const { node } of data.product.variants.edges) {
    const numericId = node.id.replace(/^gid:\/\/shopify\/ProductVariant\//, "");
    variantPrice.set(numericId, {
      price: parseFloat(node.price),
      compareAtPrice: node.compareAtPrice ? parseFloat(node.compareAtPrice) : null,
    });
  }

  const perBox: number[] = [];
  const compareAtPerBox: (number | null)[] = [];
  for (let boxes = 1; boxes <= 6; boxes++) {
    const variantId = VARIANT_BY_BOX_COUNT[boxes as 1 | 2 | 3 | 4 | 5 | 6];
    const v = variantPrice.get(variantId);
    if (!v) {
      throw new Error(`Variant for ${boxes} box(es) not found: ${variantId}`);
    }
    perBox.push(v.price);
    compareAtPerBox.push(v.compareAtPrice);
  }
  return { perBox, compareAtPerBox };
}

/**
 * Get pricing for all box counts. Uses in-memory cache (5 min TTL).
 */
export async function getPricing(): Promise<{
  perBox: number[];
  compareAtPerBox: (number | null)[];
  isPlaceholder: boolean;
  lastUpdated: string;
}> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return {
      perBox: _cache.perBox,
      compareAtPerBox: _cache.compareAtPerBox,
      isPlaceholder: false,
      lastUpdated: PRICING_LAST_UPDATED,
    };
  }
  const { perBox, compareAtPerBox } = await fetchPrices();
  _cache = { perBox, compareAtPerBox, fetchedAt: Date.now() };
  return { perBox, compareAtPerBox, isPlaceholder: false, lastUpdated: PRICING_LAST_UPDATED };
}

/**
 * Get total per shipment for a given box count. (Variant price already includes
 * the bulk discount — no extra math needed.)
 */
export async function priceForBoxCount(boxCount: number): Promise<number> {
  if (boxCount < 1 || boxCount > 6) {
    throw new Error(`Invalid box count ${boxCount} — must be 1..6`);
  }
  const { perBox } = await getPricing();
  return perBox[boxCount - 1];
}

/**
 * Manually invalidate the cache (e.g., after admin updates Shopify variants).
 */
export function invalidatePricingCache(): void {
  _cache = null;
}

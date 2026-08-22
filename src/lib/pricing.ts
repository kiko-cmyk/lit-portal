/**
 * Pricing — dynamic from Shopify, computed on the ESCALERA WEB (2026-08-22).
 *
 * La escalera ya NO se lee de las variantes por tramo (SL60..SL180 conservan sus
 * precios viejos en Shopify como solo-lectura para contratos existentes): se
 * COMPUTA desde dos precios de catálogo vivos — la variante de 1 caja (28,35) y
 * el producto PACK4 (85,05, pagas 3 y la 4ª gratis) — con la misma fórmula
 * (`ladderTotalCents`) que usa planTargetLines. Un solo origen: si el tier y las
 * líneas divergieran un céntimo, cada edición fallaría con mix_price_mismatch.
 *
 *   perBox        = [28.35, 56.70, 85.05, 85.05, 113.40, 141.75]
 *   compareAtPerBox = tachado coherente con la web: n × compareAt de 1 caja
 *                   (37,80) para 1-3, compareAt del pack (113,40) para 4, y
 *                   pack + (n−4) × 37,80 para 5-6.
 *
 * Cached in-memory for 5 minutes to avoid hitting Shopify Admin on every Plan
 * overlay open. Frequency does NOT affect per-shipment price — cadence is
 * independent.
 */

import { DEFAULT_FLAVOR, FLAVORS, PACK4_PRODUCT_ID, type FlavorKey } from "./seal-plans";
import { ladderTotalCents, MAX_BOXES, type LadderPrices } from "./mix";
import { shopifyAdmin } from "./shopify-admin";

export const CURRENCY = "EUR" as const;
export const PRICING_LAST_UPDATED = "2026-08-22";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface LadderCache {
  prices: LadderPrices;
  oneBoxCompareCents: number | null;
  pack4CompareCents: number | null;
  fetchedAt: number;
}

// Cache is per flavor: each flavor is its own Shopify product with its own 1-box
// price (identical across flavors today, but priced independently). El precio del
// pack es común, pero cachearlo por sabor mantiene la invalidación simple.
const _cache = new Map<FlavorKey, LadderCache>();

interface VariantPrice {
  priceCents: number;
  compareAtCents: number | null;
}

const PRODUCT_PRICES_QUERY = `query litPricing($id: ID!) {
  product(id: $id) {
    variants(first: 50) {
      edges { node { id price compareAtPrice } }
    }
  }
}`;

async function fetchVariantPrices(productId: string): Promise<Map<string, VariantPrice>> {
  const data = await shopifyAdmin.graphql<{
    product: {
      variants: {
        edges: Array<{ node: { id: string; price: string; compareAtPrice: string | null } }>;
      };
    } | null;
  }>(PRODUCT_PRICES_QUERY, { id: `gid://shopify/Product/${productId}` });

  if (!data.product) throw new Error(`Product ${productId} not found`);

  const out = new Map<string, VariantPrice>();
  for (const { node } of data.product.variants.edges) {
    const numericId = node.id.replace(/^gid:\/\/shopify\/ProductVariant\//, "");
    out.set(numericId, {
      priceCents: Math.round(parseFloat(node.price) * 100),
      compareAtCents: node.compareAtPrice ? Math.round(parseFloat(node.compareAtPrice) * 100) : null,
    });
  }
  return out;
}

/** Los dos precios vivos de los que se deriva toda la escalera, en céntimos. */
async function fetchLadder(flavor: FlavorKey): Promise<LadderCache> {
  const def = FLAVORS[flavor];
  const [flavorPrices, packPrices] = await Promise.all([
    fetchVariantPrices(def.productId),
    fetchVariantPrices(PACK4_PRODUCT_ID),
  ]);

  const oneBox = flavorPrices.get(def.variantByBoxCount[1]);
  if (!oneBox) {
    throw new Error(`1-box variant not found: ${def.variantByBoxCount[1]} (${flavor})`);
  }

  // Las 5 variantes de mezcla del pack deben costar lo mismo; si alguien las
  // desalinea en Shopify, cobramos la MÁS BARATA (el redondeo solo puede
  // favorecer al cliente) y dejamos rastro.
  const packValues = [...packPrices.values()];
  if (!packValues.length) throw new Error(`PACK4 product ${PACK4_PRODUCT_ID} has no variants`);
  const pack4Cents = Math.min(...packValues.map((v) => v.priceCents));
  if (packValues.some((v) => v.priceCents !== pack4Cents)) {
    console.warn(
      `[pricing] PACK4 variants have diverging prices (${packValues.map((v) => v.priceCents).join(", ")}c) — using ${pack4Cents}c`,
    );
  }
  const pack4CompareCents = packValues
    .map((v) => v.compareAtCents)
    .filter((v): v is number => v !== null)
    .reduce<number | null>((m, v) => (m === null ? v : Math.max(m, v)), null);

  return {
    prices: { oneBoxCents: oneBox.priceCents, pack4Cents },
    oneBoxCompareCents: oneBox.compareAtCents,
    pack4CompareCents,
    fetchedAt: Date.now(),
  };
}

async function getLadder(flavor: FlavorKey): Promise<LadderCache> {
  const cached = _cache.get(flavor);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const fresh = await fetchLadder(flavor);
  _cache.set(flavor, fresh);
  return fresh;
}

/**
 * Los precios de catálogo (céntimos enteros) que planTargetLines necesita para
 * generar líneas. MISMO origen que getPricing/priceForBoxCount.
 */
export async function getLadderPrices(flavor: FlavorKey = DEFAULT_FLAVOR): Promise<LadderPrices> {
  return (await getLadder(flavor)).prices;
}

/**
 * Get pricing for all box counts of a flavor. Uses in-memory cache (5 min TTL).
 * `perBox[n-1]` es SIEMPRE la escalera web computada, nunca el precio crudo de
 * una variante por tramo.
 */
export async function getPricing(flavor: FlavorKey = DEFAULT_FLAVOR): Promise<{
  perBox: number[];
  compareAtPerBox: (number | null)[];
  isPlaceholder: boolean;
  lastUpdated: string;
}> {
  const { prices, oneBoxCompareCents, pack4CompareCents } = await getLadder(flavor);

  const perBox: number[] = [];
  const compareAtPerBox: (number | null)[] = [];
  for (let boxes = 1; boxes <= MAX_BOXES; boxes++) {
    perBox.push(ladderTotalCents(boxes, prices) / 100);
    let compareCents: number | null = null;
    if (boxes < 4) {
      compareCents = oneBoxCompareCents !== null ? boxes * oneBoxCompareCents : null;
    } else if (pack4CompareCents !== null && oneBoxCompareCents !== null) {
      compareCents = pack4CompareCents + (boxes - 4) * oneBoxCompareCents;
    }
    compareAtPerBox.push(compareCents !== null ? compareCents / 100 : null);
  }
  return { perBox, compareAtPerBox, isPlaceholder: false, lastUpdated: PRICING_LAST_UPDATED };
}

/**
 * Get total per shipment for a given box count + flavor, en la escalera web.
 */
export async function priceForBoxCount(
  boxCount: number,
  flavor: FlavorKey = DEFAULT_FLAVOR,
): Promise<number> {
  if (boxCount < 1 || boxCount > MAX_BOXES) {
    throw new Error(`Invalid box count ${boxCount} — must be 1..${MAX_BOXES}`);
  }
  const { perBox } = await getPricing(flavor);
  return perBox[boxCount - 1];
}

/**
 * Manually invalidate the cache (e.g., after admin updates Shopify variants).
 */
export function invalidatePricingCache(): void {
  _cache.clear();
}

/**
 * Pricing — dynamic from Shopify, computed on the ESCALERA WEB (2026-08-22).
 *
 * La escalera NO se lee de las variantes por tramo (SL60..SL180 conservan sus
 * precios viejos en Shopify como solo-lectura para contratos existentes): se
 * COMPUTA desde dos precios de catálogo vivos, la variante de 1 caja y el producto
 * PACK4 (pagas 3, la 4ª gratis), con la misma fórmula (`ladderTotalCents`) que usa
 * planTargetLines. Un solo origen: si el tier y las líneas divergieran un céntimo,
 * cada edición fallaría con mix_price_mismatch.
 *
 * PRECIO EFECTIVO DE SUSCRIPCIÓN (6-oct-2026). El -25% se muda del precio de la
 * variante a los 8 planes de venta, así que cada precio de la escalera es
 * `precio de la variante × (1 − % del plan)`, con el % leído de los planes del mismo
 * producto y en la MISMA petición GraphQL que el precio. Antes del cambio: 28,35 al
 * 0%; después: 37,80 al 25%. Las dos dan 28,35 (y el pack, 85,05). La lógica pura,
 * las guardas del cambio a medias y sus tests viven en pricing-core.ts.
 *
 *   perBox          = [28.35, 56.70, 85.05, 85.05, 113.40, 141.75]
 *   compareAtPerBox = tachado coherente con la web, SIN descuento de plan: n × 37,80
 *                     para 1-3, el compareAt del pack (151,20) para 4, y pack +
 *                     (n−4) × 37,80 para 5-6. compareAt de la variante o, si no
 *                     tiene, su precio crudo.
 *
 * Caché en memoria de 60 s por sabor (antes 5 min): el cambio de planes y precios se
 * hace en ~1 minuto y una lectura cogida a medias no debe sobrevivir mucho más. Las
 * lecturas a medias que se reconocen (planes que no coinciden, doble descuento, sin
 * descuento, pack que no cuesta 3 cajas) lanzan y NO se cachean. Para ESCRIBIR
 * precios en Seal se usa getLadderPricesForWrite, que nunca lee de la caché.
 *
 * Frequency does NOT affect per-shipment price — cadence is independent (los 8
 * planes llevan el mismo %, y si no, pricing-core lanza).
 */

import {
  confirmLadderForWrite,
  ladderDeltaCents,
  ladderFromProducts,
  PRICING_QUERY,
  pricingTable,
  type LadderSnapshot,
  type ShopifyPricingProduct,
} from "./pricing-core";
import { DEFAULT_FLAVOR, FLAVORS, PACK4_PRODUCT_ID, type FlavorKey } from "./seal-plans";
import { MAX_BOXES, type LadderPrices } from "./mix";
import { shopifyAdmin } from "./shopify-admin";

export { PricingConfigError } from "./pricing-core";

export const CURRENCY = "EUR" as const;
export const PRICING_LAST_UPDATED = "2026-10-06";

/**
 * 60 s. Con 5 minutos, una lectura cogida durante el cambio de planes y precios
 * podía quedarse sirviendo (y, antes de la guarda de escritura, escribiendo) un
 * precio equivocado hasta 5 minutos después de que el cambio hubiera terminado.
 * El coste de bajarlo es una consulta a Admin por minuto, instancia y sabor.
 */
const CACHE_TTL_MS = 60 * 1000;

interface LadderCache extends LadderSnapshot {
  fetchedAt: number;
}

// Cache is per flavor: each flavor is its own Shopify product with its own 1-box
// price (identical across flavors today, but priced independently). El precio del
// pack es común, pero cachearlo por sabor mantiene la invalidación simple.
const _cache = new Map<FlavorKey, LadderCache>();

/** La escalera viva de un sabor, leída de Shopify ahora mismo (sin caché). */
async function fetchLadder(flavor: FlavorKey): Promise<LadderCache> {
  const def = FLAVORS[flavor];
  const data = await shopifyAdmin.graphql<{
    flavor: ShopifyPricingProduct | null;
    pack: ShopifyPricingProduct | null;
  }>(PRICING_QUERY, {
    flavorId: `gid://shopify/Product/${def.productId}`,
    packId: `gid://shopify/Product/${PACK4_PRODUCT_ID}`,
  });

  const snapshot = ladderFromProducts({
    label: flavor,
    oneBoxVariantId: def.variantByBoxCount[1],
    flavorProduct: data.flavor,
    packProduct: data.pack,
    warn: (msg) => console.warn(msg),
  });
  return { ...snapshot, fetchedAt: Date.now() };
}

async function getLadder(flavor: FlavorKey): Promise<LadderCache> {
  const cached = _cache.get(flavor);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const fresh = await fetchLadder(flavor);
  if (cached && ladderDeltaCents(cached.prices, fresh.prices) > 1) {
    console.warn(
      `[pricing] ${flavor}: la escalera de suscripción cambió ${cached.prices.oneBoxCents}/` +
        `${cached.prices.pack4Cents}c → ${fresh.prices.oneBoxCents}/${fresh.prices.pack4Cents}c ` +
        `(variantes ${fresh.rawOneBoxCents}/${fresh.rawPack4Cents}c al ${fresh.planPercentage}%)`,
    );
  }
  _cache.set(flavor, fresh);
  return fresh;
}

/**
 * Los precios de suscripción (céntimos enteros) para COMPARAR o ENSEÑAR: caché de
 * 60 s. MISMO origen que getPricing/priceForBoxCount. Para escribir precios en Seal,
 * getLadderPricesForWrite.
 */
export async function getLadderPrices(flavor: FlavorKey = DEFAULT_FLAVOR): Promise<LadderPrices> {
  return (await getLadder(flavor)).prices;
}

/**
 * Los precios de suscripción para ESCRIBIR en Seal (plan route, cura del cron de
 * renovación). Lee siempre en fresco y, si la escalera se ha movido respecto a la
 * que esta instancia tenía en caché, relee una vez antes de fiarse (ver
 * confirmLadderForWrite). Lanza PricingConfigError si Shopify está a medio cambiar.
 */
export async function getLadderPricesForWrite(flavor: FlavorKey = DEFAULT_FLAVOR): Promise<LadderPrices> {
  const { ladder, refetched } = await confirmLadderForWrite(
    _cache.get(flavor) ?? null,
    () => fetchLadder(flavor),
    (msg) => console.warn(`${msg} (${flavor})`),
  );
  if (refetched) {
    console.warn(
      `[pricing] ${flavor}: escalera confirmada tras releer: ${ladder.prices.oneBoxCents}/${ladder.prices.pack4Cents}c`,
    );
  }
  _cache.set(flavor, ladder);
  return ladder.prices;
}

/**
 * Get pricing for all box counts of a flavor. Uses in-memory cache (60 s TTL).
 * `perBox[n-1]` es SIEMPRE la escalera web de suscripción computada, nunca el
 * precio crudo de una variante.
 */
export async function getPricing(flavor: FlavorKey = DEFAULT_FLAVOR): Promise<{
  perBox: number[];
  compareAtPerBox: (number | null)[];
  isPlaceholder: boolean;
  lastUpdated: string;
}> {
  const { perBox, compareAtPerBox } = pricingTable(await getLadder(flavor));
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
 * Vacía la caché de ESTA instancia. Solo sirve dentro del mismo proceso (scripts,
 * tests): en Vercel cada instancia tiene la suya, así que tras un cambio de precios
 * lo que manda es el TTL de 60 s y, para escribir, getLadderPricesForWrite.
 */
export function invalidatePricingCache(): void {
  _cache.clear();
}

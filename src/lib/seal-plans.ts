/**
 * Mapping of LIT flavors → product variants, plus Seal selling plans.
 *
 * Source of truth for the (flavor, boxCount, frequency) → (variant, sellingPlan)
 * lookup used when changing a customer's plan OR flavor via the portal.
 *
 * IDs verified against Shopify Admin + Seal data 2026-05-06 (Salty Lemon) and
 * Shopify products.json 2026-07-11 (Salty Watermelon, launches 2026-07-15).
 */

import type { Frequency } from "./types";

export type BoxCount = 1 | 2 | 3 | 4 | 5 | 6;

/** Stable key for each LIT flavor. Threaded through the plan route + overlays. */
export type FlavorKey = "salty-lemon" | "salty-watermelon";

export interface FlavorDef {
  key: FlavorKey;
  /** UI label shown in the portal in BOTH languages (Juan 2026-07-11: the
   *  Account card strips the leading "Salty " → shows LEMON / WATERMELON). */
  label: string;
  /** Shopify product id (numeric string). All 6 box-count variants live under it. */
  productId: string;
  /**
   * Variant id by box count (1..6). The variant determines:
   *  - Sachets per shipment (30 / 60 / 90 / 120 / 150 / 180)
   *  - Per-shipment price (bulk discount baked in: 25% / 40% / 45%)
   * Prices are identical across flavors as of launch.
   */
  variantByBoxCount: Record<BoxCount, string>;
}

/**
 * Flavor registry — the source of truth for (flavor, boxCount) → variant.
 *
 * To add a flavor: create the Shopify product with the 6 box-count variants,
 * attach it to the 8 Seal selling plans (SELLING_PLAN_BY_FREQUENCY below), then
 * add an entry here. Everything else (extractFlavor, plan route, overlays,
 * pricing, box-count resolution) is driven off this map.
 */
export const FLAVORS: Record<FlavorKey, FlavorDef> = {
  "salty-lemon": {
    key: "salty-lemon",
    label: "Salty Lemon",
    productId: "16008517550429",
    variantByBoxCount: {
      1: "63887092154717",  // SL30  €28.35 (compare €37.80, -25%)
      2: "64629025341789",  // SL60  €56.70 (compare €75.60, -25%)
      3: "63887092220253",  // SL90  €67.93 (compare €113.40, -40%)
      4: "64629029077341",  // SL120 €90.57 (compare €151.20, -40%)
      5: "64629160477021",  // SL150 €103.95 (compare €189.00, -45%)
      6: "64629047624029",  // SL180 €124.74 (compare €226.80, -45%)
    },
  },
  "salty-watermelon": {
    key: "salty-watermelon",
    label: "Salty Watermelon",
    productId: "16272445112669",
    variantByBoxCount: {
      1: "65046727459165",  // W30  €28.35 (compare €37.80, -25%)
      2: "65046727491933",  // W60  €56.70 (compare €75.60, -25%)
      3: "65046727524701",  // W90  €67.93 (compare €113.40, -40%)
      4: "65046727557469",  // W120 €90.57 (compare €151.20, -40%)
      5: "65046727590237",  // W150 €103.95 (compare €189.00, -45%)
      6: "65046727623005",  // W180 €124.74 (compare €226.80, -45%)
    },
  },
};

/** The flavor every legacy/unmapped subscription and the storefront default to. */
export const DEFAULT_FLAVOR: FlavorKey = "salty-lemon";
export const ALL_FLAVORS: FlavorDef[] = Object.values(FLAVORS);
export const FLAVOR_KEYS: FlavorKey[] = ALL_FLAVORS.map((f) => f.key);

export function isFlavorKey(v: unknown): v is FlavorKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FLAVORS, v);
}

/** Default-flavor product id — kept as a named export for pricing/back-compat. */
export const LIT_PRODUCT_ID = FLAVORS[DEFAULT_FLAVOR].productId;

/** Default-flavor variant map — kept for back-compat (pricing default path). */
export const VARIANT_BY_BOX_COUNT: Record<BoxCount, string> =
  FLAVORS[DEFAULT_FLAVOR].variantByBoxCount;

/**
 * Reverse lookup — variant id → box count, UNIONED across every flavor. Critical:
 * getBoxCount() falls back to quantity=1 for an unmapped variant, which silently
 * breaks the box-count display AND the webhook/hub cache upserts (box_count CHECK
 * 1..6). Every flavor's variants must be here.
 */
export const BOX_COUNT_BY_VARIANT: Record<string, BoxCount> = Object.fromEntries(
  ALL_FLAVORS.flatMap((f) =>
    (Object.entries(f.variantByBoxCount) as [string, string][]).map(
      ([boxes, variantId]) => [variantId, Number(boxes) as BoxCount],
    ),
  ),
);

/** variant id → flavor key, unioned across every flavor. */
export const FLAVOR_BY_VARIANT: Record<string, FlavorKey> = Object.fromEntries(
  ALL_FLAVORS.flatMap((f) =>
    Object.values(f.variantByBoxCount).map((variantId) => [variantId, f.key] as const),
  ),
);

/** product id → flavor key. */
export const FLAVOR_BY_PRODUCT_ID: Record<string, FlavorKey> = Object.fromEntries(
  ALL_FLAVORS.map((f) => [f.productId, f.key] as const),
);

/** Target variant id for a (flavor, boxCount). Null if boxCount out of range. */
export function variantForFlavorBox(flavor: FlavorKey, boxCount: number): string | null {
  if (!Number.isInteger(boxCount) || boxCount < 1 || boxCount > 6) return null;
  return FLAVORS[flavor]?.variantByBoxCount[boxCount as BoxCount] ?? null;
}

/** Flavor key for a variant id (null if unmapped/legacy). */
export function flavorKeyForVariant(variantId: string | null | undefined): FlavorKey | null {
  if (!variantId) return null;
  return FLAVOR_BY_VARIANT[String(variantId)] ?? null;
}

/** Flavor key for a product id (null if unmapped/legacy). */
export function flavorKeyForProductId(productId: string | null | undefined): FlavorKey | null {
  if (!productId) return null;
  return FLAVOR_BY_PRODUCT_ID[String(productId)] ?? null;
}

/** UI label for a flavor key (falls back to the default flavor's label). */
export function flavorLabel(flavor: FlavorKey | null | undefined): string {
  return (FLAVORS[flavor ?? DEFAULT_FLAVOR] ?? FLAVORS[DEFAULT_FLAVOR]).label;
}

/**
 * Seal selling plan ID by frequency. The selling plan determines cadence only;
 * NO discount config (discount is on the variant, not the plan).
 *
 * These are the *canonical* IDs we write on plan changes. Legacy IDs (see
 * LEGACY_SELLING_PLAN_ALIASES) are read-only — subs on those IDs still
 * resolve to a known Frequency, but a plan change migrates them to the
 * canonical IDs.
 */
export const SELLING_PLAN_BY_FREQUENCY: Record<Frequency, string> = {
  "15d": "691259801949", // Envío 15 días
  "1mo": "691259834717", // Envío 1 mes
  "45d": "691259867485", // Envío 45 días
  "2mo": "691259900253", // Envío 2 meses
  "3mo": "691259933021", // Envío 3 meses
  "4mo": "691259965789", // Envío 4 meses
  "5mo": "691259998557", // Envío 5 meses
  "6mo": "691260031325", // Envío 6 meses
};

/**
 * Read-only aliases for legacy selling plan IDs that pre-date the uniform
 * "Envío X días/mes/meses" naming. Subs on these still exist (e.g., Juan's
 * `12635109` uses `690752356701`), so reads must resolve them to a Frequency.
 */
export const LEGACY_SELLING_PLAN_ALIASES: Record<string, Frequency> = {
  "690752356701": "1mo", // "Envío mensual." (legacy, with trailing period)
  "690752389469": "3mo", // "Envío trimestral." (legacy)
};

/**
 * Reverse lookup — selling plan ID back to our Frequency enum. Includes
 * legacy aliases so existing subs render correctly in the UI.
 */
export const FREQUENCY_BY_SELLING_PLAN: Record<string, Frequency> = {
  ...Object.fromEntries(
    (Object.entries(SELLING_PLAN_BY_FREQUENCY) as [Frequency, string][]).map(
      ([freq, id]) => [id, freq],
    ),
  ),
  ...LEGACY_SELLING_PLAN_ALIASES,
};

/**
 * The 6 box-count discount tiers — for UI display.
 *  1-2 boxes: 25%
 *  3-4 boxes: 40%
 *  5-6 boxes: 45%
 */
export const DISCOUNT_BY_BOX_COUNT: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 0.25,
  2: 0.25,
  3: 0.40,
  4: 0.40,
  5: 0.45,
  6: 0.45,
};

/**
 * Mapping of LIT product variants + Seal selling plans.
 *
 * Source of truth for the (boxCount, frequency) → (variant, sellingPlan) lookup
 * used when changing a customer's subscription plan via the portal.
 *
 * IDs verified against Shopify Admin + Seal data 2026-05-06.
 */

import type { Frequency } from "./types";

/**
 * Shopify product ID for LIT Daily Hydration. All 6 variants live under this product.
 */
export const LIT_PRODUCT_ID = "16008517550429";

/**
 * Variant ID by box count (1..6). The variant determines:
 *  - Quantity of sachets per shipment (30 / 60 / 90 / 120 / 150 / 180)
 *  - Per-shipment price (with bulk discount baked in: 25% / 40% / 45%)
 */
export const VARIANT_BY_BOX_COUNT: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: "63887092154717",  // SL30  €28.35 (compare €37.80, -25%)
  2: "64629025341789",  // SL60  €56.70 (compare €75.60, -25%)
  3: "63887092220253",  // SL90  €67.93 (compare €113.40, -40%)
  4: "64629029077341",  // SL120 €90.57 (compare €151.20, -40%)
  5: "64629160477021",  // SL150 €103.95 (compare €189.00, -45%)
  6: "64629047624029",  // SL180 €124.74 (compare €226.80, -45%)
};

/**
 * Reverse lookup — variant ID back to box count.
 */
export const BOX_COUNT_BY_VARIANT: Record<string, 1 | 2 | 3 | 4 | 5 | 6> =
  Object.fromEntries(
    (Object.entries(VARIANT_BY_BOX_COUNT) as [string, string][]).map(([k, v]) => [
      v,
      Number(k) as 1 | 2 | 3 | 4 | 5 | 6,
    ]),
  );

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

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
    // Las variantes 2-6 son la ESCALERA VIEJA: solo lectura (subs existentes las
    // conservan y deben seguir leyéndose igual). Desde la escalera web 2026-08-22
    // planTargetLines solo escribe la variante de 1 caja y el PACK4 de abajo.
    variantByBoxCount: {
      1: "63887092154717",  // SL30  €28.35 (compare €37.80, -25%)
      2: "64629025341789",  // SL60  €56.70 (escalera vieja, solo lectura)
      3: "63887092220253",  // SL90  €67.93 (escalera vieja, solo lectura)
      4: "64629029077341",  // SL120 €90.57 (escalera vieja, solo lectura)
      5: "64629160477021",  // SL150 €103.95 (escalera vieja, solo lectura)
      6: "64629047624029",  // SL180 €124.74 (escalera vieja, solo lectura)
    },
  },
  "salty-watermelon": {
    key: "salty-watermelon",
    label: "Salty Watermelon",
    productId: "16272445112669",
    variantByBoxCount: {
      1: "65046727459165",  // W30  €28.35 (compare €37.80, -25%)
      2: "65046727491933",  // W60  €56.70 (escalera vieja, solo lectura)
      3: "65046727524701",  // W90  €67.93 (escalera vieja, solo lectura)
      4: "65046727557469",  // W120 €90.57 (escalera vieja, solo lectura)
      5: "65046727590237",  // W150 €103.95 (escalera vieja, solo lectura)
      6: "65046727623005",  // W180 €124.74 (escalera vieja, solo lectura)
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

// ─── PACK 3+1 (escalera web, 2026-08-22) ────────────────────────────────────────
//
// El pack de 4 cajas (pagas 3, la 4ª gratis) es UN producto cuyas variantes son
// las combinaciones de sabores. Una suscripción de 4 cajas es UNA línea de este
// producto a 85,05 (precio de catálogo, nunca un descuento); 5-6 cajas = pack +
// líneas de 1 caja a 28,35. IDs y SKUs copiados de Shopify Admin GraphQL el
// 2026-08-22 (scripts/verify-pack-setup.ts los re-verifica contra la tienda).

/** Cajas dentro del pack: pagas 3, recibes 4. */
export const PACK4_BOXES = 4;

/** Producto pack de SUSCRIPCIÓN — el asignado a los 8 selling plans de Seal.
 *  Es el ÚNICO destino de escritura del pack. */
export const PACK4_PRODUCT_ID = "16386839445853";

/** Producto pack de COMPRA ÚNICA — aparece en pedidos web, jamás en contratos
 *  de Seal. Solo lectura (emails de confirmación, Drops). */
export const PACK4_OT_PRODUCT_ID = "16386839478621";

export interface Pack4VariantDef {
  variantId: string;
  /** SKU real de la variante. Viaja verbatim Seal → pedido → Hive, que lo
   *  descompone en cajas (Hive Bundle). */
  sku: string;
  /** Cajas por sabor dentro del pack, en orden canónico (más cajas primero,
   *  empate → orden del registro). Suma exactamente PACK4_BOXES. */
  composition: ReadonlyArray<{ flavor: FlavorKey; boxes: number }>;
}

/** Variantes del pack de suscripción — destino de escritura de planTargetLines. */
export const PACK4_VARIANTS: Pack4VariantDef[] = [
  { variantId: "65636234625373", sku: "PACK4-4L",   composition: [{ flavor: "salty-lemon", boxes: 4 }] },
  { variantId: "65636234658141", sku: "PACK4-3L1W", composition: [{ flavor: "salty-lemon", boxes: 3 }, { flavor: "salty-watermelon", boxes: 1 }] },
  { variantId: "65636234690909", sku: "PACK4-2L2W", composition: [{ flavor: "salty-lemon", boxes: 2 }, { flavor: "salty-watermelon", boxes: 2 }] },
  { variantId: "65636234723677", sku: "PACK4-1L3W", composition: [{ flavor: "salty-watermelon", boxes: 3 }, { flavor: "salty-lemon", boxes: 1 }] },
  { variantId: "65636234756445", sku: "PACK4-4W",   composition: [{ flavor: "salty-watermelon", boxes: 4 }] },
];

/** Variantes del pack de compra única — mismas mezclas y SKUs, solo lectura. */
const PACK4_OT_VARIANTS: Pack4VariantDef[] = [
  { variantId: "65636236788061", sku: "PACK4-4L",   composition: PACK4_VARIANTS[0].composition },
  { variantId: "65636236820829", sku: "PACK4-3L1W", composition: PACK4_VARIANTS[1].composition },
  { variantId: "65636236853597", sku: "PACK4-2L2W", composition: PACK4_VARIANTS[2].composition },
  { variantId: "65636236886365", sku: "PACK4-1L3W", composition: PACK4_VARIANTS[3].composition },
  { variantId: "65636236919133", sku: "PACK4-4W",   composition: PACK4_VARIANTS[4].composition },
];

/**
 * variant id (sub O compra única) → definición del pack. Es el mapa de LECTURA:
 * getLines y order-lines lo usan para traducir una línea pack a su composición
 * multi-sabor. Sin él, la línea caería al fallback "variante desconocida = 1 caja
 * Salty Lemon", que es exactamente cómo se leían mal los 35 contratos migrados.
 */
export const PACK4_BY_VARIANT: Record<string, Pack4VariantDef> = Object.fromEntries(
  [...PACK4_VARIANTS, ...PACK4_OT_VARIANTS].map((v) => [v.variantId, v]),
);

/** Clave canónica de una composición: cuenta por sabor en orden de registro. */
function pack4Key(mix: ReadonlyArray<{ flavor: FlavorKey; boxes: number }>): string {
  return FLAVOR_KEYS
    .map((k) => `${k}:${mix.filter((c) => c.flavor === k).reduce((s, c) => s + c.boxes, 0)}`)
    .join("|");
}

const PACK4_VARIANT_BY_KEY: Record<string, Pack4VariantDef> = Object.fromEntries(
  PACK4_VARIANTS.map((v) => [pack4Key(v.composition), v]),
);

/**
 * Variante del pack de SUSCRIPCIÓN para una composición que sume exactamente 4
 * cajas. Null si no suma 4 o si la mezcla no tiene variante (p. ej. un tercer
 * sabor futuro sin variantes de pack regeneradas).
 */
export function pack4VariantForComposition(
  mix: ReadonlyArray<{ flavor: FlavorKey; boxes: number }>,
): Pack4VariantDef | null {
  const total = mix.reduce((s, c) => s + c.boxes, 0);
  if (total !== PACK4_BOXES) return null;
  return PACK4_VARIANT_BY_KEY[pack4Key(mix)] ?? null;
}

/**
 * Reverse lookup — variant id → box count, UNIONED across every flavor. Critical:
 * getBoxCount() falls back to quantity=1 for an unmapped variant, which silently
 * breaks the box-count display AND the webhook/hub cache upserts (box_count CHECK
 * 1..6). Every flavor's variants must be here — the PACK4 variants included
 * (each pack unit counts 4 boxes).
 */
export const BOX_COUNT_BY_VARIANT: Record<string, BoxCount> = Object.fromEntries([
  ...ALL_FLAVORS.flatMap((f) =>
    (Object.entries(f.variantByBoxCount) as [string, string][]).map(
      ([boxes, variantId]) => [variantId, Number(boxes) as BoxCount],
    ),
  ),
  ...[...PACK4_VARIANTS, ...PACK4_OT_VARIANTS].map(
    (v) => [v.variantId, PACK4_BOXES as BoxCount] as [string, BoxCount],
  ),
]);

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
 * OBSOLETO con la escalera web 2026-08-22 (el descuento por cajas ya no existe:
 * la suscripción es -25% sobre compra única en todos los tramos y el "descuento"
 * de 4+ cajas es el pack 3+1, una caja gratis). Sin usos fuera de este fichero;
 * se conserva solo como referencia de la escalera vieja.
 */
export const DISCOUNT_BY_BOX_COUNT: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 0.25,
  2: 0.25,
  3: 0.40,
  4: 0.40,
  5: 0.45,
  6: 0.45,
};

/**
 * Mapping of LIT flavors → product variants, plus Seal selling plans.
 *
 * Source of truth for the (flavor, boxCount, frequency) → (variant, sellingPlan)
 * lookup used when changing a customer's plan OR flavor via the portal.
 *
 * IDs verified against Shopify Admin + Seal data 2026-05-06 (Salty Lemon) and
 * Shopify products.json 2026-07-11 (Salty Watermelon, launches 2026-07-15).
 * Salty Raw (2026-10-29): las 6 variantes de Juan y las 40 del pack de la respuesta
 * de su creación (theme-backups/20261029-pack-raw-variantes/creadas.json).
 */

import type { Frequency } from "./types";

export type BoxCount = 1 | 2 | 3 | 4 | 5 | 6;

/** Stable key for each LIT flavor. Threaded through the plan route + overlays. */
export type FlavorKey = "salty-lemon" | "salty-watermelon" | "salty-peach" | "salty-raw";

export interface FlavorDef {
  key: FlavorKey;
  /** UI label shown in the portal in BOTH languages (Juan 2026-07-11: the
   *  Account card strips the leading "Salty " → shows LEMON / WATERMELON). */
  label: string;
  /** Shopify product id (numeric string). All 6 box-count variants live under it. */
  productId: string;
  /**
   * Prefijo del SKU de las variantes de este sabor: SL30, W30, P30…
   * Vive aquí a propósito. Antes `mix.ts::skuFor` lo resolvía con un ternario
   * binario (`flavor === "salty-lemon" ? "SL" : "W"`), así que al añadir un tercer
   * sabor las cajas sueltas de melocotón salían con SKU W30 y Hive habría pickeado
   * SANDÍA (el SKU viaja verbatim Seal → pedido → Hive). Al estar en el registro,
   * TypeScript obliga a rellenarlo para cada sabor nuevo.
   */
  skuPrefix: string;
  /**
   * Variant id by box count (1..6). The variant determines:
   *  - Sachets per shipment (30 / 60 / 90 / 120 / 150 / 180)
   *  - The ONE-TIME price since 2026-10-06 (SL30 37,80). Until then the -25% of the
   *    subscription was baked into the variant price (SL30 28,35) and the plans were
   *    at 0%; now it lives in the selling plans. The subscription price is always
   *    computed by pricing.ts as variant × (1 − plan %), never read raw from here.
   * Prices are identical across flavors as of launch.
   */
  variantByBoxCount: Record<BoxCount, string>;
  /**
   * Desde cuándo se OFRECE este sabor (ISO en UTC, contra el reloj del servidor): como
   * destino del cambio de sabor, en el mezclador, en la oferta de la baja y en el bot.
   * Sin él, desde siempre. Solo gatea ELEGIRLO: leer y pintar una línea de este sabor
   * no depende de esto, porque una sub que ya lo lleva (puesta a mano en Seal, o
   * vendida en la tienda) tiene que leerse bien desde el primer minuto.
   * Ver isFlavorOfferable.
   */
  offerableFrom?: string;
}

/**
 * Lanzamiento de Salty Raw: 29-oct-2026 a las 17:00 de Madrid (CET, UTC+1 desde el
 * 25-oct) = 16:00 UTC. Hasta esa hora sus productos siguen en BORRADOR: el portal lee
 * bien una línea Raw pero no lo ofrece como destino.
 */
export const RAW_OFFERABLE_FROM = "2026-10-29T16:00:00Z";

/**
 * Flavor registry — the source of truth for (flavor, boxCount) → variant.
 *
 * To add a flavor: create the Shopify product with the 6 box-count variants,
 * attach it to the 8 Seal selling plans (SELLING_PLAN_BY_FREQUENCY below), then
 * add an entry here. Everything else (extractFlavor, plan route, overlays,
 * pricing, box-count resolution) is driven off this map.
 * Además (Raw, 2026-10-29): su caja y colores en flavor-visuals.ts (tsc lo pide), las
 * variantes de pack con él en las dos listas PACK4 de abajo (test-flavor-registry lo
 * pide) y, si sale a una hora concreta, `offerableFrom`.
 */
export const FLAVORS: Record<FlavorKey, FlavorDef> = {
  "salty-lemon": {
    key: "salty-lemon",
    label: "Salty Lemon",
    productId: "16008517550429",
    skuPrefix: "SL",
    // Las variantes 2-6 son la ESCALERA VIEJA: solo lectura (subs existentes las
    // conservan y deben seguir leyéndose igual). Desde la escalera web 2026-08-22
    // planTargetLines solo escribe la variante de 1 caja y el PACK4 de abajo.
    variantByBoxCount: {
      1: "63887092154717",  // SL30  1 caja (sub 28,35: hasta 6-oct variante a 28,35 al 0%; después 37,80 al 25%)
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
    skuPrefix: "W",
    variantByBoxCount: {
      1: "65046727459165",  // W30  1 caja (sub 28,35, ver SL30)
      2: "65046727491933",  // W60  €56.70 (escalera vieja, solo lectura)
      3: "65046727524701",  // W90  €67.93 (escalera vieja, solo lectura)
      4: "65046727557469",  // W120 €90.57 (escalera vieja, solo lectura)
      5: "65046727590237",  // W150 €103.95 (escalera vieja, solo lectura)
      6: "65046727623005",  // W180 €124.74 (escalera vieja, solo lectura)
    },
  },
  "salty-peach": {
    key: "salty-peach",
    label: "Salty Peach",
    productId: "16272456188253",
    skuPrefix: "P",
    variantByBoxCount: {
      1: "65046790537565",  // P30  1 caja (sub 28,35, ver SL30)
      2: "65046790570333",  // P60  €56.70 (escalera vieja, solo lectura)
      3: "65046790603101",  // P90  €67.93 (escalera vieja, solo lectura)
      4: "65046790635869",  // P120 €90.57 (escalera vieja, solo lectura)
      5: "65046790668637",  // P150 €103.95 (escalera vieja, solo lectura)
      6: "65046790701405",  // P180 €124.74 (escalera vieja, solo lectura)
    },
  },
  // Salty Raw, sin sabor (2026-10-29). Mismo modelo de precio que Peach: variante a
  // precio de compra única y el -25% en los 8 planes de Seal. El producto de compra
  // única (16272465789277, R30 65046850044253) no entra, igual que las cajas sueltas
  // de compra única de los otros sabores: nunca está en un contrato de Seal y, en un
  // pedido, una caja por unidad es justo lo que ya cuenta el fallback por cantidad.
  "salty-raw": {
    key: "salty-raw",
    label: "Salty Raw",
    productId: "16272462053725",
    skuPrefix: "R",
    offerableFrom: RAW_OFFERABLE_FROM,
    variantByBoxCount: {
      1: "65046837297501",  // R30  1 caja (sub 28,35, ver SL30)
      2: "65046837330269",  // R60  (escalera vieja, solo lectura)
      3: "65046837363037",  // R90  (escalera vieja, solo lectura)
      4: "65046837395805",  // R120 (escalera vieja, solo lectura)
      5: "65046837428573",  // R150 (escalera vieja, solo lectura)
      6: "65046837461341",  // R180 (escalera vieja, solo lectura)
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

/**
 * ¿Se puede ELEGIR este sabor ahora? `now` es la hora de quien pregunta: en el
 * servidor, la suya (plan-core, flavor-core y el `offerableFlavors` que
 * mapToSubscription manda a la pantalla). Una fecha ilegible cuenta como «todavía
 * no»: fallar cerrado esconde un sabor un rato; fallar abierto lo vende antes de hora.
 */
export function isFlavorOfferable(flavor: FlavorKey, now: number = Date.now()): boolean {
  const from = FLAVORS[flavor]?.offerableFrom;
  if (!from) return true;
  const at = Date.parse(from);
  return Number.isFinite(at) && now >= at;
}

/** Los sabores que se pueden elegir ahora, en el orden del registro. */
export function offerableFlavorKeys(now: number = Date.now()): FlavorKey[] {
  return FLAVOR_KEYS.filter((k) => isFlavorOfferable(k, now));
}

/**
 * Los sabores que un cambio METERÍA, o a los que subiría cajas, sin poder elegirse
 * todavía. Vacío = puede seguir. Lo que la sub ya lleva no cuenta: cambiarle la
 * frecuencia o quitarle cajas a un sabor que aún no se ofrece no es elegirlo.
 */
export function flavorsNotYetOffered(
  current: ReadonlyArray<{ flavor: FlavorKey; boxes: number }>,
  target: ReadonlyArray<{ flavor: FlavorKey; boxes: number }>,
  now: number = Date.now(),
): FlavorKey[] {
  const boxesOf = (mix: ReadonlyArray<{ flavor: FlavorKey; boxes: number }>, k: FlavorKey) =>
    mix.filter((c) => c.flavor === k).reduce((s, c) => s + c.boxes, 0);
  return FLAVOR_KEYS.filter((k) => !isFlavorOfferable(k, now) && boxesOf(target, k) > boxesOf(current, k));
}

/**
 * Los sabores que ofrece una pantalla: los que el servidor dice que se pueden elegir
 * hoy (`Subscription.offerableFlavors`) más los que la sub ya lleva, para que una
 * mezcla con un sabor aún no ofrecido no pierda su fila. Sin la lista del servidor
 * (no debería pasar) cae al reloj del navegador; el servidor vuelve a mirar al guardar.
 */
export function flavorChoices(
  offerable: readonly FlavorKey[] | null | undefined,
  keep: readonly FlavorKey[] = [],
): FlavorDef[] {
  return ALL_FLAVORS.filter(
    (f) => (offerable ? offerable.includes(f.key) : isFlavorOfferable(f.key)) || keep.includes(f.key),
  );
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
// producto a 85,05 (precio de suscripción, nunca un descuento por línea); 5-6 cajas =
// pack + líneas de 1 caja a 28,35. Desde el 6-oct-2026 la variante vale 113,40 (compra
// única) y el 25% lo pone el plan: pricing.ts calcula el neto. IDs y SKUs copiados de Shopify Admin GraphQL el
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
  // Salty Peach (2026-08-31). Con 3 sabores las mezclas de 4 cajas pasan de 5 a 15
  // (combinaciones con repetición). Estas 10 son las que llevan melocotón; creadas en
  // Shopify el 2026-08-31 y heredan los 8 planes de Seal del producto del pack.
  { variantId: "65753050612061", sku: "PACK4-3L1P",   composition: [{ flavor: "salty-lemon", boxes: 3 }, { flavor: "salty-peach", boxes: 1 }] },
  { variantId: "65753050677597", sku: "PACK4-2L1W1P", composition: [{ flavor: "salty-lemon", boxes: 2 }, { flavor: "salty-watermelon", boxes: 1 }, { flavor: "salty-peach", boxes: 1 }] },
  { variantId: "65753050743133", sku: "PACK4-2L2P",   composition: [{ flavor: "salty-lemon", boxes: 2 }, { flavor: "salty-peach", boxes: 2 }] },
  { variantId: "65753050775901", sku: "PACK4-1L2W1P", composition: [{ flavor: "salty-watermelon", boxes: 2 }, { flavor: "salty-lemon", boxes: 1 }, { flavor: "salty-peach", boxes: 1 }] },
  { variantId: "65753051136349", sku: "PACK4-1L1W2P", composition: [{ flavor: "salty-peach", boxes: 2 }, { flavor: "salty-lemon", boxes: 1 }, { flavor: "salty-watermelon", boxes: 1 }] },
  { variantId: "65753051431261", sku: "PACK4-1L3P",   composition: [{ flavor: "salty-peach", boxes: 3 }, { flavor: "salty-lemon", boxes: 1 }] },
  { variantId: "65753051627869", sku: "PACK4-3W1P",   composition: [{ flavor: "salty-watermelon", boxes: 3 }, { flavor: "salty-peach", boxes: 1 }] },
  { variantId: "65753051660637", sku: "PACK4-2W2P",   composition: [{ flavor: "salty-watermelon", boxes: 2 }, { flavor: "salty-peach", boxes: 2 }] },
  { variantId: "65753051726173", sku: "PACK4-1W3P",   composition: [{ flavor: "salty-peach", boxes: 3 }, { flavor: "salty-watermelon", boxes: 1 }] },
  { variantId: "65753051791709", sku: "PACK4-4P",     composition: [{ flavor: "salty-peach", boxes: 4 }] },
  // Salty Raw (2026-10-29). Con 4 sabores las mezclas pasan de 15 a 35; estas 20 son
  // las que llevan Raw, creadas en Shopify el 2026-10-29 (creadas.json) y heredan los 8
  // planes de Seal del producto del pack. SKU con R al final (PACK4-1L1W1P1R).
  { variantId: "67811578708358", sku: "PACK4-3L1R",   composition: [{ flavor: "salty-lemon", boxes: 3 }, { flavor: "salty-raw", boxes: 1 }] },
  { variantId: "67811578741126", sku: "PACK4-2L1W1R", composition: [{ flavor: "salty-lemon", boxes: 2 }, { flavor: "salty-watermelon", boxes: 1 }, { flavor: "salty-raw", boxes: 1 }] },
  { variantId: "67811578773894", sku: "PACK4-2L1P1R", composition: [{ flavor: "salty-lemon", boxes: 2 }, { flavor: "salty-peach", boxes: 1 }, { flavor: "salty-raw", boxes: 1 }] },
  { variantId: "67811578806662", sku: "PACK4-2L2R",   composition: [{ flavor: "salty-lemon", boxes: 2 }, { flavor: "salty-raw", boxes: 2 }] },
  { variantId: "67811578839430", sku: "PACK4-1L2W1R", composition: [{ flavor: "salty-watermelon", boxes: 2 }, { flavor: "salty-lemon", boxes: 1 }, { flavor: "salty-raw", boxes: 1 }] },
  { variantId: "67811578872198", sku: "PACK4-1L1W1P1R", composition: [{ flavor: "salty-lemon", boxes: 1 }, { flavor: "salty-watermelon", boxes: 1 }, { flavor: "salty-peach", boxes: 1 }, { flavor: "salty-raw", boxes: 1 }] },
  { variantId: "67811578904966", sku: "PACK4-1L1W2R", composition: [{ flavor: "salty-raw", boxes: 2 }, { flavor: "salty-lemon", boxes: 1 }, { flavor: "salty-watermelon", boxes: 1 }] },
  { variantId: "67811578937734", sku: "PACK4-1L2P1R", composition: [{ flavor: "salty-peach", boxes: 2 }, { flavor: "salty-lemon", boxes: 1 }, { flavor: "salty-raw", boxes: 1 }] },
  { variantId: "67811578970502", sku: "PACK4-1L1P2R", composition: [{ flavor: "salty-raw", boxes: 2 }, { flavor: "salty-lemon", boxes: 1 }, { flavor: "salty-peach", boxes: 1 }] },
  { variantId: "67811579003270", sku: "PACK4-1L3R",   composition: [{ flavor: "salty-raw", boxes: 3 }, { flavor: "salty-lemon", boxes: 1 }] },
  { variantId: "67811579036038", sku: "PACK4-3W1R",   composition: [{ flavor: "salty-watermelon", boxes: 3 }, { flavor: "salty-raw", boxes: 1 }] },
  { variantId: "67811579068806", sku: "PACK4-2W1P1R", composition: [{ flavor: "salty-watermelon", boxes: 2 }, { flavor: "salty-peach", boxes: 1 }, { flavor: "salty-raw", boxes: 1 }] },
  { variantId: "67811579101574", sku: "PACK4-2W2R",   composition: [{ flavor: "salty-watermelon", boxes: 2 }, { flavor: "salty-raw", boxes: 2 }] },
  { variantId: "67811579134342", sku: "PACK4-1W2P1R", composition: [{ flavor: "salty-peach", boxes: 2 }, { flavor: "salty-watermelon", boxes: 1 }, { flavor: "salty-raw", boxes: 1 }] },
  { variantId: "67811579167110", sku: "PACK4-1W1P2R", composition: [{ flavor: "salty-raw", boxes: 2 }, { flavor: "salty-watermelon", boxes: 1 }, { flavor: "salty-peach", boxes: 1 }] },
  { variantId: "67811579199878", sku: "PACK4-1W3R",   composition: [{ flavor: "salty-raw", boxes: 3 }, { flavor: "salty-watermelon", boxes: 1 }] },
  { variantId: "67811579232646", sku: "PACK4-3P1R",   composition: [{ flavor: "salty-peach", boxes: 3 }, { flavor: "salty-raw", boxes: 1 }] },
  { variantId: "67811579265414", sku: "PACK4-2P2R",   composition: [{ flavor: "salty-peach", boxes: 2 }, { flavor: "salty-raw", boxes: 2 }] },
  { variantId: "67811579298182", sku: "PACK4-1P3R",   composition: [{ flavor: "salty-raw", boxes: 3 }, { flavor: "salty-peach", boxes: 1 }] },
  { variantId: "67811579330950", sku: "PACK4-4R",     composition: [{ flavor: "salty-raw", boxes: 4 }] },
];

/** Variantes del pack de compra única — mismas mezclas y SKUs, solo lectura.
 *  Exportadas solo para comprobarlas (scripts/verify-pack-setup.ts contra la tienda y
 *  scripts/test-flavor-registry.ts contra sus gemelas de suscripción). */
export const PACK4_OT_VARIANTS: Pack4VariantDef[] = [
  { variantId: "65636236788061", sku: "PACK4-4L",   composition: PACK4_VARIANTS[0].composition },
  { variantId: "65636236820829", sku: "PACK4-3L1W", composition: PACK4_VARIANTS[1].composition },
  { variantId: "65636236853597", sku: "PACK4-2L2W", composition: PACK4_VARIANTS[2].composition },
  { variantId: "65636236886365", sku: "PACK4-1L3W", composition: PACK4_VARIANTS[3].composition },
  { variantId: "65636236919133", sku: "PACK4-4W",   composition: PACK4_VARIANTS[4].composition },
  // Gemelas de compra única de las 10 mezclas con melocotón. Mismo orden que arriba,
  // así que la composición se referencia por índice y no se puede desincronizar.
  { variantId: "65753051824477", sku: "PACK4-3L1P",   composition: PACK4_VARIANTS[5].composition },
  { variantId: "65753051857245", sku: "PACK4-2L1W1P", composition: PACK4_VARIANTS[6].composition },
  { variantId: "65753051890013", sku: "PACK4-2L2P",   composition: PACK4_VARIANTS[7].composition },
  { variantId: "65753051922781", sku: "PACK4-1L2W1P", composition: PACK4_VARIANTS[8].composition },
  { variantId: "65753051955549", sku: "PACK4-1L1W2P", composition: PACK4_VARIANTS[9].composition },
  { variantId: "65753053299037", sku: "PACK4-1L3P",   composition: PACK4_VARIANTS[10].composition },
  { variantId: "65753053364573", sku: "PACK4-3W1P",   composition: PACK4_VARIANTS[11].composition },
  { variantId: "65753053528413", sku: "PACK4-2W2P",   composition: PACK4_VARIANTS[12].composition },
  { variantId: "65753053561181", sku: "PACK4-1W3P",   composition: PACK4_VARIANTS[13].composition },
  { variantId: "65753053593949", sku: "PACK4-4P",     composition: PACK4_VARIANTS[14].composition },
  // Gemelas de compra única de las 20 mezclas con Raw, en el mismo orden.
  { variantId: "67811579396486", sku: "PACK4-3L1R",   composition: PACK4_VARIANTS[15].composition },
  { variantId: "67811579429254", sku: "PACK4-2L1W1R", composition: PACK4_VARIANTS[16].composition },
  { variantId: "67811579462022", sku: "PACK4-2L1P1R", composition: PACK4_VARIANTS[17].composition },
  { variantId: "67811579494790", sku: "PACK4-2L2R",   composition: PACK4_VARIANTS[18].composition },
  { variantId: "67811579527558", sku: "PACK4-1L2W1R", composition: PACK4_VARIANTS[19].composition },
  { variantId: "67811579560326", sku: "PACK4-1L1W1P1R", composition: PACK4_VARIANTS[20].composition },
  { variantId: "67811579593094", sku: "PACK4-1L1W2R", composition: PACK4_VARIANTS[21].composition },
  { variantId: "67811579625862", sku: "PACK4-1L2P1R", composition: PACK4_VARIANTS[22].composition },
  { variantId: "67811579658630", sku: "PACK4-1L1P2R", composition: PACK4_VARIANTS[23].composition },
  { variantId: "67811579691398", sku: "PACK4-1L3R",   composition: PACK4_VARIANTS[24].composition },
  { variantId: "67811579724166", sku: "PACK4-3W1R",   composition: PACK4_VARIANTS[25].composition },
  { variantId: "67811579756934", sku: "PACK4-2W1P1R", composition: PACK4_VARIANTS[26].composition },
  { variantId: "67811579789702", sku: "PACK4-2W2R",   composition: PACK4_VARIANTS[27].composition },
  { variantId: "67811579822470", sku: "PACK4-1W2P1R", composition: PACK4_VARIANTS[28].composition },
  { variantId: "67811579855238", sku: "PACK4-1W1P2R", composition: PACK4_VARIANTS[29].composition },
  { variantId: "67811579888006", sku: "PACK4-1W3R",   composition: PACK4_VARIANTS[30].composition },
  { variantId: "67811579920774", sku: "PACK4-3P1R",   composition: PACK4_VARIANTS[31].composition },
  { variantId: "67811579953542", sku: "PACK4-2P2R",   composition: PACK4_VARIANTS[32].composition },
  { variantId: "67811579986310", sku: "PACK4-1P3R",   composition: PACK4_VARIANTS[33].composition },
  { variantId: "67811580019078", sku: "PACK4-4R",     composition: PACK4_VARIANTS[34].composition },
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
 * cajas. Null si no suma 4 o si la mezcla no tiene variante (p. ej. un sabor
 * futuro sin variantes de pack regeneradas).
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
 * Seal selling plan ID by frequency. The selling plan determines cadence AND, since
 * 2026-10-06, the subscription discount: the 8 plans carry the SAME percentage (25%;
 * 0% before, when the discount was baked into the variant price). pricing-core.ts
 * reads that percentage live and refuses to price if the 8 disagree.
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

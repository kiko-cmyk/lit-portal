/**
 * Precio de SUSCRIPCIÓN desde Shopify: la parte pura (sin red) de pricing.ts.
 *
 * EL DESCUENTO SE MUDA AL PLAN (6-oct-2026, decisión de Juan). Hasta hoy el -25% de
 * la suscripción vivía en el PRECIO DE LA VARIANTE (SL30/W30/P30 = 28,35 y el pack
 * 3+1 = 85,05) y los 8 planes de venta estaban al 0%. Pasa a vivir en los PLANES: los
 * 8 al 25% y las variantes a precio de compra única (37,80 la caja, 113,40 el pack).
 * El neto no cambia: 37,80 × 0,75 = 28,35 y 113,40 × 0,75 = 85,05.
 *
 * Por eso la escalera ya no puede leer `price` a secas. Después del cambio daría
 * 37,80 / 113,40, y el portal escribiría en Seal y enseñaría precios de compra única
 * a suscriptores. Aquí el precio de la escalera es el EFECTIVO de suscripción:
 *
 *     precio de la variante × (1 − % del plan / 100), redondeado al céntimo
 *
 * con el % leído EN LA MISMA PETICIÓN GraphQL que el precio (pricing.ts), así que
 * antes (28,35 al 0%) y después (37,80 al 25%) sale lo mismo: 28,35 y 85,05.
 *
 * NUNCA se cae al precio crudo en silencio. Todo lo que no cuadra lanza
 * PricingConfigError con un código, y quien llama responde 503 y avisa a Slack:
 *  - uno de los 8 planes canónicos que no está en el producto, o con una política
 *    que no sea UN porcentaje fijo (FIXED_AMOUNT, PRICE, una recurrente que cambia
 *    el precio tras N ciclos…): el portal no sabría qué precio escribir;
 *  - planes que no coinciden entre sí, o entre el producto del sabor y el del pack.
 *    Los 8 se actualizan de uno en uno, así que a medias hay unos al 0% y otros al 25%;
 *  - las dos firmas del cambio A MEDIAS, que con los planes ya coherentes entre sí
 *    siguen siendo posibles porque precios y planes no se cambian en el mismo instante:
 *      · DOBLE DESCUENTO: planes ya al 25% y la caja todavía a 28,35. El precio de
 *        la variante es justo su compareAt (37,80) con el descuento del plan ya
 *        aplicado, o sea que el descuento iría dos veces: 21,26.
 *      · SIN DESCUENTO: planes todavía al 0% y la caja ya a 37,80, igual a su
 *        compareAt. La suscripción costaría lo mismo que la compra única.
 *  - PACK 3+1 ROTO: el pack de suscripción tiene que costar lo que 3 cajas sueltas
 *    (±2 céntimos de redondeo). Es lo que la UI promete con todas las letras ("pagas
 *    3 cajas y 1 es gratis") y es lo único que delata el cambio a medias del PACK, que
 *    las firmas de la caja no ven: planes al 25% con el pack todavía a 85,05 → 63,79.
 *
 * El tachado ("precio sin suscripción") NO lleva descuento: es el compareAt de la
 * variante y, si no tiene, su precio crudo. Antes del cambio la caja tacha 37,80 (su
 * compareAt) y después también (compareAt = precio = 37,80); el pack tacha 151,20 en
 * los dos estados (su compareAt desde el 5-oct).
 *
 * Tests: scripts/test-pricing-core.ts (los dos estados, los estados a medias, el
 * redondeo y la guarda de escritura).
 */

import { ladderTotalCents, MAX_BOXES, type LadderPrices } from "./mix";
import { PACK4_BOXES, SELLING_PLAN_BY_FREQUENCY } from "./seal-plans";

export type PricingErrorCode =
  | "product_missing"
  | "variant_missing"
  | "price_invalid"
  | "plan_missing"
  | "policy_unexpected"
  | "plans_disagree"
  | "double_discount"
  | "no_subscription_discount"
  | "pack_not_three_boxes"
  | "pricing_in_flux";

/**
 * La configuración de precios de Shopify no permite saber el precio de suscripción
 * con certeza. Es un error de CONFIGURACIÓN (o de un cambio a medio aplicar), no de
 * red: quien la reciba responde 503 y avisa a Slack, y jamás escribe un precio.
 */
export class PricingConfigError extends Error {
  constructor(public code: PricingErrorCode, message: string) {
    super(`[pricing:${code}] ${message}`);
    this.name = "PricingConfigError";
  }
}

// ─── La consulta a Admin GraphQL y la forma de su respuesta ─────────────────────

export interface ShopifyPricingPolicy {
  __typename: string;
  adjustmentType?: string | null;
  adjustmentValue?: { __typename?: string; percentage?: number | null } | null;
}

export interface ShopifyPricingProduct {
  variants: {
    edges: Array<{ node: { id: string; price: string; compareAtPrice: string | null } }>;
  };
  sellingPlanGroups: {
    edges: Array<{
      node: {
        sellingPlans: {
          edges: Array<{ node: { id: string; pricingPolicies: ShopifyPricingPolicy[] } }>;
        };
      };
    }>;
  };
}

const PRICING_PRODUCT_FIELDS = `
    variants(first: 50) {
      edges { node { id price compareAtPrice } }
    }
    sellingPlanGroups(first: 20) {
      edges { node { sellingPlans(first: 20) { edges { node {
        id
        pricingPolicies {
          __typename
          ... on SellingPlanFixedPricingPolicy {
            adjustmentType
            adjustmentValue {
              __typename
              ... on SellingPlanPricingPolicyPercentageValue { percentage }
            }
          }
        }
      } } } } }
    }`;

/**
 * UNA sola petición para los dos productos y para precio + planes: así el precio y
 * el % que se combinan son de la misma foto. Con dos peticiones, una podía pillar el
 * estado de antes y la otra el de después del cambio.
 *
 * `product.sellingPlanGroups` devuelve también los grupos de OTRAS apps (los de Seal);
 * el `sellingPlanGroups` de la raíz, no: solo los de la app que pregunta, y saldría
 * vacío. Verificado el 6-oct-2026 en la API 2026-04 con un token de la app cuyas
 * credenciales usa el portal en producción (SHOPIFY_ADMIN_CLIENT_ID, la que tiene
 * `read_purchase_options`). Lo usan pricing.ts y scripts/verify-pack-setup.ts.
 */
export const PRICING_QUERY = `query litPricing($flavorId: ID!, $packId: ID!) {
  flavor: product(id: $flavorId) {${PRICING_PRODUCT_FIELDS}
  }
  pack: product(id: $packId) {${PRICING_PRODUCT_FIELDS}
  }
}`;

/** Lo que la escalera necesita de Shopify, ya resuelto y validado. */
export interface LadderSnapshot {
  /** Precios EFECTIVOS de suscripción (variante × (1 − % del plan)), céntimos. */
  prices: LadderPrices;
  /** Tachado de la caja suelta: compareAt, o el precio crudo si no tiene. */
  oneBoxCompareCents: number;
  /** Tachado del pack: el mayor compareAt (o precio crudo) de sus variantes. */
  pack4CompareCents: number;
  /** El % común de los 8 planes (0 antes del cambio, 25 después). */
  planPercentage: number;
  /** Precios crudos de las variantes, solo para logs y avisos. */
  rawOneBoxCents: number;
  rawPack4Cents: number;
}

/** Tolerancia de redondeo de la regla del pack 3+1, en céntimos. 3 × round(x) y
 *  round(3x) pueden separarse hasta 2 céntimos sin que nadie haya hecho nada mal. */
const PACK_RULE_TOLERANCE_CENTS = 2;

/** Cajas que se PAGAN en el pack 3+1. */
const PACK_PAID_BOXES = PACK4_BOXES - 1;

/** "28.35" → 2835. Lanza ante cualquier cosa que no sea un importe positivo. */
function moneyToCents(value: string, what: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new PricingConfigError("price_invalid", `${what}: precio inválido "${value}"`);
  }
  return Math.round(n * 100);
}

/**
 * Aplica el % del plan a un precio en céntimos y redondea al céntimo MÁS CERCANO, con
 * los medios hacia arriba (half-up), que es el redondeo comercial de Shopify.
 *
 * En aritmética ENTERA, sin floats: 37.8 * 0.75 en JavaScript da 28.349999999999998,
 * y un Math.floor mal puesto lo deja en 28,34. Con enteros, 3780 × 7500 / 10000 es
 * exactamente 2835. El % se acepta con hasta 2 decimales (puntos básicos enteros):
 * más precisión no es un dato de Shopify sino un error, y lanza.
 *
 * Los importes reales del cambio son EXACTOS (37,80 → 28,35; 113,40 → 85,05; 75,60 →
 * 56,70; 151,20 → 113,40; 189,00 → 141,75), así que no dependen del criterio de
 * redondeo. El half-up solo decide en un medio céntimo exacto, y ese caso no se ha
 * podido contrastar con un checkout real de Shopify.
 */
export function applyPlanPercentageCents(priceCents: number, percentage: number): number {
  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    throw new PricingConfigError("price_invalid", `precio en céntimos inválido: ${priceCents}`);
  }
  if (!Number.isFinite(percentage) || percentage < 0 || percentage >= 100) {
    throw new PricingConfigError("policy_unexpected", `porcentaje de plan fuera de rango: ${percentage}`);
  }
  const basisPoints = Math.round(percentage * 100);
  if (Math.abs(percentage * 100 - basisPoints) > 1e-6) {
    throw new PricingConfigError(
      "policy_unexpected",
      `porcentaje de plan con más de 2 decimales: ${percentage}`,
    );
  }
  const numerator = priceCents * (10_000 - basisPoints);
  // round-half-up(numerator / 10000) = floor((2·numerator + 10000) / 20000)
  return Math.floor((2 * numerator + 10_000) / 20_000);
}

/**
 * El % de descuento de los 8 planes canónicos (SELLING_PLAN_BY_FREQUENCY) tal como
 * los ve ESTE producto. Los 8 tienen que estar, cada uno con una única política de
 * porcentaje fijo, y todos con el mismo %. Los planes que no son canónicos (si algún
 * día se adjunta otro grupo) se ignoran: el portal nunca escribe con ellos.
 *
 * Un plan sin ninguna política es un 0% (así lo trata Shopify: no ajusta el precio).
 */
export function planPercentageForProduct(product: ShopifyPricingProduct, label: string): number {
  const policiesByPlan = new Map<string, ShopifyPricingPolicy[]>();
  for (const { node: group } of product.sellingPlanGroups.edges) {
    for (const { node: plan } of group.sellingPlans.edges) {
      policiesByPlan.set(plan.id.replace(/^gid:\/\/shopify\/SellingPlan\//, ""), plan.pricingPolicies ?? []);
    }
  }

  const seen: Array<{ planId: string; percentage: number }> = [];
  for (const [frequency, planId] of Object.entries(SELLING_PLAN_BY_FREQUENCY)) {
    const policies = policiesByPlan.get(planId);
    if (!policies) {
      throw new PricingConfigError(
        "plan_missing",
        `${label}: el plan ${planId} (${frequency}) no está adjunto al producto`,
      );
    }
    if (policies.length === 0) {
      seen.push({ planId, percentage: 0 });
      continue;
    }
    if (policies.length > 1) {
      throw new PricingConfigError(
        "policy_unexpected",
        `${label}: el plan ${planId} (${frequency}) tiene ${policies.length} políticas de precio ` +
          `(¿una recurrente tras N ciclos?); el portal solo sabe tarificar un porcentaje fijo`,
      );
    }
    const [p] = policies;
    const percentage = p.adjustmentValue?.percentage;
    if (
      p.__typename !== "SellingPlanFixedPricingPolicy" ||
      p.adjustmentType !== "PERCENTAGE" ||
      typeof percentage !== "number"
    ) {
      throw new PricingConfigError(
        "policy_unexpected",
        `${label}: el plan ${planId} (${frequency}) tiene una política ${p.__typename}/` +
          `${p.adjustmentType ?? "?"}; el portal solo sabe tarificar un porcentaje fijo`,
      );
    }
    seen.push({ planId, percentage });
  }

  const distinct = [...new Set(seen.map((s) => s.percentage))];
  if (distinct.length !== 1) {
    throw new PricingConfigError(
      "plans_disagree",
      `${label}: los planes no coinciden (${seen.map((s) => `${s.planId}=${s.percentage}%`).join(", ")}). ` +
        `¿Cambio de planes a medio aplicar?`,
    );
  }
  return distinct[0];
}

/**
 * Del snapshot crudo de Shopify (producto del sabor + producto del pack, leídos en la
 * MISMA petición) a la escalera de suscripción. Lanza PricingConfigError ante
 * cualquier incoherencia; ver la cabecera del fichero.
 */
export function ladderFromProducts(args: {
  label: string;
  oneBoxVariantId: string;
  flavorProduct: ShopifyPricingProduct | null;
  packProduct: ShopifyPricingProduct | null;
  /** Para dejar rastro si las variantes del pack divergen (sin efecto en el cálculo). */
  warn?: (msg: string) => void;
}): LadderSnapshot {
  const { label, oneBoxVariantId, flavorProduct, packProduct } = args;
  if (!flavorProduct) throw new PricingConfigError("product_missing", `${label}: producto del sabor no encontrado`);
  if (!packProduct) throw new PricingConfigError("product_missing", `${label}: producto del pack no encontrado`);

  const numericId = (gid: string) => gid.replace(/^gid:\/\/shopify\/ProductVariant\//, "");

  const oneBoxNode = flavorProduct.variants.edges.find((e) => numericId(e.node.id) === oneBoxVariantId)?.node;
  if (!oneBoxNode) {
    throw new PricingConfigError("variant_missing", `${label}: variante de 1 caja ${oneBoxVariantId} no encontrada`);
  }
  const oneBoxPrice = moneyToCents(oneBoxNode.price, `${label} 1 caja`);
  const oneBoxCompare = oneBoxNode.compareAtPrice ? moneyToCents(oneBoxNode.compareAtPrice, `${label} 1 caja compareAt`) : null;

  const packNodes = packProduct.variants.edges.map((e) => e.node);
  if (!packNodes.length) throw new PricingConfigError("variant_missing", `${label}: el pack no tiene variantes`);
  const packPrices = packNodes.map((n) => moneyToCents(n.price, `${label} pack ${numericId(n.id)}`));
  // Las variantes de mezcla del pack deben costar lo mismo; si alguien las desalinea
  // en Shopify, se cobra la MÁS BARATA (el redondeo solo puede favorecer al cliente) y
  // se deja rastro. Si la causa es un cambio de precios a medias, la regla del pack
  // 3+1 de abajo lo para.
  const rawPack4 = Math.min(...packPrices);
  if (packPrices.some((c) => c !== rawPack4)) {
    args.warn?.(`[pricing] PACK4 variants have diverging prices (${packPrices.join(", ")}c) — using ${rawPack4}c`);
  }
  const pack4Compare = Math.max(
    ...packNodes.map((n, i) =>
      n.compareAtPrice ? moneyToCents(n.compareAtPrice, `${label} pack compareAt`) : packPrices[i],
    ),
  );

  // Planes: los 8 del sabor y los 8 del pack son los MISMOS grupos de Seal, así que
  // tienen que decir lo mismo. Si no, una de las dos lecturas pilló el cambio a medias.
  const flavorPct = planPercentageForProduct(flavorProduct, `${label} (sabor)`);
  const packPct = planPercentageForProduct(packProduct, `${label} (pack)`);
  if (flavorPct !== packPct) {
    throw new PricingConfigError(
      "plans_disagree",
      `${label}: los planes dicen ${flavorPct}% en el sabor y ${packPct}% en el pack`,
    );
  }
  const pct = flavorPct;

  const oneBoxCents = applyPlanPercentageCents(oneBoxPrice, pct);
  const pack4Cents = applyPlanPercentageCents(rawPack4, pct);

  // ── Firmas del cambio a medias (ver cabecera) ──
  if (
    pct > 0 &&
    oneBoxCompare !== null &&
    oneBoxPrice < oneBoxCompare &&
    Math.abs(oneBoxPrice - applyPlanPercentageCents(oneBoxCompare, pct)) <= 1
  ) {
    throw new PricingConfigError(
      "double_discount",
      `${label}: la caja vale ${oneBoxPrice}c, que ya es su compareAt ${oneBoxCompare}c con el ` +
        `${pct}% del plan aplicado, y el plan lo volvería a descontar (${oneBoxCents}c). ` +
        `¿Planes cambiados y precios de variante todavía no?`,
    );
  }
  if (pct === 0 && oneBoxCompare !== null && oneBoxPrice >= oneBoxCompare) {
    throw new PricingConfigError(
      "no_subscription_discount",
      `${label}: planes al 0% y la caja a ${oneBoxPrice}c, igual o por encima de su compareAt ` +
        `${oneBoxCompare}c: la suscripción costaría lo mismo que la compra única. ` +
        `¿Precios de variante cambiados y planes todavía no?`,
    );
  }
  if (Math.abs(pack4Cents - PACK_PAID_BOXES * oneBoxCents) > PACK_RULE_TOLERANCE_CENTS) {
    throw new PricingConfigError(
      "pack_not_three_boxes",
      `${label}: el pack de suscripción sale a ${pack4Cents}c y 3 cajas a ${PACK_PAID_BOXES * oneBoxCents}c ` +
        `(variantes ${oneBoxPrice}c / ${rawPack4}c al ${pct}%). La UI promete "pagas 3 y 1 es ` +
        `gratis". ¿Precio del pack o de la caja cambiado y el otro todavía no?`,
    );
  }

  return {
    prices: { oneBoxCents, pack4Cents },
    oneBoxCompareCents: oneBoxCompare ?? oneBoxPrice,
    pack4CompareCents: pack4Compare,
    planPercentage: pct,
    rawOneBoxCents: oneBoxPrice,
    rawPack4Cents: rawPack4,
  };
}

/**
 * La tabla que enseña la UI (PlanOverlay, FlavorOverlay, SkipOverlay, CancelTakeover):
 * total por envío de 1..6 cajas en la escalera de suscripción, y su tachado coherente
 * con la web: n × tachado de la caja para 1-3, el tachado del pack para 4, y pack +
 * (n − 4) × caja para 5-6. En euros, como los consume /api/pricing.
 */
export function pricingTable(snapshot: LadderSnapshot): { perBox: number[]; compareAtPerBox: number[] } {
  const perBox: number[] = [];
  const compareAtPerBox: number[] = [];
  for (let boxes = 1; boxes <= MAX_BOXES; boxes++) {
    perBox.push(ladderTotalCents(boxes, snapshot.prices) / 100);
    const compareCents =
      boxes < PACK4_BOXES
        ? boxes * snapshot.oneBoxCompareCents
        : snapshot.pack4CompareCents + (boxes - PACK4_BOXES) * snapshot.oneBoxCompareCents;
    compareAtPerBox.push(compareCents / 100);
  }
  return { perBox, compareAtPerBox };
}

/** Máxima diferencia en céntimos entre dos escaleras (caja o pack). */
export function ladderDeltaCents(a: LadderPrices, b: LadderPrices): number {
  return Math.max(Math.abs(a.oneBoxCents - b.oneBoxCents), Math.abs(a.pack4Cents - b.pack4Cents));
}

/**
 * GUARDA DE ESCRITURA. Antes de usar la escalera para ESCRIBIR precios en Seal (plan
 * route, cura del cron de renovación) se lee fresca, nunca de la caché. Si difiere en
 * más de 1 céntimo de la que esta instancia tenía (`previous`), se relee UNA vez:
 *   - la relectura coincide con la lectura fresca → el cambio es real (una subida o
 *     bajada de tarifa de verdad, ya estable) y se usa;
 *   - la relectura tampoco coincide → los precios se están moviendo ahora mismo y se
 *     lanza `pricing_in_flux`. No se escribe nada.
 * Si `previous` es la que estaba mal (una lectura vieja cogida a medias), la lectura
 * fresca la sustituye sin más.
 *
 * Límite asumido: en una instancia fría no hay `previous` con el que comparar. Lo que
 * cubre ese hueco son las firmas de ladderFromProducts, que no dependen de la historia.
 */
export async function confirmLadderForWrite<T extends { prices: LadderPrices }>(
  previous: T | null,
  fetchFresh: () => Promise<T>,
  log?: (msg: string) => void,
): Promise<{ ladder: T; refetched: boolean }> {
  const fresh = await fetchFresh();
  if (!previous || ladderDeltaCents(previous.prices, fresh.prices) <= 1) {
    return { ladder: fresh, refetched: false };
  }
  log?.(
    `[pricing] la escalera cambió respecto a la caché (${previous.prices.oneBoxCents}/${previous.prices.pack4Cents}c → ` +
      `${fresh.prices.oneBoxCents}/${fresh.prices.pack4Cents}c); se relee antes de escribir`,
  );
  const again = await fetchFresh();
  if (ladderDeltaCents(again.prices, fresh.prices) > 1) {
    throw new PricingConfigError(
      "pricing_in_flux",
      `dos lecturas seguidas no coinciden (${fresh.prices.oneBoxCents}/${fresh.prices.pack4Cents}c y ` +
        `${again.prices.oneBoxCents}/${again.prices.pack4Cents}c): los precios se están cambiando ahora mismo`,
    );
  }
  return { ladder: again, refetched: true };
}

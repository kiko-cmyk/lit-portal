/**
 * Tests de src/lib/pricing-core.ts. Sin framework, como el resto de scripts de test
 * del repo: aserciones a mano y respuestas de Shopify construidas a mano.
 *
 *   npm test
 *   npx tsx scripts/test-pricing-core.ts
 *
 * Qué protege. El 6-oct-2026 el -25% de la suscripción se muda del precio de la
 * variante a los 8 planes de venta. El portal escribe precios en Seal a partir de
 * esta escalera, así que los casos que no se pueden romper son:
 *   - ANTES (caja 28,35 / pack 85,05, planes al 0%) y DESPUÉS (37,80 / 113,40, planes
 *     al 25%) dan la MISMA escalera: 28,35 la caja y 85,05 el pack;
 *   - el tachado sigue siendo 37,80 por caja y 151,20 por pack en los dos estados;
 *   - cualquier estado a medias (planes que no coinciden, doble descuento, sin
 *     descuento, pack que no cuesta 3 cajas) LANZA, nunca devuelve un precio;
 *   - el redondeo es entero y half-up, y los importes reales del cambio son exactos;
 *   - la guarda de escritura relee cuando la escalera se ha movido y para si dos
 *     lecturas seguidas no coinciden.
 */

import {
  applyPlanPercentageCents,
  confirmLadderForWrite,
  ladderFromProducts,
  PricingConfigError,
  pricingTable,
  type PricingErrorCode,
  type ShopifyPricingPolicy,
  type ShopifyPricingProduct,
} from "@/lib/pricing-core";
import { planTargetLines, type LadderPrices } from "@/lib/mix";
import { FLAVORS, PACK4_VARIANTS, SELLING_PLAN_BY_FREQUENCY } from "@/lib/seal-plans";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function throwsCode(name: string, fn: () => unknown, code: PricingErrorCode) {
  try {
    const out = fn();
    failures++;
    console.error(`✗ ${name} — no lanzó nada (devolvió ${JSON.stringify(out)}), se esperaba ${code}`);
  } catch (err) {
    const actual = err instanceof PricingConfigError ? err.code : `${(err as Error)?.name}: ${(err as Error)?.message}`;
    check(name, actual === code, `lanzó ${actual}`);
  }
}

async function rejectsCode(name: string, p: Promise<unknown>, code: PricingErrorCode) {
  try {
    await p;
    failures++;
    console.error(`✗ ${name} — no lanzó nada, se esperaba ${code}`);
  } catch (err) {
    const actual = err instanceof PricingConfigError ? err.code : String(err);
    check(name, actual === code, `lanzó ${actual}`);
  }
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ─── Respuestas de Shopify de mentira ───────────────────────────────────────────

const PLAN_IDS = Object.values(SELLING_PLAN_BY_FREQUENCY);

const pctPolicy = (percentage: number): ShopifyPricingPolicy[] => [
  {
    __typename: "SellingPlanFixedPricingPolicy",
    adjustmentType: "PERCENTAGE",
    adjustmentValue: { __typename: "SellingPlanPricingPolicyPercentageValue", percentage },
  },
];

/** Un grupo por plan, como los de Seal. `policies(i)` da las políticas del plan i. */
function product(
  variants: Array<{ id: string; price: string; compareAtPrice: string | null }>,
  policies: (i: number, planId: string) => ShopifyPricingPolicy[] | null,
): ShopifyPricingProduct {
  return {
    variants: {
      edges: variants.map((v) => ({ node: { ...v, id: `gid://shopify/ProductVariant/${v.id}` } })),
    },
    sellingPlanGroups: {
      edges: PLAN_IDS.flatMap((planId, i) => {
        const p = policies(i, planId);
        return p === null
          ? []
          : [{ node: { sellingPlans: { edges: [{ node: { id: `gid://shopify/SellingPlan/${planId}`, pricingPolicies: p } }] } } }];
      }),
    },
  };
}

const LEMON = FLAVORS["salty-lemon"];
const ONE_BOX = LEMON.variantByBoxCount[1];

/** Producto del sabor: SL30..SL180 con los precios dados para la caja suelta. */
function flavorProduct(oneBox: string, compareAt: string | null, pct: number | ((i: number) => number)) {
  const others = (["2", "3", "4", "5", "6"] as const).map((n) => ({
    id: LEMON.variantByBoxCount[Number(n) as 2 | 3 | 4 | 5 | 6],
    price: "99.99",
    compareAtPrice: null,
  }));
  return product(
    [{ id: ONE_BOX, price: oneBox, compareAtPrice: compareAt }, ...others],
    (i) => pctPolicy(typeof pct === "number" ? pct : pct(i)),
  );
}

/** Producto del pack: las 15 variantes al mismo precio y compareAt. */
function packProduct(price: string, compareAt: string | null, pct: number | ((i: number) => number)) {
  return product(
    PACK4_VARIANTS.map((v) => ({ id: v.variantId, price, compareAtPrice: compareAt })),
    (i) => pctPolicy(typeof pct === "number" ? pct : pct(i)),
  );
}

function ladder(fp: ShopifyPricingProduct | null, pp: ShopifyPricingProduct | null, warn?: (m: string) => void) {
  return ladderFromProducts({ label: "salty-lemon", oneBoxVariantId: ONE_BOX, flavorProduct: fp, packProduct: pp, warn });
}

// Los dos estados buenos.
const ANTES = () => ladder(flavorProduct("28.35", "37.80", 0), packProduct("85.05", "151.20", 0));
const DESPUES = () => ladder(flavorProduct("37.80", "37.80", 25), packProduct("113.40", "151.20", 25));

const PER_BOX = [28.35, 56.7, 85.05, 85.05, 113.4, 141.75];
const TACHADO = [37.8, 75.6, 113.4, 151.2, 189, 226.8];

function run() {
  // ── Redondeo ──
  check("37,80 al 25% = 28,35 exacto", applyPlanPercentageCents(3780, 25) === 2835);
  check("113,40 al 25% = 85,05 exacto", applyPlanPercentageCents(11340, 25) === 8505);
  check(
    "SL60..SL180 al 25%: 75,60→56,70 · 113,40→85,05 · 151,20→113,40 · 189,00→141,75",
    eq([7560, 11340, 15120, 18900].map((c) => applyPlanPercentageCents(c, 25)), [5670, 8505, 11340, 14175]),
  );
  check("0% deja el precio tal cual", applyPlanPercentageCents(2835, 0) === 2835);
  check(
    "en float 37.8 × 0.75 NO es 28.35 (por eso enteros)",
    37.8 * 0.75 !== 28.35 && applyPlanPercentageCents(3780, 25) === 2835,
    String(37.8 * 0.75),
  );
  check("28,35 al 25% = 21,2625 → 21,26 (redondeo hacia abajo)", applyPlanPercentageCents(2835, 25) === 2126);
  check("85,05 al 25% = 63,7875 → 63,79 (redondeo hacia arriba)", applyPlanPercentageCents(8505, 25) === 6379);
  check("medio céntimo exacto sube (half-up): 0,02 al 25% = 0,015 → 0,02", applyPlanPercentageCents(2, 25) === 2);
  check("medio céntimo exacto sube (half-up): 0,10 al 15% = 0,085 → 0,09", applyPlanPercentageCents(10, 15) === 9);
  check("% con 2 decimales se acepta: 10,00 al 12,5% = 8,75", applyPlanPercentageCents(1000, 12.5) === 875);
  throwsCode("% con más de 2 decimales lanza", () => applyPlanPercentageCents(3780, 12.345), "policy_unexpected");
  throwsCode("100% lanza", () => applyPlanPercentageCents(3780, 100), "policy_unexpected");
  throwsCode("% negativo lanza", () => applyPlanPercentageCents(3780, -5), "policy_unexpected");
  throwsCode("precio no entero lanza", () => applyPlanPercentageCents(37.8, 25), "price_invalid");

  // ── ANTES del cambio ──
  const antes = ANTES();
  check("antes: caja 28,35 y pack 85,05", eq(antes.prices, { oneBoxCents: 2835, pack4Cents: 8505 }), JSON.stringify(antes.prices));
  check("antes: planes al 0%", antes.planPercentage === 0);
  check("antes: tachado caja 37,80 y pack 151,20", antes.oneBoxCompareCents === 3780 && antes.pack4CompareCents === 15120);
  const tAntes = pricingTable(antes);
  check("antes: escalera 1..6", eq(tAntes.perBox, PER_BOX), JSON.stringify(tAntes.perBox));
  check("antes: tachado 1..6", eq(tAntes.compareAtPerBox, TACHADO), JSON.stringify(tAntes.compareAtPerBox));

  // ── DESPUÉS del cambio ──
  const despues = DESPUES();
  check("después: caja 28,35 y pack 85,05", eq(despues.prices, { oneBoxCents: 2835, pack4Cents: 8505 }), JSON.stringify(despues.prices));
  check("después: planes al 25%", despues.planPercentage === 25);
  check("después: precios crudos 37,80 y 113,40", despues.rawOneBoxCents === 3780 && despues.rawPack4Cents === 11340);
  check("después: tachado caja 37,80 y pack 151,20", despues.oneBoxCompareCents === 3780 && despues.pack4CompareCents === 15120);
  const tDespues = pricingTable(despues);
  check("después: escalera 1..6 idéntica a antes", eq(tDespues.perBox, tAntes.perBox), JSON.stringify(tDespues.perBox));
  check("después: tachado 1..6 idéntico a antes", eq(tDespues.compareAtPerBox, tAntes.compareAtPerBox), JSON.stringify(tDespues.compareAtPerBox));

  // Sin compareAt, el tachado es el precio crudo (nunca el descontado).
  const sinCompare = ladder(flavorProduct("37.80", null, 25), packProduct("113.40", null, 25));
  check("después sin compareAt: caja 28,35, tachado 37,80 (precio crudo)", sinCompare.prices.oneBoxCents === 2835 && sinCompare.oneBoxCompareCents === 3780);
  check("después sin compareAt: pack 85,05, tachado 113,40 (precio crudo)", sinCompare.prices.pack4Cents === 8505 && sinCompare.pack4CompareCents === 11340);

  // Las líneas que se escriben en Seal salen de la misma escalera en los dos estados.
  const mix = [{ flavor: "salty-lemon" as const, boxes: 3 }, { flavor: "salty-watermelon" as const, boxes: 2 }];
  const linesAntes = planTargetLines(mix, antes.prices);
  const linesDespues = planTargetLines(mix, despues.prices);
  check(
    "5 cajas: mismas líneas y 113,40 antes y después",
    linesAntes.totalCents === 11340 && eq(linesAntes.lines, linesDespues.lines),
    `${linesAntes.totalCents} / ${linesDespues.totalCents}`,
  );
  check(
    "5 cajas: el pack se escribe a 85,05 y la suelta a 28,35, nunca a 113,40 / 37,80",
    eq(linesDespues.lines.map((l) => l.unitPriceCents).sort(), [2835, 8505]),
    JSON.stringify(linesDespues.lines.map((l) => l.unitPriceCents)),
  );

  // Un plan sin política es un 0% (así lo trata Shopify).
  const sinPolitica = ladder(
    product([{ id: ONE_BOX, price: "28.35", compareAtPrice: "37.80" }], () => []),
    product(PACK4_VARIANTS.map((v) => ({ id: v.variantId, price: "85.05", compareAtPrice: "151.20" })), () => []),
  );
  check("planes sin política = 0%: caja 28,35", sinPolitica.prices.oneBoxCents === 2835 && sinPolitica.planPercentage === 0);

  // ── Estados A MEDIAS: todos lanzan ──
  throwsCode(
    "a medias: planes al 25% y caja todavía a 28,35 (doble descuento → 21,26)",
    () => ladder(flavorProduct("28.35", "37.80", 25), packProduct("85.05", "151.20", 25)),
    "double_discount",
  );
  throwsCode(
    "a medias: caja ya a 37,80 y planes todavía al 0% (sin descuento → 37,80)",
    () => ladder(flavorProduct("37.80", "37.80", 0), packProduct("85.05", "151.20", 0)),
    "no_subscription_discount",
  );
  throwsCode(
    "a medias: caja y pack ya a compra única y planes al 0% (37,80 / 113,40)",
    () => ladder(flavorProduct("37.80", "37.80", 0), packProduct("113.40", "151.20", 0)),
    "no_subscription_discount",
  );
  throwsCode(
    "a medias: planes al 25%, caja cambiada y pack todavía a 85,05 (→ 63,79)",
    () => ladder(flavorProduct("37.80", "37.80", 25), packProduct("85.05", "151.20", 25)),
    "pack_not_three_boxes",
  );
  throwsCode(
    "a medias: planes al 0%, caja sin cambiar y pack ya a 113,40",
    () => ladder(flavorProduct("28.35", "37.80", 0), packProduct("113.40", "151.20", 0)),
    "pack_not_three_boxes",
  );
  throwsCode(
    "a medias: 4 planes al 25% y 4 al 0%",
    () => ladder(flavorProduct("37.80", "37.80", (i) => (i < 4 ? 25 : 0)), packProduct("113.40", "151.20", (i) => (i < 4 ? 25 : 0))),
    "plans_disagree",
  );
  throwsCode(
    "a medias: el sabor ve los planes al 25% y el pack al 0%",
    () => ladder(flavorProduct("37.80", "37.80", 25), packProduct("113.40", "151.20", 0)),
    "plans_disagree",
  );

  // ── Configuración inesperada: lanza, nunca cae al precio crudo ──
  throwsCode(
    "falta uno de los 8 planes",
    () =>
      ladder(
        product([{ id: ONE_BOX, price: "28.35", compareAtPrice: "37.80" }], (i) => (i === 3 ? null : pctPolicy(0))),
        packProduct("85.05", "151.20", 0),
      ),
    "plan_missing",
  );
  throwsCode(
    "plan con descuento de importe fijo",
    () =>
      ladder(
        product([{ id: ONE_BOX, price: "37.80", compareAtPrice: "37.80" }], () => [
          { __typename: "SellingPlanFixedPricingPolicy", adjustmentType: "FIXED_AMOUNT", adjustmentValue: { __typename: "MoneyV2" } },
        ]),
        packProduct("113.40", "151.20", 25),
      ),
    "policy_unexpected",
  );
  throwsCode(
    "plan con política recurrente además de la fija",
    () =>
      ladder(
        product([{ id: ONE_BOX, price: "37.80", compareAtPrice: "37.80" }], () => [
          ...pctPolicy(25),
          { __typename: "SellingPlanRecurringPricingPolicy", adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 30 } },
        ]),
        packProduct("113.40", "151.20", 25),
      ),
    "policy_unexpected",
  );
  throwsCode(
    "plan con una sola política recurrente",
    () =>
      ladder(
        product([{ id: ONE_BOX, price: "37.80", compareAtPrice: "37.80" }], () => [
          { __typename: "SellingPlanRecurringPricingPolicy", adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 25 } },
        ]),
        packProduct("113.40", "151.20", 25),
      ),
    "policy_unexpected",
  );
  throwsCode("producto del sabor no encontrado", () => ladder(null, packProduct("85.05", "151.20", 0)), "product_missing");
  throwsCode(
    "variante de 1 caja no encontrada",
    () => ladder(product([{ id: "1", price: "28.35", compareAtPrice: null }], () => pctPolicy(0)), packProduct("85.05", "151.20", 0)),
    "variant_missing",
  );
  throwsCode(
    "pack sin variantes",
    () => ladder(flavorProduct("28.35", "37.80", 0), product([], () => pctPolicy(0))),
    "variant_missing",
  );

  // Pack con variantes desalineadas: se cobra la más barata y se deja rastro.
  const warns: string[] = [];
  const desalineado = ladder(
    flavorProduct("28.35", "37.80", 0),
    product(
      PACK4_VARIANTS.map((v, i) => ({ id: v.variantId, price: i === 0 ? "85.06" : "85.05", compareAtPrice: "151.20" })),
      () => pctPolicy(0),
    ),
    (m) => warns.push(m),
  );
  check("pack desalineado: usa la más barata y avisa", desalineado.prices.pack4Cents === 8505 && warns.length === 1);
}

async function runWriteGuard() {
  const L = (oneBoxCents: number, pack4Cents: number) => ({ prices: { oneBoxCents, pack4Cents } as LadderPrices });
  const seq = (...values: ReturnType<typeof L>[]) => {
    let n = 0;
    const fetch = async () => {
      const v = values[Math.min(n, values.length - 1)];
      n++;
      return v;
    };
    return { fetch, calls: () => n };
  };

  {
    const s = seq(L(2835, 8505));
    const r = await confirmLadderForWrite(null, s.fetch);
    check("escritura sin caché previa: una lectura fresca", s.calls() === 1 && !r.refetched && r.ladder.prices.oneBoxCents === 2835);
  }
  {
    const s = seq(L(2835, 8505));
    const r = await confirmLadderForWrite(L(2835, 8505), s.fetch);
    check("escritura con la misma escalera en caché: una lectura, sin releer", s.calls() === 1 && !r.refetched);
  }
  {
    const s = seq(L(2836, 8505));
    const r = await confirmLadderForWrite(L(2835, 8505), s.fetch);
    check("1 céntimo de diferencia no relee", s.calls() === 1 && !r.refetched);
  }
  {
    // La caché tenía una lectura a medias (21,26) y Shopify ya terminó: manda la fresca.
    const s = seq(L(2835, 8505), L(2835, 8505));
    const r = await confirmLadderForWrite(L(2126, 6379), s.fetch);
    check(
      "caché vieja a medias (21,26): relee y usa 28,35",
      s.calls() === 2 && r.refetched && r.ladder.prices.oneBoxCents === 2835 && r.ladder.prices.pack4Cents === 8505,
    );
  }
  {
    // Un cambio de tarifa de verdad, ya estable: dos lecturas coinciden y se acepta.
    const s = seq(L(2990, 8970), L(2990, 8970));
    const r = await confirmLadderForWrite(L(2835, 8505), s.fetch);
    check("cambio de tarifa estable: se acepta tras releer", s.calls() === 2 && r.ladder.prices.oneBoxCents === 2990);
  }
  {
    // Dos lecturas seguidas distintas: los precios se están moviendo ahora mismo.
    const s = seq(L(2126, 6379), L(2835, 8505));
    await rejectsCode("dos lecturas seguidas distintas: pricing_in_flux", confirmLadderForWrite(L(2835, 8505), s.fetch), "pricing_in_flux");
  }
  {
    // Si la lectura fresca lanza (estado a medias reconocido), la escritura no sigue.
    const fetch = async () => {
      throw new PricingConfigError("double_discount", "a medias");
    };
    await rejectsCode("la lectura fresca lanza: no hay escalera para escribir", confirmLadderForWrite(L(2835, 8505), fetch), "double_discount");
  }
}

run();
runWriteGuard()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} aserciones fallidas`);
      process.exit(1);
    }
    console.log("\npricing-core: todo en verde");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

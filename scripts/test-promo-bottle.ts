/**
 * Botella de regalo en los «Adelantar» durante la promo (20-oct-2026).
 *
 *   npx tsx scripts/test-promo-bottle.ts
 *
 * La lógica de lib/promo-bottle.ts con Seal, Shopify y Slack sustituidos en memoria
 * (ninguna llamada sale), y guardas de código de que la ruta de Adelantar la mete
 * ANTES del cobro y la quita si Seal lo rechaza.
 */
import { readFileSync } from "node:fs";

for (const k of [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SEAL_API_TOKEN",
  "SHOPIFY_ADMIN_TOKEN",
  "SHOPIFY_API_SECRET",
  "SLACK_ALERTS_WEBHOOK_URL",
  "SLACK_SECURITY_WEBHOOK_URL",
  "SLACK_INCIDENTS_WEBHOOK_URL",
]) {
  delete process.env[k];
}

let failed = 0;
function check(name: string, cond: boolean, hint: string) {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}\n    ${hint}`);
    failed++;
  }
}
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

async function main() {
  const pb = await import("../src/lib/promo-bottle");
  const { seal } = await import("../src/lib/seal");
  const { shopifyAdmin } = await import("../src/lib/shopify-admin");

  let discountStatus: string | Error = "ACTIVE";
  shopifyAdmin.graphql = (async () => {
    if (discountStatus instanceof Error) throw discountStatus;
    return { discountNode: { discount: { status: discountStatus } } };
  }) as typeof shopifyAdmin.graphql;
  shopifyAdmin.getVariantForSealAddItems = (async () => ({
    productId: "16596466008454",
    variantId: "67543664951686",
    title: "Botella",
    sku: "BOTTLE2-LIT",
    price: "28.90",
    taxable: true,
    requiresShipping: true,
  })) as typeof shopifyAdmin.getVariantForSealAddItems;

  type Added = Parameters<typeof seal.addItems>[1];
  const adds: Added[] = [];
  const removes: number[][] = [];
  let sealShowsBottle = true;
  let addFails = false;
  seal.addItems = (async (_id: number, items: Added) => {
    if (addFails) throw new Error("Seal 503");
    adds.push(items);
  }) as typeof seal.addItems;
  seal.getSubscriptionById = (async () => ({
    items: sealShowsBottle
      ? [
          { id: 1, variant_id: "63887092154717", is_one_time_item: 0 },
          { id: 99, variant_id: "67543664951686", is_one_time_item: 1 },
        ]
      : [{ id: 1, variant_id: "63887092154717", is_one_time_item: 0 }],
  })) as unknown as typeof seal.getSubscriptionById;
  seal.removeItems = (async (_id: number, ids: number[]) => {
    removes.push(ids);
  }) as typeof seal.removeItems;

  const box = { id: 555, items: [{ id: 1, variant_id: "63887092154717", is_one_time_item: 0 }] } as never;
  const withBottle = {
    id: 556,
    items: [
      { id: 1, variant_id: "63887092154717", is_one_time_item: 0 },
      { id: 7, variant_id: "67543664951686", is_one_time_item: 1 },
    ],
  } as never;
  const ctx = { customerId: "1", path: "/test" };

  console.log("\n── cuándo hay promo ──\n");
  check(
    "ventana anunciada: antes no, durante sí, después no",
    !pb.inFallbackWindow(Date.parse("2026-10-19T11:00:00Z")) &&
      pb.inFallbackWindow(Date.parse("2026-10-20T12:00:00Z")) &&
      !pb.inFallbackWindow(Date.parse("2026-10-20T22:00:00Z")),
    "Del lunes 19-oct 13:21 al martes 20-oct 23:59, hora de Madrid.",
  );
  pb.resetPromoBottleCache();
  discountStatus = "EXPIRED";
  check("descuento EXPIRED: sin promo", (await pb.promoBottleActive()) === false, "Manda el descuento de Shopify.");
  pb.resetPromoBottleCache();
  discountStatus = new Error("Shopify 401");
  check(
    "descuento ilegible: manda la ventana",
    (await pb.promoBottleActive(Date.parse("2026-10-20T12:00:00Z"))) === true &&
      (pb.resetPromoBottleCache(), await pb.promoBottleActive(Date.parse("2026-10-21T08:00:00Z"))) === false,
    "Sin poder leer el descuento, solo dentro de las fechas anunciadas.",
  );

  console.log("\n── antes del cobro ──\n");
  pb.resetPromoBottleCache();
  discountStatus = "EXPIRED";
  adds.length = 0;
  check(
    "fuera de la promo: no toca la sub",
    (await pb.addPromoBottleBeforeCharge(box, ctx)).kind === "inactive" && adds.length === 0,
    JSON.stringify(adds),
  );

  pb.resetPromoBottleCache();
  discountStatus = "ACTIVE";
  adds.length = 0;
  check(
    "la sub ya lleva botella (puesta a mano): no se pone otra",
    (await pb.addPromoBottleBeforeCharge(withBottle, ctx)).kind === "already" && adds.length === 0,
    "Una botella por pedido.",
  );

  adds.length = 0;
  sealShowsBottle = true;
  const ok = await pb.addPromoBottleBeforeCharge(box, ctx);
  const item = adds[0]?.[0];
  check("con promo: la mete y Seal la enseña", ok.kind === "added" && (ok as { itemId: number }).itemId === 99, JSON.stringify(ok));
  check(
    "a 0€, de un solo uso, con su SKU y marcada",
    !!item &&
      item.price === "0.00" &&
      item.oneTime === true &&
      item.sku === "BOTTLE2-LIT" &&
      item.variantId === "67543664951686" &&
      item.quantity === 1 &&
      JSON.stringify(item.properties) === JSON.stringify([{ key: "_lit_promo", value: "botella-adelantar" }]),
    JSON.stringify(item),
  );

  adds.length = 0;
  sealShowsBottle = false;
  check(
    "Seal tarda en enseñarla: se cobra igual (added_unseen)",
    (await pb.addPromoBottleBeforeCharge(box, ctx)).kind === "added_unseen" && adds.length === 1,
    "El cobro no espera más de unos segundos.",
  );

  addFails = true;
  let threw = false;
  let failOutcome: { kind: string } | null = null;
  try {
    failOutcome = await pb.addPromoBottleBeforeCharge(box, ctx);
  } catch {
    threw = true;
  }
  addFails = false;
  check("si Seal falla, no lanza: el Adelantar sigue sin botella", !threw && failOutcome?.kind === "failed", JSON.stringify(failOutcome));

  console.log("\n── si el cobro falla ──\n");
  removes.length = 0;
  await pb.removePromoBottleAfterRejection(555, { kind: "added", itemId: 99 }, ctx);
  check("rechazo: quita la botella que acaba de meter", JSON.stringify(removes) === "[[99]]", JSON.stringify(removes));
  removes.length = 0;
  await pb.removePromoBottleAfterRejection(556, { kind: "already" }, ctx);
  await pb.removePromoBottleAfterRejection(555, { kind: "added_unseen" }, ctx);
  check(
    "nunca quita una botella que no ha puesto, ni una que no ha visto",
    removes.length === 0,
    "La de atención (already) se queda; sin id no se toca nada.",
  );

  console.log("\n── la ruta de Adelantar ──\n");
  const ROUTE = code(readFileSync("src/app/api/subscription/charge-now/route.ts", "utf8"));
  const iAdd = ROUTE.indexOf("addPromoBottleBeforeCharge(sub,");
  const iCharge = ROUTE.indexOf("await seal.chargeNow(sub.id");
  const iIntent = ROUTE.indexOf("recordChargeNowIntent({");
  check(
    "mete la botella ANTES del cobro y después de apuntar la intención",
    iIntent > 0 && iAdd > iIntent && iCharge > iAdd,
    "El pedido lo crea Seal desde la sub: después del cobro ya no entra.",
  );
  check(
    "la quita solo con un rechazo explícito que no sea «ya hay un cobro en curso»",
    /if \(explicitRejection && !alreadyScheduled\) \{\s*await removePromoBottleAfterRejection\(sub\.id, promoBottle,/.test(ROUTE),
    "Con un resultado ambiguo el cobro puede salir, y con otro en curso también.",
  );
  check(
    "la respuesta y el evento dicen si va la botella",
    ROUTE.includes("promoBottle: promoBottle.kind }") && ROUTE.includes('promoBottle: promoBottle.kind === "added"'),
    "Para la pantalla de Listo y para CRM.",
  );
  const OVERLAY = readFileSync("src/components/ChargeNowOverlay.tsx", "utf8");
  check(
    "la pantalla solo promete la botella cuando ya estaba en la sub",
    /done\.promoBottle === "added" \|\| done\.promoBottle === "already"/.test(OVERLAY),
    "Con added_unseen puede viajar en el siguiente pedido: no se promete.",
  );

  console.log(failed === 0 ? "\nTodo OK" : `\n${failed} fallo(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

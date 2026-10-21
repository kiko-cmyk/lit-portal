/**
 * «Adelantar» bloqueado hasta que salga el primer pedido (21-oct-2026).
 *
 *   npx tsx scripts/test-charge-now-first-order.ts
 *
 * La regla de lib/charge-now-first-order.ts con Shopify sustituido en memoria (ninguna llamada
 * sale), y guardas de código de que la ruta de Adelantar la comprueba ANTES del cerrojo y del
 * cobro, y de que la pantalla tiene su mensaje.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  const fo = await import("../src/lib/charge-now-first-order");
  const { shopifyAdmin } = await import("../src/lib/shopify-admin");
  const { ApiHttpError } = await import("../src/lib/api-helpers");

  console.log("\n── estado del pedido origen ──\n");
  const allows = (displayFulfillmentStatus: string, cancelledAt: string | null = null) =>
    fo.firstOrderAllowsChargeNow({ displayFulfillmentStatus, cancelledAt });
  check("FULFILLED: se puede adelantar", allows("FULFILLED"), "Ya ha salido del almacén.");
  check("UNFULFILLED: no", !allows("UNFULFILLED"), "Sigue en el almacén con sus etiquetas.");
  check("PARTIALLY_FULFILLED: no", !allows("PARTIALLY_FULFILLED"), "Una parte sigue en el almacén.");
  check(
    "en espera o en preparación: no",
    !allows("ON_HOLD") && !allows("IN_PROGRESS") && !allows("SCHEDULED") && !allows("OPEN"),
    "Cualquier estado que no sea salido espera.",
  );
  check(
    "cancelado: sí, aunque no haya salido",
    allows("UNFULFILLED", "2026-10-20T10:00:00Z") && allows("PARTIALLY_FULFILLED", "2026-10-20T10:00:00Z"),
    "Un pedido cancelado no sale: no hay botella doble.",
  );
  check("todo devuelto al stock: sí", allows("RESTOCKED"), "Tampoco va a salir.");

  const withTags = (tags: string[], displayFulfillmentStatus = "UNFULFILLED") =>
    fo.firstOrderAllowsChargeNow({ displayFulfillmentStatus, cancelledAt: null, tags });
  check(
    "cancelado solo en Hive (#12194): sí",
    withTags(["hive_fulfillment_stage:cancelled", "Order-3", "seal_new_subscription"]),
    "En Shopify sigue pagado y sin enviar, pero no va a salir nunca.",
  );
  check(
    "cancelado en Hive y vuelto a mandar al almacén: no",
    !withTags(["hive_fulfillment_stage:cancelled", "hive_fulfillment_stage:open"]) &&
      !withTags(["hive_fulfillment_stage:cancelled", "hive_fulfillment_stage:shipped"]),
    "Con otra etapa de Hive el pedido puede salir con sus etiquetas.",
  );
  check(
    "otras etapas de Hive o sin etiquetas: manda Shopify",
    !withTags(["hive_fulfillment_stage:open", "botella"]) &&
      !withTags(["hive_fulfillment_stage:shipped"]) &&
      !withTags([]) &&
      withTags(["hive_fulfillment_stage:shipped"], "FULFILLED"),
    "Solo la cancelación de Hive se adelanta a Shopify.",
  );
  check(
    "una etiqueta parecida no cuenta",
    !withTags(["hive_fulfillment_stage:cancelled_partial"]) && !withTags(["cancelled"]),
    "Tiene que ser exactamente hive_fulfillment_stage:cancelled.",
  );

  console.log("\n── si Shopify no contesta ──\n");
  const now = Date.parse("2026-10-21T12:00:00Z");
  check(
    "pedido de hace más de 7 días: se deja pasar",
    fo.allowWhenFirstOrderUnreadable("2026-10-10T09:00:00Z", now) &&
      fo.allowWhenFirstOrderUnreadable("2026-10-13 09:00:00", now),
    "El primer pedido sale en 1-3 días; un fallo de Shopify no bloquea a todo el mundo.",
  );
  check(
    "pedido reciente o sin fecha: se bloquea",
    !fo.allowWhenFirstOrderUnreadable("2026-10-20T21:00:00Z", now) &&
      !fo.allowWhenFirstOrderUnreadable("2026-10-15T12:00:00Z", now) &&
      !fo.allowWhenFirstOrderUnreadable("", now) &&
      !fo.allowWhenFirstOrderUnreadable(null, now) &&
      !fo.allowWhenFirstOrderUnreadable("no es una fecha", now),
    "Es la ventana con riesgo de botella doble.",
  );

  console.log("\n── assertFirstOrderShipped ──\n");
  type Detail = Awaited<ReturnType<typeof shopifyAdmin.getOrderDetail>>;
  let detail: Detail | Error = null;
  const asked: string[] = [];
  shopifyAdmin.getOrderDetail = (async (gid: string) => {
    asked.push(gid);
    if (detail instanceof Error) throw detail;
    return detail;
  }) as typeof shopifyAdmin.getOrderDetail;
  const order = (displayFulfillmentStatus: string, customerNumericId = "777", cancelledAt: string | null = null) =>
    ({ customerNumericId, displayFulfillmentStatus, cancelledAt }) as unknown as Detail;
  const recent = { id: 1, order_id: "19149421642118", order_placed: new Date().toISOString() };
  const old = { id: 2, order_id: "17796940628317", order_placed: "2026-09-06T08:25:39Z" };

  async function outcome(sub: typeof recent, customerId = "777"): Promise<string> {
    try {
      await fo.assertFirstOrderShipped(sub, customerId);
      return "ok";
    } catch (e) {
      return e instanceof ApiHttpError ? `${e.status} ${e.code}` : `lanza ${String(e)}`;
    }
  }

  detail = order("UNFULFILLED");
  asked.length = 0;
  check(
    "sin salir: 409 first_order_not_shipped",
    (await outcome(recent)) === "409 first_order_not_shipped",
    "Es el caso de la botella doble.",
  );
  check(
    "pregunta a Shopify por el pedido origen de Seal",
    asked[0] === "gid://shopify/Order/19149421642118",
    JSON.stringify(asked),
  );
  detail = order("FULFILLED");
  check("ya salió: pasa", (await outcome(recent)) === "ok", "");
  detail = order("UNFULFILLED", "777", "2026-10-21T09:00:00Z");
  check("cancelado: pasa", (await outcome(recent)) === "ok", "");
  detail = { ...(order("UNFULFILLED") as object), tags: ["hive_fulfillment_stage:cancelled"] } as Detail;
  check(
    "cancelado solo en Hive: pasa, con las etiquetas que da getOrderDetail",
    (await outcome(recent)) === "ok",
    "assertFirstOrderShipped tiene que pasar las etiquetas a la regla.",
  );
  const SHOPIFY_ADMIN = code(readFileSync("src/lib/shopify-admin.ts", "utf8"));
  check(
    "getOrderDetail pide las etiquetas a Shopify",
    /displayFulfillmentStatus displayFinancialStatus tags\b/.test(SHOPIFY_ADMIN) && SHOPIFY_ADMIN.includes("tags: o.tags ?? []"),
    "Sin ellas la cancelación en Hive no se ve.",
  );
  const ORDER_ROUTE = code(readFileSync("src/app/api/orders/[id]/route.ts", "utf8"));
  check(
    "la ruta de detalle de pedido no devuelve las etiquetas al cliente",
    !/\btags\b/.test(ORDER_ROUTE) && !ORDER_ROUTE.includes("...raw"),
    "Son internas (B2B, campañas, etapas de Hive).",
  );

  detail = order("UNFULFILLED", "999");
  check(
    "pedido de otro cliente: no decide con él",
    (await outcome(recent)) === "ok",
    "Como pide getOrderDetail, se comprueba customerNumericId.",
  );
  detail = null;
  check("pedido que Shopify no encuentra: pasa", (await outcome(recent)) === "ok", "No hay nada que esperar.");

  asked.length = 0;
  check(
    "sub sin pedido origen: pasa sin preguntar a Shopify",
    (await outcome({ ...recent, order_id: "" })) === "ok" &&
      (await outcome({ ...recent, order_id: "0" })) === "ok" &&
      asked.length === 0,
    JSON.stringify(asked),
  );

  detail = new Error("Shopify 503");
  check(
    "Shopify falla con una sub reciente: 409 first_order_unverified",
    (await outcome(recent)) === "409 first_order_unverified",
    "Un 409 llega tal cual a la pantalla; un 5xx lo cambia la App Proxy por HTML.",
  );
  check("Shopify falla con una sub antigua: pasa", (await outcome(old)) === "ok", "Su primer pedido salió hace tiempo.");

  console.log("\n── la ruta de Adelantar ──\n");
  const ROUTE = code(readFileSync("src/app/api/subscription/charge-now/route.ts", "utf8"));
  const iOpen = ROUTE.indexOf("await hasOpenChargeNowIntent(");
  const iGuard = ROUTE.indexOf("await assertFirstOrderShipped(sub, ctx.customerId)");
  const iLock = ROUTE.indexOf('.from("charge_now_locks")');
  const iIntent = ROUTE.indexOf("recordChargeNowIntent({");
  const iBottle = ROUTE.indexOf("addPromoBottleBeforeCharge(sub,");
  const iCharge = ROUTE.indexOf("await seal.chargeNow(sub.id");
  check(
    "comprueba el primer pedido después de hasOpenChargeNowIntent y antes del cerrojo",
    iOpen > 0 && iGuard > iOpen && iLock > iGuard,
    `hasOpen=${iOpen} guarda=${iGuard} cerrojo=${iLock}`,
  );
  check(
    "y antes de apuntar la intención, de la botella y de seal.chargeNow",
    iGuard > 0 && iIntent > iGuard && iBottle > iGuard && iCharge > iGuard,
    `guarda=${iGuard} intención=${iIntent} botella=${iBottle} cobro=${iCharge}`,
  );
  const callers = (readdirSync("src", { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .flatMap((f) => {
      const n = code(readFileSync(join("src", f), "utf8")).split("seal.chargeNow(").length - 1;
      return n > 0 ? [`${f}:${n}`] : [];
    });
  check(
    "seal.chargeNow solo se llama desde esta ruta, una vez",
    callers.length === 1 && callers[0] === join("app", "api", "subscription", "charge-now", "route.ts") + ":1",
    `Llamadas: ${callers.join(", ")}. Otra llamada necesita la misma guarda.`,
  );

  const OVERLAY = readFileSync("src/components/ChargeNowOverlay.tsx", "utf8");
  check(
    "la pantalla tiene mensaje propio para first_order_not_shipped y bloquea el botón",
    /code === "first_order_not_shipped"\) \{[\s\S]{0,200}setLocked\(true\)/.test(OVERLAY) &&
      OVERLAY.includes("Tu primer pedido todavía no ha salido del almacén.") &&
      OVERLAY.includes("Your first order hasn't left the warehouse yet."),
    "Reintentar no sirve hasta que salga.",
  );
  check(
    "y para first_order_unverified, sin bloquear (puede reintentar)",
    /code === "first_order_unverified"\) \{\s*\/\/[^\n]*\n\s*setError\(/.test(OVERLAY),
    "No se ha cobrado nada; en unos minutos puede volver a probar.",
  );

  console.log(failed === 0 ? "\nTodo OK" : `\n${failed} fallo(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

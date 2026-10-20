/**
 * Aviso de «3 días en el punto de recogida» (SUB-08, 2026-10-20).
 *
 *   npx tsx scripts/test-pickup-reminder.ts
 *
 * Las reglas puras con los datos REALES del 20-oct: los títulos de envío y las
 * direcciones de los puntos tal como los da Shopify, y los envíos tal como los da la
 * API de Hive, comparados con el seguimiento de GLS de los mismos paquetes. Y guardas
 * de código fuente de que el envío va donde toca y solo cuando toca.
 */
import { readFileSync } from "node:fs";
import {
  decideReminder,
  isGlsPickupShipment,
  isPickupShipping,
  madridDaysBetween,
  pickupAddress,
  pickupName,
  pickupState,
} from "../src/lib/pickup-reminder";
import type { HiveShipment } from "../src/lib/hive";

let failed = 0;
function check(name: string, cond: boolean, hint: string) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name}\n    ${hint}`);
    failed++;
  }
}

const NOW = Date.parse("2026-10-20T09:00:00Z"); // el cron, a las 11:00 de Madrid

type Row = Pick<HiveShipment, "delivery_status" | "delivered_at" | "updated_at" | "shipment_provider" | "shipping_method">;
const gls = (r: Pick<Row, "delivery_status" | "delivered_at" | "updated_at">): Row => ({
  shipment_provider: "GLS ES",
  shipping_method: "GLS ES Parcel Point Mainland",
  ...r,
});

// Filas reales de GET /shipments (20-oct).
// #11843: GLS lo deposita en PS COPISTERIA BCN el 16-oct a las 10:58 UTC y sigue allí.
const h11843 = gls({ delivery_status: "awaiting_customer_pickup", delivered_at: null, updated_at: "2026-10-16T15:26:10.529+02:00" });
// #11830: depositado el 17-oct a las 11:57 UTC, sin recoger.
const h11830 = gls({ delivery_status: "awaiting_customer_pickup", delivered_at: null, updated_at: "2026-10-17T14:46:32.333+02:00" });
// #11867: depositado a las 07:44 UTC y recogido a las 15:36 UTC del mismo día.
const h11867 = {
  ...gls({ delivery_status: "delivered", delivered_at: "2026-10-19T17:36:16.000+02:00", updated_at: "2026-10-19T18:09:00.124+02:00" }),
  shipping_method: "GLS ES Parcel Point Madrid",
};
// #11360: GLS dice que lo recogieron el 30-sep a las 11:02 UTC; Hive nunca se enteró.
const h11360 = gls({ delivery_status: "awaiting_customer_pickup", delivered_at: null, updated_at: "2026-09-30T15:13:06.230+02:00" });
// #11840: recogido en la taquilla a las 09:54 UTC del 16-oct; Hive pasó a «esperando» a las 13:11 UTC y ahí se quedó.
const h11840 = gls({ delivery_status: "awaiting_customer_pickup", delivered_at: null, updated_at: "2026-10-16T15:11:24.158+02:00" });

console.log("\n── qué pedidos van a punto de recogida ──\n");

check(
  "la tarifa sola y la combinada con el exprés de la suscripción",
  isPickupShipping(["GLS Punto de Recogida"]) &&
    isPickupShipping(["GLS Punto de Recogida and Exprés - 48-72 horas (laborales)"]) &&
    isPickupShipping(["Exprés - 48-72 horas (laborales)", "GLS Punto de Recogida"]),
  "Son los títulos reales de Shopify (#12155, #12092). Los pedidos de suscripción llevan las dos líneas.",
);
check(
  "el exprés a domicilio, no",
  !isPickupShipping(["Exprés - 48-72 horas (laborales)"]) && !isPickupShipping([null, ""]),
  "Sin la tarifa de punto de recogida no hay punto al que ir.",
);
check(
  "solo los envíos que Hive mandó por GLS",
  isGlsPickupShipment(h11843) &&
    isGlsPickupShipment({ shipment_provider: "GLS ES", shipping_method: "GLS ES Parcel Point Balearics Mayores" }) &&
    !isGlsPickupShipment({ shipment_provider: "CTT", shipping_method: "CTT Express ES Madrid" }),
  "#11596 pidió punto de recogida y salió por CTT: el punto de su dirección no es donde está el paquete.",
);

console.log("\n── dónde está el paquete ──\n");

const s11843 = pickupState(h11843);
check(
  "esperando en el punto desde la última actualización de Hive",
  s11843.state === "waiting" && s11843.arrivedAt === "2026-10-16T15:26:10.529+02:00",
  `Sale ${JSON.stringify(s11843)}. Hive no guarda la hora de llegada; updated_at cae el mismo día, unas horas después.`,
);
check(
  "recogido cuando Hive tiene delivered_at",
  pickupState(h11867).state === "collected" &&
    pickupState({ delivery_status: "awaiting_customer_pickup", delivered_at: "2026-10-19T17:36:16.000+02:00", updated_at: "2026-10-19T18:09:00.124+02:00" }).state === "collected",
  "Con fecha de entrega ya no espera, diga lo que diga delivery_status.",
);
check(
  "sin llegar al punto, no espera",
  pickupState({ delivery_status: "information_transmitted", delivered_at: null, updated_at: "2026-10-17T13:22:11.280+02:00" }).state === "not_at_point" &&
    pickupState({ delivery_status: "action_required", delivered_at: null, updated_at: "2026-10-16T10:42:15.310+02:00" }).state === "not_at_point" &&
    pickupState({ delivery_status: null, delivered_at: null, updated_at: "2026-10-20T10:00:00+02:00" }).state === "not_at_point",
  "Son #11907 (etiqueta creada) y #11749 (parado en aduanas en Canarias).",
);
check(
  "devuelto, no",
  pickupState({ delivery_status: "returned_to_sender", delivered_at: null, updated_at: "2026-10-15T22:30:48.342+02:00" }).state === "returned" &&
    pickupState({ delivery_status: "return_initiated", delivered_at: null, updated_at: "2026-10-15T22:30:48.342+02:00" }).state === "returned",
  "Si el punto lo devuelve, ya no se puede recoger.",
);

console.log("\n── días en el punto ──\n");

check(
  "días naturales de Madrid, no horas, con la zona horaria de Hive",
  madridDaysBetween("2026-10-16T15:26:10.529+02:00", NOW) === 4 &&
    madridDaysBetween("2026-10-17T14:46:32.333+02:00", NOW) === 3 &&
    madridDaysBetween("2026-10-19T11:31:48.103+02:00", NOW) === 1,
  "#11843 (16-oct) lleva 4, #11830 (17-oct) 3 y #11787 (19-oct) 1.",
);
check(
  "el día es el de Madrid, no el de UTC",
  madridDaysBetween("2026-10-16T22:30:00Z", Date.parse("2026-10-17T09:00:00Z")) === 0 &&
    madridDaysBetween("2026-10-16T21:30:00Z", Date.parse("2026-10-17T09:00:00Z")) === 1,
  "El 16-oct a las 22:30 UTC ya es el 17 a las 00:30 en Madrid: a las 11:00 del 17 lleva 0 días, no 1.",
);
check(
  "el cambio de hora del 25-oct no se come un día",
  madridDaysBetween("2026-10-23T10:00:00Z", Date.parse("2026-10-26T09:00:00Z")) === 3,
  "Del viernes 23 al lunes 26 son 3 días aunque el domingo tenga 25 horas.",
);

console.log("\n── se avisa o no ──\n");

const d11843 = decideReminder({ state: s11843, shopifyDeliveredAt: null, now: NOW });
check("#11843, 4 días esperando: sí", d11843.send === true && d11843.days === 4, JSON.stringify(d11843));
const d11830 = decideReminder({ state: pickupState(h11830), shopifyDeliveredAt: null, now: NOW });
check("#11830, 3 días esperando: sí", d11830.send === true && d11830.days === 3, JSON.stringify(d11830));
check(
  "con 2 días, todavía no",
  decideReminder({ state: { state: "waiting", arrivedAt: "2026-10-18T12:00:00+02:00" }, shopifyDeliveredAt: null, now: NOW }).send === false,
  "El email dice «3 días».",
);
check(
  "si Shopify ya tiene la entrega, no",
  decideReminder({ state: s11843, shopifyDeliveredAt: "2026-10-19T15:36:16Z", now: NOW }).send === false,
  "Su deliveredAt coincide al minuto con la recogida en GLS.",
);
check(
  "colgado en Hive desde hace semanas (#11360), no",
  decideReminder({ state: pickupState(h11360), shopifyDeliveredAt: null, now: NOW }).send === false,
  "Pasados 10 días, o se recogió o el punto ya lo devolvió.",
);
check(
  "LÍMITE CONOCIDO: #11840 se avisa aunque ya se recogió",
  decideReminder({ state: pickupState(h11840), shopifyDeliveredAt: null, now: NOW }).send === true,
  "Hive no se enteró de la recogida y no hay otra fuente: lo cubre «Si ya lo has recogido, ignora este mensaje». Si esto deja de avisar, es que hay una fuente nueva y hay que documentarla.",
);
check(
  "recogido o devuelto, no",
  decideReminder({ state: pickupState(h11867), shopifyDeliveredAt: null, now: NOW }).send === false &&
    decideReminder({ state: { state: "returned", at: "2026-10-19T00:00:00Z" }, shopifyDeliveredAt: null, now: NOW }).send === false,
  "Solo se avisa a quien tiene el paquete esperando.",
);

console.log("\n── el punto en el email ──\n");

check(
  "sin el «PS » ni el «PS GLS DIS » de GLS",
  pickupName("PS COPISTERIA BCN") === "COPISTERIA BCN" &&
    pickupName("PS GLS DIS EL PAISA 2") === "EL PAISA 2" &&
    pickupName("GLS Locker 24/7 AVIA BANYOLES") === "GLS Locker 24/7 AVIA BANYOLES" &&
    pickupName("AGENCIA COLABORADORA 1014 CAMPAMENTO") === "AGENCIA COLABORADORA 1014 CAMPAMENTO",
  "«PS» es el código de GLS para sus tiendas; las taquillas y agencias se quedan como vienen.",
);
check(
  "la dirección limpia de los guiones de relleno de GLS",
  pickupAddress({ address1: "Carrer Entença 30 lc 6 -", address2: "", zip: "08015", city: "Barcelona" }) ===
    "Carrer Entença 30 lc 6, 08015 Barcelona" &&
    pickupAddress({ address1: "Rúa Poeta Manuel María  - bajo -", address2: null, zip: "27003", city: "Lugo" }) ===
      "Rúa Poeta Manuel María - bajo, 27003 Lugo" &&
    pickupAddress({ address1: "Calle de Maldonado 26", address2: "", zip: "28006", city: "Madrid" }) ===
      "Calle de Maldonado 26, 28006 Madrid",
  "Son direcciones reales de pedidos a punto de recogida (#11857, #11677, #12144).",
);

console.log("\n── guardas de código ──\n");

const LIB = readFileSync("src/lib/pickup-reminder.ts", "utf8");
const HIVE = readFileSync("src/lib/hive.ts", "utf8");
const ROUTE = readFileSync("src/app/api/cron/pickup-reminder/route.ts", "utf8");
const KLAVIYO = readFileSync("src/lib/klaviyo.ts", "utf8");
const VERCEL = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
const FLAGS = readFileSync("src/lib/flags.ts", "utf8");
const TRACK = 'klaviyo.trackEvent(\n        "pickup_point_reminder"';

check("el evento está en KlaviyoEvent", KLAVIYO.includes('| "pickup_point_reminder"'), "Sin él no compila trackEvent.");
check(
  "a Hive solo se le lee",
  !/method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(HIVE) && /fetch\(url, \{ headers:/.test(HIVE),
  "En Hive no se toca nada: el cliente solo hace GET.",
);
check(
  "el filtro por pedidos va con comas",
  /merchant_order_id%5Bin%5D=\$\{chunk\.join\(","\)\}/.test(HIVE),
  "La forma repetida (`merchant_order_id[in][]=`) devuelve 500.",
);
check(
  "el cron exige el secreto de Vercel",
  ROUTE.indexOf("requireCron(req)") > 0 && ROUTE.indexOf("requireCron(req)") < ROUTE.indexOf("runPickupReminders("),
  "Sin requireCron cualquiera podría disparar los avisos.",
);
check(
  "el cron va una vez al día",
  VERCEL.crons.some((c) => c.path === "/api/cron/pickup-reminder" && /^\d+ \d+ \* \* \*$/.test(c.schedule)),
  "El Vercel del portal es Hobby: un cron más frecuente hace fallar el despliegue entero.",
);
check(
  "en dry run o con el flag apagado no se manda",
  /const willSend = !opts\.dryRun && allowed;/.test(LIB) &&
    LIB.indexOf(TRACK) > 0 &&
    LIB.indexOf("if (!willSend)") < LIB.indexOf(TRACK),
  "El dry run y PICKUP_REMINDER=off tienen que cortar ANTES de llamar a Klaviyo.",
);
check(
  "el flag está apagado salvo que se encienda",
  /modeOf\("PICKUP_REMINDER"\)/.test(FLAGS) && /\(process\.env\[name\] \?\? "off"\)/.test(FLAGS),
  "Sin la variable, el cron solo dice lo que mandaría.",
);
check(
  "un aviso por pedido",
  /uniqueId: `pickup:\$\{order\.legacyResourceId\}`/.test(LIB) &&
    /template_id: PICKUP_REMINDER_TEMPLATE/.test(LIB) &&
    /orderId: order\.legacyResourceId/.test(LIB) &&
    /done\.has\(o\.legacyResourceId\)/.test(LIB),
  "uniqueId en Klaviyo y fila en email_logs con metadata.orderId, que se mira antes de mandar.",
);
check(
  "email_logs se apunta después de mandar, no antes",
  LIB.indexOf(TRACK) > 0 && LIB.indexOf(TRACK) < LIB.indexOf('from("email_logs").insert('),
  "Apuntarlo antes dejaría sin aviso para siempre a quien Klaviyo no llegó a recibir.",
);
check(
  "daysAtPickup va como número 3",
  /daysAtPickup: REMIND_AFTER_DAYS,/.test(LIB) && /export const REMIND_AFTER_DAYS = 3;/.test(LIB),
  "El flow solo arranca con el número 3: ni «3» como texto ni 4.",
);
check(
  "el email lleva el nombre y la dirección del punto",
  /pickupName: name,/.test(LIB) && /pickupAddress: address,/.test(LIB) && /sin_datos_del_punto/.test(LIB),
  "Los pinta el email: sin ellos no se manda.",
);
check(
  "no lleva la propiedad `test`",
  !/\btest:/.test(LIB),
  "A producción no van eventos de prueba.",
);

console.log(failed === 0 ? "\nTodo en verde.\n" : `\n${failed} fallo(s).\n`);
process.exit(failed === 0 ? 0 : 1);

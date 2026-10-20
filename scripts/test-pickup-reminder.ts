/**
 * Aviso de «3 días en el punto de recogida» (SUB-08, 2026-10-20).
 *
 *   npx tsx scripts/test-pickup-reminder.ts
 *
 * Las reglas puras con los pedidos REALES del 20-oct: los títulos de envío y las
 * direcciones de los puntos tal como los da Shopify, y las líneas de tiempo de GLS
 * de esos pedidos traducidas a eventos de Sendcloud con la forma de su API v3
 * (`phase` = `pup` al depositarlo en el punto, `delivered` al recogerlo). Y guardas
 * de código fuente de que el envío va donde toca y solo cuando toca.
 */
import { readFileSync } from "node:fs";
import {
  decideReminder,
  isPickupShipping,
  madridDaysBetween,
  pickupAddress,
  pickupName,
  pickupState,
} from "../src/lib/pickup-reminder";
import type { SendcloudTrackingEvent } from "../src/lib/sendcloud";

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
const ev = (event_at: string, phase: string, exception = "none"): SendcloudTrackingEvent => ({
  event_at,
  event_type: "carrier",
  phase,
  exception,
  sub_status: "none",
});

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

console.log("\n── dónde está el paquete ──\n");

// #11843 (20-oct): depositado en PS COPISTERIA BCN el 16-oct a las 10:58 y sin recoger.
const waiting11843 = [
  ev("2026-10-15T10:20:00Z", "announced"),
  ev("2026-10-15T18:43:00Z", "accepted"),
  ev("2026-10-16T03:27:00Z", "in_transit"),
  ev("2026-10-16T07:49:00Z", "in_delivery"),
  ev("2026-10-16T10:58:00Z", "pup"),
];
// #11867: depositado a las 07:44 y recogido a las 15:36 del mismo día.
const collected11867 = [
  ev("2026-10-17T01:40:00Z", "in_transit"),
  ev("2026-10-19T06:41:00Z", "in_delivery"),
  ev("2026-10-19T07:44:00Z", "pup"),
  ev("2026-10-19T15:36:00Z", "delivered"),
];

const s1 = pickupState(waiting11843.slice().reverse()); // Sendcloud los da de nuevo a viejo
check(
  "esperando en el punto desde que llega, aunque los eventos vengan al revés",
  s1.state === "waiting" && s1.arrivedAt === "2026-10-16T10:58:00Z",
  `Sale ${JSON.stringify(s1)}. La API v3 ordena de más nuevo a más viejo; se reordena por event_at.`,
);
const s2 = pickupState(collected11867);
check(
  "recogido cuando hay `delivered` después de `pup`",
  s2.state === "collected" && s2.collectedAt === "2026-10-19T15:36:00Z",
  `Sale ${JSON.stringify(s2)}.`,
);
check(
  "sin llegada al punto no está esperando",
  pickupState([ev("2026-10-17T11:07:00Z", "announced")]).state === "not_at_point",
  "Es #11907: etiqueta creada y GLS aún no lo ha recogido en el almacén.",
);
check(
  "si Sendcloud traduce el depósito como `delivered`, no se avisa nunca",
  pickupState([ev("2026-10-16T10:58:00Z", "delivered")]).state === "collected",
  "El modo de fallo tiene que ser no mandar: sin `pup` no se sabe si sigue en el punto.",
);
check(
  "«sin novedades» y «se acaba el plazo» no lo sacan del punto",
  (() => {
    const s = pickupState([
      ...waiting11843,
      ev("2026-10-19T00:00:00Z", "none", "off_radar"),
      ev("2026-10-21T00:00:00Z", "none", "pup_expiration"),
    ]);
    return s.state === "waiting" && s.arrivedAt === "2026-10-16T10:58:00Z";
  })(),
  "Son justo los eventos que llegan mientras el paquete espera; la espera cuenta desde el primer `pup`.",
);
check(
  "devuelto al remitente, no",
  pickupState([...waiting11843, ev("2026-10-24T08:00:00Z", "none", "dropoff_expiration")]).state === "returned",
  "Si el punto lo devuelve, ya no se puede recoger.",
);
check(
  "si sale del punto y llega a otro, la espera empieza de nuevo",
  (() => {
    const s = pickupState([
      ...waiting11843,
      ev("2026-10-17T08:00:00Z", "in_transit"),
      ev("2026-10-18T09:00:00Z", "pup"),
    ]);
    return s.state === "waiting" && s.arrivedAt === "2026-10-18T09:00:00Z";
  })(),
  "Contar desde el primer punto diría «3 días» antes de tiempo.",
);
check(
  "las reclamaciones no cuentan",
  pickupState([...waiting11843, { ...ev("2026-10-19T10:00:00Z", "in_progress"), event_type: "claim" }]).state === "waiting",
  "Los eventos `claim` usan sus propias fases y no dicen dónde está el paquete.",
);

console.log("\n── días en el punto ──\n");

check(
  "días naturales de Madrid, no horas",
  madridDaysBetween("2026-10-16T10:58:00Z", NOW) === 4 &&
    madridDaysBetween("2026-10-17T11:57:00Z", NOW) === 3 &&
    madridDaysBetween("2026-10-19T08:57:00Z", NOW) === 1,
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

const d1 = decideReminder({ state: s1, shopifyDeliveredAt: null, now: NOW });
check("#11843, 4 días esperando: sí", d1.send === true && d1.days === 4, JSON.stringify(d1));
check(
  "con 2 días, todavía no",
  decideReminder({ state: { state: "waiting", arrivedAt: "2026-10-18T10:00:00Z" }, shopifyDeliveredAt: null, now: NOW }).send === false,
  "El email dice «3 días».",
);
check(
  "si Shopify ya tiene la entrega, no, diga lo que diga Sendcloud",
  decideReminder({ state: s1, shopifyDeliveredAt: "2026-10-19T15:36:16Z", now: NOW }).send === false,
  "Su deliveredAt coincide al minuto con la recogida en GLS (18 de 18 que lo tenían).",
);
check(
  "pasados 10 días, no",
  decideReminder({ state: { state: "waiting", arrivedAt: "2026-10-08T10:00:00Z" }, shopifyDeliveredAt: null, now: NOW }).send === false,
  "A esas alturas el punto ya lo devuelve.",
);
check(
  "recogido o devuelto, no",
  decideReminder({ state: s2, shopifyDeliveredAt: null, now: NOW }).send === false &&
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
const ROUTE = readFileSync("src/app/api/cron/pickup-reminder/route.ts", "utf8");
const KLAVIYO = readFileSync("src/lib/klaviyo.ts", "utf8");
const VERCEL = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
const FLAGS = readFileSync("src/lib/flags.ts", "utf8");

check("el evento está en KlaviyoEvent", KLAVIYO.includes('| "pickup_point_reminder"'), "Sin él no compila trackEvent.");
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
    LIB.indexOf("if (!willSend)") < LIB.indexOf('klaviyo.trackEvent(\n        "pickup_point_reminder"'),
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
    /done\.has\(order\.legacyResourceId\)/.test(LIB),
  "uniqueId en Klaviyo y fila en email_logs con metadata.orderId, que se mira antes de mandar.",
);
check(
  "email_logs se apunta después de mandar, no antes",
  LIB.indexOf('klaviyo.trackEvent(\n        "pickup_point_reminder"') < LIB.indexOf('from("email_logs").insert('),
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

/**
 * Cupones de campaña dentro de su descuento padre (Juan 2026-10-14).
 *
 *   npx tsx scripts/test-coupon-parent.ts
 *
 * Dos partes: la regla pura que decide qué código se borra de un padre
 * (`couponVerdict`), que es la que sustituye a la caducidad y al `usageLimit: 1`
 * que Shopify ya no deja poner por código; y comprobaciones de código fuente de
 * que la emisión, el webhook y el cron usan los padres.
 */
import { readFileSync } from "node:fs";
import {
  COUPON_SEED_PREFIX,
  couponVerdict,
  DISCOVERY_COUPON_PARENT_GID,
  isCampaignCouponCode,
  SURVEY_COUPON_PARENT_GID,
} from "../src/lib/coupon-parent";

let failed = 0;
function check(name: string, cond: boolean, hint: string) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name}\n    ${hint}`);
    failed++;
  }
}

const NOW = new Date("2026-10-14T12:00:00Z");
const FUTURE = "2026-10-20T12:00:00Z";
const PAST = "2026-10-14T11:59:59Z";

console.log("\n── qué se borra de un padre ──\n");

check(
  "el código semilla se queda siempre",
  couponVerdict(`${COUPON_SEED_PREFIX}ABCDEFGH2345`, 3, null, NOW) === "keep",
  "Es el que Shopify exige para crear el padre. Aunque cuente usos, no se toca.",
);
check(
  "un código sin fila en Supabase NO se borra",
  couponVerdict("LIT-AB34CD56", 0, null, NOW) === "unknown",
  "Nunca se borra un código que no sabemos de dónde ha salido: se cuenta para revisarlo a mano.",
);
check(
  "perfilado sin usar y en fecha: se queda",
  couponVerdict("LIT-AB34CD56", 0, { expiresAt: FUTURE }, NOW) === "keep",
  "Es un cupón vivo que el cliente tiene en su email.",
);
check(
  "perfilado caducado: se va",
  couponVerdict("LIT-AB34CD56", 0, { expiresAt: PAST }, NOW) === "expired",
  "Es la caducidad de 30 días que antes ponía `endsAt` en cada descuento suelto.",
);
check(
  "caduca justo en su hora, no antes",
  couponVerdict("LIT-AB34CD56", 0, { expiresAt: "2026-10-14T12:00:01Z" }, NOW) === "keep" &&
    couponVerdict("LIT-AB34CD56", 0, { expiresAt: "2026-10-14T12:00:00Z" }, NOW) === "expired",
  "Nunca antes de la fecha prometida en el email y en la pantalla de gracias.",
);
check(
  "perfilado usado: se va aunque esté en fecha",
  couponVerdict("LIT-AB34CD56", 1, { expiresAt: FUTURE }, NOW) === "used",
  "Es el «un solo uso» que antes ponía `usageLimit: 1`: en un padre ese límite contaría todos los códigos.",
);
check(
  "Discovery del email: misma regla",
  couponVerdict("LIT-AB34CD56", 0, { expiresAt: PAST, mode: "checkout", status: null }, NOW) === "expired" &&
    couponVerdict("LIT-AB34CD56", 1, { expiresAt: FUTURE, mode: "checkout", status: null }, NOW) === "used" &&
    couponVerdict("LIT-AB34CD56", 0, { expiresAt: FUTURE, mode: "checkout", status: null }, NOW) === "keep",
  "Los 30 días y el un solo uso valen igual para el Discovery que se manda por email.",
);
check(
  "renovación aplicada y sin cobrar: se queda (no caduca)",
  couponVerdict("LIT-AB34CD56", 0, { expiresAt: null, mode: "renewal", status: "pending_charge" }, NOW) === "keep" &&
    couponVerdict("LIT-AB34CD56", 0, { expiresAt: PAST, mode: "renewal", status: "pending_apply" }, NOW) === "keep",
  "Va aplicado en Seal a la primera renovación, que puede caer a 45 días, 2, 3 o 6 meses: si se borrara antes, no descontaría.",
);
check(
  "renovación cobrada o anulada: se va",
  couponVerdict("LIT-AB34CD56", 0, { expiresAt: null, mode: "renewal", status: "removed" }, NOW) === "settled" &&
    couponVerdict("LIT-AB34CD56", 0, { expiresAt: null, mode: "renewal", status: "void" }, NOW) === "settled",
  "Cuando la renovación ya se cobró (removed) o la sub se canceló (void), el código no tiene nada más que hacer.",
);
check(
  "renovación con un uso en Shopify: se va",
  couponVerdict("LIT-AB34CD56", 1, { expiresAt: null, mode: "renewal", status: "pending_charge" }, NOW) === "used",
  "Si Shopify ya le cuenta un uso, el pedido de renovación lo llevó: está consumido.",
);

console.log("\n── el formato de nuestros códigos ──\n");

check(
  "reconoce un código de campaña",
  isCampaignCouponCode("LIT-TW3DVWJD") && isCampaignCouponCode(" lit-tw3dvwjd "),
  "Es el formato de survey-discount.ts y discovery-discount.ts (y da igual mayúsculas o espacios).",
);
check(
  "no confunde otros códigos",
  !isCampaignCouponCode("JUAN9NSC") &&
    !isCampaignCouponCode("LITREF-ABCDEFGH") &&
    !isCampaignCouponCode("LIT-AB34CD5O") &&
    !isCampaignCouponCode("GET10LIT") &&
    !isCampaignCouponCode(""),
  "Un código de referidos, una recompensa LITREF o un código de marketing no son de estas campañas: el webhook no debe intentar retirarlos.",
);

console.log("\n── la emisión, el webhook y el cron usan los padres ──\n");

const SURVEY = readFileSync("src/lib/survey-discount.ts", "utf8");
const WEBHOOK = readFileSync("src/app/api/webhooks/shopify/route.ts", "utf8");
const CLEANUP = readFileSync("src/app/api/cron/survey-discount-cleanup/route.ts", "utf8");
const PARENT = readFileSync("src/lib/coupon-parent.ts", "utf8");

check(
  "los dos padres tienen su gid real",
  /^gid:\/\/shopify\/DiscountCodeNode\/\d+$/.test(SURVEY_COUPON_PARENT_GID) &&
    /^gid:\/\/shopify\/DiscountCodeNode\/\d+$/.test(DISCOVERY_COUPON_PARENT_GID) &&
    (SURVEY_COUPON_PARENT_GID as string) !== DISCOVERY_COUPON_PARENT_GID,
  "Sin un gid real la emisión fallaría en cada encuesta y cada Discovery Set.",
);
check(
  "la encuesta emite DENTRO de su padre, no un descuento suelto",
  /addCouponCode\(SURVEY_COUPON_PARENT_GID, code\)/.test(SURVEY) && !/discountCodeBasicCreate/.test(SURVEY),
  "Un descuento suelto por cliente es lo que llenó el admin (98 líneas solo del perfilado).",
);
const consumeAt = WEBHOOK.indexOf("consumeCampaignCouponsSafe(campaignCodes");
check(
  "orders/paid retira el código usado, en after() y al final",
  consumeAt > WEBHOOK.indexOf("recordOrderPaid(payload)") &&
    /after\(\(\) => runAsBackgroundJob\(\(\) => consumeCampaignCouponsSafe\(campaignCodes, label\)\)\)/.test(WEBHOOK) &&
    /\.filter\(\(c\) => isCampaignCouponCode\(c\)\)/.test(WEBHOOK),
  "Es el «un solo uso». Al final y en segundo plano: un fallo aquí no puede repetir el webhook entero (confirmation_sent duplicado).",
);
check(
  "el webhook solo retira códigos de NUESTROS padres",
  /PARENT_GIDS\.includes\(owner\)/.test(PARENT),
  "Un LIT-… que siga siendo un descuento suelto de antes se limita solo; un código de otro descuento no se toca.",
);
check(
  "el cron barre los padres",
  /sweepCouponParents\(/.test(CLEANUP),
  "Sin el barrido, los códigos caducados seguirían funcionando para siempre: en un padre Shopify no caduca códigos uno a uno.",
);

console.log(failed === 0 ? "\nTodo en verde.\n" : `\n${failed} fallo(s).\n`);
process.exit(failed === 0 ? 0 : 1);

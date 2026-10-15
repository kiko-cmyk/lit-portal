/**
 * Protege la guarda del cupón de 4,99 € del LIT Discovery Set, que es lo que
 * decide a quién se le emite.
 *
 *   npx tsx scripts/test-discovery-discount-guard.ts
 *
 * ── Por qué existe, con el precedente ──
 *
 * El 23-sep-2026 la ruta de la encuesta regaló tres cupones de 5 € a
 * suscriptores activos porque preguntaba a `resolveActiveSubFast`, que mira
 * SOLO la caché de Supabase y devuelve `null` en un cache miss. Una de las
 * afectadas tenía sub ACTIVE desde julio y CERO filas en la caché: nunca había
 * entrado al portal. El agravante: esa función acaba en `catch { return null }`,
 * así que un fallo de Seal llegaba disfrazado de "no tiene suscripción" y
 * dejaba inalcanzable el catch escrito justamente para no emitir.
 *
 * Este cupón nace con la misma guarda, y este test es para que no se cambie por
 * el atajo la próxima vez que alguien quiera ahorrarse una llamada.
 *
 * Es de CÓDIGO FUENTE, no de comportamiento, igual que su gemelo
 * `test-survey-discount-guard.ts` y por el mismo motivo: el handler habla con
 * Seal, Shopify, Klaviyo y Supabase, y montar ese cuádruple mock costaría más
 * de lo que protege. Lo que no puede volver a pasar se ve leyendo el fichero.
 */

import { readFileSync } from "node:fs";

const ROUTE = "src/app/api/webhooks/shopify/route.ts";
const MODULE = "src/lib/discovery-discount.ts";
const src = readFileSync(ROUTE, "utf8");
const mod = readFileSync(MODULE, "utf8");

let failed = 0;
function check(name: string, cond: boolean, hint: string) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name}\n    ${hint}`);
    failed++;
  }
}

// El cuerpo de la función que decide y emite.
const start = src.indexOf("async function maybeIssueDiscoveryCoupon");
const end = src.indexOf("async function orderHasDiscoverySet", start);
const fn = start >= 0 && end > start ? src.slice(start, end) : "";

// Solo las líneas de CÓDIGO: los comentarios nombran a propósito la función que
// NO se debe usar, para explicar por qué.
const fnCode = fn
  .split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

console.log("\n── la guarda del cupón de 4,99 € (Discovery Set) ──\n");

check(
  "la función de emisión existe",
  fn.length > 0,
  `No se encontró maybeIssueDiscoveryCoupon en ${ROUTE}. Si se ha reestructurado, ACTUALIZA este test, no lo borres.`,
);

check(
  "pregunta a Seal por email (fuente de verdad)",
  /seal\.getSubscriptionsByEmail/.test(fnCode),
  "La guarda debe usar seal.getSubscriptionsByEmail: Seal es la fuente de verdad y propaga los fallos en vez de tragárselos.",
);

check(
  "NO usa el atajo de caché resolveActiveSubFast",
  !/resolveActiveSubFast/.test(fnCode),
  "resolveActiveSubFast mira solo la caché de Supabase y devuelve null en un cache miss, que aquí se leería como 'no tiene suscripción' y regala 4,99 €.",
);

check(
  "cuenta paused y reactivating como suscripción viva",
  /"paused"/.test(fnCode) && /"reactivating"/.test(fnCode),
  "Una sub pausada sigue siendo cliente de suscripción: no hay nada que convertir, no le toca el cupón.",
);

// FAIL-CLOSED: el catch de Seal tiene que dejar hadLiveSubscription en true.
const catchIdx = fnCode.indexOf("} catch (err) {", fnCode.indexOf("getSubscriptionsByEmail"));
const catchBlock = catchIdx >= 0 ? fnCode.slice(catchIdx, catchIdx + 400) : "";
check(
  "si Seal falla, asume suscripción viva (no emite)",
  /hadLiveSubscription = true/.test(catchBlock),
  "Fail-closed: perder un cupón recuperable a mano es preferible a regalárselo a quien ya paga.",
);

check(
  "sin cliente o sin email no emite",
  /if \(!customerId \|\| !email\)/.test(fnCode),
  "Sin customerId no hay idempotencia (la PK es el cliente) y sin email no hay a quién mandarlo. Dirección segura: no emitir y avisar.",
);

check(
  "es idempotente: si ya tiene código, no reemite",
  /discovery_set_coupons/.test(fnCode) && /prior\?\.discount_code/.test(fnCode),
  "Un segundo Discovery Set (o una redelivery) debe devolver el MISMO cupón, no emitir otro. Se lee la fila antes de emitir.",
);

check(
  "guarda la fila ANTES de disparar el evento de Klaviyo",
  fnCode.indexOf(".insert({") < fnCode.indexOf("Discovery Set Purchased") &&
    fnCode.indexOf(".insert({") > 0,
  "Si el evento saliera primero y la escritura fallara, el cliente tendría el código y nosotros ninguna fila: su siguiente compra emitiría un segundo cupón.",
);

console.log("\n── Discovery + suscripción en el MISMO pedido (2026-10-09, #11724) ──\n");

check(
  "la sub nacida de ESTE pedido no cuenta como 'ya era suscriptor'",
  /String\(sub\.order_id \?\? ""\) === orderId\) return false/.test(fnCode),
  "Es la conversión, no un suscriptor previo. Sin excluirla, el mismo pedido daría o no crédito según si Seal ha creado la sub antes de que llegue orders/paid.",
);

check(
  "elige el modo 'renewal' si el pedido trae suscripción (líneas o Seal)",
  /orderHasSubscription \|\| sealHasSubFromThisOrder \? "renewal" : "checkout"/.test(fnCode),
  "Las dos señales: el selling plan de las líneas (Admin API) y una sub de Seal nacida del pedido, por si la relectura de líneas falló.",
);

const renewalBranch = fnCode.indexOf('if (mode === "renewal") {');
check(
  "en modo 'renewal' NO dispara el flow de cinco emails",
  renewalBranch > 0 &&
    renewalBranch < fnCode.indexOf("Discovery Set Purchased") &&
    /if \(mode === "renewal"\) \{[\s\S]*?return;\s*\}/.test(fnCode),
  "Ese flow le pide suscribirse y canjear un código a quien ya está suscrito: es justo lo que le pasó al pedido #11724.",
);

check(
  "en modo 'renewal' guarda la fila como pending_apply",
  /mode: "renewal", status: "pending_apply"/.test(fnCode),
  "Sin la fila pendiente, ni el webhook de Seal ni el cron sabrían que hay que aplicar los 4,99 € a la renovación.",
);

check(
  "la rama 'checkout' no escribe columnas de la migración nueva",
  /\.\.\.\(mode === "renewal" \? \{ mode: "renewal", status: "pending_apply" \} : \{\}\)/.test(fnCode),
  "Así el cupón de siempre sigue saliendo aunque el código llegue a producción antes que la migración 2026-10-09.",
);

console.log("\n── la configuración del descuento (en su descuento PADRE, 2026-10-14) ──\n");

// Desde el 2026-10-14 los códigos van DENTRO de «Cupón Discovery Set · 4,99€»,
// así que la configuración vive en el padre: la función que lo crea
// (lib/coupon-parent.ts) y la definición con la que se creó
// (scripts/coupons-create-parents.ts).
const PARENT_MOD = readFileSync("src/lib/coupon-parent.ts", "utf8");
const CREATE = readFileSync("scripts/coupons-create-parents.ts", "utf8");
const createFn = (() => {
  const a = PARENT_MOD.indexOf("export async function createCouponParent");
  const b = PARENT_MOD.indexOf("export async function addCouponCode", a);
  return a >= 0 && b > a ? PARENT_MOD.slice(a, b) : "";
})();
const createCode = createFn
  .split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");
const discoveryDef = (() => {
  const i = CREATE.indexOf('name: "DISCOVERY_COUPON_PARENT_GID"');
  return i >= 0 ? CREATE.slice(i, i + 400) : "";
})();

check(
  "el padre del Discovery NO aplica en compra única",
  /appliesOnOneTimePurchase: false/.test(discoveryDef),
  "La promesa es devolver los 4,99 € al pedir una caja CON envíos programados. Si valiera en one-shot, el cliente lo gasta ahí y la campaña no convierte a nadie.",
);

check(
  "el padre aplica en suscripción, explícito",
  /appliesOnSubscription: true/.test(createCode),
  "Es FALSE por defecto en Shopify. Omitirlo con one-time ya en false deja un cupón que no sirve en NINGÚN carrito.",
);

check(
  "solo el primer cobro",
  /recurringCycleLimit: 1/.test(createCode),
  "Sin esto son 4,99 € menos en cada entrega para siempre: un cupón de captación convertido en descuento permanente.",
);

check(
  "el código va suelto, nunca por segmento de clientes",
  /customerSelection: \{ all: true \}/.test(createCode),
  "Restringir por cliente es lo que dejó los cupones de GoAffPro con CERO redenciones: Shopify los rechaza a quien paga sin estar logueado, que es justo el comprador del Discovery Set.",
);

check(
  "una vez por cliente, y SIN usageLimit en el padre",
  /appliesOncePerCustomer: true/.test(createCode) && !/usageLimit/.test(createCode),
  "En un padre el usageLimit cuenta TODOS los códigos: con 1, el primer canje dejaría muerto el cupón de todos los demás. El «un solo uso» de cada código lo pone el portal (orders/paid y el cron).",
);

check(
  "el importe es el precio del Set",
  /const DISCOUNT_AMOUNT_EUR = "4\.99"/.test(mod) && /DISCOVERY_DISCOUNT_VALUE_EUR/.test(discoveryDef),
  "Es una devolución del precio del Discovery Set (4,99 €), no un descuento redondo, y el padre se crea con ese mismo importe.",
);

check(
  "emite DENTRO del padre, no un descuento suelto",
  /addCouponCode\(DISCOVERY_COUPON_PARENT_GID, code\)/.test(mod) && !/discountCodeBasicCreate/.test(mod),
  "Un descuento suelto por cliente es lo que llenó el admin de Shopify (140 líneas en un mes). Juan, 2026-10-14: todos los nuevos dentro del padre.",
);

check(
  "el código de RENOVACIÓN no caduca",
  /mode === "renewal"\s*\?\s*null/.test(mod) && /row\.mode === "renewal"/.test(PARENT_MOD),
  "La primera renovación de una sub de 45 días o más cae después de 30 días: el cron solo puede quitar ese código cuando la renovación ya se ha cobrado o anulado.",
);

console.log("\n── el cron de limpieza no borra cupones ajenos ──\n");

const CLEANUP = "src/app/api/cron/survey-discount-cleanup/route.ts";
const cleanup = readFileSync(CLEANUP, "utf8");

check(
  "revalida el título en casa, no solo con el query: de Shopify",
  /CAMPAIGN_PREFIXES\.some\(/.test(cleanup),
  `El query "title:Discovery*" de Shopify NO es un prefijo: hace match por palabra. Verificado el 2026-09-24 contra producción, devuelve "DESCUBRE595 - reembolso Discovery Set en suscripcion", que está EXPIRED y sin usar — sin esta revalidación el cron lo BORRARÍA.`,
);

// La regla de verdad, ejecutada. Los dos primeros títulos son reales, salidos
// de la consulta a producción del 2026-09-24.
const PREFIXES = ["Perfilado ", "Discovery "];
const wouldDelete = (t: string) => PREFIXES.some((p) => t.startsWith(p));

check(
  "NO borra DESCUBRE595 (lo cuela el query de Shopify)",
  !wouldDelete("DESCUBRE595 - reembolso Discovery Set en suscripcion"),
  "Es el código general que sustituye este mecanismo. Está EXPIRED y con 0 usos, así que pasa las otras dos guardas: solo el prefijo lo salva.",
);

check(
  "NO borra un descuento ajeno que mencione Discovery",
  !wouldDelete("BLACKFRIDAY Discovery deal"),
  "Cualquier campaña de marketing que lleve la palabra en el título entra por el query y no puede salir por el delete.",
);

check(
  "SÍ borra los nuestros, de las dos campañas",
  wouldDelete("Perfilado LIT-TW3DVWJD (27044729520477)") &&
    wouldDelete("Discovery LIT-AB34CD56 (28520928051549)"),
  "Si deja de reconocer sus propios prefijos, el cron no limpia nada y la lista del admin se vuelve inservible.",
);

check(
  "NO borra los descuentos padre (sus títulos no empiezan por los prefijos)",
  !wouldDelete("Cupón perfilado · 5€") && !wouldDelete("Cupón Discovery Set · 4,99€"),
  "El bucle de los sueltos borra por prefijo de título. Si un padre empezara por «Perfilado » o «Discovery », un día podría llevarse por delante todos los códigos de la campaña.",
);

console.log(
  failed === 0 ? "\nTodo en verde.\n" : `\n${failed} fallo(s).\n`,
);
process.exit(failed === 0 ? 0 : 1);

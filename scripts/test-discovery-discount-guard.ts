/**
 * Protege la guarda del cupón de 5,95 € del LIT Discovery Set, que es lo que
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

console.log("\n── la guarda del cupón de 5,95 € (Discovery Set) ──\n");

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
  "resolveActiveSubFast mira solo la caché de Supabase y devuelve null en un cache miss, que aquí se leería como 'no tiene suscripción' y regala 5,95 €.",
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

console.log("\n── la configuración del descuento ──\n");

check(
  "NO aplica en compra única",
  /appliesOnOneTimePurchase: false/.test(mod),
  "La promesa es devolver los 5,95 € al pedir una caja CON envíos programados. Si valiera en one-shot, el cliente lo gasta ahí y la campaña no convierte a nadie.",
);

check(
  "aplica en suscripción, explícito",
  /appliesOnSubscription: true/.test(mod),
  "Es FALSE por defecto en Shopify. Omitirlo con one-time ya en false deja un cupón que no sirve en NINGÚN carrito.",
);

check(
  "solo el primer cobro",
  /recurringCycleLimit: 1/.test(mod),
  "Sin esto son 5,95 € menos en cada entrega para siempre: un cupón de captación convertido en descuento permanente.",
);

check(
  "el código va suelto, nunca por segmento de clientes",
  /customerSelection: \{ all: true \}/.test(mod),
  "Restringir por cliente es lo que dejó los cupones de GoAffPro con CERO redenciones: Shopify los rechaza a quien paga sin estar logueado, que es justo el comprador del Discovery Set.",
);

check(
  "el importe es el precio del Set",
  /const DISCOUNT_AMOUNT_EUR = "5\.95"/.test(mod),
  "Es una devolución del precio del Discovery Set (5,95 €), no un descuento redondo.",
);

check(
  "el título lleva el prefijo Discovery",
  /title: `Discovery \$\{code\}/.test(mod),
  "Es por donde los busca el cron de limpieza y por donde se distinguen en el admin de los del perfilado.",
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

console.log(
  failed === 0 ? "\nTodo en verde.\n" : `\n${failed} fallo(s).\n`,
);
process.exit(failed === 0 ? 0 : 1);

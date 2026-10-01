/**
 * Protege la comprobación de "¿tiene suscripción viva?" de la ruta de la
 * encuesta, que es lo que decide si se emite un cupón de 5 €.
 *
 *   npx tsx scripts/test-survey-discount-guard.ts
 *
 * ── Qué pasó el 23-sep-2026 ──
 *
 * La ruta usaba `resolveActiveSubFast`, que mira SOLO la caché de Supabase y
 * devuelve `null` en cuanto no encuentra la fila. Su docstring dice que es
 * seguro "porque el llamante cae al escaneo por email"; el portal hace ese
 * fallback, esta ruta NO lo hacía. Resultado: 3 suscriptores activos se
 * llevaron cupón de 5 € y el email de "aquí están tus 5 €" el día del
 * lanzamiento. Una de ellas tenía sub ACTIVE desde julio y CERO filas en la
 * caché, simplemente porque nunca había entrado al portal.
 *
 * Y el agravante: esa función acaba en `catch { return null }`, así que un
 * fallo de Seal llegaba a la ruta disfrazado de "no tiene suscripción". El
 * `catch` de la ruta, escrito justamente para NO emitir cupón cuando Seal no
 * contesta, era inalcanzable.
 *
 * Este test es de CÓDIGO FUENTE, no de comportamiento, a propósito: la ruta
 * habla con Seal, Shopify y Supabase, y montar ese triple mock costaría más de
 * lo que protege. Lo que no puede volver a pasar es que alguien cambie la
 * fuente de verdad por el atajo, y eso se ve leyendo el fichero.
 */

import { readFileSync } from "node:fs";

const ROUTE = "src/app/api/survey/profile/route.ts";
const src = readFileSync(ROUTE, "utf8");

let failed = 0;
function check(name: string, cond: boolean, hint: string) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name}\n    ${hint}`);
    failed++;
  }
}

// El bloque que decide la emisión: desde `if (!discount)` hasta el cierre del
// catch que fija `hadLiveSubscription = true`.
const start = src.indexOf("if (!discount) {");
const end = src.indexOf("hadLiveSubscription = true;", start);
const guard = start >= 0 && end > start ? src.slice(start, end) : "";

console.log("\n── la guarda del cupón de 5 € ──\n");

check(
  "el bloque de decisión existe",
  guard.length > 0,
  `No se encontró 'if (!discount)' + el catch en ${ROUTE}. Si se ha reestructurado, ACTUALIZA este test, no lo borres.`,
);

check(
  "pregunta a Seal por email (fuente de verdad)",
  /getSubscriptionsByEmail/.test(guard),
  "La guarda debe usar seal.getSubscriptionsByEmail: Seal es la fuente de verdad y propaga los fallos.",
);

// Se miran solo las líneas de CÓDIGO: los comentarios de arriba nombran la
// función a propósito, para explicar por qué no se usa.
const guardCode = guard
  .split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

check(
  "NO usa el atajo de caché resolveActiveSubFast",
  !/resolveActiveSubFast/.test(guardCode),
  "resolveActiveSubFast mira solo la caché de Supabase y devuelve null en un cache miss, que aquí se lee como 'no tiene suscripción' y regala 5 €.",
);

check(
  "cuenta paused y reactivating como suscripción viva",
  /"paused"/.test(guard) && /"reactivating"/.test(guard),
  "Una sub pausada sigue siendo cliente de suscripción: no le toca el cupón de recuperación.",
);

check(
  "sin email de cliente NO emite cupón",
  /if \(!email\)/.test(guard) && /throw/.test(guard),
  "Sin email no se puede preguntar a Seal. Hay que ir a la dirección segura (no emitir), no asumir que no tiene suscripción.",
);

// El catch debe dejar hadLiveSubscription en true: si Seal no contesta, NO se
// emite. Al revés sería regalar dinero en cada incidencia de Seal.
const catchBlock = src.slice(src.indexOf("} catch (err) {", start), end);
check(
  "si Seal falla, asume suscripción viva (no emite)",
  /hadLiveSubscription/.test(catchBlock + "hadLiveSubscription = true;"),
  "El catch debe fijar hadLiveSubscription = true.",
);


// ── La reserva del código contra la doble emisión (Kiko, 2026-09-24) ──
//
// Dos envíos simultáneos creaban DOS descuentos en Shopify. El índice único es
// sobre `discount_code` y los códigos son aleatorios, así que dos códigos
// distintos del mismo cliente no chocan: el índice los deja pasar. Lo que
// protege es reservar la fila antes de llamar a Shopify.

console.log("\n── la reserva del cupón ──\n");

check(
  "reserva el código ANTES de crearlo en Shopify",
  /\.update\(\{ discount_code: reservedCode \}\)/.test(src) &&
    /\.is\("discount_code", null\)/.test(src),
  "Hace falta un UPDATE condicional (.is('discount_code', null)) que Postgres serializa por fila: de dos peticiones a la vez solo una recibe fila.",
);

check(
  "el código reservado es el que se emite",
  /issueSurveyDiscount\(ctx\.customerId, codeToIssue\)/.test(src),
  "Si se emitiera otro código distinto del reservado, la reserva no serviría de nada.",
);

check(
  "si Shopify falla, LIBERA la reserva",
  /\.update\(\{ discount_code: null \}\)/.test(src) &&
    /\.eq\("discount_code", codeToIssue\)/.test(src),
  "Sin liberar, el cliente queda con un código muerto en la fila y ningún reintento podría volver a ganar la reserva: no recibiría cupón nunca.",
);

// ── El fallo de comprobación no puede guardarse como medición ──

console.log("\n── el fallo silencioso ──\n");

check(
  "un fallo al comprobar la suscripción AVISA por Slack",
  /survey_subscription_check_failed/.test(src),
  "Sin alerta, un fallo de Seal es invisible: el cliente ve su pantalla de gracias y nadie se entera.",
);

check(
  "un fallo de comprobación deja was_subscriber_at_answer a NULL",
  // Sin \s ni multilinea el test se rompe con solo pasar prettier.
  /subscriptionCheckFailed[\s\S]{0,40}\?\s*null/.test(src),
  "hadLiveSubscription=true en el catch es una decisión operativa, no una medición: guardarla dejaría a un one-shot anotado como suscriptor para siempre.",
);

// ── El formulario vacío ──

check(
  "exige al menos una respuesta",
  /Object\.keys\(v\.clean\)\.length === 0/.test(src) && /no_answers/.test(src),
  "Enviar en blanco cobraba los 50 drops y el cupón a cambio de cero información.",
);

// ── El evento de Klaviyo no puede quedar huérfano ──

check(
  "el evento de Klaviyo va en after(), no en void",
  /after\(\(\) =>/.test(src) && !/void klaviyo/.test(src),
  "Con `void` la promesa queda huérfana: si la función se congela al responder se pierde el evento y con él el correo del cupón.",
);

console.log(
  failed === 0 ? "\nTodo en verde.\n" : `\n${failed} fallo(s).\n`,
);
process.exit(failed === 0 ? 0 : 1);

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

console.log(
  failed === 0 ? "\nTodo en verde.\n" : `\n${failed} fallo(s).\n`,
);
process.exit(failed === 0 ? 0 : 1);

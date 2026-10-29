/**
 * Tests del 15 % de la baja con sus dos puertas (27-oct-2026): el asistente de baja del área
 * personal (`api/subscription/retention-discount`) y el bot de WhatsApp
 * (`api/internal/subscription/retention-discount`), que comparten `src/lib/retention-discount-apply.ts`.
 * Sin framework, como el resto de scripts de test del repo.
 *
 *   npm test
 *   npx tsx scripts/test-retention-discount.ts
 *
 * El fixture de calendario es la forma real de `billing_attempts` en Seal (cobros hechos con
 * `completed_at`, saltados con `skipped_on`, uno fallido con `status`, y DESORDENADOS: Seal
 * no garantiza el orden).
 *
 * Qué protege:
 *   - una sola copia del camino de dinero: ninguna de las dos rutas toca la tabla
 *     `retention_discounts` ni aplica el código en Seal por su cuenta;
 *   - las guardas de Juan (una vez por cliente, solo en la primera baja) se miran en las dos
 *     puertas ANTES de ofrecer o simular;
 *   - la fila de seguimiento se reserva ANTES de aplicar el código, y un fallo de Seal solo
 *     libera la reserva si Seal dijo que no de verdad;
 *   - el bot no puede aplicar sin la fecha que vio la oferta, ni decir «hecho» sin ver el
 *     código en la sub;
 *   - el «próximo LIT» del que habla el bot es el primer cobro PENDIENTE por fecha.
 */

import { readFileSync } from "node:fs";

import { nextChargeDateOf, normalizeRetentionReason, retentionDiscountCode } from "@/lib/retention-discount-apply";
import type { SealSubscription } from "@/lib/seal";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Quita comentarios para que una guarda no pase en verde por estar citada en un comentario. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sub = (raw: unknown) => raw as SealSubscription;

console.log("\n── el código y los motivos ──\n");
{
  const prev = process.env.RETENTION_DISCOUNT_CODE;
  delete process.env.RETENTION_DISCOUNT_CODE;
  check("por defecto, LITSTAY15", retentionDiscountCode() === "LITSTAY15", retentionDiscountCode());
  process.env.RETENTION_DISCOUNT_CODE = "OTRO15";
  check("RETENTION_DISCOUNT_CODE manda", retentionDiscountCode() === "OTRO15");
  if (prev === undefined) delete process.env.RETENTION_DISCOUNT_CODE;
  else process.env.RETENTION_DISCOUNT_CODE = prev;

  check("un motivo del área personal se guarda tal cual", normalizeRetentionReason("too_expensive") === "too_expensive");
  check("uno que no está en la lista, como `other`", normalizeRetentionReason("me mudo") === "other");
  check("sin motivo, null", normalizeRetentionReason(undefined) === null && normalizeRetentionReason("") === null);
}

console.log("\n── el próximo cobro ──\n");
{
  // Desordenado, como lo devuelve Seal: un cobro hecho, uno saltado, uno fallido y dos pendientes.
  const s = sub({
    id: 1,
    billing_attempts: [
      { id: 5, date: "2027-01-12T10:00:00+00:00", completed_at: null, status: "", skipped_on: null },
      { id: 2, date: "2026-10-12T10:00:00+00:00", completed_at: "2026-10-12T10:03:11+00:00", status: "", skipped_on: null },
      { id: 4, date: "2026-12-12T10:00:00+00:00", completed_at: null, status: "", skipped_on: null },
      { id: 3, date: "2026-11-12T10:00:00+00:00", completed_at: null, status: "", skipped_on: "2026-10-20T08:00:00+00:00" },
      { id: 6, date: "2026-11-02T10:00:00+00:00", completed_at: null, status: "error", skipped_on: null },
    ],
  });
  check("el primer pendiente por fecha, no por orden de llegada", nextChargeDateOf(s) === "2026-12-12", String(nextChargeDateOf(s)));
  check("ni el saltado ni el fallido ni el ya cobrado", nextChargeDateOf(s) !== "2026-11-12" && nextChargeDateOf(s) !== "2026-11-02");
  check("sin pendientes, null", nextChargeDateOf(sub({ id: 1, billing_attempts: [] })) === null);
}

console.log("\n── una sola copia del camino de dinero ──\n");
{
  const core = code(readFileSync("src/lib/retention-discount-apply.ts", "utf8"));
  const portal = code(readFileSync("src/app/api/subscription/retention-discount/route.ts", "utf8"));
  const bot = code(readFileSync("src/app/api/internal/subscription/retention-discount/route.ts", "utf8"));

  for (const [name, src] of [["área personal", portal], ["bot", bot]] as const) {
    check(`${name}: no toca la tabla por su cuenta`, !src.includes('"retention_discounts"'));
    check(`${name}: no aplica ni quita el código en Seal por su cuenta`, !/seal\.(applyDiscountCode|removeDiscountCode)\(/.test(src));
    check(`${name}: aplica por el núcleo`, src.includes("applyRetentionDiscount({"));
    check(`${name}: mira las guardas de Juan`, src.includes("assertRetentionDiscountAllowed("));
  }
  check("área personal: la fuente es el portal", /source: "portal"/.test(portal));
  check("bot: la fuente es la del resto del bot (`whatsapp_bot`)", /source: "whatsapp_bot"/.test(bot));

  const lockAt = core.indexOf("assertNoPendingLineRepair(");
  const reserveAt = core.search(/\.from\("retention_discounts"\)\s*\.insert\(/);
  const applyAt = core.indexOf("seal.applyDiscountCode(");
  check("núcleo: sin cambio de plan a medias antes de reservar", lockAt > 0 && lockAt < reserveAt);
  check("núcleo: la fila se reserva ANTES de aplicar", reserveAt > 0 && applyAt > reserveAt);
  const rejectedAt = core.indexOf("sealWriteDefinitelyRejected(e)");
  const deleteAt = core.indexOf(".delete()");
  check("núcleo: solo se libera la reserva si Seal dijo que no", rejectedAt > applyAt && deleteAt > rejectedAt);
  check("núcleo: una duplicada en la base es `already_used`", /ins\.error\.code === "23505"[\s\S]{0,200}"already_used"/.test(core));
  const lockTakenAt = core.indexOf("acquirePlanLock(customerId, sub.id");
  check(
    "núcleo: el 15 % entra dentro del cerrojo de los cambios de plan, y se suelta siempre",
    lockTakenAt > 0 && lockTakenAt < lockAt && applyAt > lockTakenAt &&
      /\} finally \{\s*await lock\.release\(\);\s*\}/.test(core) && core.indexOf("await lock.release()") > applyAt,
  );
  const perSubAt = core.indexOf('.eq("status", "pending_charge")');
  check("núcleo: una sola fila viva por suscripción, mirada antes de reservar", perSubAt > lockAt && perSubAt < reserveAt);
  const unknownAt = core.indexOf("retention_apply_unknown");
  check(
    "núcleo: el aviso de un 15 % dudoso se ESPERA antes de lanzar",
    /await runWithoutRequestDeadline\(\(\) =>\s*alertSlackErrorAwaited\(\{\s*path,\s*code: `retention_apply_unknown/.test(core) &&
      core.indexOf('"discount_apply_unconfirmed"', unknownAt) > unknownAt &&
      !/\balertSlackError\(/.test(core),
  );
  // 29-oct-2026: del bot no avisa, porque lo sigue `check_bot_writes` (tarea en LIT Tasks y ticket
  // para Antonio). El del área personal se queda: ahí es lo único que avisa a una persona.
  check(
    "núcleo: el aviso del 15 % dudoso solo cuando no es el bot",
    /if \(source !== "whatsapp_bot"\) \{\s*await runWithoutRequestDeadline\(\(\) =>\s*alertSlackErrorAwaited\(\{\s*path,\s*code: `retention_apply_unknown/.test(core),
  );

  const portalGuardAt = portal.indexOf("assertRetentionDiscountAllowed(");
  const portalDryAt = portal.indexOf("if (dryRun)");
  check("área personal: las guardas antes de la simulación, como siempre", portalGuardAt > 0 && portalGuardAt < portalDryAt);

  // Juan (28-oct): una lectura que falla no deja pasar. Cada guarda mira su `error` y lanza 503
  // ANTES de mirar el dato; sin esto la de la primera baja ofrecía el 15 % a ciegas.
  const guardas = core.slice(core.indexOf("export async function assertRetentionDiscountAllowed"),
                             core.indexOf("export interface ApplyRetentionDiscountArgs"));
  for (const [tabla, err, dato] of [["retention_discounts", "usedErr", "if (existing)"],
                                    ["customer_preferences", "prefsErr", "if ((prefs?.cancel_count"]] as const) {
    const leeAt = guardas.indexOf(`.from("${tabla}")`);
    const lanzaAt = guardas.search(new RegExp(`if \\(${err}\\) \\{\\s*throw new ApiHttpError\\(503, "guard_unavailable"`));
    check(`guardas: si no se puede leer ${tabla}, lanzan 503 antes de mirar el dato`,
          guardas.includes(`error: ${err}`) && leeAt > 0 && lanzaAt > leeAt && lanzaAt < guardas.indexOf(dato));
  }
}

console.log("\n── guardas de la ruta del bot ──\n");
{
  const route = code(readFileSync("src/app/api/internal/subscription/retention-discount/route.ts", "utf8"));
  // Dónde se LANZA cada rechazo (no dónde se nombra en BY_DESIGN_FAILURES, que va arriba del todo).
  const thrown = (c: string) => route.search(new RegExp(`ApiHttpError\\(\\s*\\d{3},\\s*"${c}"`));
  const authAt = route.indexOf("requireCron(req)");
  check("el secreto se mira antes que nada", authAt > 0 && authAt < route.indexOf("handle(req, attempt)"));
  const readAt = route.indexOf("seal.getSubscriptionById(subId, undefined, { throwTransient: true })");
  check("una escritura no nace de olvidar `dryRun`", /typeof body\.dryRun !== "boolean"/.test(route) && thrown("dry_run_required") > 0 && thrown("dry_run_required") < readAt);
  check("aplicar exige la fecha de la oferta, antes de leer Seal", thrown("expected_date_required") > 0 && thrown("expected_date_required") < readAt);
  const guardAt = route.indexOf("assertRetentionDiscountAllowed(customerId)");
  const offerAt = route.indexOf('mode: "dry_run" as const');
  check("las guardas también en la oferta: no se ofrece lo que no se va a poder poner", guardAt > 0 && guardAt < offerAt);
  check("sin cobro pendiente no se ofrece", thrown("no_pending_attempt") > 0 && thrown("no_pending_attempt") < offerAt);
  check("ni pausada ni parada", thrown("subscription_paused") > 0 && thrown("subscription_paused") < offerAt && thrown("subscription_not_active") > 0 && thrown("subscription_not_active") < offerAt);
  check("un 15 % ya puesto sin fila no se vuelve a poner", thrown("already_applied") > 0 && thrown("already_applied") < offerAt);
  const changedAt = thrown("subscription_changed");
  const applyAt = route.indexOf("applyRetentionDiscount({");
  check(
    "si el próximo cobro ya no es el de la oferta, no se aplica",
    changedAt > offerAt && changedAt < applyAt &&
      /if \(expected !== nextChargeDate\) \{[\s\S]{0,200}"subscription_changed"/.test(route),
  );
  const verifyAt = route.indexOf("findAppliedDiscountCodeId(live, CODE)", applyAt);
  const unverifiedAt = thrown("discount_unverified");
  const doneAt = route.indexOf("verified: true", unverifiedAt);
  check("después de aplicar se relee y sin verlo no hay «hecho»", applyAt > 0 && verifyAt > applyAt && unverifiedAt > verifyAt && doneAt > unverifiedAt);
  check(
    "lo que es de diseño no avisa, ni un 15 % sin verificar (lo sigue check_bot_writes); uno puesto sin fila sí",
    /BY_DESIGN_FAILURES = new Set\(\[[^\]]*"already_used"[^\]]*"not_first_cancel"/.test(route) &&
      /BY_DESIGN_FAILURES = new Set\(\[[^\]]*"discount_unverified"/.test(route) &&
      !/BY_DESIGN_FAILURES = new Set\(\[[^\]]*"already_applied"/.test(route),
  );
  check("otro cambio en curso no es una avería", /BY_DESIGN_FAILURES = new Set\(\[[^\]]*"plan_change_in_progress"/.test(route));
}

if (failures) {
  console.error(`\n${failures} fallo(s)`);
  process.exit(1);
}
console.log("\nOK — test-retention-discount");

/**
 * Reactivar y reanudar desde el portal (2026-10-14): quién puede reactivar
 * (también bajas por impago y por atención) y lo que pasa después (cobro a mañana
 * tras un impago, aviso con la fecha buena).
 *
 *   npx tsx scripts/test-reactivation.ts
 */
import { readFileSync } from "node:fs";
import { decideFollowup, pickExternalCandidate, portalCancelEligible } from "../src/lib/reactivation";
import type { SealSubscription } from "../src/lib/seal";

let failed = 0;
function check(name: string, cond: boolean, hint: string) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name}\n    ${hint}`);
    failed++;
  }
}

const NOW = Date.parse("2026-10-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

type Attempt = { id: number; date: string; status?: string; completed_at?: string; attempted_at?: string | null; triggered_manually?: string; skipped_on?: string };
const sub = (over: Partial<Record<string, unknown>> & { billing_attempts?: Attempt[] } = {}) =>
  ({
    id: 1,
    status: "ACTIVE",
    email: "x@example.com",
    cancelled_on: "",
    cancellation_scheduled_for: "",
    paused_on: "",
    billing_attempts: [],
    ...over,
  }) as unknown as SealSubscription;

console.log("\n── quién puede reactivar ──\n");

check(
  "la regla de siempre: primera baja desde el portal y dentro de 90 días",
  portalCancelEligible({ cancel_count: 1, last_cancelled_at: iso(NOW - 10 * DAY) }, NOW) &&
    !portalCancelEligible({ cancel_count: 2, last_cancelled_at: iso(NOW - 10 * DAY) }, NOW) &&
    !portalCancelEligible({ cancel_count: 1, last_cancelled_at: iso(NOW - 91 * DAY) }, NOW) &&
    !portalCancelEligible(null, NOW),
  "Es la que ya tenían el panel, la lista y la ruta; ahora vive en un solo sitio.",
);
check(
  "fuera del portal: la cancelada más reciente, dentro de 90 días",
  pickExternalCandidate(
    [
      sub({ id: 1, status: "CANCELLED", cancelled_on: iso(NOW - 40 * DAY) }),
      sub({ id: 2, status: "CANCELLED", cancelled_on: iso(NOW - 3 * DAY) }),
    ],
    NOW,
  )?.id === 2,
  "Se ofrece reactivar la última baja, no una vieja.",
);
check(
  "fuera del portal: nada si tiene otra sub activa o pausada, o si pasaron 90 días",
  pickExternalCandidate([sub({ id: 1, status: "CANCELLED", cancelled_on: iso(NOW - 3 * DAY) }), sub({ id: 2, status: "PAUSED" })], NOW) === null &&
    pickExternalCandidate([sub({ id: 1, status: "CANCELLED", cancelled_on: iso(NOW - 91 * DAY) })], NOW) === null,
  "Con otra sub viva no hay nada que reactivar; pasados 90 días se vuelve por la tienda, como con la baja del portal.",
);

console.log("\n── lo que pasa después ──\n");

const created = iso(NOW - 3 * 60 * 1000);
const failedAttempt: Attempt = { id: 10, date: "2026-10-09T10:00:00Z", status: "error", attempted_at: "2026-10-09T10:00:05Z" };
const farPending: Attempt = { id: 11, date: "2027-04-09T10:00:00Z", status: "" };
const unpaidRow = { pull_to: "2026-10-15", created_at: created };

check(
  "espera mientras Seal no la ha reactivado",
  decideFollowup(sub({ status: "CANCELLED", billing_attempts: [farPending] }), unpaidRow, { now: NOW }).kind === "wait",
  "Sin sub activa no hay calendario que tocar.",
);
check(
  "espera mientras Seal no ha regenerado el calendario",
  decideFollowup(sub({ billing_attempts: [failedAttempt] }), unpaidRow, { now: NOW }).kind === "wait",
  "Seal tarda 27-170 s; antes de eso no hay cobro pendiente.",
);
check(
  "espera si hay un cobro vencido o en marcha (Seal puede cobrar al reactivar)",
  decideFollowup(sub({ billing_attempts: [{ id: 12, date: iso(NOW - 60 * 1000), status: "" }, farPending] }), unpaidRow, { now: NOW }).kind === "wait",
  "La 15304997 cobró a los 87 s de reactivar: traer otro a mañana le cobraría dos veces.",
);
check(
  "impago con el cobro a 6 meses: se trae a mañana",
  JSON.stringify(decideFollowup(sub({ billing_attempts: [failedAttempt, farPending] }), unpaidRow, { now: NOW })) ===
    JSON.stringify({ kind: "pull", targetDate: "2026-10-15" }),
  "Es la caja que no se pudo cobrar; un semestral la recibiría en abril.",
);
check(
  "impago con el cobro ya mañana o antes: solo avisar",
  decideFollowup(sub({ billing_attempts: [failedAttempt, { id: 13, date: "2026-10-15T09:00:00Z", status: "" }] }), unpaidRow, { now: NOW }).kind === "notify",
  "pullCadenceBackTo solo mueve hacia atrás; no hay nada que traer.",
);
check(
  "impago con un cobro bueno tras reactivar: solo avisar",
  decideFollowup(
    sub({ billing_attempts: [failedAttempt, { id: 14, date: iso(NOW - 2 * 60 * 1000), status: "completed", completed_at: iso(NOW - 110 * 1000), attempted_at: iso(NOW - 115 * 1000) }, farPending] }),
    unpaidRow,
    { now: NOW },
  ).kind === "notify" &&
    decideFollowup(sub({ billing_attempts: [failedAttempt, farPending] }), unpaidRow, { now: NOW, chargeNowAfter: true }).kind === "notify",
  "Seal cobró al reactivar o el cliente pulsó Adelantar: otro cobro mañana sería el segundo.",
);
check(
  "si Seal intentó cobrar al reactivar y FALLÓ, tampoco se trae nada",
  decideFollowup(
    sub({ billing_attempts: [failedAttempt, { id: 16, date: iso(Date.parse(created) - 30 * 1000), status: "error", attempted_at: iso(Date.parse(created) - 25 * 1000) }, farPending] }),
    unpaidRow,
    { now: NOW },
  ).kind === "notify",
  "Ese intento ya está en el ciclo de reintentos de Seal: traer otro a mañana coincidiría con su reintento y, con tarjeta nueva, cobrarían los dos.",
);
check(
  "los intentos fallidos de ANTES de la baja no frenan el cobro a mañana",
  decideFollowup(sub({ billing_attempts: [failedAttempt, farPending] }), unpaidRow, { now: NOW }).kind === "pull",
  "Son los que provocaron la baja (días antes); si contaran, nunca se traería la caja.",
);
check(
  "un cobro de Seal fechado justo ANTES de apuntar también cuenta",
  decideFollowup(
    sub({ billing_attempts: [failedAttempt, { id: 15, date: iso(Date.parse(created) - 60 * 1000), status: "completed", completed_at: iso(Date.parse(created) - 30 * 1000) }, farPending] }),
    unpaidRow,
    { now: NOW },
  ).kind === "notify",
  "Seal fecha el cobro inmediato en el instante de reactivar, antes de que la ruta escriba la fila.",
);
check(
  "un apunte viejo nunca trae el cobro al pasado",
  JSON.stringify(decideFollowup(sub({ billing_attempts: [failedAttempt, farPending] }), { pull_to: "2026-10-10", created_at: iso(NOW - 4 * DAY) }, { now: NOW })) ===
    JSON.stringify({ kind: "pull", targetDate: "2026-10-15" }),
  "Si el cron lo recoge días después, el cobro va a mañana, no a la fecha apuntada.",
);
check(
  "reanudar, o reactivar sin impago: solo avisar, en cuanto hay calendario",
  decideFollowup(sub({ billing_attempts: [farPending] }), { pull_to: null, created_at: created }, { now: NOW }).kind === "notify",
  "Sin cobro que traer, el seguimiento es solo el aviso con la fecha buena.",
);

console.log("\n── enganchado donde toca ──\n");

const REACT = readFileSync("src/app/api/subscription/reactivate/route.ts", "utf8");
const RESUME = readFileSync("src/app/api/subscription/resume/route.ts", "utf8");
const SEAL = readFileSync("src/app/api/webhooks/seal/route.ts", "utf8");
const CRON = readFileSync("src/app/api/cron/subscription-notices/route.ts", "utf8");
const DASH = readFileSync("src/app/api/hub/dashboard/route.ts", "utf8");
const SUBS = readFileSync("src/app/api/subscriptions/route.ts", "utf8");
const CARD = readFileSync("src/components/ReactivateCard.tsx", "utf8");
const HUB = readFileSync("src/app/[locale]/my-lit/page.tsx", "utf8");
const MIGRATION = readFileSync("database/migrations/2026-10-14_reactivation_followups.sql", "utf8");

check(
  "reactivar mira primero si la baja fue por impago o por atención",
  REACT.indexOf("findExternalCancel(subs)") > 0 && REACT.indexOf("findExternalCancel(subs)") < REACT.indexOf('"no_cancellation"'),
  "Si no, la regla de la baja del portal les contesta no_cancellation, que es lo que pasaba hasta hoy.",
);
check(
  "solo el impago trae el cobro a mañana, y sin devolver Drops",
  /external\.actor === "unpaid" \? addDaysUtc/.test(REACT) && /reactivateWithFollowup\(sub, external\.actor, ctx\.customerId, \{ dropsRestored: 0 \}, pullTo\)/.test(REACT),
  "Estas bajas no retienen Drops; devolver los de una baja vieja del portal regalaría Drops.",
);
check(
  "reactivar y reanudar dejan el aviso para cuando Seal haya regenerado",
  /recordFollowup\(/.test(REACT) && /kind: "resume"/.test(RESUME) && !/waitForNextCharge/.test(REACT + RESUME),
  "Esperar 20 s en la petición dejaba el aviso sin fecha: Seal tarda hasta 170 s.",
);
check(
  "el webhook aplica el seguimiento en updated, resumed y reactivated",
  (SEAL.match(/applyFollowupSafe\(sub\)/g) ?? []).length >= 2,
  "Es cuando llega el calendario regenerado.",
);
check(
  "el cron diario repasa los seguimientos pendientes",
  /runAsBackgroundJob\(\(\) => sweepFollowups/.test(CRON),
  "Red por si el webhook no llega a correr.",
);
check(
  "el Hub enseña la tarjeta a estas bajas y espera al calendario",
  /findExternalCancel\(subsRes\)/.test(DASH) &&
    /reactivationKind,/.test(DASH) &&
    /from\("reactivation_followups"\)/.test(DASH) &&
    /findExternalCancel\(subs\)/.test(SUBS),
  "Sin esto la pestaña Suscripción se apaga y el Hub les manda a la tienda.",
);
check(
  "la tarjeta de impago tiene su texto y enlaza a Cuenta",
  /variant\?: "cancelled" \| "paused" \| "unpaid"/.test(CARD) &&
    /portalHref\(lang, "account"\)/.test(CARD) &&
    /variant=\{data\.reactivationKind === "unpaid" \? "unpaid" : "cancelled"\}/.test(HUB),
  "Quien no eligió irse tiene que leer qué pasó, que la caja se cobra mañana y dónde cambiar la tarjeta.",
);
check(
  "un Seal ocupado no convierte una baja externa en una del portal",
  /getSubscriptionById\(Number\(candidate\.id\), undefined, \{ throwTransient: true \}\)/.test(readFileSync("src/lib/reactivation.ts", "utf8")) &&
    !/findExternalCancel\(subsRes\)\.catch/.test(DASH),
  "Un 429 leído como «no es externa» devolvía Drops y no traía el cobro; en el Hub enseñaba la tienda.",
);
check(
  "el Hub mira la baja externa ANTES que la regla del portal, como la ruta",
  DASH.indexOf("findExternalCancel(subsRes)") < DASH.indexOf("portalCancelEligible(prefsRes)"),
  "Si el orden difiere, la tarjeta dice una cosa y la ruta hace otra.",
);
check(
  "el apunte se escribe ANTES de reactivar o reanudar en Seal",
  REACT.indexOf("recordFollowup(") < REACT.indexOf("seal.reactivateSubscription(") &&
    RESUME.indexOf("recordFollowup(") < RESUME.indexOf("seal.resumeSubscription("),
  "Si Seal aplica pero contesta tarde, sin apunte no hay cobro a mañana ni aviso.",
);
check(
  "el aviso de respaldo y el del seguimiento comparten clave",
  /notifyFollowup\(sub, kind, customerId, extra, createdAt\)/.test(REACT) && /followupAt\)\)/.test(RESUME),
  "Si el apunte se guardó pero la respuesta falló, saldrían dos emails.",
);
check(
  "los Drops solo vuelven por la baja del portal de ESA sub",
  /seal_subscription_id\.eq\.\$\{String\(sub\.id\)\},seal_subscription_id\.is\.null/.test(REACT),
  "Una baja hecha por Seal o atención no retiene Drops: no puede devolver los de otra baja vieja.",
);
check(
  "la tabla nueva con RLS",
  /enable row level security/.test(MIGRATION) && /seal_subscription_id\s+text\s+primary key/.test(MIGRATION),
  "RLS sin policies como el resto; una fila por sub.",
);

console.log(failed === 0 ? "\nTodo en verde.\n" : `\n${failed} fallo(s).\n`);
process.exit(failed === 0 ? 0 : 1);

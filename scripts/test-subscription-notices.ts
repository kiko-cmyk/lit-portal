/**
 * Avisos de suscripción (2026-10-14): rescate de los «Adelantar» rechazados y
 * avisos de las bajas que no pasan por el portal.
 *
 *   npx tsx scripts/test-subscription-notices.ts
 *
 * Las reglas puras con datos con la forma REAL de Seal (copiados de webhook_log y
 * del log de las subs), y comprobaciones de código fuente de que todo está
 * enganchado donde toca.
 */
import { readFileSync } from "node:fs";
import { classifyCancel, cancelNoticeEvent } from "../src/lib/cancel-notice";
import {
  addDaysUtc,
  decideRecovery,
  failedManualAttempts,
  hasLaterSuccess,
  matchIntent,
  syncFailedNote,
  type ChargeNowIntentRow,
  type RawBillingAttempt,
} from "../src/lib/charge-now-recovery";

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

// Forma real (sub 14536480, 16-sep): un Adelantar que pasó, otro rechazado por el
// antifraude, y el calendario ya reanclado dos meses más tarde.
const okManual: RawBillingAttempt = {
  id: 173153160, date: "2026-10-13T20:52:01+00:00", attempted_at: "2026-10-13T20:52:01+00:00",
  status: "completed", completed_at: "2026-10-13T20:52:07+00:00", triggered_manually: "2026-10-13 20:52:01",
};
const failedManual: RawBillingAttempt = {
  id: 173398853, date: "2026-10-14T11:02:22+00:00", attempted_at: "2026-10-14T11:02:30+00:00",
  status: "error", completed_at: "", triggered_manually: "2026-10-14 11:02:30",
  error_code: "FRAUD__SUSPECTED", error_message: "Payment couldn't be processed.",
};
const queuedManual: RawBillingAttempt = {
  id: 173398999, date: "2026-10-14T11:50:00+00:00", attempted_at: null, status: "", triggered_manually: "attempt_now",
};
const failedScheduled: RawBillingAttempt = {
  id: 170000001, date: "2026-10-14T10:00:00+00:00", attempted_at: "2026-10-14T10:00:05+00:00",
  status: "error", triggered_manually: "", error_code: "INSUFFICIENT_FUNDS",
};
const pending: RawBillingAttempt = { id: 173399295, date: "2026-12-14T22:00:00+00:00", status: "", triggered_manually: "" };

console.log("\n── qué fallo se rescata ──\n");

check(
  "un Adelantar rechazado en las últimas 24 h, sí",
  failedManualAttempts([okManual, failedManual, pending], NOW).map((a) => a.id).join() === "173398853",
  "Es el intento con status error y triggered_manually con hora: lo que manda Seal tras un Adelantar rechazado.",
);
check(
  "un cobro programado fallido, no",
  failedManualAttempts([failedScheduled], NOW).length === 0,
  "Esos los reintenta Seal 4 veces y los avisa payment_failed. Tocarlos aquí movería calendarios de renovaciones normales.",
);
check(
  "un Adelantar aún en cola, no",
  failedManualAttempts([queuedManual], NOW).length === 0,
  "«attempt_now» sin status es un cobro que la pasarela aún no ha procesado.",
);
check(
  "un Adelantar rechazado hace 3 días, no (salvo que el cron amplíe la ventana)",
  failedManualAttempts([{ ...failedManual, attempted_at: "2026-10-11T11:00:00Z", date: "2026-10-11T11:00:00Z" }], NOW).length === 0 &&
    failedManualAttempts([{ ...failedManual, attempted_at: "2026-10-12T11:00:00Z", date: "2026-10-12T11:00:00Z" }], NOW, 72).length === 1,
  "El webhook solo mira lo reciente; el cron diario mira 72 h.",
);
check(
  "si hubo un cobro bueno DESPUÉS del fallo, no se toca",
  hasLaterSuccess([failedManual, { ...okManual, attempted_at: "2026-10-14T11:20:00Z", date: "2026-10-14T11:20:00Z" }], failedManual) &&
    !hasLaterSuccess([okManual, failedManual], failedManual),
  "El cliente ya ha pagado (otro Adelantar o soporte): traer el calendario a mañana le cobraría dos veces.",
);

console.log("\n── qué se hace con el cobro ──\n");

check(
  "rechazo normal: se reintenta mañana",
  JSON.stringify(decideRecovery({ errorCode: "INSUFFICIENT_FUNDS", preChargeDate: "2026-11-02", todayYmd: "2026-10-14" })) ===
    JSON.stringify({ action: "retry", targetDate: "2026-10-15" }),
  "Juan 14-oct: «si falla, se debería reintentar solo». Desde mañana es un cobro programado con los 4 intentos de Seal.",
);
check(
  "antifraude: NO se reintenta, vuelve la fecha de antes",
  JSON.stringify(decideRecovery({ errorCode: "FRAUD__SUSPECTED", preChargeDate: "2026-11-02", todayYmd: "2026-10-14" })) ===
    JSON.stringify({ action: "restore", targetDate: "2026-11-02" }) &&
    decideRecovery({ errorCode: "FRAUD_SUSPECTED", preChargeDate: "2026-11-02", todayYmd: "2026-10-14" }).action === "restore",
  "Cada reintento fuera de sesión sube el riesgo y empeora el bloqueo. Seal escribe el código con uno y con dos guiones bajos.",
);
check(
  "antifraude con la fecha de antes ya encima: mañana, nunca hoy ni el pasado",
  decideRecovery({ errorCode: "FRAUD__SUSPECTED", preChargeDate: "2026-10-14", todayYmd: "2026-10-14" }).targetDate === "2026-10-15" &&
    decideRecovery({ errorCode: "FRAUD__SUSPECTED", preChargeDate: null, todayYmd: "2026-10-14" }).targetDate === "2026-10-15",
  "pullCadenceBackTo se niega a fechas pasadas; un cobro para hoy a las 13:00 podría ya haber pasado.",
);
check(
  "suma de días en UTC, también a fin de mes",
  addDaysUtc("2026-10-31", 1) === "2026-11-01" && addDaysUtc("2026-12-31", 1) === "2027-01-01",
  "La fecha objetivo sale de aquí.",
);

console.log("\n── solo los Adelantar de ESTE portal ──\n");

const row = (id: number, requestedAt: string, status = "requested"): ChargeNowIntentRow => ({
  id, seal_subscription_id: "14536480", customer_id: "1", pre_charge_date: "2026-11-02", requested_at: requestedAt, status,
});
check(
  "casa la fila escrita justo antes del cobro",
  matchIntent([row(1, "2026-10-14T11:02:21.500Z")], failedManual)?.id === 1,
  "charge-now escribe la fila unos milisegundos antes de llamar a Seal.",
);
check(
  "sin fila cercana no es nuestro (soporte cobrando desde el admin)",
  matchIntent([row(1, "2026-10-14T09:00:00Z")], failedManual) === null && matchIntent([], failedManual) === null,
  "Los «cobrar ya» de soporte no se tocan: puede estar haciendo algo a propósito.",
);
check(
  "con dos filas antes del intento gana la más reciente",
  matchIntent([row(1, "2026-10-14T10:55:00Z"), row(2, "2026-10-14T11:02:20Z")], failedManual)?.id === 2,
  "Si el cliente pulsó dos veces, el fallo es del último.",
);
check(
  "una fila escrita DESPUÉS del intento no se lo queda",
  matchIntent([row(1, "2026-10-14T11:02:21Z"), row(2, "2026-10-14T11:04:00Z")], failedManual)?.id === 1 &&
    matchIntent([row(2, "2026-10-14T11:04:00Z")], failedManual) === null,
  "La fila se escribe siempre antes de llamar a Seal: una de minutos después es de otro Adelantar (revisión adversarial).",
);
check(
  "si entre la fila y el fallo hubo otro cobro manual, la fila es de ese otro",
  matchIntent(
    [row(1, "2026-10-14T10:58:00Z")],
    failedManual,
    [{ id: 1, date: "2026-10-14T10:58:01Z", attempted_at: "2026-10-14T10:58:02Z", status: "completed", triggered_manually: "2026-10-14 10:58:02" }, failedManual],
  ) === null,
  "Un Adelantar que pasó y, minutos después, un «cobrar ya» de soporte que falla: no se toca el de soporte.",
);

console.log("\n── quién canceló ──\n");

const at = (content: string, created: string) => ({ content, created });
check(
  "impago",
  classifyCancel([
    at("Email about a failed billing attempt was sent to the customer.", "2026-10-09 10:28:25"),
    at("Subscription was cancelled because the payment couldn't be processed within the allowed number of retries.", "2026-10-09 10:30:27"),
  ]).actor === "unpaid",
  "Texto literal del log de Seal (sub 15950195).",
);
check(
  "atención desde el admin",
  classifyCancel([at("Merchant cancelled the subscription.", "2026-10-09 09:49:20")]).actor === "support",
  "Sin «through API»: es una persona en el admin de Seal.",
);
check(
  "desde el portal (API): no se avisa otra vez",
  classifyCancel([at("Merchant cancelled the subscription through API.", "2026-09-30 08:02:38")]).actor === "api" &&
    cancelNoticeEvent("api") === null,
  "La baja del portal ya manda subscription_cancelled; avisar aquí sería el segundo email.",
);
check(
  "manda la ÚLTIMA baja del log",
  classifyCancel([
    at("Merchant cancelled the subscription.", "2026-10-09 09:49:20"),
    at("Merchant reactivated the subscription.", "2026-10-09 10:35:33"),
    at("Merchant cancelled the subscription through API.", "2026-10-09 11:25:47"),
  ]).actor === "api",
  "Una sub puede haberse cancelado y reactivado varias veces.",
);
check(
  "cada baja con su evento, y ninguna reusa subscription_cancelled",
  cancelNoticeEvent("unpaid") === "subscription_cancelled_unpaid" &&
    cancelNoticeEvent("support") === "subscription_cancelled_support" &&
    cancelNoticeEvent("customer_seal_portal") === null &&
    cancelNoticeEvent("unknown") === null,
  "El email de subscription_cancelled lleva «Reactivar» al portal, y el portal no deja reactivar estas bajas.",
);

console.log("\n── rechazo síncrono: la fila dice si volvió la fecha ──\n");

// 27-oct-2026, Kiko: la fila se quedaba en sync_failed sin nota, se hubiera devuelto el
// calendario o no. LIT Tasks recoge de la tabla las que empiezan por «calendario sin devolver».
check(
  "fecha devuelta",
  syncFailedNote("2026-11-02", 3) === "calendario devuelto a 2026-11-02",
  "La nota de un rechazo resuelto no puede parecerse a la de un cliente sin envío.",
);
check(
  "nada que mover: sin devolver",
  syncFailedNote("2026-11-02", 0) === "calendario sin devolver a 2026-11-02: nada que mover",
  "moved 0 es el caso de la fecha ya pasada o sin pendientes.",
);
check(
  "la llamada para devolverla falló: sin devolver, con el error",
  syncFailedNote("2026-11-02", null, "Seal 503") === "calendario sin devolver a 2026-11-02: Seal 503",
  "El error de Seal ayuda a quien lo coge a mano.",
);
check(
  "sin fecha de antes: sin devolver",
  syncFailedNote(null, null).startsWith("calendario sin devolver"),
  "Sin fecha a la que volver, el calendario se queda donde lo dejó Seal.",
);
check(
  "un error larguísimo no revienta la columna",
  syncFailedNote("2026-11-02", null, "x".repeat(2000)).length === 500,
  "La nota es texto para leer, no el volcado entero.",
);

console.log("\n── enganchado donde toca ──\n");

const CHARGE = readFileSync("src/app/api/subscription/charge-now/route.ts", "utf8");
const SEAL = readFileSync("src/app/api/webhooks/seal/route.ts", "utf8");
const VERCEL = readFileSync("vercel.json", "utf8");
const MIGRATION = readFileSync("database/migrations/2026-10-14_charge_now_attempts.sql", "utf8");
const KLAVIYO = readFileSync("src/lib/klaviyo.ts", "utf8");
const RESUME = readFileSync("src/app/api/subscription/resume/route.ts", "utf8");
const CRON = readFileSync("src/app/api/cron/subscription-notices/route.ts", "utf8");
const RECOVERY = readFileSync("src/lib/charge-now-recovery.ts", "utf8");
const REACTIVATE = readFileSync("src/app/api/subscription/reactivate/route.ts", "utf8");

check(
  "charge-now apunta el intento ANTES de cobrar",
  CHARGE.indexOf("recordChargeNowIntent(") > 0 && CHARGE.indexOf("recordChargeNowIntent(") < CHARGE.indexOf("seal.chargeNow("),
  "Sin la fila, el rescate no sabe que el cobro era nuestro ni qué fecha devolver.",
);
check(
  "el catch síncrono marca la fila antes de mover el calendario",
  /claimChargeNowIntent\(intentId/.test(CHARGE) &&
    /if \(!alreadyScheduled && syncOwned\)/.test(CHARGE) &&
    CHARGE.indexOf("claimChargeNowIntent(intentId") < CHARGE.indexOf("seal.pullCadenceBackTo("),
  "Si no, el rechazo síncrono y el rescate del webhook moverían el mismo calendario a la vez.",
);
check(
  "el rechazo síncrono apunta la nota y avisa a incidencias, no a #server-errors",
  /noteChargeNowIntent\(intentId, syncFailedNote\(preChargeDate, moved, restoreError\)\)/.test(CHARGE) &&
    CHARGE.indexOf("noteChargeNowIntent(intentId") < CHARGE.indexOf('code: "charge_now_schedule_not_restored"') &&
    /after\(\(\) =>\s*customerCase\(\{[\s\S]{0,120}code: "charge_now_schedule_not_restored"/.test(CHARGE) &&
    /after\(\(\) =>\s*customerCase\(\{[\s\S]{0,120}code: "charge_now_ambiguous_no_intent"/.test(CHARGE) &&
    !CHARGE.includes("alertSlackError"),
  "Son casos de cliente: LIT Tasks los recoge de la tabla y de incidencias, no del canal de errores (27-oct, Kiko).",
);
check(
  "un timeout o un 5xx de Seal NO devuelve la fecha",
  /alreadyScheduled \|\| \(err instanceof SealApiError && err\.status >= 200 && err\.status < 500\)/.test(CHARGE) &&
    /let syncOwned = explicitRejection;/.test(CHARGE),
  "Seal puede haber cobrado y contestado tarde: devolver la fecha de antes le cobraría dos veces.",
);
check(
  "no deja lanzar un Adelantar con otro en curso, y lo mira antes del lock",
  CHARGE.indexOf("hasOpenChargeNowIntent(") > 0 &&
    CHARGE.indexOf("hasOpenChargeNowIntent(") < CHARGE.indexOf('.from("charge_now_locks")'),
  "Con un cobro en el aire, otro encima puede cobrar dos veces; y si se mira después del lock, el 409 lo deja puesto.",
);
check(
  "el webhook de Seal rescata en subscription.updated, en segundo plano",
  /hasRecentManualFailure\(sub\)[\s\S]{0,200}after\(\(\) => runAsBackgroundJob\(\(\) => handleManualChargeFailureSafe\(sub\)\)\)/.test(SEAL),
  "Es el único aviso que manda Seal tras un Adelantar rechazado.",
);
check(
  "el cron diario está programado y corre con el plazo largo",
  /"\/api\/cron\/subscription-notices"/.test(VERCEL) &&
    /"45 8 \* \* \*"/.test(VERCEL) &&
    /runAsBackgroundJob\(\(\) => sweepChargeNowAttempts/.test(CRON) &&
    /runAsBackgroundJob\(\(\) => runCancelNotices/.test(CRON),
  "Es la red del rescate y el que manda los avisos de baja; con el plazo de 6 s de las rutas, un Seal lento lo cortaría.",
);
check(
  "un rescate que falla a medias vuelve a la cola, y el cron recoge los atascados",
  /catch \(err\) \{\s*await releaseClaim\(intent\.id\);\s*throw err;/.test(RECOVERY) &&
    /\.eq\("status", "handling"\)\s*\.lt\("handled_at"/.test(RECOVERY),
  "Sin esto la fila se quedaba en handling para siempre y el cliente, sin caja.",
);
check(
  "el rescate toma el mismo cerrojo que charge-now",
  /recoverClaimed[\s\S]*\.from\("charge_now_locks"\)\s*\.insert/.test(RECOVERY),
  "Sin él, un Adelantar que entra durante el rescate dejaría el siguiente cobro para mañana a quien acaba de pagar.",
);
check(
  "la tabla nueva con RLS y el cerrojo de un intento por fila",
  /enable row level security/.test(MIGRATION) && /failed_attempt_id\s+text unique/.test(MIGRATION),
  "RLS sin policies como el resto; el unique impide que dos filas reclamen el mismo fallo.",
);
check(
  "los eventos nuevos existen para Klaviyo",
  ['"charge_now_failed"', '"subscription_cancelled_unpaid"', '"subscription_cancelled_support"'].every((e) => KLAVIYO.includes(e)),
  "Sin ellos en la unión no compila trackEvent.",
);
check(
  "reanudar y reactivar mandan la fecha de la próxima caja",
  /recordFollowup\(/.test(RESUME) && /recordFollowup\(/.test(REACTIVATE) &&
    /subscriptionSnapshotProps\(sub\)/.test(readFileSync("src/lib/reactivation.ts", "utf8")),
  "Sin la fecha, el email de confirmación no puede decir cuándo llega la próxima caja.",
);

console.log(failed === 0 ? "\nTodo en verde.\n" : `\n${failed} fallo(s).\n`);
process.exit(failed === 0 ? 0 : 1);

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
  addIntervalUtc,
  cardExpiredAt,
  decideRecovery,
  failedManualAttempts,
  hasLaterSuccess,
  DOUBLE_CHARGE_NOTE,
  lateManualSuccesses,
  lateSuccessNote,
  matchIntent,
  movedByPortal,
  PAID_LATE_NOTE,
  planLateSuccess,
  recoveryReadiness,
  unpaidManualFailure,
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
check(
  "tarjeta caducada: NO se reintenta, vuelve la fecha de antes",
  JSON.stringify(
    decideRecovery({ errorCode: "INVALID_PURCHASE_TYPE", preChargeDate: "2026-11-30", todayYmd: "2026-10-28", cardExpired: true }),
  ) === JSON.stringify({ action: "restore", targetDate: "2026-11-30" }) &&
    decideRecovery({ errorCode: "INVALID_PURCHASE_TYPE", preChargeDate: "2026-11-30", todayYmd: "2026-10-28" }).action === "retry",
  "13175857 (28-oct): tarjeta de 06/2026. Mañana fallaría otra vez y Seal cancela la sub al cuarto intento.",
);
check(
  "la tarjeta vale hasta el último día de su mes",
  cardExpiredAt("6", "2026", "2026-10-28") &&
    !cardExpiredAt("10", "2026", "2026-10-28") &&
    !cardExpiredAt("12", "2026", "2026-10-28") &&
    cardExpiredAt("12", "2025", "2026-01-05") &&
    !cardExpiredAt("", "", "2026-10-28") &&
    !cardExpiredAt("6", "26", "2026-10-28"),
  "Sin fecha legible no se sabe, y entonces se reintenta como siempre.",
);

console.log("\n── cobrado tarde: el cliente cambió la tarjeta ──\n");

// Forma real (sub 13175857): rechazado el 28-oct y cobrado el 29-oct a las 15:09 con la
// tarjeta nueva. El error_code se queda puesto aunque el intento ya esté completado.
const paidLate: RawBillingAttempt = {
  id: 183919212, date: "2026-10-28T15:02:40+00:00", attempted_at: "2026-10-29T15:09:28+00:00",
  status: "completed", completed_at: "2026-10-29T15:09:36+00:00", triggered_manually: "2026-10-28 15:02:46",
  error_code: "INVALID_PURCHASE_TYPE", error_message: "Your card does not support this type of purchase.",
};
const LATE_NOW = Date.parse("2026-10-29T15:10:12Z");
check(
  "un Adelantar que falló y luego entró se ve como cobrado tarde",
  lateManualSuccesses([paidLate, pending], LATE_NOW).map((a) => a.id).join() === "183919212",
  "Seal reintenta el mismo cobro manual al cambiar la tarjeta y no toca el calendario.",
);
check(
  "un cobro programado o uno de hace días, no",
  lateManualSuccesses([{ ...paidLate, triggered_manually: "" }], LATE_NOW).length === 0 &&
    lateManualSuccesses([paidLate], LATE_NOW + 4 * 24 * 3600_000).length === 0 &&
    lateManualSuccesses([paidLate], LATE_NOW + 4 * 24 * 3600_000, 7 * 24).length === 1,
  "El webhook mira 72 h; el cron, una semana.",
);
check(
  "siguiente cobro: un ciclo después, con meses de verdad",
  addIntervalUtc("2026-10-29", "6 month") === "2027-04-29" &&
    addIntervalUtc("2026-10-29", "1 months") === "2026-11-29" &&
    addIntervalUtc("2026-08-31", "6 month") === "2027-02-28" &&
    addIntervalUtc("2026-10-29", "45 day") === "2026-12-13" &&
    addIntervalUtc("2026-10-29", "2 week") === "2026-11-12" &&
    addIntervalUtc("2026-10-29", "") === null,
  "Es lo que hace Seal tras un Adelantar que pasa: hoy + el intervalo de la sub.",
);

// Forma real de 13175857 en webhook_log, 28-oct: el rechazo llega a las 15:04:03 SIN
// cobros pendientes y el calendario nuevo, a las 15:04:13. El rescate corrió a las 15:04:04.
const may: RawBillingAttempt = {
  id: 138548513, date: "2026-05-30T10:00:00+00:00", attempted_at: "2026-05-30T10:03:15+00:00",
  status: "completed", completed_at: "2026-05-30T10:03:21+00:00", triggered_manually: "",
};
const rejected: RawBillingAttempt = {
  id: 183919212, date: "2026-10-28T15:02:40+00:00", attempted_at: "2026-10-28T15:02:46+00:00",
  status: "error", completed_at: "", triggered_manually: "2026-10-28 15:02:46", error_code: "INVALID_PURCHASE_TYPE",
};
const sched = (id: number, ymd: string): RawBillingAttempt => ({
  id, date: `${ymd}T15:00:00+00:00`, attempted_at: null, status: "", completed_at: "", triggered_manually: "",
});
const regenerated = [sched(183919354, "2027-04-28"), sched(183919355, "2027-10-28"), sched(183919356, "2028-04-28")];
const RESCUE_AT = Date.parse("2026-10-28T15:04:04Z");
const MIN = 60_000;

console.log("\n── el rescate espera al calendario nuevo ──\n");

check(
  "a las 15:04:04, sin calendario nuevo: espera",
  recoveryReadiness({ now: RESCUE_AT, failed: rejected, attempts: [may, rejected] }) === "wait",
  "Es justo lo que pasó: leído 9 s antes del calendario nuevo. Ni el cobro de mayo ni el rechazado cuentan como pendientes.",
);
check(
  "10 s después, con el calendario nuevo: sigue",
  recoveryReadiness({ now: RESCUE_AT + 10_000, failed: rejected, attempts: [may, rejected, ...regenerated] }) === "go",
  "Con cobros pendientes ya hay algo que traer.",
);
check(
  "espera solo mientras el fallo es reciente (menos de 30 min)",
  recoveryReadiness({ now: Date.parse(rejected.attempted_at!) + 29 * MIN, failed: rejected, attempts: [may, rejected] }) === "wait" &&
    recoveryReadiness({ now: Date.parse(rejected.attempted_at!) + 31 * MIN, failed: rejected, attempts: [may, rejected] }) === "go",
  "Pasada la media hora (el cron) se decide con lo que haya: si sigue sin calendario, va a una persona.",
);
check(
  "tras mover: espera solo si había algo que traer y no se movió nada",
  recoveryReadiness({ now: RESCUE_AT, failed: rejected, attempts: [may, rejected, ...regenerated], targetDate: "2026-10-29", moved: 0 }) === "wait" &&
    recoveryReadiness({ now: RESCUE_AT + 31 * MIN, failed: rejected, attempts: [may, rejected, ...regenerated], targetDate: "2026-10-29", moved: 0 }) === "go" &&
    recoveryReadiness({ now: RESCUE_AT, failed: rejected, attempts: [may, rejected, sched(1, "2026-10-29")], targetDate: "2026-10-29", moved: 0 }) === "go" &&
    recoveryReadiness({ now: RESCUE_AT, failed: rejected, attempts: [may, rejected, ...regenerated], targetDate: "2026-10-29", moved: 3 }) === "go",
  "Un 0 con el primer cobro más tarde es una lectura fallida dentro de pullCadenceBackTo; con el primero ya en su fecha, es de verdad nada que mover.",
);

console.log("\n── cobrado tarde: qué se hace ──\n");

// Tras el cobro del 29-oct: el mismo intento, completado; el calendario, el del reset.
const afterPay = [may, paidLate, ...regenerated];
const plan = (rowStatus: string, attempts: RawBillingAttempt[], interval = "6 month", rowNote?: string) =>
  planLateSuccess({ rowStatus, rowNote, paid: paidLate, attempts, interval, now: LATE_NOW });
check(
  "13175857 tal cual (unhandled, calendario del reset): sin riesgo y sin mover",
  ((p) => !p.doubleChargeRisk && p.reanchorTo === null && p.charged.length === 0 && p.failing.length === 0)(plan("unhandled", afterPay)),
  "El reset de Seal ya dejó el siguiente cobro seis meses después; solo se avisa de que no hay que devolver la fecha.",
);
check(
  "unhandled y alguien trajo la fecha a mano: posible doble cobro, sin mover",
  ((p) => p.doubleChargeRisk && p.pulledByHand === "2026-11-30" && p.reanchorTo === null)(
    plan("unhandled", [may, paidLate, sched(1, "2026-11-30"), sched(2, "2027-05-30")]),
  ),
  "Lo que pedía el correo del 29-oct: con el cobro del 29 hecho, el 30-nov sería el segundo.",
);
check(
  "date_restored: se lleva el siguiente cobro a un ciclo después del pago",
  ((p) => !p.doubleChargeRisk && p.reanchorTo === "2027-04-29")(plan("date_restored", [may, paidLate, sched(1, "2026-11-30"), sched(2, "2027-05-30")])),
  "La fecha de antes la puso el rescate; con el Adelantar cobrado, sobra.",
);
// 3-nov-2026, Kiko: un rechazo en la misma llamada que deje un intento fallido en Seal se
// cobra igual al cambiar la tarjeta. La nota dice si charge-now devolvió la fecha.
const pulledBack = [may, paidLate, sched(1, "2026-11-30"), sched(2, "2027-05-30")];
check(
  "sync_failed con la fecha devuelta: se recoloca como date_restored",
  ((p) => !p.doubleChargeRisk && p.reanchorTo === "2027-04-29")(plan("sync_failed", pulledBack, "6 month", syncFailedNote("2026-11-30", 3))),
  "charge-now la devolvió con pullCadenceBackTo: sin recolocar, el 30-nov sería el segundo cobro.",
);
check(
  "sync_failed sin devolver: como las de una persona, avisa y no mueve",
  ((p) => p.doubleChargeRisk && p.pulledByHand === "2026-11-30" && p.reanchorTo === null)(
    plan("sync_failed", pulledBack, "6 month", syncFailedNote("2026-11-30", 0)),
  ) && plan("sync_failed", pulledBack).reanchorTo === null,
  "Fue a una persona (LIT-631): si devolvió la fecha a mano, son dos cobros.",
);
check(
  "movedByPortal: solo el rescate o charge-now con la fecha devuelta",
  movedByPortal("date_restored", null) &&
    movedByPortal("retry_scheduled", null) &&
    movedByPortal("sync_failed", syncFailedNote("2026-11-30", 3)) &&
    !movedByPortal("sync_failed", syncFailedNote("2026-11-30", 0)) &&
    !movedByPortal("sync_failed", syncFailedNote("2026-11-30", null, "Seal 503")) &&
    !movedByPortal("sync_failed", null) &&
    !movedByPortal("unhandled", syncFailedNote("2026-11-30", 3)),
  "La nota de syncFailedNote y la comprobación tienen que decir lo mismo.",
);
const retryPaid: RawBillingAttempt = {
  id: 9, date: "2026-10-29T13:00:00+00:00", attempted_at: "2026-10-29T13:00:04+00:00",
  status: "completed", completed_at: "2026-10-29T13:00:09+00:00", triggered_manually: "",
};
check(
  "retry_scheduled y el reintento de mañana ya entró: doble cobro",
  ((p) => p.doubleChargeRisk && p.charged.map((x) => x.id).join() === "9")(plan("retry_scheduled", [may, paidLate, retryPaid, ...regenerated])),
  "Se cuenta desde que se PIDIÓ el Adelantar (date): el reintento de las 13:00 va antes del cobro tardío de las 15:09.",
);
check(
  "retry_scheduled y el reintento falló: Seal puede cobrarlo también",
  ((p) => p.doubleChargeRisk && p.failing.map((x) => x.id).join() === "9")(
    plan("retry_scheduled", [may, paidLate, { ...retryPaid, status: "error", completed_at: "" }, ...regenerated]),
  ),
  "Seal reintenta todos los fallidos al cambiar la tarjeta (14657439, 28-oct).",
);
check(
  "intervalo sin entender: a una persona, sin mover",
  ((p) => p.doubleChargeRisk && p.unknownInterval && p.reanchorTo === null)(plan("date_restored", afterPay, "")),
  "Sin intervalo no se sabe dónde va el siguiente cobro.",
);
check(
  "la nota dice si hay que actuar",
  lateSuccessNote(plan("unhandled", afterPay), 0).startsWith(PAID_LATE_NOTE) &&
    lateSuccessNote(plan("retry_scheduled", [may, paidLate, retryPaid]), 0).startsWith(DOUBLE_CHARGE_NOTE) &&
    lateSuccessNote(plan("retry_scheduled", [may, paidLate, retryPaid]), 0).includes("9 (2026-10-29)"),
  "check_charge_now_unhandled de LIT Tasks abre la tarea con unhandled + «posible doble cobro:».",
);
check(
  "la nota no dice «a mano» cuando puede que nadie tocara la fecha",
  ((n) => n.includes("próximo cobro el 2026-11-30, antes de un ciclo desde el Adelantar") && !/a mano/.test(n))(
    lateSuccessNote(plan("unhandled", [may, paidLate, sched(1, "2026-11-30"), sched(2, "2027-05-30")]), 0),
  ),
  "Con «nada que mover» Seal no llegó a mover la fecha; lo que hay que hacer es lo mismo (Kiko, 3-nov).",
);

console.log("\n── no se deja adelantar otra vez con uno rechazado sin cobrar ──\n");

check(
  "13175857 tras el rechazo: bloqueado hasta que cambie la tarjeta",
  unpaidManualFailure([may, rejected, ...regenerated], RESCUE_AT)?.id === 183919212,
  "Seal reintenta todos los Adelantar fallidos al cambiar la tarjeta: otro encima serían dos cobros.",
);
check(
  "en cuanto se cobra (el mismo intento u otro posterior), deja de bloquear",
  unpaidManualFailure(afterPay, LATE_NOW) === null &&
    unpaidManualFailure([may, rejected, retryPaid, ...regenerated], LATE_NOW) === null,
  "Con un cobro bueno después, el cliente ya ha pagado algo.",
);
check(
  "ni un cobro programado fallido ni uno manual de hace más de 30 días",
  unpaidManualFailure([failedScheduled], Date.parse("2026-10-14T12:00:00Z")) === null &&
    unpaidManualFailure([rejected], Date.parse(rejected.attempted_at!) + 31 * 24 * 3600_000) === null &&
    unpaidManualFailure([rejected], Date.parse(rejected.attempted_at!) + 29 * 24 * 3600_000)?.id === 183919212,
  "Los programados los lleva el ciclo de 4 intentos de Seal; el bloqueo no es para siempre.",
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
  "con un Adelantar rechazado sin cobrar, charge-now contesta 409 antes de nada y la pantalla bloquea el botón",
  CHARGE.indexOf("hasUnpaidChargeNow(sub)") > 0 &&
    CHARGE.indexOf("hasUnpaidChargeNow(sub)") < CHARGE.indexOf("hasOpenChargeNowIntent(") &&
    CHARGE.indexOf("hasUnpaidChargeNow(sub)") < CHARGE.indexOf("seal.chargeNow(") &&
    /if \(hasUnpaidChargeNow\(sub\)\) \{\s*throw new ApiHttpError\(\s*409,\s*"card_update_pending"/.test(CHARGE) &&
    /code === "card_update_pending"\) \{[\s\S]{0,200}setLocked\(true\)/.test(readFileSync("src/components/ChargeNowOverlay.tsx", "utf8")),
  "Decisión de Juan (3-nov): el Adelantar rechazado se cobra solo al cambiar la tarjeta; otra pulsación sería otro cobro.",
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
/** Cuerpo de una función del fuente, hasta su llave de cierre en la columna 0. */
const fnBody = (src: string, name: string): string => {
  const i = src.search(new RegExp(`function ${name}\\b`));
  if (i < 0) return "";
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j < 0 ? undefined : j);
};
const RECOVER_CLAIMED = fnBody(RECOVERY, "recoverClaimed");
const RECOVER = fnBody(RECOVERY, "recover");
const SETTLE_LATE = fnBody(RECOVERY, "settleLateSuccess");

check(
  "el rescate toma el mismo cerrojo que charge-now",
  /\.from\("charge_now_locks"\)\s*\.insert/.test(RECOVER_CLAIMED),
  "Sin él, un Adelantar que entra durante el rescate dejaría el siguiente cobro para mañana a quien acaba de pagar.",
);
check(
  "el rescate pregunta a recoveryReadiness antes y después de mover, y si espera devuelve la fila a la cola",
  RECOVER.indexOf("recoveryReadiness(") > 0 &&
    RECOVER.indexOf("recoveryReadiness(") < RECOVER.indexOf("seal.pullCadenceBackTo(") &&
    (RECOVER.match(/=== "wait"\) \{\s*await releaseClaim\(intent\.id\);\s*return \{ kind: "not_ready" \};/g) ?? []).length === 2,
  "13175857 (28-oct): el rescate leyó la sub 9 s antes del calendario nuevo, no movió nada y la sub se quedó con el siguiente cobro en abril.",
);
check(
  "el webhook resuelve el cobro tardío en los dos topics, y el cron es la red",
  (SEAL.match(/hasRecentManualSuccess\(sub\)\) \{\s*after\(\(\) => runAsBackgroundJob\(\(\) => handleLateManualSuccessSafe\(sub\)\)\)/g) ?? [])
    .length === 2 && /handleLateManualSuccess\(s, \{ now, maxAgeHours: 7 \* 24 \}\)/.test(RECOVERY),
  "Llegan billing_attempt/succeeded y subscription/updated a la vez; el cron es la red.",
);
check(
  "cobrado tarde: cerrojo de charge-now y cerrojo de plan alrededor de reanchorCadence",
  /\.from\("charge_now_locks"\)\s*\.insert/.test(SETTLE_LATE) &&
    /tryWithPlanLock\([\s\S]{0,160}?seal\.reanchorCadence\(subId, to\)/.test(SETTLE_LATE) &&
    /if \(!res\.ran\) return "busy";/.test(SETTLE_LATE) &&
    !/seal\.reanchorCadence\(/.test(SETTLE_LATE.replace(/tryWithPlanLock\([\s\S]*?seal\.reanchorCadence\(subId, to\)/, "")),
  "charge_now_locks no excluye un cambio de plan a medias: sin el de plan, el calendario se movía dos veces (Kiko, revisión del #171).",
);
check(
  "cobrado tarde: mira también las filas que fueron a una persona y los rechazos al momento",
  /const LATE_ROW_STATUSES = \["retry_scheduled", "date_restored", "unhandled", "expired", "sync_failed"\];/.test(RECOVERY) &&
    /\.in\("status", LATE_ROW_STATUSES\)/.test(fnBody(RECOVERY, "handleLateManualSuccess")) &&
    /\.in\("status", LATE_ROW_STATUSES\)/.test(fnBody(RECOVERY, "sweepChargeNowAttempts")),
  "13175857 estaba en unhandled: si alguien devolvía la fecha a mano, eran dos cobros sin caso. Igual con sync_failed (Kiko, 3-nov).",
);
check(
  "cobrado tarde: la nota de la fila decide si se recoloca y si se avisa",
  /rowNote: row\.note,/.test(SETTLE_LATE) &&
    /if \(!movedByPortal\(row\.status, row\.note\)\) \{/.test(SETTLE_LATE) &&
    !/MOVED_BY_RESCUE/.test(SETTLE_LATE) &&
    /movedByPortal\(input\.rowStatus, input\.rowNote\)/.test(fnBody(RECOVERY, "planLateSuccess")),
  "Sin la nota, un sync_failed con la fecha devuelta no se recolocaba y quedaba el segundo cobro.",
);
check(
  "cobrado tarde: el webhook busca la fila hasta un año atrás",
  /const LATE_ROW_MAX_DAYS = 365;/.test(RECOVERY) &&
    /\.gte\("requested_at", new Date\(now - LATE_ROW_MAX_DAYS \* 24 \* H\)/.test(fnBody(RECOVERY, "handleLateManualSuccess")),
  "Seal deja los fallidos en error meses y no dice hasta cuándo los reintenta; con 30 días, un cobro más tardío no lo veía nadie.",
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

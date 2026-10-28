import { after, NextResponse, type NextRequest } from "next/server";

import { alertSlackErrorAwaited } from "@/lib/alert";
import { ApiHttpError } from "@/lib/api-helpers";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { runWithoutRequestDeadline, runWithRequestDeadline } from "@/lib/http-timeout";
import {
  applyRetentionDiscount,
  assertRetentionDiscountAllowed,
  nextChargeDateOf,
  normalizeRetentionReason,
  retentionDiscountCode,
} from "@/lib/retention-discount-apply";
import { findAppliedDiscountCodeId, getChargeTotalCents, seal, type SealSubscription } from "@/lib/seal";

/**
 * POST /apps/portal/api/internal/subscription/retention-discount
 *
 * Entrada MÁQUINA A MÁQUINA al 15 % de la baja (27-oct-2026). La usa el bot de WhatsApp de
 * Permut a través de `lit-webhooks` (`/webhook/seal-action/retention`) cuando un cliente que
 * quiere dejar LIT acepta quedarse con un 15 % en su próximo cobro. Es el paso «descuento»
 * del asistente de baja (CancelTakeover) por el MISMO núcleo (`@/lib/retention-discount-apply`):
 * las dos guardas de Juan (una vez en la vida del cliente, solo en su primera baja), la fila
 * de seguimiento reservada ANTES de aplicar, el fallo que no se da por «no aplicado», y la
 * retirada tras el primer cobro (`lib/retention-discount`: webhook de Seal + barrido diario,
 * que leen la misma tabla). Aquí no se escribe nada en Seal por otro camino.
 *
 * Calcada de `internal/subscription/flavor`: el id llega dado, la barrera es el secreto
 * compartido y el cliente sale de la propia sub de Seal (`customer_id`).
 *
 * Dos modos, y `dryRun` es OBLIGATORIO (una escritura no puede nacer de olvidar un campo):
 *
 *   - `dryRun: true` → ¿SE PUEDE OFRECER? Las mismas guardas, sin escribir nada. Devuelve la
 *     fecha y el importe del próximo cobro, que es lo que el bot le dice al cliente.
 *   - `dryRun: false` → APLICAR. Exige la fecha que vio la oferta (`expectedNextChargeDate`):
 *     el cliente aceptó «un 15 % en tu LIT del X», y si el próximo cobro ya es otro no se
 *     aplica (`subscription_changed`). Después se RELEE Seal: sin ver el código en la sub no
 *     hay «hecho» (`discount_unverified`, que avisa; la fila se queda y, si entró, el barrido
 *     lo quita tras su cobro como cualquier otro).
 *
 * Sin entrega pendiente no se ofrece (`no_pending_attempt`): no hay «próximo LIT» que
 * descontar, y es justo cuando Seal está regenerando el calendario o cobrando.
 */

export const maxDuration = 30;

/** Presupuesto de la petición, el de las otras entradas del bot: una persona espera al otro lado. */
const REQUEST_BUDGET_MS = 20_000;

/** La relectura de después de aplicar: cuántas veces y cada cuánto. */
const VERIFY_ATTEMPTS = 3;
const VERIFY_PAUSE_MS = 1_500;

const PATH = "/api/internal/subscription/retention-discount";

/**
 * Rechazos que son una respuesta de diseño y no un portal roto: no van a #server-errors.
 * El bot los explica (o deja de ofrecer el 15 %) y, si hace falta, pasa con una persona.
 * `discount_apply_unconfirmed` está aquí porque el núcleo ya avisa él mismo
 * (`retention_apply_unknown`); avisar otra vez sería doble.
 */
const BY_DESIGN_FAILURES = new Set([
  "missing_field",
  "dry_run_required",
  "expected_date_required",
  "subscription_not_found",
  "subscription_not_active",
  "subscription_paused",
  "no_pending_attempt",
  "already_used",
  "not_first_cancel",
  "subscription_changed",
  "change_applying",
  "plan_change_in_progress",
  "discount_apply_unconfirmed",
]);

interface InternalRetentionBody {
  sealSubscriptionId?: number | string;
  dryRun?: unknown;
  /** La fecha (YYYY-MM-DD) del próximo cobro que vio la oferta. Obligatoria al aplicar. */
  expectedNextChargeDate?: unknown;
  /** El motivo de la baja con el vocabulario del área personal (`too_expensive`…). */
  reason?: unknown;
}

interface Attempt {
  mode?: "dry_run" | "write";
  sealSubscriptionId?: number | string;
  customerId?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    requireCron(req);
  } catch (err) {
    if (err instanceof CronAuthError) {
      return NextResponse.json({ ok: false, code: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const attempt: Attempt = {};
  try {
    return NextResponse.json(
      await runWithRequestDeadline(REQUEST_BUDGET_MS, () => handle(req, attempt)),
    );
  } catch (err) {
    // Como en las de sabor y frecuencia: aquí no hay pantalla que avise de los 5xx y el bot
    // le dice al cliente lo que salga. Un fallo que no es de diseño se avisa.
    if (err instanceof ApiHttpError) {
      if (!BY_DESIGN_FAILURES.has(err.code)) {
        const { code, message } = err;
        after(() =>
          runWithoutRequestDeadline(() =>
            alertSlackErrorAwaited({
              path: PATH,
              code,
              msg: `sub ${attempt.sealSubscriptionId ?? "?"} modo ${attempt.mode ?? "?"}: ${message}`,
              customerId: attempt.customerId,
            }),
          ),
        );
      }
      return NextResponse.json(
        { ok: false, code: err.code, message: err.message },
        { status: err.status },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[internal/retention-discount] error inesperado:", err);
    after(() =>
      runWithoutRequestDeadline(() =>
        alertSlackErrorAwaited({
          path: PATH,
          code: "internal_error",
          msg: `sub ${attempt.sealSubscriptionId ?? "?"} modo ${attempt.mode ?? "?"}: ${msg}`,
          customerId: attempt.customerId,
        }),
      ),
    );
    return NextResponse.json({ ok: false, code: "internal_error", message: msg }, { status: 500 });
  }
}

async function handle(req: NextRequest, attempt: Attempt) {
  const t0 = Date.now();
  const body = (await req.json().catch(() => ({}))) as InternalRetentionBody;
  const subId = Number(body.sealSubscriptionId);
  attempt.sealSubscriptionId = body.sealSubscriptionId;
  attempt.mode = body.dryRun === true ? "dry_run" : body.dryRun === false ? "write" : undefined;
  const log = (step: string, extra?: Record<string, unknown>) =>
    console.log(
      `[internal/retention-discount] ${step} t+${Date.now() - t0}ms sub=${body.sealSubscriptionId ?? "?"} mode=${attempt.mode ?? "?"}`,
      extra ? JSON.stringify(extra) : "",
    );

  if (!subId || Number.isNaN(subId)) {
    throw new ApiHttpError(400, "missing_field", "sealSubscriptionId is required");
  }
  if (typeof body.dryRun !== "boolean") {
    throw new ApiHttpError(400, "dry_run_required", "dryRun must be true or false");
  }
  const expected =
    typeof body.expectedNextChargeDate === "string" ? body.expectedNextChargeDate.trim().slice(0, 10) : "";
  if (body.dryRun === false && !/^\d{4}-\d{2}-\d{2}$/.test(expected)) {
    throw new ApiHttpError(
      400,
      "expected_date_required",
      "Applying needs expectedNextChargeDate (YYYY-MM-DD) from the offer",
    );
  }

  // `throwTransient`: con una selección EXPLÍCITA, tragarse un 429 de Seal y devolver null
  // se leería como «esa suscripción no existe».
  const sub = await seal.getSubscriptionById(subId, undefined, { throwTransient: true });
  if (!sub) {
    throw new ApiHttpError(404, "subscription_not_found", `No Seal subscription ${subId}`);
  }
  attempt.customerId = sub.customer_id ? String(sub.customer_id) : undefined;
  if (sub.status === "PAUSED") {
    throw new ApiHttpError(409, "subscription_paused", `Subscription ${subId} is paused`);
  }
  if (sub.status !== "ACTIVE") {
    throw new ApiHttpError(409, "subscription_not_active", `Subscription ${subId} is ${sub.status}`);
  }
  if (!sub.customer_id) {
    throw new ApiHttpError(409, "customer_id_missing", `Seal returned subscription ${subId} without customer_id`);
  }
  const customerId = String(sub.customer_id);
  const nextChargeDate = nextChargeDateOf(sub);
  if (!nextChargeDate) {
    throw new ApiHttpError(409, "no_pending_attempt", `Subscription ${subId} has no pending delivery right now`);
  }

  // Las guardas de Juan, TAMBIÉN en la oferta: el bot no puede ofrecer un 15 % que luego no
  // se va a poder poner.
  await assertRetentionDiscountAllowed(customerId);
  const CODE = retentionDiscountCode();
  if (findAppliedDiscountCodeId(sub, CODE)) {
    // Puesto en la sub sin fila de seguimiento (la guarda de una vez lo habría parado): nada
    // lo quitaría tras el cobro. No se pone otra vez, y lo mira una persona.
    throw new ApiHttpError(409, "already_applied", `${CODE} is already on subscription ${subId} without a tracking row`);
  }
  const chargeCents = getChargeTotalCents(sub);

  // ¿SE PUEDE OFRECER?
  if (body.dryRun === true) {
    log("offer", { nextChargeDate, chargeCents });
    return { ok: true, mode: "dry_run" as const, eligible: true, code: CODE, nextChargeDate, chargeCents };
  }

  // APLICAR, solo sobre el cobro que vio la oferta.
  if (expected !== nextChargeDate) {
    log("stale-offer", { expected, nextChargeDate });
    throw new ApiHttpError(409, "subscription_changed", `The next charge is ${nextChargeDate}, the offer was for ${expected}`);
  }
  const { discountCodeId } = await applyRetentionDiscount({
    customerId,
    sub,
    email: sub.email ?? null,
    reason: normalizeRetentionReason(body.reason),
    path: PATH,
    source: "whatsapp",
  });

  // No hay «hecho» sin ver el código en la sub.
  let live: SealSubscription | null = null;
  let seen = !!discountCodeId;
  for (let i = 0; !seen && i < VERIFY_ATTEMPTS; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, VERIFY_PAUSE_MS));
    live = await seal.getSubscriptionById(subId).catch(() => null);
    seen = !!live && !!findAppliedDiscountCodeId(live, CODE);
  }
  log("verify", { seen, discountCodeId });
  if (!seen) {
    throw new ApiHttpError(
      409,
      "discount_unverified",
      `${CODE} was applied to ${subId} but Seal does not show it yet; the tracking row stays`,
    );
  }
  return {
    ok: true,
    mode: "write" as const,
    applied: true,
    verified: true,
    code: CODE,
    nextChargeDate: (live && nextChargeDateOf(live)) || nextChargeDate,
    chargeCents,
  };
}

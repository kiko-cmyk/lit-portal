import { after, NextResponse, type NextRequest } from "next/server";

import { alertSlackErrorAwaited } from "@/lib/alert";
import { ApiHttpError } from "@/lib/api-helpers";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { cutoffEndsAt, isWithinCutoff } from "@/lib/cutoff";
import {
  assertGains,
  assertLonger,
  changeFrequencyOnly,
  isFrequency,
  longerOptions,
  naturalNextShipDate,
} from "@/lib/frequency-core";
import { runWithoutRequestDeadline, runWithRequestDeadline } from "@/lib/http-timeout";
import { klaviyo } from "@/lib/klaviyo";
import { mixBoxCount } from "@/lib/mix";
import { acquirePlanLock } from "@/lib/plan-lock";
import { getComposition, getNextBillingAttempt, normalizeFrequency, seal } from "@/lib/seal";

/**
 * POST /apps/portal/api/internal/subscription/frequency
 *
 * Entrada MÁQUINA A MÁQUINA al cambio de frecuencia. La usa el bot de WhatsApp de
 * Permut a través de `lit-webhooks` (`/webhook/seal-action/cadence`) cuando un
 * cliente, avisado de que su próximo LIT sale en dos días, acepta estirar el
 * tiempo entre cajas en vez de saltar la entrega. Es lo mismo que hace el
 * SkipOverlay del área personal al «Ajustar mi plan», por la misma maquinaria
 * (`@/lib/frequency-core`: edit de `delivery_interval`, relectura, intención de
 * re-anclaje que converge el cron drain), sin sesión de cliente.
 *
 * Calcada de `internal/subscription/address`: aquí el id llega dado y la barrera
 * es el secreto compartido. Recibir un id y escribir en él es todo lo que hace,
 * y así no hay superficie para pedir la suscripción de otra persona.
 *
 * Tres modos, elegidos por el cuerpo:
 *
 *   - Sin `frequency` → CONSULTA. Ritmo actual, próxima fecha, corte, y las
 *     frecuencias más largas con la fecha natural de cada una.
 *   - `frequency` + `dryRun: true` → PROPUESTA. Valida y devuelve dónde caería la
 *     próxima entrega, sin escribir. Es lo que el bot le lee al cliente.
 *   - `frequency` + `dryRun: false` → ESCRITURA. Verificando releyendo; sin
 *     relectura no hay «hecho».
 *
 * Solo ALARGA: una frecuencia igual o más corta sale como `not_longer`. Acortar
 * tiene su sitio en el área personal. Y solo frecuencia: las líneas y su precio no
 * se tocan, así que las suscripciones con precio de contrato lo conservan y las
 * dos de más de 6 cajas pasan igual que pasan por el plan route.
 */

export const maxDuration = 30;

/**
 * Presupuesto de la petición. Holgado porque no hay App Proxy cortando a los
 * ~10 s, pero acotado: al otro lado hay un bot con una persona esperando.
 */
const REQUEST_BUDGET_MS = 20_000;

const PATH = "/api/internal/subscription/frequency";

/**
 * Rechazos que son una respuesta de diseño y no un portal roto: no van a
 * #server-errors. El bot los traduce y ofrece saltar o pasa con una persona.
 */
const BY_DESIGN_FAILURES = new Set([
  "cutoff_passed",
  "not_longer",
  "no_gain",
  "invalid_frequency",
  "subscription_not_active",
  "no_pending_attempt",
  "plan_change_in_progress",
]);

interface InternalFrequencyBody {
  sealSubscriptionId?: number | string;
  frequency?: string;
  dryRun?: boolean;
  /** El motivo del cliente (valores del SkipOverlay). Solo auditoría y Klaviyo. */
  reason?: string;
  /** Quién pide el cambio. Por defecto `whatsapp`, que es el único caller hoy. */
  source?: string;
}

interface Attempt {
  mode?: "read" | "dry_run" | "write";
  sealSubscriptionId?: number | string;
  customerId?: string;
  target?: string;
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
    // Aquí no hay pantalla ni `withCustomer` que avise de los 5xx: el bot le dice
    // al cliente lo que salga y nadie más se entera. Un fallo que no es de diseño
    // se avisa, con lo que se sabe del intento.
    if (err instanceof ApiHttpError) {
      if (!BY_DESIGN_FAILURES.has(err.code)) {
        const { code, message } = err;
        after(() =>
          runWithoutRequestDeadline(() =>
            alertSlackErrorAwaited({
              path: PATH,
              code,
              msg: `sub ${attempt.sealSubscriptionId ?? "?"} modo ${attempt.mode ?? "?"}${attempt.target ? ` → ${attempt.target}` : ""}: ${message}`,
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
    console.error("[internal/frequency] error inesperado:", err);
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
  const body = (await req.json().catch(() => ({}))) as InternalFrequencyBody;
  const subId = Number(body.sealSubscriptionId);
  attempt.sealSubscriptionId = body.sealSubscriptionId;
  attempt.mode = body.frequency === undefined ? "read" : body.dryRun ? "dry_run" : "write";
  attempt.target = body.frequency;
  const log = (step: string, extra?: Record<string, unknown>) =>
    console.log(
      `[internal/frequency] ${step} t+${Date.now() - t0}ms sub=${body.sealSubscriptionId ?? "?"} mode=${attempt.mode}`,
      extra ? JSON.stringify(extra) : "",
    );

  if (!subId || Number.isNaN(subId)) {
    throw new ApiHttpError(400, "missing_field", "sealSubscriptionId is required");
  }
  if (body.frequency !== undefined && !isFrequency(body.frequency)) {
    throw new ApiHttpError(400, "invalid_frequency", `Unknown frequency: ${body.frequency}`);
  }

  // `throwTransient`: con una selección EXPLÍCITA, tragarse un 429 de Seal y
  // devolver null se leería como «esa suscripción no existe».
  const sealSub = await seal.getSubscriptionById(subId, undefined, { throwTransient: true });
  if (!sealSub) {
    throw new ApiHttpError(404, "subscription_not_found", `No Seal subscription ${subId}`);
  }
  if (sealSub.status !== "ACTIVE") {
    throw new ApiHttpError(409, "subscription_not_active", `Subscription ${subId} is ${sealSub.status}`);
  }
  attempt.customerId = sealSub.customer_id ? String(sealSub.customer_id) : undefined;

  const current = normalizeFrequency(sealSub.delivery_interval);
  const nextAttempt = getNextBillingAttempt(sealSub);
  const nextShipDate = nextAttempt?.date ?? null;
  const withinCutoff = nextShipDate ? isWithinCutoff(nextShipDate) : false;
  // Cajas REALES, de las líneas: `getBoxCount` clampa a 6 y aquí no hace falta.
  const boxCount = mixBoxCount(getComposition(sealSub));

  // CONSULTA
  if (body.frequency === undefined) {
    return {
      ok: true,
      mode: "read" as const,
      frequency: current,
      frequencyLabel: sealSub.delivery_interval,
      boxCount,
      nextShipDate,
      withinCutoff,
      changeableUntil: nextShipDate ? cutoffEndsAt(nextShipDate).toISOString() : null,
      longerFrequencies: longerOptions(sealSub, current),
    };
  }

  const target = body.frequency;
  assertLonger(current, target);
  if (!nextShipDate) {
    throw new ApiHttpError(409, "no_pending_attempt", `Subscription ${subId} has no pending charge to move`);
  }
  // El corte se comprueba TAMBIÉN en la propuesta, para que el bot no le pida al
  // cliente que confirme algo que después se va a rechazar.
  if (withinCutoff) {
    throw new ApiHttpError(409, "cutoff_passed", "Cannot change the frequency within 24h of the next ship");
  }

  // LIT-464 en la puerta, también en la propuesta: el bot no le pide al cliente
  // que confirme una fecha que después no se va a escribir.
  assertGains(sealSub, nextShipDate, current, target);
  const proposedNextShipDate = naturalNextShipDate(sealSub, nextShipDate, current, target);

  // PROPUESTA
  if (body.dryRun) {
    return {
      ok: true,
      mode: "dry_run" as const,
      frequency: current,
      frequencyLabel: sealSub.delivery_interval,
      boxCount,
      proposedFrequency: target,
      currentNextShipDate: nextShipDate,
      proposedNextShipDate,
      priceUnchanged: true,
    };
  }

  // ESCRITURA
  // El cerrojo y la intención de re-anclaje cuelgan del customer_id: con una
  // cadena vacía el drain no encontraría la intención y el cerrojo no cerraría
  // nada. Seal lo devuelve siempre; si un día no, se para aquí y avisa.
  if (!sealSub.customer_id) {
    throw new ApiHttpError(409, "customer_id_missing", `Seal returned subscription ${subId} without customer_id`);
  }
  const customerId = String(sealSub.customer_id);
  const source = body.source?.trim() || "whatsapp";
  const reason = body.reason?.trim() || null;

  // El mismo cerrojo que la ruta del cliente: un cliente con el portal abierto
  // y el bot escribiendo a la vez es la carrera que el cerrojo cierra.
  const lock = await acquirePlanLock(customerId, subId, "internal-frequency");
  let result;
  try {
    result = await changeFrequencyOnly({
      sealSub,
      target,
      customerId,
      source,
      reason,
      reanchorMode: "natural",
      log,
    });
  } finally {
    await lock.release();
  }

  // El mismo evento que dispara el área personal al «Ajustar mi plan»
  // (`skip_retained`, vía /api/subscription/skip/track), para que el funnel del
  // skip cuente los dos canales. Best effort: un fallo de Klaviyo no deshace nada.
  if (result.changed && sealSub.email) {
    await klaviyo
      .trackEvent("skip_retained", sealSub.email, {
        source,
        reason,
        fromFrequency: current,
        toFrequency: target,
        sealSubscriptionId: String(subId),
        nextShipDate: result.nextShipDate,
      })
      .catch((e) => log("klaviyo-skip-retained-failed", { msg: e instanceof Error ? e.message : String(e) }));
  }

  log("done", { changed: result.changed, reanchor: result.reanchor, nextShipDate: result.nextShipDate });
  return {
    ok: true,
    mode: "write" as const,
    changed: result.changed,
    frequency: result.frequency,
    frequencyLabel: result.deliveryInterval,
    previousFrequency: result.previousFrequency,
    boxCount,
    nextShipDate: result.nextShipDate,
    preserveDate: result.preserveDate,
    reanchor: result.reanchor,
    priceUnchanged: true,
  };
}

import { after, NextResponse, type NextRequest } from "next/server";

import { alertSlackErrorAwaited } from "@/lib/alert";
import { ApiHttpError } from "@/lib/api-helpers";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { isWithinCutoff } from "@/lib/cutoff";
import { checkFlavorWrite, discountCodesThatMustSurvive, flavorOptions, resolveFlavorTarget } from "@/lib/flavor-core";
import { runWithoutRequestDeadline, runWithRequestDeadline } from "@/lib/http-timeout";
import { compositionLabel, type FlavorComposition, mixBoxCount } from "@/lib/mix";
import { changePlan } from "@/lib/plan-core";
import {
  getChargeTotalCents,
  getComposition,
  getLines,
  getNextBillingAttempt,
  normalizeFrequency,
  seal,
  type SealSubscription,
} from "@/lib/seal";
import { flavorLabel } from "@/lib/seal-plans";

/**
 * POST /apps/portal/api/internal/subscription/flavor
 *
 * Entrada MÁQUINA A MÁQUINA al cambio de sabor (LIT-625). La usa el bot de WhatsApp de
 * Permut a través de `lit-webhooks` (`/webhook/seal-action/flavor`) cuando un cliente
 * pide que sus próximas cajas sean de otro sabor, o de varios. Es lo mismo que hace
 * FlavorOverlay en el área personal, por el MISMO núcleo (`changePlan` de
 * `@/lib/plan-core`): conservar el importe del contrato, `add_items` antes de
 * `remove_items`, la red de reparación, el cerrojo por cliente, el corte de 24 h y el
 * aviso SUB-04 «Sabor actualizado». Aquí no se escribe nada en Seal por otro camino.
 *
 * Calcada de `internal/subscription/frequency`: el id llega dado y la barrera es el
 * secreto compartido. El cliente sale de la propia sub de Seal (`customer_id`).
 *
 * Tres modos, elegidos por el cuerpo:
 *
 *   - Sin `flavor` ni `mix` → CONSULTA. Composición actual, sabores que hay, cajas,
 *     importe, próxima entrega, corte e ids de línea.
 *   - `flavor` o `mix` + `dryRun: true` → PROPUESTA. Pasa por el núcleo en simulación,
 *     con todas sus guardas, y devuelve lo que quedaría y el importe. Es lo que el bot
 *     le lee al cliente.
 *   - `flavor` o `mix` + `dryRun: false` → ESCRITURA. Y después se RELEE Seal: el núcleo
 *     puede contestar 200 sin haber podido releer (la red lo termina detrás), y el bot
 *     no puede decir «hecho» sin haberlo visto. Sin relectura buena, 409
 *     `flavor_unverified` y el cambio sigue su curso en segundo plano.
 *
 * `dryRun` es OBLIGATORIO cuando hay sabor o mezcla: una escritura no puede nacer de
 * olvidar un campo. Y la escritura exige el estado que vio la propuesta
 * (`expectedLineIds`, `expectedBoxCount`, `expectedChargeCents`): si las líneas, las cajas
 * o el importe ya no son esos, no se escribe (`subscription_changed`). Los ids de línea
 * solos no bastan: un cambio de cantidad en sitio (`edit_items`) los conserva.
 *
 * Sin entrega pendiente no se cambia nada (`no_pending_attempt`), igual que en la de
 * frecuencia: sin fecha no hay corte que mirar, y es justo cuando Seal está regenerando
 * el calendario o procesando un cobro.
 *
 * Y tras escribir, además de las líneas, los descuentos: si falta alguno de los que no son
 * `LITREF-` (el 15 % de retención, el crédito del Discovery Set), 409
 * `discount_not_restored`: el sabor está cambiado pero el bot no puede decir que el precio
 * no cambia.
 *
 * Solo sabor y mezcla, con las MISMAS cajas. `boxCount` o `frequency` en el cuerpo es un
 * 400: cambiar las cajas reprecia a catálogo, y eso se decide en el área personal viendo
 * el precio. La frecuencia tiene su propia entrada.
 */

export const maxDuration = 60;

/**
 * Presupuesto de la petición, el de la entrada de frecuencia. Sin App Proxy que corte a
 * los ~10 s, y con una persona esperando al otro lado. El núcleo reparte el suyo dentro.
 */
const REQUEST_BUDGET_MS = 20_000;

/** La relectura de después de escribir: cuántas veces y cada cuánto. */
const VERIFY_ATTEMPTS = 3;
const VERIFY_PAUSE_MS = 1_500;

const PATH = "/api/internal/subscription/flavor";

/**
 * Rechazos que son una respuesta de diseño y no un portal roto: no van a
 * #server-errors. El bot los explica y, si hace falta, pasa con una persona.
 * `price_would_increase` está aquí porque el núcleo ya avisa él mismo
 * (`price_preserve_unavailable`) antes de lanzarlo; avisar otra vez sería doble.
 */
const BY_DESIGN_FAILURES = new Set([
  "cutoff_passed",
  "subscription_not_active",
  "subscription_paused",
  "invalid_flavor",
  "flavor_not_available_yet",
  "invalid_mix",
  "conflicting_flavor_intent",
  "no_changes",
  "only_flavor",
  "dry_run_required",
  "mix_needs_more_boxes",
  "box_count_change_not_allowed",
  "box_count_out_of_range",
  "mix_not_enabled",
  "subscription_changed",
  "plan_change_in_progress",
  "change_in_progress",
  "change_applying",
  "seal_busy",
  "price_would_increase",
  "no_pending_attempt",
]);

interface InternalFlavorBody {
  sealSubscriptionId?: number | string;
  /** Clave de sabor (`salty-peach`). «Todo de este sabor». */
  flavor?: unknown;
  /** Mezcla `[{ flavor, boxes }]`, que tiene que sumar las cajas de hoy. */
  mix?: unknown;
  dryRun?: unknown;
  /** Lo que vio la propuesta. Obligatorio al escribir: si Seal ya es otra cosa, no se escribe. */
  expectedLineIds?: unknown;
  expectedBoxCount?: unknown;
  expectedChargeCents?: unknown;
  boxCount?: unknown;
  frequency?: unknown;
  /** Quién pide el cambio, para `subscription_changes`. Por defecto `whatsapp`. */
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
    // Como en la entrada de frecuencia: aquí no hay pantalla que avise de los 5xx y el
    // bot le dice al cliente lo que salga. Un fallo que no es de diseño se avisa.
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
    console.error("[internal/flavor] error inesperado:", err);
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

function describe(composition: FlavorComposition[]) {
  return composition.map((c) => ({ flavor: c.flavor, label: flavorLabel(c.flavor), boxes: c.boxes }));
}

async function handle(req: NextRequest, attempt: Attempt) {
  const t0 = Date.now();
  const body = (await req.json().catch(() => ({}))) as InternalFlavorBody;
  const subId = Number(body.sealSubscriptionId);
  const asksChange =
    (body.flavor !== undefined && body.flavor !== null && body.flavor !== "") ||
    (body.mix !== undefined && body.mix !== null);
  attempt.sealSubscriptionId = body.sealSubscriptionId;
  attempt.mode = !asksChange ? "read" : body.dryRun === true ? "dry_run" : "write";
  attempt.target = asksChange ? JSON.stringify(body.flavor ?? body.mix) : undefined;
  const log = (step: string, extra?: Record<string, unknown>) =>
    console.log(
      `[internal/flavor] ${step} t+${Date.now() - t0}ms sub=${body.sealSubscriptionId ?? "?"} mode=${attempt.mode}`,
      extra ? JSON.stringify(extra) : "",
    );

  if (!subId || Number.isNaN(subId)) {
    throw new ApiHttpError(400, "missing_field", "sealSubscriptionId is required");
  }
  if (body.boxCount !== undefined || body.frequency !== undefined) {
    throw new ApiHttpError(400, "only_flavor", "This entry changes flavors only; boxCount and frequency are not accepted");
  }
  if (asksChange && typeof body.dryRun !== "boolean") {
    throw new ApiHttpError(400, "dry_run_required", "dryRun must be true or false when asking for a change");
  }

  // `throwTransient`: con una selección EXPLÍCITA, tragarse un 429 de Seal y devolver
  // null se leería como «esa suscripción no existe».
  const sealSub = await seal.getSubscriptionById(subId, undefined, { throwTransient: true });
  if (!sealSub) {
    throw new ApiHttpError(404, "subscription_not_found", `No Seal subscription ${subId}`);
  }
  attempt.customerId = sealSub.customer_id ? String(sealSub.customer_id) : undefined;
  if (sealSub.status === "PAUSED") {
    throw new ApiHttpError(409, "subscription_paused", `Subscription ${subId} is paused`);
  }
  if (sealSub.status !== "ACTIVE") {
    throw new ApiHttpError(409, "subscription_not_active", `Subscription ${subId} is ${sealSub.status}`);
  }

  const lines = getLines(sealSub);
  const current = getComposition(sealSub);
  const boxCount = mixBoxCount(current);
  const chargeCents = getChargeTotalCents(sealSub);
  const nextShipDate = getNextBillingAttempt(sealSub)?.date ?? null;
  const withinCutoff = nextShipDate ? isWithinCutoff(nextShipDate) : false;
  const lineIds = lines.map((l) => l.itemId);
  const snapshot = {
    composition: describe(current),
    compositionLabel: compositionLabel(current),
    boxCount,
    chargeCents,
    frequency: normalizeFrequency(sealSub.delivery_interval),
    nextShipDate,
    withinCutoff,
    lineIds,
    discountCodes: discountCodesThatMustSurvive(sealSub.items ?? []),
  };

  // CONSULTA
  if (!asksChange) {
    return { ok: true, mode: "read" as const, ...snapshot, flavors: flavorOptions() };
  }

  const resolved = resolveFlavorTarget(current, { flavor: body.flavor, mix: body.mix });
  const to = {
    composition: describe(resolved.target),
    compositionLabel: compositionLabel(resolved.target),
  };
  if (!resolved.changed) {
    return {
      ok: true,
      mode: attempt.mode,
      changed: false,
      alreadyCurrent: true,
      ...snapshot,
      to,
    };
  }
  if (!nextShipDate) {
    throw new ApiHttpError(409, "no_pending_attempt", `Subscription ${subId} has no pending delivery right now`);
  }
  // El corte se comprueba TAMBIÉN en la propuesta, para que el bot no le pida al cliente
  // que confirme algo que después se va a rechazar. El núcleo lo vuelve a mirar.
  if (withinCutoff) {
    throw new ApiHttpError(409, "cutoff_passed", "Cannot change the flavor within 24h of the next ship");
  }

  if (!sealSub.customer_id) {
    throw new ApiHttpError(409, "customer_id_missing", `Seal returned subscription ${subId} without customer_id`);
  }
  const customerId = String(sealSub.customer_id);
  const main = lines[0];
  const expectedLineIds = Array.isArray(body.expectedLineIds)
    ? body.expectedLineIds.map(Number).filter((n) => Number.isFinite(n))
    : undefined;
  if (body.dryRun === false) {
    const expBoxes = Number(body.expectedBoxCount);
    const expCharge = Number(body.expectedChargeCents);
    if (!expectedLineIds?.length || !Number.isInteger(expBoxes) || !Number.isInteger(expCharge)) {
      throw new ApiHttpError(
        400,
        "expected_state_required",
        "Writing needs expectedLineIds, expectedBoxCount and expectedChargeCents from the proposal",
      );
    }
    const sameLines =
      expectedLineIds.length === lineIds.length && expectedLineIds.every((id) => lineIds.includes(id));
    if (!sameLines || expBoxes !== boxCount || expCharge !== chargeCents) {
      log("stale-proposal", { expectedLineIds, lineIds, expBoxes, boxCount, expCharge, chargeCents });
      throw new ApiHttpError(409, "subscription_changed", "The subscription changed since the proposal");
    }
  }

  const result = await changePlan(
    {
      ...resolved.intent,
      sealSubscriptionId: subId,
      // Las mismas cuatro que manda FlavorOverlay: con ellas el núcleo va por el camino
      // rápido (relee la sub por id y comprueba que la línea es suya).
      mainItemId: main ? Number(main.itemId) : undefined,
      currentVariantId: main ? String(main.variantId) : undefined,
      currentFrequency: normalizeFrequency(sealSub.delivery_interval),
      expectedLineIds: expectedLineIds?.length ? expectedLineIds : undefined,
      preserveNextShipDate: nextShipDate,
      source: body.source?.trim() || "whatsapp",
    },
    { customerId, requestUrl: req.url },
    { dryRun: body.dryRun === true, eventSource: "whatsapp_bot" },
  );

  // PROPUESTA
  if (body.dryRun === true) {
    const projectedCents = result.chargeTotalCents;
    if (projectedCents > chargeCents) {
      // Con las mismas cajas el núcleo conserva el importe o rechaza con
      // `price_would_increase`. Si aun así sale más caro, algo no cuadra: no se ofrece,
      // y se avisa. Un céntimo MENOS sí puede salir (ver `checkFlavorWrite`) y se acepta.
      throw new ApiHttpError(
        409,
        "price_would_change",
        `Projected charge ${projectedCents} is above the current ${chargeCents} with the same ${boxCount} boxes`,
      );
    }
    log("dry-run", { from: snapshot.compositionLabel, to: to.compositionLabel, projectedCents });
    return {
      ok: true,
      mode: "dry_run" as const,
      changed: true,
      ...snapshot,
      to,
      chargeCentsAfter: projectedCents,
      priceUnchanged: projectedCents === chargeCents,
      appliesFrom: nextShipDate,
    };
  }

  // ESCRITURA: no hay «hecho» sin ver en Seal lo pedido, al importe que se escribió.
  const writtenCents = result.chargeTotalCents;
  let check: ReturnType<typeof checkFlavorWrite> | "unreadable" = "unreadable";
  let live: SealSubscription | null = null;
  for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, VERIFY_PAUSE_MS));
    live = await seal.getSubscriptionById(subId).catch(() => null);
    if (!live) continue;
    check = checkFlavorWrite(
      { composition: getComposition(live), chargeCents: getChargeTotalCents(live) },
      resolved.target,
      writtenCents,
    );
    if (check === "ok") break;
  }
  log("verify", { check, returned: result.flavorSummary, writtenCents, chargeCents });
  if (check !== "ok") {
    // El cambio puede estar aún aplicándose (la red de reparación lo termina detrás y
    // avisa con SUB-04 al converger). Lo que no se puede es decir «hecho».
    throw new ApiHttpError(
      409,
      "flavor_unverified",
      `Seal does not show ${to.compositionLabel} at ${writtenCents} yet (${check})`,
    );
  }
  const lost = snapshot.discountCodes.filter((c) => !discountCodesThatMustSurvive(live!.items ?? []).includes(c));
  if (lost.length) {
    // El sabor está cambiado, pero sin ese descuento pagaría más: el bot no puede decir
    // que el precio no cambia. Va a una persona, y se avisa.
    throw new ApiHttpError(
      409,
      "discount_not_restored",
      `Flavor changed to ${to.compositionLabel} but ${lost.join(", ")} is no longer applied`,
    );
  }
  if (writtenCents > chargeCents) {
    // Hecho, pero más caro: el núcleo no debería llegar aquí con las mismas cajas (y ya
    // avisa con `price_increase_without_preservation`). El bot no puede contestar «hecho,
    // pagas lo mismo», así que sale como fallo, que avisa y pasa a una persona.
    throw new ApiHttpError(
      409,
      "charge_increased",
      `Flavor changed to ${to.compositionLabel} but the charge went from ${chargeCents} to ${writtenCents}`,
    );
  }
  return {
    ok: true,
    mode: "write" as const,
    changed: true,
    verified: true,
    from: { composition: snapshot.composition, compositionLabel: snapshot.compositionLabel },
    to,
    boxCount,
    chargeCentsBefore: chargeCents,
    chargeCents: writtenCents,
    priceUnchanged: writtenCents === chargeCents,
    nextShipDate: getNextBillingAttempt(live!)?.date ?? nextShipDate,
    lineIds: getLines(live!).map((l) => l.itemId),
  };
}

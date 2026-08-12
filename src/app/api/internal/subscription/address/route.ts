import { after, NextResponse, type NextRequest } from "next/server";

import {
  assertBeforeCutoff,
  assertWriteBudget,
  currentAddress,
  formatAddress,
  normalizeAddress,
  syncShopifyDefaultAddress,
  validateAddressInput,
  writeAddress,
  type AddressInput,
} from "@/lib/address-core";
import { ApiHttpError } from "@/lib/api-helpers";
import { cutoffEndsAt } from "@/lib/cutoff";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { runWithoutRequestDeadline, runWithRequestDeadline } from "@/lib/http-timeout";
import { getNextBillingAttempt, seal } from "@/lib/seal";

/**
 * POST /apps/portal/api/internal/subscription/address
 *
 * Entrada MÁQUINA A MÁQUINA al cambio de dirección. Hoy la usa el bot de
 * WhatsApp de Permut a través de `lit-webhooks` (`/webhook/seal-action/address`),
 * cuando un cliente contesta al aviso de renovación diciendo que se ha mudado.
 *
 * Comparte TODO con la ruta del cliente vía `@/lib/address-core`: el corte de
 * 24h, el relleno de los campos que Seal exige, la provincia derivada del código
 * postal y la sincronización con Shopify. Lo único que cambia es cómo se decide
 * sobre qué suscripción se escribe:
 *
 *   - La ruta del cliente parte de una sesión y resuelve la suscripción DESDE
 *     ella, con `assertSubscriptionBelongsToCustomer` de guard.
 *   - Aquí el id llega dado. No hay sesión que validar, así que la barrera es el
 *     secreto compartido y nada más. Por eso esta ruta no acepta un email ni
 *     resuelve por cliente: recibir un id y escribir en él es todo lo que hace,
 *     y así no hay superficie para pedir la suscripción de otra persona.
 *
 * Dos modos, elegidos por `dryRun`, calcados de la convención de
 * `/webhook/seal-action/skip`:
 *
 *   - Sin campos de dirección → CONSULTA. Devuelve la dirección actual.
 *   - `dryRun: true` con dirección → valida y devuelve cómo quedaría, sin
 *     escribir. Es lo que el bot le lee al cliente para que confirme.
 *   - `dryRun: false` con dirección → escribe, verificando releyendo.
 *
 * El `dryRun` lo fija la capability de Permut como valor literal, nunca se
 * extrae de lo que diga el cliente.
 */

export const maxDuration = 30;

/**
 * Presupuesto de la petición. Más holgado que los 9,5s de la ruta del cliente
 * porque aquí no hay App Proxy de Shopify cortando a los ~10s, pero acotado
 * igualmente: al otro lado hay un bot con una persona esperando en WhatsApp.
 */
const REQUEST_BUDGET_MS = 20_000;

/** Margen para las lecturas antes de negarse a escribir. */
const READ_BUDGET_MS = 12_000;

interface InternalAddressBody extends Partial<AddressInput> {
  sealSubscriptionId?: number | string;
  dryRun?: boolean;
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

  try {
    return NextResponse.json(await runWithRequestDeadline(REQUEST_BUDGET_MS, () => handle(req)));
  } catch (err) {
    if (err instanceof ApiHttpError) {
      return NextResponse.json(
        { ok: false, code: err.code, message: err.message },
        { status: err.status },
      );
    }
    console.error("[internal/address] error inesperado:", err);
    return NextResponse.json(
      { ok: false, code: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

async function handle(req: NextRequest) {
  const startedAt = Date.now();
  const body = (await req.json().catch(() => ({}))) as InternalAddressBody;

  const subId = Number(body.sealSubscriptionId);
  if (!subId || Number.isNaN(subId)) {
    throw new ApiHttpError(400, "missing_field", "sealSubscriptionId is required");
  }

  // `throwTransient` a propósito: con una selección EXPLÍCITA, tragarse un 429
  // de Seal y devolver null se leería como "esa suscripción no existe", y el bot
  // le diría al cliente que no encuentra su suscripción cuando lo único que pasa
  // es que Seal iba saturado.
  const sealSub = await seal.getSubscriptionById(subId, undefined, { throwTransient: true });
  if (!sealSub) {
    throw new ApiHttpError(404, "subscription_not_found", `No Seal subscription ${subId}`);
  }
  if (sealSub.status !== "ACTIVE") {
    throw new ApiHttpError(
      409,
      "subscription_not_active",
      `Subscription ${subId} is ${sealSub.status}`,
    );
  }

  const nextAttempt = getNextBillingAttempt(sealSub);
  const current = currentAddress(sealSub);

  // CONSULTA: sin dirección nueva no hay nada que validar ni que escribir.
  const hasNewAddress = Boolean(body.address1 || body.postalCode || body.city);
  if (!hasNewAddress) {
    return {
      ok: true,
      mode: "read" as const,
      current,
      currentFormatted: formatAddress(current),
      nextShipDate: nextAttempt?.date ?? null,
      changeableUntil: nextAttempt?.date ? cutoffEndsAt(nextAttempt.date).toISOString() : null,
    };
  }

  // Con dirección nueva, lo que no venga se hereda de la que ya hay. El cliente
  // en WhatsApp dice "mándalo a Calle Nueva 5, 08001 Barcelona" y no repite su
  // apellido ni el país; heredar es lo que hace que eso funcione. `address2` NO
  // se hereda: si la calle cambia, el piso viejo es peor que ninguno.
  //
  // Y se dice con cadena VACÍA, no con `undefined`. Aquí ponía `undefined`, que
  // expresa la intención correcta pero que `updateShippingAddress` interpretaba
  // como "no toques este campo", así que el piso viejo sobrevivía igual. Un
  // cambio de Madrid a Barcelona dejó puesto el "3B" de Madrid (2026-08-12,
  // primera prueba real de la capability). `""` es lo único que Seal entiende
  // como borrar.
  const merged: Partial<AddressInput> = {
    address1: body.address1 || current.address1,
    address2: body.address1 && !body.address2 ? "" : body.address2 ?? current.address2,
    city: body.city || current.city,
    postalCode: body.postalCode || current.postalCode,
    country: body.country || current.country,
    countryCode: body.countryCode || current.countryCode,
    province: body.province,
    provinceCode: body.provinceCode,
    firstName: body.firstName || current.firstName,
    lastName: body.lastName || current.lastName,
    phone: body.phone ?? current.phone,
  };
  validateAddressInput(merged);
  const addr = normalizeAddress(merged, sealSub);

  // El corte se comprueba TAMBIÉN en el dry-run, para que el bot no le pida al
  // cliente que confirme algo que después va a rechazar.
  assertBeforeCutoff(sealSub);

  if (body.dryRun) {
    return {
      ok: true,
      mode: "dry_run" as const,
      current,
      currentFormatted: formatAddress(current),
      proposed: addr,
      proposedFormatted: formatAddress(addr),
      nextShipDate: nextAttempt?.date ?? null,
    };
  }

  assertWriteBudget(startedAt, READ_BUDGET_MS, "/api/internal/subscription/address");

  // `verify: true`: aquí nadie mira una pantalla. El bot dice "hecho" y el
  // cliente se lo cree, así que un no-op silencioso de Seal sería una caja
  // saliendo a la dirección vieja sin que nadie se entere hasta que vuelva.
  const { appliesFrom } = await writeAddress(sealSub, addr, { verify: true });

  after(() =>
    runWithoutRequestDeadline(() =>
      syncShopifyDefaultAddress(
        String(sealSub.customer_id ?? ""),
        addr,
        "/api/internal/subscription/address",
      ),
    ),
  );

  return {
    ok: true,
    mode: "write" as const,
    updated: true,
    applied: addr,
    appliedFormatted: formatAddress(addr),
    appliesFrom,
  };
}

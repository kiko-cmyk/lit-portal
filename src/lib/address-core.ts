/**
 * Núcleo compartido del cambio de dirección de envío.
 *
 * Extraído de `src/app/api/subscription/address/route.ts` el 2026-08-04 para que
 * lo puedan usar DOS entradas sin duplicar la lógica:
 *
 *   - `PATCH /apps/portal/api/subscription/address` — el cliente desde el portal.
 *   - `POST  /apps/portal/api/internal/subscription/address` — máquina a máquina,
 *     hoy el bot de WhatsApp de Permut a través de `lit-webhooks`.
 *
 * Duplicar esto sería repetir el incidente de mayo. El 2026-05-13 se reescribió
 * el flujo a Shopify-only creyendo que Seal ignoraba los campos `s_*`, y hubo
 * que revertirlo el 2026-05-22 al comprobar que Seal los acepta perfectamente
 * SI le mandas todos los requeridos. Toda esa cicatriz vive aquí dentro y no
 * debe existir una segunda copia.
 *
 * Lo que este módulo NO hace, a propósito: resolver de quién es la suscripción.
 * Cada entrada lo resuelve a su manera (sesión de cliente vs id explícito) y le
 * pasa la suscripción ya resuelta. Así el guard de propiedad no se puede saltar
 * por accidente desde una entrada nueva.
 */

import { alertSlackError } from "@/lib/alert";
import { ApiHttpError } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { provinceFromEsPostalCode } from "@/lib/es-provinces";
import { getNextBillingAttempt, seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";

export interface AddressInput {
  address1: string;
  address2?: string;
  city: string;
  postalCode: string;
  country: string;
  countryCode: string;
  province?: string;
  provinceCode?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

/** La dirección tal y como se va a escribir, ya rellenada y con provincia derivada. */
export interface NormalizedAddress extends AddressInput {
  firstName: string;
  lastName: string;
  country: string;
}

/**
 * Campos cuyo valor decide A DÓNDE llega la caja. Son los que se verifican
 * releyendo tras escribir (ver `writeAddress`). El resto (nombre, teléfono,
 * provincia) se comprueba también pero solo genera aviso: Seal los normaliza a
 * su gusto y un falso positivo aquí haría fallar un cambio que sí se guardó.
 */
const LOAD_BEARING: Array<[keyof NormalizedAddress, keyof SealSubscription]> = [
  ["address1", "s_address1"],
  ["postalCode", "s_zip"],
  ["city", "s_city"],
];

const SOFT_CHECK: Array<[keyof NormalizedAddress, keyof SealSubscription]> = [
  ["address2", "s_address2"],
  ["province", "s_province"],
  ["provinceCode", "s_province_code"],
  ["firstName", "s_first_name"],
  ["lastName", "s_last_name"],
];

/** Seal tarda ~1s en reflejar una escritura. Dos intentos antes de dar mismatch. */
const READBACK_DELAYS_MS = [600, 1_400];

function eq(a: unknown, b: unknown): boolean {
  return String(a ?? "").trim().toLocaleLowerCase("es-ES") ===
    String(b ?? "").trim().toLocaleLowerCase("es-ES");
}

/**
 * Validación de forma. Ligera a propósito: Shopify y Seal rechazan lo que esté
 * realmente malformado, y aquí lo único que buscamos es no gastar una llamada
 * a Seal en algo que no puede funcionar.
 */
export function validateAddressInput(body: Partial<AddressInput>): asserts body is AddressInput {
  if (!body.address1 || !body.city || !body.postalCode || !body.country || !body.countryCode) {
    throw new ApiHttpError(
      400,
      "invalid_address",
      "address1, city, postalCode, country, countryCode are required",
    );
  }
  if (!/^[A-Za-z]{2}$/.test(body.countryCode)) {
    throw new ApiHttpError(400, "invalid_country_code", "countryCode must be ISO 2-letter (e.g. ES)");
  }
  const pc = body.postalCode.trim();
  if (pc.length < 3 || pc.length > 12) {
    throw new ApiHttpError(400, "invalid_postal_code", "postalCode must be 3-12 chars");
  }
  if (body.provinceCode && body.provinceCode.length > 12) {
    throw new ApiHttpError(400, "invalid_province_code", "provinceCode too long (max 12)");
  }
}

/**
 * Rellena lo que Seal exige y deriva la provincia del código postal.
 *
 * Seal pide `s_first_name` + `s_last_name` + `s_country` en TODA edición de
 * dirección; si la entrada no los trae se cogen de la suscripción actual.
 *
 * La provincia se deriva y GANA sobre lo que venga: el formulario del portal no
 * tiene campo de provincia, así que viaja heredada de la dirección anterior. Una
 * clienta que se mudó de Madrid a Asturias envió con `province: Madrid / M`
 * contra un CP 33xxx (incidente 2026-07-27). Fuera de España, o si el CP no se
 * reconoce, se conserva lo recibido: derivar es una mejora, nunca una regresión.
 */
export function normalizeAddress(body: AddressInput, sealSub: SealSubscription): NormalizedAddress {
  const firstName = (body.firstName || sealSub.s_first_name || "").trim();
  const lastName = (body.lastName || sealSub.s_last_name || "").trim();
  const country = (body.country || sealSub.s_country || "").trim();
  if (!firstName || !lastName || !country) {
    throw new ApiHttpError(
      400,
      "invalid_address",
      "firstName, lastName and country must be present (existing or in payload)",
    );
  }

  const derived =
    body.countryCode.toUpperCase() === "ES" ? provinceFromEsPostalCode(body.postalCode) : null;
  if (derived && derived.code !== body.provinceCode) {
    console.log(
      `[address] province derived from postal code: ${body.provinceCode ?? "∅"} → ${derived.code} (${derived.name})`,
    );
  }

  return {
    ...body,
    firstName,
    lastName,
    country,
    province: derived?.name ?? body.province,
    provinceCode: derived?.code ?? body.provinceCode,
  };
}

/**
 * Corte de 24h contra el próximo cobro. Seal es la fuente de verdad de la fecha
 * en este flujo, así que se mide contra su billing attempt.
 */
export function assertBeforeCutoff(sealSub: SealSubscription): void {
  const nextAttempt = getNextBillingAttempt(sealSub);
  if (nextAttempt?.date && isWithinCutoff(nextAttempt.date)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change address within 24h of next ship");
  }
}

/** Una línea legible, para confirmarle al cliente qué dirección tenemos o vamos a poner. */
export function formatAddress(a: {
  address1?: string | null;
  address2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  province?: string | null;
}): string {
  const clean = (v: unknown) => String(v ?? "").trim();
  return [
    [clean(a.address1), clean(a.address2)].filter(Boolean).join(", "),
    [clean(a.postalCode), clean(a.city)].filter(Boolean).join(" "),
    clean(a.province),
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * La dirección que Seal tiene hoy para esta suscripción.
 *
 * Se recorta todo: en producción hay valores guardados con espacios de sobra
 * (la sub 14030060 tiene `s_address2 = "3B "`), y esta cadena la lee un bot en
 * voz alta por WhatsApp, donde "3B , 28004 Madrid" se nota.
 */
export function currentAddress(sealSub: SealSubscription): NormalizedAddress {
  const t = (v: string | undefined | null) => (v ?? "").trim();
  const opt = (v: string | undefined | null) => t(v) || undefined;
  return {
    address1: t(sealSub.s_address1),
    address2: opt(sealSub.s_address2),
    city: t(sealSub.s_city),
    postalCode: t(sealSub.s_zip),
    country: t(sealSub.s_country),
    countryCode: t(sealSub.s_country_code),
    province: opt(sealSub.s_province),
    provinceCode: opt(sealSub.s_province_code),
    firstName: t(sealSub.s_first_name),
    lastName: t(sealSub.s_last_name),
    phone: opt(sealSub.s_phone),
  };
}

export interface WriteResult {
  appliesFrom: string | null;
  refreshed: SealSubscription | null;
}

/**
 * Escribe en Seal y, si `verify`, COMPRUEBA releyendo que se ha escrito.
 *
 * La comprobación no es paranoia: el `edit` de Seal hace **no-op silencioso con
 * las claves que no reconoce**, así que un 200 no significa que el dato haya
 * cambiado. Se verifican solo los tres campos que deciden a dónde llega la caja.
 *
 * Por qué es opcional y no siempre. Verificar cuesta hasta 2s de esperas, y en
 * la ruta del cliente eso se come el margen del App Proxy de Shopify, que deja
 * de escuchar sobre los 10s: endurecerla convertiría un guardado bueno en un
 * "no se pudo guardar". Ahí hay una persona mirando la pantalla que ve su
 * dirección nueva y puede reintentar, así que se relee de forma tolerante.
 *
 * Donde SÍ hace falta es en la entrada máquina a máquina: el bot le dice al
 * cliente "hecho" y nadie comprueba nada. Ahí un no-op silencioso es una caja
 * saliendo a la dirección vieja con el cliente convencido de lo contrario, y no
 * hay pantalla donde se note.
 */
export async function writeAddress(
  sealSub: SealSubscription,
  addr: NormalizedAddress,
  opts: { verify?: boolean } = {},
): Promise<WriteResult> {
  await seal.updateShippingAddress(sealSub.id, {
    firstName: addr.firstName,
    lastName: addr.lastName,
    address1: addr.address1,
    address2: addr.address2,
    city: addr.city,
    postalCode: addr.postalCode,
    country: addr.country,
    countryCode: addr.countryCode,
    province: addr.province,
    provinceCode: addr.provinceCode,
    phone: addr.phone,
  });

  let refreshed: SealSubscription | null = null;
  let mismatched: string[] = [];
  const delays = opts.verify ? READBACK_DELAYS_MS : [0];
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      refreshed = await seal.getSubscriptionById(sealSub.id);
    } catch (err) {
      console.warn("[address] read-back failed:", err);
      continue;
    }
    if (!refreshed) continue;
    mismatched = LOAD_BEARING.filter(([ours, theirs]) => !eq(addr[ours], refreshed![theirs])).map(
      ([ours]) => String(ours),
    );
    if (mismatched.length === 0) break;
  }

  // No poder releer NO es lo mismo que haber fallado: la escritura ya salió y
  // Seal la habrá aplicado. Se avisa, pero no se convierte en error del cliente.
  if (!refreshed) {
    console.warn("[address] no se pudo releer tras escribir; se reporta éxito igualmente");
    return { appliesFrom: null, refreshed: null };
  }

  if (opts.verify && mismatched.length > 0) {
    alertSlackError({
      path: "/lib/address-core",
      code: "seal_address_not_persisted",
      msg:
        `Seal devolvió OK pero ${mismatched.join(", ")} no cambió en la sub ${sealSub.id}. ` +
        "Es el no-op silencioso del `edit`: revisa los nombres de campo.",
    });
    throw new ApiHttpError(
      502,
      "seal_address_not_persisted",
      `Seal accepted the edit but ${mismatched.join(", ")} did not change`,
    );
  }

  const soft = !opts.verify
    ? []
    : SOFT_CHECK.filter(([ours, theirs]) => addr[ours] && !eq(addr[ours], refreshed![theirs])).map(
        ([ours]) => String(ours),
      );
  if (soft.length > 0) {
    console.warn(`[address] campos secundarios que Seal no refleja igual: ${soft.join(", ")}`);
  }

  return { appliesFrom: getNextBillingAttempt(refreshed)?.date ?? null, refreshed };
}

/**
 * Sincroniza la dirección por defecto del cliente en Shopify (best-effort).
 *
 * Manda los pedidos sueltos del storefront, no la caja de la suscripción, así
 * que su fallo nunca debe tumbar el cambio. Pero una divergencia silenciosa
 * entre Seal y Shopify es justo lo que mantuvo un bug invisible durante semanas,
 * de ahí la alerta. A Shopify solo se le da `provinceCode`: canonicaliza él el
 * nombre y así no hay que acertar con su lista localizada.
 *
 * El llamante debe envolverlo en `after()` para que serverless no lo mate al
 * vaciar la respuesta, y en `runWithoutRequestDeadline()` porque para entonces
 * el presupuesto de la petición está gastado por definición.
 */
export async function syncShopifyDefaultAddress(
  customerId: string,
  addr: NormalizedAddress,
  path: string,
): Promise<void> {
  try {
    await shopifyAdmin.updateCustomerDefaultAddress(customerId, {
      address1: addr.address1,
      address2: addr.address2,
      city: addr.city,
      zip: addr.postalCode,
      countryCode: addr.countryCode,
      provinceCode: addr.provinceCode,
      firstName: addr.firstName,
      lastName: addr.lastName,
      phone: addr.phone,
    });
  } catch (err) {
    console.warn("[address-sync] Shopify default address update failed:", err);
    alertSlackError({
      path,
      code: "shopify_address_sync_failed",
      msg: err instanceof Error ? err.message : String(err),
      customerId,
    });
  }
}

/**
 * Guard de presupuesto antes de escribir.
 *
 * Si las lecturas ya han consumido el presupuesto, negarse a escribir es la
 * salida honesta: una escritura que aterriza después de que el llamante haya
 * dejado de escuchar tiene éxito INVISIBLEMENTE. Reintentar es seguro y barato;
 * un éxito que nadie ve, no.
 */
export function assertWriteBudget(
  startedAt: number,
  budgetMs: number,
  path: string,
  customerId?: string,
): void {
  const elapsed = Date.now() - startedAt;
  if (elapsed <= budgetMs) return;
  alertSlackError({
    path,
    code: "proxy_budget_exceeded",
    msg: `Reads took ${elapsed}ms (> ${budgetMs}ms) — refused to write so the save can't succeed invisibly`,
    customerId,
  });
  throw new ApiHttpError(
    503,
    "upstream_timeout",
    `Too slow to save safely (${elapsed}ms). Please try again.`,
  );
}

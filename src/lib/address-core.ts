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

import { alertSlackError, alertSlackNoticeAwaited } from "@/lib/alert";
import { ApiHttpError } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { provinceFromEsPostalCode } from "@/lib/es-provinces";
import { UpstreamTimeoutError } from "@/lib/http-timeout";
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

/* ─────────────── Un cambio de dirección que no se guarda tiene que verse ────────────── */

/**
 * Lo que se sabe del intento cuando falla. Todo opcional menos la ruta: el fallo
 * puede saltar antes de haber resuelto la suscripción, y un aviso a medias vale
 * mucho más que ninguno.
 *
 * Del destino se manda SOLO código postal y ciudad. Es lo que distingue una
 * mudanza de verdad de una errata y lo que permite a soporte arreglarlo, y deja
 * fuera calle, nombre y teléfono. Igual que el resto de avisos: ids sí, ficha
 * completa del cliente no.
 */
export interface AddressAttempt {
  path: string;
  customerId?: string;
  sealSubscriptionId?: number | string;
  postalCode?: string;
  city?: string;
  /** Solo la entrada del bot: `read` | `dry_run` | `write`. */
  mode?: string;
}

/**
 * Fallos que son una respuesta de diseño, no un portal roto: el cliente escribió
 * algo que no vale, o llegó dentro de las 24h previas al envío. No van a
 * #server-errors, que es un canal de errores y no una cola de trabajo.
 *
 * `cutoff_passed` es el que más duele dejar fuera, porque a quien se muda dos
 * días antes del cobro le sale la caja a la dirección vieja igual. Pero eso es
 * trabajo de CS con dueño y guion, o sea la cola de llamadas de la CS Platform
 * (`lit-dashboard`), no una línea de Slack que muere con el scroll.
 */
const BY_DESIGN_FAILURES = new Set([
  "cutoff_passed",
  "invalid_address",
  "invalid_country_code",
  "invalid_postal_code",
  "invalid_province_code",
  // El limitador haciendo su trabajo tampoco es un portal roto. Y sobre todo:
  // para llegar a él hacen falta 10 intentos previos en el mismo minuto, que si
  // fallaron YA avisaron uno a uno; y si salieron bien, avisar del 11º diría
  // "no se guardó" de un cliente al que sí se le guardó. Cuando el limitador
  // falla de verdad ya avisa por su cuenta (`rate_limit_rpc_error`).
  "rate_limited",
]);

/**
 * Etiqueta con la que se reporta el fallo. Reproduce el mapeo de `withCustomer`
 * para que el motivo del aviso sea EL MISMO código que ve el cliente entre
 * paréntesis en el overlay, que es como se cruza un aviso con un correo de
 * soporte sin tener que abrir los logs.
 */
export function addressFailureCode(err: unknown): string {
  if (err instanceof ApiHttpError) return err.code;
  if (err instanceof UpstreamTimeoutError) return `upstream_timeout:${err.upstream}`;
  const up = err as { name?: string; status?: number };
  if (up?.name === "SealApiError") {
    return up.status === 429 || (up.status ?? 0) >= 500 ? "seal_busy" : `seal_error_${up.status ?? "?"}`;
  }
  return "internal_error";
}

/** True si el fallo es una respuesta de diseño y no merece aviso. */
export function isByDesignFailure(code: string): boolean {
  return BY_DESIGN_FAILURES.has(code);
}

/**
 * Avisa a #server-errors de un cambio de dirección que NO llegó a escribirse.
 *
 * Por qué existe. El 2026-07-06 un cliente intentó cambiar su dirección desde el
 * portal, no pudo, escribió a soporte, se le cambió la dirección en la ficha de
 * Shopify creyendo que bastaba, y su caja siguió saliendo a la dirección vieja
 * dos meses. De nuestro lado no quedó NADA: ni alerta ni rastro, porque las tres
 * salidas más probables de esa ruta (`seal_busy` cuando Seal va saturado,
 * `subscription_not_found`, y el 4xx) no avisan a nadie. Con 50 clientes en tres
 * meses usando este formulario, un intento perdido es un cliente perdido.
 *
 * Se usa `alertSlackNoticeAwaited` y no `alertSlackError` por dos razones:
 * el aviso NO se deduplica (la clave `path|code` de `alertSlackError` se
 * comería el segundo cliente que falle en el mismo minuto, que es justo el que
 * no queremos perder), y se puede esperar, que hace falta porque el llamante
 * avisa y RELANZA. El llamante debe envolverlo en `after()`: así se manda
 * cuando la respuesta ya ha salido y no le añade latencia a un guardado que ya
 * ha ido mal.
 *
 * Nunca lanza: un fallo de Slack no puede cambiar lo que ve el cliente.
 */
export async function reportAddressSaveFailure(
  attempt: AddressAttempt,
  err: unknown,
): Promise<void> {
  try {
    const code = addressFailureCode(err);
    const raw = err instanceof Error ? err.message : String(err);
    if (isByDesignFailure(code)) {
      // Greppable en los logs de Vercel, fuera de Slack. Ver BY_DESIGN_FAILURES.
      console.log(
        `[address] intento rechazado por diseño (${code}) · cliente ${attempt.customerId ?? "?"} · ${attempt.path}`,
      );
      return;
    }
    // El log completo sí lleva el email si lo trae: es de Vercel, no de Slack.
    console.warn(`[address] guardado fallido (${code}) · ${attempt.path} · ${raw}`);
    if (!shouldPost(attempt, code)) return;
    await alertSlackNoticeAwaited({
      icon: ":red_circle:",
      title:
        attempt.mode && attempt.mode !== "write"
          ? "El bot no pudo operar sobre la dirección"
          : "Un cambio de dirección no se guardó",
      fields: {
        motivo: code,
        cliente: attempt.customerId,
        suscripcion: attempt.sealSubscriptionId,
        destino: [attempt.postalCode, attempt.city].filter(Boolean).join(" ") || undefined,
        modo: attempt.mode,
        ruta: attempt.path,
        detalle: redactEmails(raw).slice(0, 160),
      },
    });
  } catch (e) {
    console.warn("[address] no se pudo avisar del guardado fallido:", e);
  }
}

/**
 * Fuera emails del texto que va a Slack.
 *
 * `detalle` es el mensaje del error, y por ahí se cuela el correo del cliente
 * sin que se vea venir: `subscription_not_found` lo lleva dentro
 * (`No Seal subscription for ...`), igual que el guard de propiedad, y el
 * mensaje de `SealApiError` arrastra el cuerpo crudo de la respuesta de Seal,
 * que no controlamos. La regla del módulo de avisos es "ids sí, email no", y
 * con motivo + cliente + suscripción ya se cruza un aviso con un correo de
 * soporte. Se filtra en la salida, que es lo único que cubre también lo que
 * venga de fuera.
 */
function redactEmails(text: string): string {
  return text.replace(/[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}/g, "[email]");
}

/**
 * Un mismo cliente fallando en bucle no puede llenar el canal.
 *
 * La ventana es por (ruta, motivo, CLIENTE) a propósito, no por contenido: dos
 * clientes distintos fallando en el mismo minuto son dos avisos, que es
 * justamente lo que el dedupe de `alertSlackError` se comería y por lo que aquí
 * se usa `alertSlackNoticeAwaited`. Vive en memoria del proceso, así que un
 * arranque en frío lo reinicia; con medio cambio de dirección al día eso da
 * igual, y errar hacia "avisa de más" es el lado correcto.
 */
const POST_WINDOW_MS = 60_000;
const lastPosted = new Map<string, number>();

function shouldPost(attempt: AddressAttempt, code: string): boolean {
  const key = `${attempt.path}|${code}|${attempt.customerId ?? attempt.sealSubscriptionId ?? "?"}`;
  const now = Date.now();
  const prev = lastPosted.get(key);
  if (prev !== undefined && now - prev < POST_WINDOW_MS) {
    console.log(`[address] aviso repetido en menos de 60s, no se manda: ${key}`);
    return false;
  }
  if (lastPosted.size > 500) {
    for (const [k, t] of lastPosted) if (now - t >= POST_WINDOW_MS) lastPosted.delete(k);
  }
  lastPosted.set(key, now);
  return true;
}

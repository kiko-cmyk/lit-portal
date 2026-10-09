/**
 * Referidos «Trae a alguien», fase 0: la lógica PURA.
 *
 * Sin red, sin base de datos, sin imports de Node: se puede importar desde el
 * navegador (la tarjeta de Mi LIT usa el texto de WhatsApp) y se prueba entera
 * con `scripts/test-referral-core.ts`. Todo lo que habla con Seal, Shopify,
 * Supabase o Klaviyo vive en `referral-reward.ts` y `referral-shopify.ts`, que
 * reúnen los hechos y le preguntan a este módulo qué hacer.
 *
 * El programa, en una frase: cada suscriptor tiene un código personal
 * (`MARIA27`); su amigo lo escribe en el checkout y tiene 10 € en su primer
 * pedido de cajas (suscripción o compra única); quien invita tiene 10 € menos
 * en su siguiente cobro.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Importes, códigos y ventanas
// ═══════════════════════════════════════════════════════════════════════════

/** Lo que recibe el amigo, en el formato decimal que pide Shopify. */
export const REFERRAL_FRIEND_AMOUNT_EUR = "10.00";
/** Lo que recibe quien invita, por amigo. */
export const REFERRAL_REWARD_CENTS = 1000;
export const REFERRAL_REWARD_AMOUNT_EUR = "10.00";

/**
 * Colección «Cupones - solo cajas LIT (tecnica, no publicar)», la misma de los
 * cupones del perfilado y del Discovery: las cajas de suscripción, el pack de 4
 * y sus versiones de compra única. Deja fuera el Discovery Set, la botella, el
 * merch y el wholesale. Verificada contra Shopify el 2026-10-09.
 */
export const COUPON_COLLECTION_GID = "gid://shopify/Collection/726625812829";

/**
 * Prefijo de los códigos de recompensa (los 10 € de quien invita). Un código
 * por recompensa, de un solo uso, que solo aplica el cron. No puede chocar con
 * los personales (`MARIA27`, sin guion) ni con los del perfilado y el Discovery
 * (`LIT-` + 8).
 */
export const REWARD_CODE_PREFIX = "LITREF-";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Cada cuánto corre el cron `referral-sweep` (vercel.json: "50 *\/4 * * *"). */
export const SWEEP_INTERVAL_MS = 4 * HOUR_MS;

/**
 * La recompensa se aplica en Seal JUSTO ANTES del cobro, nunca al pagar el
 * amigo: un código aplicado en Seal se repite en cada cobro hasta que se quita,
 * así que cuanto menos tiempo pase puesto, menos superficie de fuga. Con 48 h
 * de ventana y una pasada cada 4 h, cada cobro tiene una docena de pasadas
 * dentro (y una que falle no se lleva el cobro por delante).
 */
export const APPLY_WINDOW_MS = 48 * HOUR_MS;
/** Por debajo de 1 h el cobro puede estar ya en curso: se deja para el siguiente. */
export const APPLY_MIN_LEAD_MS = 1 * HOUR_MS;
/**
 * Si un código aplicado se queda con el cobro a más de 72 h (un salto, un cambio
 * de frecuencia, el bot de Permut), se retira y vuelve a la cola: no se deja
 * colgado de una sub semanas.
 */
export const CHARGE_MOVED_AWAY_MS = 72 * HOUR_MS;
/** Un `applying` más viejo que esto sin código visible no es una carrera: es un fallo. */
export const APPLYING_STUCK_MS = 10 * 60 * 1000;
/**
 * Carencia desde el pedido del amigo: no se aplica nada hasta que han pasado 48 h.
 * Es lo que dicen las condiciones («si tu cobro cae al menos 48 h después») y
 * frena el «compro, cobro el premio de mi otra cuenta y devuelvo».
 */
export const COOLING_OFF_MS = 48 * HOUR_MS;
/** Mientras quien invita tenga una sub cobrable, su recompensa no caduca: se le alarga esto. */
export const REWARD_EXPIRY_MS = 180 * DAY_MS;

/**
 * Tiempo de FUNCIÓN que tiene que quedar para EMPEZAR una aplicación (Vercel la
 * mata a los 60 s). Se mide contra el final real de la función, no contra el
 * corte de la fase: medirlo contra un corte de 30 s con un umbral de 35 s hacía
 * que no se aplicara nunca nada (segunda revisión, 2026-10-10). Si aun así la
 * función muere a mitad, `apply_sent_at` deja rastro y la pasada siguiente lo
 * resuelve.
 */
export const APPLY_MIN_BUDGET_MS = 30_000;

export function canStartApply(functionTimeLeftMs: number): boolean {
  return functionTimeLeftMs >= APPLY_MIN_BUDGET_MS;
}

/** Como mucho, cuánto se fía la pasada de la fecha de cobro que vio la última vez. */
export const MAX_NEXT_CHECK_MS = 7 * DAY_MS;

/**
 * Cuándo vuelve a mirar el cron una recompensa en cola que espera. Nunca «sin
 * fecha»: la cola se recorre por `next_check_at`, y una espera sin fecha se
 * pondría delante de las que vencen hoy. Con el cobro a semanas vista se vuelve
 * 48 h antes (el webhook de Seal la adelanta a «ahora» en cuanto la sub cambia).
 */
export function nextCheckAt(
  reason: string,
  candidateNextChargeAtMs: number | null,
  friendOrderAtMs: number | null,
  now: number,
): number {
  let at: number;
  switch (reason) {
    case "charge_not_in_window":
      at = candidateNextChargeAtMs !== null ? candidateNextChargeAtMs - APPLY_WINDOW_MS : now + SWEEP_INTERVAL_MS;
      break;
    case "no_chargeable_sub":
      at = now + 2 * DAY_MS;
      break;
    case "cooling_off":
      at = friendOrderAtMs !== null ? friendOrderAtMs + COOLING_OFF_MS : now + SWEEP_INTERVAL_MS;
      break;
    case "rewards_disabled":
      at = now + DAY_MS;
      break;
    case "sub_has_other_code":
    case "sub_has_live_reward":
      // Se libera con el cobro de esa sub (el otro descuento o la otra recompensa
      // se consumen en él): se vuelve a mirar justo después.
      at = candidateNextChargeAtMs !== null ? candidateNextChargeAtMs + HOUR_MS : now + SWEEP_INTERVAL_MS;
      break;
    default:
      at = now + SWEEP_INTERVAL_MS;
  }
  return Math.min(Math.max(at, now), now + MAX_NEXT_CHECK_MS);
}

/** Más de 5 amigos en 30 días: lo mira una persona antes de pagar. */
export const VELOCITY_LIMIT = 5;
export const VELOCITY_WINDOW_MS = 30 * DAY_MS;
/** Si no se puede verificar al amigo (Seal o Shopify caídos), se reintenta 7 días. */
export const QUALIFY_RETRY_MS = 7 * DAY_MS;

// ═══════════════════════════════════════════════════════════════════════════
// El código personal
// ═══════════════════════════════════════════════════════════════════════════

/** Entero uniforme en [0, maxExclusive). Inyectable para los tests. */
export type RandomInt = (maxExclusive: number) => number;

/**
 * Aleatorio criptográfico SIN sesgo de módulo (muestreo con rechazo). El
 * `b % 31` de los cupones del Discovery favorece las primeras letras; aquí da
 * igual que en un cupón de 8 caracteres, pero con 2 cifras el sesgo se notaría.
 */
export const cryptoRandomInt: RandomInt = (maxExclusive) => {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
    throw new Error(`cryptoRandomInt: rango inválido ${maxExclusive}`);
  }
  const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % maxExclusive;
  }
};

/** Nombres que no pueden ir en un código: parecerían un cupón oficial de LIT. */
const RESERVED_NAMES = new Set(["LIT", "LITREF", "AMIGO"]);

/**
 * El nombre de pila tal como irá en el código: sin tildes ni eñes, solo A-Z,
 * de 2 a 12 letras. `null` si no hay nada utilizable (nombre vacío, inicial
 * suelta, alfabeto no latino, demasiado largo): entonces el código es `AMIGO`.
 *
 *   "José María" → "JOSE"   ·   "Ñandú" → "NANDU"   ·   "Jean-Pierre" → "JEANPIERRE"
 */
export function normalizeFirstName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw.trim().split(/\s+/)[0] ?? "";
  const letters = first
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (letters.length < 2 || letters.length > 12) return null;
  if (RESERVED_NAMES.has(letters) || letters.startsWith("LITREF")) return null;
  return letters;
}

/**
 * Código personal: nombre de pila + 2 cifras, sin guion (`MARIA27`), porque se
 * dicta por teléfono y se teclea en el móvil. Con `digits: 3` (`MARIA274`) para
 * cuando las de 2 chocan, y `AMIGO` + 4 cifras cuando no hay nombre utilizable.
 * Las cifras nunca empiezan por 0, para que se lean igual que se escriben.
 *
 * La unicidad no la garantiza esto sino Shopify (un código repetido falla en la
 * bulk) y el UNIQUE de `referral_codes`; quien llama reintenta con otras cifras.
 */
export function generateReferralCode(
  firstName: string | null | undefined,
  opts: { digits?: 2 | 3; randomInt?: RandomInt } = {},
): string {
  const rnd = opts.randomInt ?? cryptoRandomInt;
  const name = normalizeFirstName(firstName);
  if (!name) return `AMIGO${1000 + rnd(9000)}`;
  if (opts.digits === 3) return `${name}${100 + rnd(900)}`;
  return `${name}${10 + rnd(90)}`;
}

const REWARD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** `LITREF-` + 8 caracteres sin ambiguos. Lo ve solo quien mire Seal o el pedido. */
export function generateRewardCode(randomInt: RandomInt = cryptoRandomInt): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += REWARD_ALPHABET[randomInt(REWARD_ALPHABET.length)];
  return `${REWARD_CODE_PREFIX}${out}`;
}

export function normalizeCode(code: string | null | undefined): string {
  return (code ?? "").trim().toUpperCase();
}

export function isRewardCode(code: string | null | undefined): boolean {
  return normalizeCode(code).startsWith(REWARD_CODE_PREFIX);
}

/** Pedido de renovación de Seal: su `source_name` es `subscription_contract*`. */
export function isRenewalSource(sourceName: string | null | undefined): boolean {
  return /^subscription_contract/i.test(sourceName ?? "");
}

/**
 * ¿Lleva la etiqueta de cuenta mayorista? Mirada directa a la etiqueta, a
 * propósito, y NO `isB2BCustomer` de flags.ts: esa devuelve false con
 * `B2B_ACCOUNT_ONLY=off` (la palanca de marcha atrás del modo B2B del portal), y
 * apagar ese modo no puede abrir los referidos a los partners.
 */
export function hasB2BTag(tags: string[] | null | undefined): boolean {
  return (tags ?? []).some((t) => t.trim().toLowerCase() === "b2b");
}

// ═══════════════════════════════════════════════════════════════════════════
// Compartir
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El mensaje que manda quien invita. Sin enlace: el amigo escribe el código en
 * el checkout (decisión del 9-oct, un enlace largo da más fricción y más
 * desconfianza que un código). Sin guiones largos ni emojis.
 */
export function buildShareText(code: string, lang: "es" | "en"): string {
  return lang === "en"
    ? `I've been using LIT for a while and I can feel it. If you want to try it, use my code ${code} at litsalt.com and get €10 off your first box.`
    : `Llevo un tiempo con LIT y lo noto. Si lo quieres probar, usa mi código ${code} en litsalt.com y tienes 10 € de descuento en tu primera caja.`;
}

export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Normalizadores (antifraude: ¿es la misma persona o el mismo domicilio?)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Email comparable: minúsculas, sin `+etiqueta`, y en Gmail sin puntos (Gmail
 * ignora los dos, así que `ma.ria+lit@gmail.com` es la misma bandeja que
 * `maria@gmail.com`).
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return null;
  let local = e.slice(0, at).split("+")[0];
  let domain = e.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (!local) return null;
  return `${local}@${domain}`;
}

/**
 * Teléfono en E.164. Sin prefijo, 9 cifras empezando por 6-9 se leen como
 * España (+34), que es casi toda la base. `null` si no hay al menos 8 cifras.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 8) return null;
  if (s.startsWith("+")) return `+${digits}`;
  if (digits.length === 9 && /^[6-9]/.test(digits)) return `+34${digits}`;
  if (digits.length === 11 && digits.startsWith("34")) return `+${digits}`;
  return `+${digits}`;
}

/**
 * Palabras de tipo de vía que se escriben de mil maneras y no distinguen nada.
 * Ojo con añadir letras sueltas: «2ºA» se parte en «2» y «a», y quitar la «a»
 * confundiría la puerta A con un piso sin letra.
 */
const STREET_WORDS = new Set([
  "calle", "c", "cl", "cll", "avenida", "avda", "av", "avd", "plaza", "pza", "pl",
  "paseo", "po", "pso", "camino", "cno", "carrer", "carretera", "ctra", "ronda",
  "rda", "travesia", "trav", "via", "glorieta", "urbanizacion", "urb", "n", "no",
  "num", "numero", "piso", "puerta", "pta", "esc", "escalera",
]);

/**
 * Domicilio comparable: código postal + la dirección sin tipo de vía, sin
 * tildes y sin signos. «C/ Mayor 5, 2ºB» y «Calle Mayor 5 2B» dan lo mismo.
 * `null` si falta algo: sin dirección no se puede decir que coinciden.
 */
export function normalizeAddress(
  address1: string | null | undefined,
  zip: string | null | undefined,
): string | null {
  if (!address1 || !zip) return null;
  const tokens = address1
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STREET_WORDS.has(t));
  const street = tokens.join("");
  const z = zip.replace(/\s+/g, "").toUpperCase();
  if (street.length < 3 || !z) return null;
  return `${z}|${street}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Qué compró el amigo
// ═══════════════════════════════════════════════════════════════════════════

export type PurchaseType = "subscription" | "one_time" | "mixed" | "none";

/** Tipo de compra según las cajas LIT del pedido (lo que no es caja no cuenta). */
export function purchaseTypeOf(
  lines: Array<{ inCollection: boolean; hasSellingPlan: boolean }>,
): PurchaseType {
  const boxes = lines.filter((l) => l.inCollection);
  if (!boxes.length) return "none";
  const sub = boxes.some((l) => l.hasSellingPlan);
  const once = boxes.some((l) => !l.hasSellingPlan);
  return sub && once ? "mixed" : sub ? "subscription" : "one_time";
}

// ═══════════════════════════════════════════════════════════════════════════
// Cualificar al amigo
// ═══════════════════════════════════════════════════════════════════════════

export type QualifyOutcome = "qualified" | "rejected" | "review" | "retry";

export interface QualifyFacts {
  /** El pedido es una renovación de Seal (no un primer pedido). */
  isRenewal: boolean;
  /** Cancelado, o reembolsado o anulado entero. */
  orderVoided: boolean;
  /** Lleva al menos una caja LIT de la colección de cupones. */
  hasLitBox: boolean;
  /** El código del pedido pertenece a un `referral_codes` activo. */
  codeActive: boolean;
  referrerIsB2B: boolean;
  referrerCustomerId: string;
  friendCustomerId: string | null;
  sameEmail: boolean;
  samePhone: boolean;
  sameAddress: boolean;
  /**
   * Pedidos ANTERIORES del amigo (distintos de este) con cajas LIT. Un Discovery
   * Set suelto no cuenta: quien solo lo probó sigue siendo cliente nuevo de
   * cajas. `null` = no se pudo leer.
   */
  friendPriorBoxOrders: number | null;
  /** Subs del amigo en Seal (cualquier estado) que NO nacen de este pedido. `null` = no se pudo leer. */
  friendOtherSealSubs: number | null;
  /** Ya hay una conversión cualificada para este amigo (con quien sea). */
  friendAlreadyQualified: boolean;
  /** Conversiones cualificadas de quien invita en los últimos 30 días. */
  referrerQualifiedInWindow: number;
  /** Cuánto lleva registrada la conversión sin poder verificarse. */
  pendingForMs: number;
}

export interface QualifyResult {
  outcome: QualifyOutcome;
  reason: string;
}

/**
 * ¿Gana su premio quien invita? Pago por resultado: solo si el amigo pagó cajas
 * LIT, es nuevo de verdad y no es la misma persona. El amigo ya tiene sus 10 €
 * pase lo que pase (los aplicó Shopify en el checkout); esto decide la otra
 * mitad.
 *
 * Un fallo al verificar NUNCA rechaza: se reintenta 7 días y luego pasa a
 * revisión humana. Rechazar por un Seal caído sería quitarle el premio a alguien
 * por un problema nuestro.
 */
export function qualifyConversion(f: QualifyFacts): QualifyResult {
  if (f.isRenewal) return { outcome: "rejected", reason: "renewal_order" };
  if (f.orderVoided) return { outcome: "rejected", reason: "order_voided" };
  if (!f.hasLitBox) return { outcome: "rejected", reason: "no_lit_box" };
  if (!f.codeActive) return { outcome: "rejected", reason: "code_inactive" };
  if (f.referrerIsB2B) return { outcome: "rejected", reason: "referrer_b2b" };
  if (!f.friendCustomerId) return { outcome: "review", reason: "no_customer" };
  if (f.friendCustomerId === f.referrerCustomerId) return { outcome: "rejected", reason: "self_referral" };
  if (f.sameEmail || f.samePhone) return { outcome: "rejected", reason: "self_referral" };
  if (f.sameAddress) return { outcome: "rejected", reason: "same_household" };
  if (f.friendAlreadyQualified) return { outcome: "rejected", reason: "friend_already_referred" };
  if (f.friendPriorBoxOrders === null || f.friendOtherSealSubs === null) {
    return f.pendingForMs > QUALIFY_RETRY_MS
      ? { outcome: "review", reason: "verification_unavailable" }
      : { outcome: "retry", reason: "verification_unavailable" };
  }
  if (f.friendPriorBoxOrders > 0 || f.friendOtherSealSubs > 0) {
    return { outcome: "rejected", reason: "not_new_customer" };
  }
  if (f.referrerQualifiedInWindow >= VELOCITY_LIMIT) return { outcome: "review", reason: "velocity" };
  return { outcome: "qualified", reason: "ok" };
}

// ═══════════════════════════════════════════════════════════════════════════
// La recompensa de quien invita
// ═══════════════════════════════════════════════════════════════════════════

export type RewardStatus =
  | "queued"
  | "applying"
  | "applied"
  | "consumed"
  | "revoked"
  | "expired"
  | "failed";

export const TERMINAL_REWARD_STATUSES: ReadonlySet<RewardStatus> = new Set([
  "consumed",
  "revoked",
  "expired",
  "failed",
]);

export interface RewardSnapshot {
  status: RewardStatus;
  expiresAtMs: number;
  updatedAtMs: number;
  /** Cuándo salió la orden de aplicar hacia Seal (null = nunca salió). */
  applySentAtMs: number | null;
}

/** La mejor sub de quien invita para aplicar (la activa que cobra antes). */
export interface SubCandidate {
  sealSubscriptionId: string;
  nextChargeAtMs: number;
  /** Lleva otro descuento puesto (cualquiera que no sea el de esta recompensa). */
  hasBlockingCode: boolean;
  /** Ya tiene una recompensa viva en BD (el índice lo impediría igualmente). */
  hasLiveReward: boolean;
}

/** Lo que la elección de sub necesita de cada suscripción de quien invita. */
export interface SubForReward {
  id: string;
  /** Activa: ni pausada ni cancelada. */
  active: boolean;
  nextChargeAtMs: number | null;
  /** Los códigos puestos en la sub (`items[].discount_codes`). */
  codes: string[];
}

/**
 * ¿Lleva la sub algún descuento que no es el de esta recompensa? El 15 % de
 * retención, el crédito Discovery de la primera renovación, otra recompensa, uno
 * puesto a mano… Entonces la recompensa ESPERA al cobro siguiente: un descuento
 * de un solo cobro por cargo, como dice el plan («si ya lleva cualquier código,
 * espera»), y la comprobación tras aplicar sigue midiendo solo nuestros 10 €.
 */
export function hasOtherDiscount(codes: readonly string[], ownCode: string | null): boolean {
  const own = ownCode ? normalizeCode(ownCode) : null;
  return codes.some((c) => {
    const n = normalizeCode(c);
    return !!n && n !== own;
  });
}

/**
 * La sub donde se aplicaría: la activa que cobra antes entre las LIBRES (sin otro
 * descuento y sin otra recompensa viva). Si todas las activas están ocupadas, la
 * que cobra antes, marcada: la recompensa espera a que se libere y NO caduca,
 * porque quien invita sí tiene una sub cobrable (las condiciones solo la caducan
 * si no la tiene). `null` solo si no hay ninguna activa con cobro programado.
 */
export function chooseCandidate(subs: readonly SubForReward[], liveSubIds: ReadonlySet<string>): SubCandidate | null {
  const active = subs
    .filter((s): s is SubForReward & { nextChargeAtMs: number } => s.active && s.nextChargeAtMs !== null)
    .map((s) => ({ s, live: liveSubIds.has(s.id), blocked: hasOtherDiscount(s.codes, null) }))
    .sort((a, b) => a.s.nextChargeAtMs - b.s.nextChargeAtMs);
  const best = active.find((x) => !x.live && !x.blocked) ?? active[0];
  if (!best) return null;
  return {
    sealSubscriptionId: best.s.id,
    nextChargeAtMs: best.s.nextChargeAtMs,
    hasBlockingCode: best.blocked,
    hasLiveReward: best.live,
  };
}

/** Estado en Seal de la sub donde la recompensa está (o se estaba) aplicando. */
export interface AppliedSubState {
  /** `false` si Seal no la devuelve (no un fallo transitorio: eso es `null` arriba). */
  exists: boolean;
  /** Activa: ni pausada ni cancelada. */
  chargeable: boolean;
  nextChargeAtMs: number | null;
  /** El código aparece en `items[].discount_codes`. */
  codeVisible: boolean;
  /** Pedido de renovación POSTERIOR a la aplicación que lleva el código. */
  consumedOrderId: string | null;
  /** Hubo cobro posterior a la aplicación y su pedido, LEÍDO, NO lleva el código. */
  chargedWithoutCode: boolean;
  /**
   * Hubo cobro posterior a la aplicación pero no se puede saber si llevó el código
   * (el intento no trae pedido, o el pedido no aparece). No se decide nada a ciegas.
   */
  chargeEvidenceUnknown: boolean;
}

export interface RewardFacts {
  now: number;
  rewardsEnabled: boolean;
  /** `null` = no se pudo leer el pedido del amigo. */
  friendOrderVoided: boolean | null;
  /**
   * Shopify dice que el pedido del amigo NO EXISTE (no un fallo de lectura). No se
   * revoca sola: sin el scope `read_all_orders` Shopify esconde los pedidos de más
   * de 60 días, y una recompensa puede esperar meses su cobro. Pasa a una persona.
   */
  friendOrderMissing?: boolean;
  /** Cuándo pagó el amigo (para la carencia). */
  friendOrderAtMs: number | null;
  /** Para `queued`: dónde se aplicaría. `null` = ninguna sub cobrable. */
  candidate: SubCandidate | null;
  /**
   * Para `queued`: no se pudieron LEER las subs de quien invita (Shopify o Seal
   * fallaron). Entonces `candidate: null` no significa «ninguna sub cobrable», y
   * no se puede ni caducar ni alejar la próxima mirada por eso.
   */
  candidateUnknown?: boolean;
  /** Para `applying` | `applied`. `null` = Seal no contestó. */
  applied: AppliedSubState | null;
}

export type RewardAction =
  | { kind: "noop" }
  | { kind: "wait"; reason: string }
  | { kind: "apply"; sealSubscriptionId: string; chargeDueAtMs: number }
  | { kind: "consume"; orderId: string }
  /** queued → revoked: todavía no tocó Seal, es solo un cambio de estado. */
  | { kind: "revoke" }
  /** applied → retirar el código → revoked. */
  | { kind: "detach_revoke" }
  /** applied → retirar el código → queued (el cron lo repondrá a tiempo). */
  | { kind: "detach_requeue"; reason: string }
  /** applying → queued sin tocar Seal: la orden de aplicar nunca llegó a salir. */
  | { kind: "requeue"; reason: string }
  | { kind: "expire" }
  /** `applying` atascado pero con el código visible: se da por aplicado. */
  | { kind: "adopt" }
  /** → failed + aviso. Nunca se reintenta solo. */
  | { kind: "fail"; reason: string }
  /** Se queda como está, con aviso a una persona. */
  | { kind: "keep_alert"; reason: string };

/**
 * Qué hacer con una recompensa. Las reglas de dinero, en orden:
 *
 *   1. Se aplica SOLO dentro de la ventana de 1-48 h antes del cobro, en una sub
 *      activa sin otro código de un solo cobro. Nunca dos vivas en la misma sub.
 *   2. Se da por consumida SOLO con el pedido de renovación que lleva el código
 *      delante. Un `completed_at` no basta: lo que importa es que el descuento
 *      salió en un pedido de verdad.
 *   3. Un código aplicado que deja de verse sin pedido que lo explique es un
 *      fallo para una persona, nunca algo que se reaplique: reaplicar encima de
 *      un código invisible es el descuento doble del incidente BONUS5.
 */
export function decideRewardAction(r: RewardSnapshot, f: RewardFacts): RewardAction {
  if (TERMINAL_REWARD_STATUSES.has(r.status)) return { kind: "noop" };

  if (r.status === "queued") {
    if (f.friendOrderVoided === true) return { kind: "revoke" };
    // Sin pedido que mirar no se puede ni pagar ni revocar con certeza. En cola no
    // hay nada puesto en Seal, así que `failed` es solo un estado: si le
    // correspondía, una persona la reencola.
    if (f.friendOrderMissing) return { kind: "fail", reason: "friend_order_missing" };
    // Con el flag apagado nada avanza, y tampoco caduca: apagar las recompensas no
    // puede ser la forma de que alguien pierda lo que ganó.
    if (!f.rewardsEnabled) return { kind: "wait", reason: "rewards_disabled" };
    // Un fallo de lectura no es «no tiene sub»: nada de caducar por un Seal caído.
    if (f.candidateUnknown) return { kind: "wait", reason: "subs_unreadable" };
    const c = f.candidate;
    // Solo caduca quien lleva el plazo entero SIN ninguna sub cobrable. Con una sub
    // activa, el plazo se alarga (lo hace quien ejecuta la espera): quien tiene una
    // semestral y tres amigos en cola cobra los tres, uno por cobro.
    if (!c) {
      if (f.now >= r.expiresAtMs) return { kind: "expire" };
      return { kind: "wait", reason: "no_chargeable_sub" };
    }
    if (f.friendOrderVoided === null) return { kind: "wait", reason: "friend_order_unknown" };
    if (f.friendOrderAtMs !== null && f.now - f.friendOrderAtMs < COOLING_OFF_MS) {
      return { kind: "wait", reason: "cooling_off" };
    }
    if (c.hasLiveReward) return { kind: "wait", reason: "sub_has_live_reward" };
    if (c.hasBlockingCode) return { kind: "wait", reason: "sub_has_other_code" };
    const lead = c.nextChargeAtMs - f.now;
    if (lead < APPLY_MIN_LEAD_MS) return { kind: "wait", reason: "charge_too_close" };
    if (lead > APPLY_WINDOW_MS) return { kind: "wait", reason: "charge_not_in_window" };
    return { kind: "apply", sealSubscriptionId: c.sealSubscriptionId, chargeDueAtMs: c.nextChargeAtMs };
  }

  const a = f.applied;
  if (!a) return { kind: "wait", reason: "seal_unreadable" };

  if (r.status === "applying") {
    // Una pasada aplicó y murió antes de apuntarlo, y el cobro ya salió con el
    // código: eso es un consumo, no algo que adoptar (adoptar con la fecha de hoy
    // dejaría el cobro fuera y la reaplicaría: 20 €).
    if (a.consumedOrderId) return { kind: "consume", orderId: a.consumedOrderId };
    if (a.codeVisible) return { kind: "adopt" };
    if (f.now - r.updatedAtMs < APPLYING_STUCK_MS) return { kind: "wait", reason: "applying_in_flight" };
    // Sin código y la orden de aplicar NUNCA salió: no hay nada en Seal, vuelve a
    // la cola sin riesgo. Si salió y no se ve, nadie sabe qué pasó: una persona.
    if (r.applySentAtMs === null) return { kind: "requeue", reason: "apply_never_sent" };
    return { kind: "fail", reason: "applying_stuck_no_code" };
  }

  // applied
  if (a.consumedOrderId) return { kind: "consume", orderId: a.consumedOrderId };
  if (!a.exists) return { kind: "keep_alert", reason: "sub_missing" };
  if (f.friendOrderVoided === true) return { kind: "detach_revoke" };
  if (!a.codeVisible) return { kind: "fail", reason: "code_not_visible" };
  // Hubo un cobro y no se puede saber si llevó el código: ni retirar ni reencolar a
  // ciegas (reencolar lo reaplicaría encima de un cobro que quizá ya lo llevó).
  if (a.chargeEvidenceUnknown) return { kind: "keep_alert", reason: "charge_evidence_unknown" };
  if (!a.chargeable) return { kind: "detach_requeue", reason: "sub_not_chargeable" };
  if (a.nextChargeAtMs === null || a.nextChargeAtMs - f.now > CHARGE_MOVED_AWAY_MS) {
    // Un cobro que salió SIN el código (estaba ya en curso al aplicar, o Seal no lo
    // descontó) deja el próximo cobro lejos: se retira y vuelve a la cola, con el
    // motivo propio para que lo mire una persona. Nada se queda colgado semanas.
    return {
      kind: "detach_requeue",
      reason: a.chargedWithoutCode ? "charged_without_code" : "charge_moved_away",
    };
  }
  if (a.chargedWithoutCode) return { kind: "keep_alert", reason: "charged_without_code" };
  return { kind: "wait", reason: "awaiting_charge" };
}

/**
 * Comprobación tras aplicar: el total de Seal (que ya resta los códigos) debe
 * bajar EXACTAMENTE el importe de la recompensa. Cubre lo que no está
 * verificado: en una sub de varias líneas Seal enseña el código en todas, y si
 * el importe fijo se aplicara por línea serían 20 € o 30 € en vez de 10.
 */
export function checkApplyPostcondition(
  beforeTotalCents: number,
  afterTotalCents: number,
  amountCents: number,
): "ok" | "not_reflected" | "over_discount" | "under_discount" {
  const delta = beforeTotalCents - afterTotalCents;
  if (Math.abs(delta - amountCents) <= 1) return "ok";
  if (delta === 0) return "not_reflected";
  if (delta > amountCents + 1) return "over_discount";
  return "under_discount";
}

/** Euros de Seal (`28.35`, a veces como string) a céntimos enteros. */
export function eurosToCents(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? Number.parseFloat(v) : v ?? 0;
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

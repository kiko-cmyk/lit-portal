import type { SealSubscription } from "@/lib/seal";

/**
 * «Adelantar» espera 15 días desde el último cobro (10-nov-2026, Juan y Kiko).
 *
 * El Adelantar cobra la tarjeta guardada sin el cliente delante (Seal
 * /subscription-create-charge-now). Dos cobros así en pocos días los para el antifraude de la
 * pasarela con FRAUD__SUSPECTED, y ni Seal ni la API pueden saltárselo
 * (reference_seal_recharge_fraud_draftorder). Medido el 10-nov sobre las 77 filas de
 * `charge_now_attempts` (14-oct a 9-nov): los 4 Adelantar pedidos a menos de 14 días del cobro
 * anterior acabaron en FRAUD__SUSPECTED, en 4 subs distintas; con 20 días o más sí se cobraron.
 * Cada uno dejaba al cliente con un email de «tu banco ha frenado el adelanto» y un ticket
 * (Pilar, sub 13900481: adelantó el 5-nov y otra vez el 9-nov).
 *
 * Kiko (10-nov): la función no se esconde. La tarjeta sale en gris, se puede pulsar y dice desde
 * qué día se podrá adelantar. Pasado ese día vuelve a funcionar sola.
 *
 * Sin imports de servidor a propósito: lo usan la ruta de Adelantar, `mapToSubscription` y la
 * pantalla.
 */

/** Días completos que tienen que pasar entre el último cobro y un Adelantar. */
export const CHARGE_NOW_MIN_DAYS = 15;

const DAY_MS = 86_400_000;

const madridDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD del día de Madrid en el que cae ese instante. */
export function madridDay(ms: number): string {
  return madridDayFormat.format(new Date(ms));
}

function addDays(yyyymmdd: string, days: number): string {
  return new Date(Date.parse(`${yyyymmdd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Instante del último cobro bueno: el `completed_at` más reciente de la cola de Seal (renovación
 * programada, Adelantar, o un fallido que Seal cobró después) o, si es posterior, la compra que
 * creó la suscripción (`order_placed`). Un intento con error no tiene `completed_at` y no cuenta.
 * El antifraude no distingue cómo se hizo el cobro: el de la primera compra también vale (la
 * 17152630 adelantó 1,8 días después de comprar y le saltó).
 */
export function lastGoodChargeAt(
  sub: Pick<SealSubscription, "billing_attempts" | "order_placed">,
): number | null {
  let last: number | null = null;
  const consider = (value: string | null | undefined) => {
    const ms = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(ms) && (last === null || ms > last)) last = ms;
  };
  for (const ba of sub.billing_attempts ?? []) consider(ba.completed_at);
  consider(sub.order_placed);
  return last;
}

/** Cuándo se puede volver a adelantar, en días de Madrid. */
export interface ChargeNowWait {
  /** Día del último cobro bueno (YYYY-MM-DD). */
  lastChargedOn: string;
  /** Primer día en el que se puede adelantar (YYYY-MM-DD). */
  availableFrom: string;
}

/**
 * La espera vigente, o null si ya se puede adelantar. Se cuenta en días de Madrid: el cobro del
 * 5 de noviembre deja adelantar desde el 21, a cualquier hora. Así la fecha que ve el cliente vale
 * para todo el día y entre los dos cobros siempre hay al menos 15 días enteros (del 5 a las 23:59
 * al 21 a las 00:00 van 15 días y un minuto).
 */
export function chargeNowWait(
  sub: Pick<SealSubscription, "billing_attempts" | "order_placed">,
  now: number = Date.now(),
): ChargeNowWait | null {
  const last = lastGoodChargeAt(sub);
  if (last === null) return null;
  const lastChargedOn = madridDay(last);
  const availableFrom = addDays(lastChargedOn, CHARGE_NOW_MIN_DAYS + 1);
  return madridDay(now) < availableFrom ? { lastChargedOn, availableFrom } : null;
}

/**
 * Para la pantalla: la espera que mandó el servidor, mientras siga vigente con el reloj de quien
 * mira. Si la página se quedó abierta y ya ha llegado el día, deja adelantar sin recargar.
 */
export function activeChargeNowWait(
  wait: ChargeNowWait | null | undefined,
  now: number = Date.now(),
): ChargeNowWait | null {
  if (!wait) return null;
  return madridDay(now) < wait.availableFrom ? wait : null;
}

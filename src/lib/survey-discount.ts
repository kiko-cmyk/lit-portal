/**
 * Cupón de 5 € que se entrega al terminar el formulario de perfilado.
 *
 * Solo lo reciben los clientes SIN suscripción viva: el email "Perfilado B"
 * (one-shot, ~4.068 personas) promete "un descuento para tu próxima caja … con
 * tu código listo para usar", y este módulo es lo que cumple esa frase. El
 * email "Perfilado A" (suscriptores) no promete nada, así que a ellos no se les
 * emite (ver `issueSurveyDiscount` y su llamada en la ruta de submit).
 *
 * Desde el 2026-10-14 cada código va DENTRO del descuento padre «Cupón
 * perfilado · 5€», no como un descuento suelto por cliente (Juan: la lista del
 * admin tenía 98 líneas solo de esto). La configuración (importe, colección,
 * suscripción y compra única, primer cobro, una vez por cliente, código suelto
 * sin segmento de clientes) vive en el padre; la caducidad y el «un solo uso»,
 * en el portal. Todo en `lib/coupon-parent.ts`.
 *
 * La unicidad la garantizamos NOSOTROS: se emite una vez por cliente y se
 * guarda en `profile_survey_answers`.
 */

import { addCouponCode, SURVEY_COUPON_PARENT_GID } from "@/lib/coupon-parent";

/** 5 € fijos. En euros porque la mutación toma un decimal, no céntimos. */
const DISCOUNT_AMOUNT_EUR = "5.0";

/**
 * El mismo importe como número, para el evento de Klaviyo.
 *
 * Va como propiedad del evento y no escrito en la plantilla del email para que
 * cambiar la cifra no obligue a editar dos correos en Klaviyo. Se deriva de
 * `DISCOUNT_AMOUNT_EUR` para que no puedan divergir.
 */
export const DISCOUNT_VALUE_EUR = Number(DISCOUNT_AMOUNT_EUR);

/** Días de validez desde la emisión. El email promete 30. */
export const DISCOUNT_DAYS = 30;

export interface IssuedDiscount {
  code: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Código legible y único. `LIT-` + 8 caracteres de un alfabeto sin ambigüedades
 * (sin O/0, I/1/L), porque esto se teclea a mano desde el móvil en el checkout.
 *
 * 32^8 combinaciones: la colisión es despreciable, y aun así Shopify rechaza un
 * código repetido con un userError, que se trata como fallo de emisión.
 */
export function generateCode(): string {
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `LIT-${out}`;
}

/**
 * Da de alta el código DENTRO del descuento padre «Cupón perfilado · 5€» y lo
 * devuelve (Juan 2026-10-14: todos los cupones de una campaña en un solo
 * descuento, como los de referidos; ver `lib/coupon-parent.ts`).
 *
 * El importe, la colección, «suscripción y compra única», «solo el primer
 * cobro» y «una vez por cliente» los pone el padre. Los 30 días y el «un solo
 * uso» los lleva el portal: la fecha se guarda en `discount_expires_at` y el
 * cron borra el código del padre cuando pasa; `orders/paid` lo borra en cuanto
 * se usa.
 *
 * Lanza si Shopify falla o no confirma el código: la ruta de submit lo captura
 * y guarda las respuestas igual con `discount_code: null`. Preferimos perder un
 * cupón (recuperable a mano) antes que perder el perfilado o dejar al cliente
 * repitiendo la encuesta.
 */
export async function issueSurveyDiscount(
  customerId: string,
  /**
   * El código YA reservado en Postgres. La ruta lo reserva antes de llamar aquí
   * (UPDATE ... WHERE discount_code IS NULL), de modo que dos peticiones
   * simultáneas solo dejan crear el descuento a la que gana la reserva. Sin
   * esto, dos envíos a la vez creaban DOS descuentos en Shopify: el índice
   * único es sobre `discount_code`, y dos códigos aleatorios distintos no
   * chocan entre sí. (Kiko, 2026-09-24.)
   */
  reservedCode?: string,
): Promise<IssuedDiscount> {
  const code = reservedCode ?? generateCode();
  const now = new Date();
  const endsAt = new Date(now.getTime() + DISCOUNT_DAYS * 24 * 60 * 60 * 1000);

  // `customerId` ya no va en Shopify (antes iba en el título de cada descuento
  // suelto): la reconciliación de un código con su cliente está en
  // `profile_survey_answers`.
  void customerId;
  await addCouponCode(SURVEY_COUPON_PARENT_GID, code);

  return {
    code,
    issuedAt: now.toISOString(),
    expiresAt: endsAt.toISOString(),
  };
}

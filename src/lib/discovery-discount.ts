/**
 * Cupón de 4,99 € que se entrega al comprar el LIT Discovery Set (4,99 € desde
 * el 2026-10-01; hasta entonces el Set y el cupón eran de 5,95 €).
 *
 * La promesa del email es literal: "te devolvemos los 4,99 € del Discovery Set
 * cuando pidas tu caja con envíos programados". Este módulo es lo que la
 * cumple. Se emite desde el webhook `orders/paid` (ver el webhook de Shopify),
 * no desde una sesión de cliente.
 *
 * Desde el 2026-10-14 cada código va DENTRO del descuento padre «Cupón
 * Discovery Set · 4,99€», no como un descuento suelto por cliente (Juan: ordenar
 * el admin como los de referidos). El padre pone el importe, la colección, el
 * «solo primer cobro», el «una vez por cliente», el código suelto sin segmento
 * de clientes y, sobre todo, `appliesOnOneTimePurchase: false`: la diferencia
 * con el del perfilado que sostiene la campaña entera (si valiera en compra
 * única, el cliente se lo gastaría en un one-shot y no convertiría a nadie). La
 * caducidad y el «un solo uso» los lleva el portal. Ver `lib/coupon-parent.ts`.
 *
 * La unicidad la garantizamos NOSOTROS: se emite una vez por cliente y se
 * guarda en `discovery_set_coupons`, cuya PK es el cliente.
 */

import { addCouponCode, DISCOVERY_COUPON_PARENT_GID } from "@/lib/coupon-parent";

/**
 * El precio del Discovery Set, que es lo que se devuelve. En euros y en texto,
 * como lo toma Shopify: con este importe se creó el descuento padre.
 *
 * Si algún día cambia el precio del Set, cambia aquí y en Shopify: el importe
 * viaja al email como propiedad del evento (`discount_value`), así que no hay
 * que tocar las cinco plantillas de Klaviyo.
 */
const DISCOUNT_AMOUNT_EUR = "4.99";

/** El mismo importe como número, para el evento de Klaviyo. Se deriva del de
 *  arriba para que no puedan divergir. */
export const DISCOVERY_DISCOUNT_VALUE_EUR = Number(DISCOUNT_AMOUNT_EUR);

/** Días de validez desde la emisión. Los emails prometen 30. */
export const DISCOVERY_DISCOUNT_DAYS = 30;

/**
 * Las dos promesas del Discovery Set (columna `mode` de `discovery_set_coupons`):
 *
 *   - "checkout": la de siempre. Código por email, válido 30 días, que el cliente
 *     canjea él en el checkout de una suscripción nueva.
 *   - "renewal": compró el Set Y una suscripción en el MISMO pedido (decisión de
 *     Juan, 2026-10-09, tras el pedido #11724). El código no se le manda: el
 *     portal lo aplica a esa suscripción en Seal y se descuenta de la primera
 *     renovación. Ver `lib/discovery-renewal-credit.ts`.
 */
export type DiscoveryCouponMode = "checkout" | "renewal";

export interface IssuedDiscount {
  code: string;
  issuedAt: string;
  /** null en modo "renewal": ese código no caduca (ver issueDiscoveryDiscount). */
  expiresAt: string | null;
}

/**
 * Código legible y único. `LIT-` + 8 caracteres de un alfabeto sin ambigüedades
 * (sin O/0, I/1/L), porque esto se teclea a mano desde el móvil en el checkout.
 *
 * Mismo formato que el del perfilado a propósito: para el cliente es "un código
 * de LIT", y los dos se distinguen por el título en el admin, no por el código.
 *
 * 32^8 combinaciones: la colisión es despreciable, y aun así Shopify rechaza un
 * código repetido con un userError, que se trata como fallo de emisión.
 */
function generateCode(): string {
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `LIT-${out}`;
}

/**
 * Da de alta el código DENTRO del descuento padre y lo devuelve.
 *
 * Lanza si Shopify falla o no confirma el código. El llamante (el webhook) lo
 * captura, avisa por Slack y NO dispara el evento de Klaviyo: el primer email
 * lleva el código en el cuerpo, así que sin código el correo sale roto y es
 * peor que no mandarlo.
 */
export async function issueDiscoveryDiscount(
  customerId: string,
  mode: DiscoveryCouponMode = "checkout",
): Promise<IssuedDiscount> {
  const code = generateCode();
  const now = new Date();
  // En modo "renewal" el código NO caduca, y es a propósito. La primera
  // renovación de una sub de 45 días, 2, 3 o 6 meses (o una con un skip) cae
  // más allá de los 30 días: un código que se borrara a los 30 días no llegaría
  // a ese cobro. No es un agujero: el código no se enseña a nadie, se borra en
  // cuanto se usa y solo vale en cajas con suscripción. El cron solo lo quita
  // cuando la renovación ya se ha cobrado o se ha anulado.
  const endsAt =
    mode === "renewal"
      ? null
      : new Date(now.getTime() + DISCOVERY_DISCOUNT_DAYS * 24 * 60 * 60 * 1000);

  // `customerId` ya no va en Shopify (antes iba en el título de cada descuento
  // suelto): la reconciliación está en `discovery_set_coupons`.
  void customerId;
  await addCouponCode(DISCOVERY_COUPON_PARENT_GID, code);

  return {
    code,
    issuedAt: now.toISOString(),
    expiresAt: endsAt ? endsAt.toISOString() : null,
  };
}

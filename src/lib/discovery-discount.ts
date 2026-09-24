/**
 * Cupón de 5,95 € que se entrega al comprar el LIT Discovery Set.
 *
 * La promesa del email es literal: "te devolvemos los 5,95 € del Discovery Set
 * cuando pidas tu caja con envíos programados". Este módulo es lo que la
 * cumple. Se emite desde el webhook `orders/paid` (ver el webhook de Shopify),
 * no desde una sesión de cliente.
 *
 * Es el gemelo de `survey-discount.ts` y comparte con él la colección, el
 * formato de código y casi toda la configuración. Lo que cambia, y por qué:
 *
 *   - 5,95 € en vez de 5,00 €: es el precio exacto del Discovery Set, porque
 *     esto es una devolución, no un descuento redondo.
 *   - `appliesOnOneTimePurchase: FALSE`. Ver abajo, es la diferencia que
 *     sostiene la campaña entera.
 *   - El título lleva el prefijo `Discovery`, que es por donde los busca (o los
 *     buscará) el cron de limpieza.
 *
 * ── El aviso que nos ahorra un mes de depuración (Kiko) ──
 *
 * `customerSelection: { all: true }`, NUNCA un segmento de clientes. Restringir
 * por cliente es lo que dejó los cupones de GoAffPro con CERO redenciones
 * durante meses sin un solo error en ningún log: Shopify rechaza el código de
 * quien paga sin estar logueado, y entre compradores antiguos ese grupo es
 * enorme. Aquí el riesgo es todavía mayor que en el perfilado: quien compra el
 * Discovery Set es, por definición, alguien que aún no es cliente de caja y que
 * muy probablemente pagó como invitado.
 *
 * El código va suelto y la unicidad la garantizamos NOSOTROS: se emite una vez
 * por cliente y se guarda en `discovery_set_coupons`, cuya PK es el cliente.
 *
 * DEUDA CONOCIDA: `customerSelection` está deprecado y Shopify pide `context`.
 * No se migra aquí a propósito, por lo mismo que no se migra en el perfilado:
 * es EXACTAMENTE el campo que dejó los cupones de GoAffPro sin canjear durante
 * meses, y cambiarlo de paso, en el commit que estrena otra campaña, es cómo se
 * repite esa historia. Cuando toque, se migra solo y se verifica con un
 * checkout real sin sesión.
 */

import { shopifyAdmin } from "@/lib/shopify-admin";

/**
 * El precio del Discovery Set, que es lo que se devuelve. En euros porque la
 * mutación toma un decimal, no céntimos.
 *
 * Si algún día cambia el precio del Set, cambia aquí y en Shopify: el importe
 * viaja al email como propiedad del evento (`discount_value`), así que no hay
 * que tocar las cinco plantillas de Klaviyo.
 */
const DISCOUNT_AMOUNT_EUR = "5.95";

/** El mismo importe como número, para el evento de Klaviyo. Se deriva del de
 *  arriba para que no puedan divergir. */
export const DISCOVERY_DISCOUNT_VALUE_EUR = Number(DISCOUNT_AMOUNT_EUR);

/** Días de validez desde la emisión. Los emails prometen 30. */
export const DISCOVERY_DISCOUNT_DAYS = 30;

/**
 * Colección "Cupones - solo cajas LIT (tecnica, no publicar)", la MISMA que usa
 * el cupón del perfilado.
 *
 * Automática por título (contiene "Daily Hydration" o "Hydration Pack"), así
 * que son las 10 cajas: 4 sabores × suscripción y compra única, más los dos
 * packs de 4. Lo que importa aquí es lo que deja FUERA: el propio Discovery
 * Set, que no está en la colección, así que el cupón no puede gastarse en otro
 * Discovery Set. También quedan fuera botella, calcetines, hoodie y wholesale.
 *
 * Contiene los "- Compra única", pero no es un agujero: con
 * `appliesOnOneTimePurchase: false` el descuento no aplica sobre ellos de todas
 * formas. Mantener una segunda colección casi idéntica costaría más de lo que
 * aporta y sería una cosa más que se desincroniza cuando entre un sabor nuevo.
 *
 * Verificado contra Shopify el 2026-09-24: 10 productos, los esperados, sin
 * Discovery Set.
 */
const COUPON_COLLECTION_GID = "gid://shopify/Collection/726625812829";

export interface IssuedDiscount {
  code: string;
  issuedAt: string;
  expiresAt: string;
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
 * Crea el descuento en Shopify y devuelve el código.
 *
 * Lanza si Shopify falla o devuelve userErrors. El llamante (el webhook) lo
 * captura, avisa por Slack y NO dispara el evento de Klaviyo: el primer email
 * lleva el código en el cuerpo, así que sin código el correo sale roto y es
 * peor que no mandarlo.
 */
export async function issueDiscoveryDiscount(customerId: string): Promise<IssuedDiscount> {
  const code = generateCode();
  const now = new Date();
  const endsAt = new Date(now.getTime() + DISCOVERY_DISCOUNT_DAYS * 24 * 60 * 60 * 1000);

  const data = await shopifyAdmin.graphql<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null;
      userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
    };
  }>(
    `mutation createDiscoveryDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }`,
    {
      basicCodeDiscount: {
        // El título es lo que ve el equipo en el admin, y el prefijo `Discovery`
        // es además el filtro por el que los encuentra el cron de limpieza.
        // Lleva el customerId para poder reconciliar a mano un cupón con quien
        // lo generó.
        title: `Discovery ${code} (${customerId})`,
        code,
        startsAt: now.toISOString(),
        endsAt: endsAt.toISOString(),
        // Ver el docstring del módulo: NUNCA un segmento.
        customerSelection: { all: true },
        customerGets: {
          value: { discountAmount: { amount: DISCOUNT_AMOUNT_EUR, appliesOnEachItem: false } },
          items: { collections: { add: [COUPON_COLLECTION_GID] } },
          // ── La diferencia con el cupón del perfilado, y es deliberada ──
          //
          // SOLO suscripción. El email promete devolver los 5,95 € "cuando
          // pidas tu caja con envíos programados", y la campaña existe para
          // convertir a quien probó el Set en suscriptor. Si el cupón valiera
          // en compra única, el cliente se lo gastaría en un one-shot y la
          // campaña no convertiría a nadie: habríamos regalado 5,95 € por una
          // venta que ya iba a ocurrir.
          appliesOnOneTimePurchase: false,
          // FALSE por defecto en Shopify, así que va explícito. Omitirlo es lo
          // que hizo rebotar los primeros cupones del perfilado con "no es
          // válido para los artículos de tu carrito", y aquí sería fatal: con
          // one-time ya en false, un `appliesOnSubscription` implícito dejaría
          // un cupón que no sirve para NADA, en ningún carrito.
          appliesOnSubscription: true,
        },
        // Solo el PRIMER cobro de la suscripción. Sin esto, 5,95 € menos en
        // cada entrega para siempre, que convierte un cupón de captación en un
        // descuento permanente sobre el ticket.
        recurringCycleLimit: 1,
        // Sin mínimo de compra: la colección ya lo resuelve, porque lo más
        // barato que contiene son 28,35 €.
        appliesOncePerCustomer: true,
        usageLimit: 1,
      },
    },
  );

  const res = data.discountCodeBasicCreate;
  if (res.userErrors?.length) {
    throw new Error(
      `discountCodeBasicCreate: ${res.userErrors.map((e) => `${e.code ?? ""} ${e.message}`).join("; ")}`,
    );
  }
  if (!res.codeDiscountNode) {
    throw new Error("discountCodeBasicCreate devolvió codeDiscountNode null sin userErrors");
  }

  return {
    code,
    issuedAt: now.toISOString(),
    expiresAt: endsAt.toISOString(),
  };
}

/**
 * Cupón de 5 € que se entrega al terminar el formulario de perfilado.
 *
 * Solo lo reciben los clientes SIN suscripción viva: el email "Perfilado B"
 * (one-shot, ~4.068 personas) promete "un descuento para tu próxima caja … con
 * tu código listo para usar", y este módulo es lo que cumple esa frase. El
 * email "Perfilado A" (suscriptores) no promete nada, así que a ellos no se les
 * emite (ver `issueSurveyDiscount` y su llamada en la ruta de submit).
 *
 * ── El aviso que nos ahorra un mes de depuración (Kiko) ──
 *
 * `customerSelection: { all: true }`, NUNCA un segmento de clientes. Restringir
 * por cliente es lo que dejó los cupones de GoAffPro con CERO redenciones
 * durante meses sin un solo error en ningún log: Shopify rechaza el código de
 * quien paga sin estar logueado, y entre compradores antiguos ese grupo es
 * enorme. El código va suelto y la unicidad la garantizamos NOSOTROS: se emite
 * una vez por cliente y se guarda en `profile_survey_answers`.
 *
 * Por eso además `usageLimit: 1` y `appliesOncePerCustomer: true` son cinturón
 * y tirantes sobre un código que ya es de un solo uso por construcción.
 */

import { shopifyAdmin } from "@/lib/shopify-admin";

/** 5 € fijos. En euros porque la mutación toma un decimal, no céntimos. */
const DISCOUNT_AMOUNT_EUR = "5.0";

/** Días de validez desde la emisión. El email promete 30. */
export const DISCOUNT_DAYS = 30;

/**
 * Colección "Cupones - solo cajas LIT (tecnica, no publicar)".
 *
 * Automática por título (contiene "Daily Hydration" o "Hydration Pack"), así
 * que hoy son las 10 cajas: 3 sabores × suscripción y compra única, más los dos
 * packs de 4. Deja fuera Discovery Set, botella, calcetines, hoodie y los tres
 * de wholesale. Cuando Raw pase de DRAFT a ACTIVE entra solo, sin tocar esto.
 *
 * Verificado contra Shopify el 2026-09-22: 10 productos, los esperados.
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
 * Lanza si Shopify falla o devuelve userErrors: la ruta de submit lo captura y
 * guarda las respuestas igual con `discount_code: null`. Preferimos perder un
 * cupón (recuperable a mano) antes que perder el perfilado o dejar al cliente
 * repitiendo la encuesta.
 */
export async function issueSurveyDiscount(customerId: string): Promise<IssuedDiscount> {
  const code = generateCode();
  const now = new Date();
  const endsAt = new Date(now.getTime() + DISCOUNT_DAYS * 24 * 60 * 60 * 1000);

  const data = await shopifyAdmin.graphql<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null;
      userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
    };
  }>(
    `mutation createSurveyDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }`,
    {
      basicCodeDiscount: {
        // El título es lo que ve el equipo en el admin. Lleva el customerId
        // para poder reconciliar a mano un cupón con quien lo generó.
        title: `Perfilado ${code} (${customerId})`,
        code,
        startsAt: now.toISOString(),
        endsAt: endsAt.toISOString(),
        // Ver el docstring del módulo: NUNCA un segmento.
        customerSelection: { all: true },
        customerGets: {
          value: { discountAmount: { amount: DISCOUNT_AMOUNT_EUR, appliesOnEachItem: false } },
          items: { collections: { add: [COUPON_COLLECTION_GID] } },
        },
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

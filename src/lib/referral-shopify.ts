/**
 * Referidos, fase 0: todo lo que habla con la Admin API de Shopify.
 *
 * Dos clases de descuento, con reglas distintas a propósito:
 *
 *  - El del AMIGO es UN descuento padre («Referidos · Amigo 10 €») con un código
 *    personal por suscriptor colgado de él (`MARIA27`). Un solo sitio para
 *    cambiar el importe o apagarlo para todos, y `appliesOncePerCustomer` vale
 *    para el padre entero: un amigo usa UN código de amigo en su vida, el que sea.
 *    Vale en suscripción Y en compra única (decisión del 9-oct: no se frena a
 *    quien no quiere suscribirse).
 *
 *  - El de QUIEN INVITA es un descuento por recompensa (`LITREF-XXXXXXXX`), de
 *    un solo uso, que solo aplica el cron sobre la sub de Seal. Seal ignora las
 *    restricciones de Shopify al aplicar un código a una sub (LIT-BONUS, con
 *    `appliesOnSubscription: false`, se cobró igual en renovaciones), así que
 *    aquí la configuración solo protege contra un uso en el checkout; el control
 *    de verdad es nuestro (lib/referral-reward.ts).
 *
 * `customerSelection: { all: true }` en los dos, NUNCA un segmento: restringir por
 * cliente dejó los cupones de GoAffPro con cero canjes (los invitados pagan sin
 * sesión). Ver discovery-discount.ts para la historia entera.
 */

import {
  COUPON_COLLECTION_GID,
  isRenewalSource,
  normalizeCode,
  purchaseTypeOf,
  REFERRAL_FRIEND_AMOUNT_EUR,
  REFERRAL_REWARD_AMOUNT_EUR,
  type PurchaseType,
} from "@/lib/referral-core";
import { shopifyAdmin } from "@/lib/shopify-admin";

/** Título del descuento padre. Lo busca el script que lo crea y lo ve el equipo en el admin. */
export const FRIEND_DISCOUNT_TITLE = "Referidos · Amigo 10 €";

/**
 * Prefijo del título de los descuentos de recompensa. NO puede empezar por
 * «Perfilado » ni «Discovery »: el cron survey-discount-cleanup borra lo que
 * empiece por eso, y un LITREF borrado mientras está aplicado en Seal no se
 * podría volver a aplicar.
 */
export const REWARD_DISCOUNT_TITLE_PREFIX = "Referido recompensa";

/** Discovery Set: un pedido que SOLO lleva esto no hace a nadie cliente anterior. */
const DISCOVERY_SKU = "LITDS";
const DISCOVERY_VARIANT_GID = "gid://shopify/ProductVariant/65812401652061";

type UserError = { field: string[] | null; message: string; code: string | null };

function throwOnUserErrors(op: string, errs: UserError[] | undefined): void {
  if (errs?.length) {
    throw new Error(`${op}: ${errs.map((e) => `${e.code ?? ""} ${e.message}`.trim()).join("; ")}`);
  }
}

const toGid = (kind: string, id: string) =>
  id.startsWith("gid://") ? id : `gid://shopify/${kind}/${id}`;

const numericId = (gid: string | null | undefined) =>
  gid ? gid.replace(/^gid:\/\/shopify\/[A-Za-z]+\//, "") : null;

// ═══════════════════════════════════════════════════════════════════════════
// El descuento del amigo
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Crea el descuento padre. Lo usa SOLO `scripts/referral-create-parent-discount.ts`,
 * una vez, con OK explícito. `seedCode` es un código aleatorio que nadie conoce:
 * Shopify exige uno para crear el descuento, y uno inerte evita regalar un
 * «10 € para nuevos» público.
 */
export async function createFriendParentDiscount(seedCode: string): Promise<string> {
  const data = await shopifyAdmin.graphql<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    `mutation createReferralParent($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }`,
    {
      basicCodeDiscount: {
        title: FRIEND_DISCOUNT_TITLE,
        code: normalizeCode(seedCode),
        startsAt: new Date().toISOString(),
        customerSelection: { all: true },
        customerGets: {
          value: { discountAmount: { amount: REFERRAL_FRIEND_AMOUNT_EUR, appliesOnEachItem: false } },
          items: { collections: { add: [COUPON_COLLECTION_GID] } },
          // Las DOS a true, y explícitas: `appliesOnSubscription` vale false por
          // defecto, y omitirlo es lo que hizo rebotar los primeros cupones del
          // perfilado en carritos de suscripción.
          appliesOnOneTimePurchase: true,
          appliesOnSubscription: true,
        },
        // En suscripción, solo el primer pedido. (Verificado el 9-oct que Seal no
        // arrastra los códigos del checkout a las renovaciones; esto es la red.)
        recurringCycleLimit: 1,
        // Para el padre ENTERO: un amigo usa un solo código de amigo en su vida.
        appliesOncePerCustomer: true,
        // Sin `usageLimit`: en un descuento con varios códigos cuenta el total del
        // padre, y cada código personal se comparte con varios amigos.
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
      },
    },
  );
  const res = data.discountCodeBasicCreate;
  throwOnUserErrors("discountCodeBasicCreate (padre)", res.userErrors);
  if (!res.codeDiscountNode) throw new Error("discountCodeBasicCreate (padre): codeDiscountNode null sin userErrors");
  return res.codeDiscountNode.id;
}

/**
 * Da de alta códigos personales en el descuento padre. Asíncrono en Shopify:
 * devuelve el id de la bulk, que se consulta con {@link readBulkCreation}.
 * Máximo 250 por llamada.
 */
export async function bulkAddFriendCodes(discountId: string, codes: string[]): Promise<string> {
  if (!codes.length) throw new Error("bulkAddFriendCodes: lista vacía");
  if (codes.length > 250) throw new Error(`bulkAddFriendCodes: ${codes.length} códigos, máximo 250`);
  const data = await shopifyAdmin.graphql<{
    discountRedeemCodeBulkAdd: {
      bulkCreation: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    `mutation addReferralCodes($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
      discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
        bulkCreation { id }
        userErrors { field message code }
      }
    }`,
    { discountId, codes: codes.map((code) => ({ code: normalizeCode(code) })) },
  );
  const res = data.discountRedeemCodeBulkAdd;
  throwOnUserErrors("discountRedeemCodeBulkAdd", res.userErrors);
  if (!res.bulkCreation) throw new Error("discountRedeemCodeBulkAdd: bulkCreation null sin userErrors");
  return res.bulkCreation.id;
}

export interface BulkCodeResult {
  code: string;
  ok: boolean;
  error: string | null;
}

/** Estado de una bulk de alta. `done: false` = Shopify aún no ha terminado. */
export async function readBulkCreation(
  bulkId: string,
): Promise<{ done: boolean; codes: BulkCodeResult[] }> {
  const data = await shopifyAdmin.graphql<{
    discountRedeemCodeBulkCreation: {
      done: boolean;
      codes: {
        nodes: Array<{
          code: string;
          errors: UserError[];
          discountRedeemCode: { id: string } | null;
        }>;
      };
    } | null;
  }>(
    `query referralBulkStatus($id: ID!) {
      discountRedeemCodeBulkCreation(id: $id) {
        done
        codes(first: 250) { nodes { code errors { field message code } discountRedeemCode { id } } }
      }
    }`,
    { id: bulkId },
  );
  const b = data.discountRedeemCodeBulkCreation;
  if (!b) throw new Error(`readBulkCreation: la bulk ${bulkId} no existe`);
  return {
    done: b.done,
    codes: b.codes.nodes.map((n) => ({
      code: normalizeCode(n.code),
      ok: !n.errors?.length && !!n.discountRedeemCode,
      error: n.errors?.length ? n.errors.map((e) => e.message).join("; ") : null,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// El descuento de la recompensa
// ═══════════════════════════════════════════════════════════════════════════

/** Crea el descuento de un solo uso de una recompensa. Devuelve su gid. */
export async function createRewardDiscount(code: string, referrerCustomerId: string): Promise<string> {
  const data = await shopifyAdmin.graphql<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    `mutation createReferralReward($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }`,
    {
      basicCodeDiscount: {
        // Lleva el cliente para poder reconciliar a mano desde el admin.
        title: `${REWARD_DISCOUNT_TITLE_PREFIX} ${normalizeCode(code)} (${referrerCustomerId})`,
        code: normalizeCode(code),
        startsAt: new Date().toISOString(),
        customerSelection: { all: true },
        customerGets: {
          value: { discountAmount: { amount: REFERRAL_REWARD_AMOUNT_EUR, appliesOnEachItem: false } },
          items: { collections: { add: [COUPON_COLLECTION_GID] } },
          appliesOnOneTimePurchase: false,
          appliesOnSubscription: true,
        },
        recurringCycleLimit: 1,
        appliesOncePerCustomer: true,
        usageLimit: 1,
      },
    },
  );
  const res = data.discountCodeBasicCreate;
  throwOnUserErrors("discountCodeBasicCreate (recompensa)", res.userErrors);
  if (!res.codeDiscountNode) throw new Error("discountCodeBasicCreate (recompensa): codeDiscountNode null sin userErrors");
  return res.codeDiscountNode.id;
}

/**
 * gid del descuento que tiene este código, o null. Sirve para el caso ambiguo:
 * una mutación de creación que no contesta (las mutaciones nunca se reintentan)
 * puede haber entrado igualmente.
 */
export async function findCodeDiscountNodeId(code: string): Promise<string | null> {
  const data = await shopifyAdmin.graphql<{ codeDiscountNodeByCode: { id: string } | null }>(
    `query referralCodeLookup($code: String!) { codeDiscountNodeByCode(code: $code) { id } }`,
    { code: normalizeCode(code) },
  );
  return data.codeDiscountNodeByCode?.id ?? null;
}

/** Borra un descuento entero (solo las recompensas ya consumidas o revocadas). */
export async function deleteCodeDiscount(discountId: string): Promise<void> {
  const data = await shopifyAdmin.graphql<{
    discountCodeDelete: { deletedCodeDiscountId: string | null; userErrors: UserError[] };
  }>(
    `mutation deleteRewardDiscount($id: ID!) {
      discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message code } }
    }`,
    { id: discountId },
  );
  throwOnUserErrors("discountCodeDelete", data.discountCodeDelete.userErrors);
}

// ═══════════════════════════════════════════════════════════════════════════
// Pedido y cliente
// ═══════════════════════════════════════════════════════════════════════════

export interface ReferralOrderFacts {
  orderId: string;
  name: string;
  createdAt: string;
  sourceName: string | null;
  isRenewal: boolean;
  /** Cancelado, o reembolsado o anulado entero. Un reembolso parcial NO cuenta. */
  voided: boolean;
  /**
   * Códigos del pedido y títulos de sus descuentos, en mayúsculas. En las
   * renovaciones de Seal incluye el código que aplicó Seal.
   */
  discountCodes: string[];
  customerId: string | null;
  email: string | null;
  phone: string | null;
  shippingAddress1: string | null;
  shippingZip: string | null;
  shippingPhone: string | null;
  hasLitBox: boolean;
  purchaseType: PurchaseType;
}

/** El pedido tal como lo necesitan la cualificación y el consumo. `null` si no existe. */
export async function readOrderForReferral(orderId: string): Promise<ReferralOrderFacts | null> {
  const data = await shopifyAdmin.graphql<{
    order: {
      id: string;
      name: string;
      createdAt: string;
      sourceName: string | null;
      cancelledAt: string | null;
      displayFinancialStatus: string | null;
      discountCodes: string[];
      discountApplications: { nodes: Array<{ code?: string | null; title?: string | null }> };
      email: string | null;
      phone: string | null;
      customer: { id: string; email: string | null; phone: string | null } | null;
      shippingAddress: { address1: string | null; zip: string | null; phone: string | null } | null;
      lineItems: {
        nodes: Array<{
          sellingPlan: { sellingPlanId: string | null } | null;
          product: { inCollection: boolean } | null;
        }>;
      };
    } | null;
  }>(
    `query referralOrder($id: ID!, $collection: ID!) {
      order(id: $id) {
        id name createdAt sourceName cancelledAt displayFinancialStatus discountCodes email phone
        discountApplications(first: 10) {
          nodes {
            ... on DiscountCodeApplication { code }
            ... on ManualDiscountApplication { title }
            ... on AutomaticDiscountApplication { title }
            ... on ScriptDiscountApplication { title }
          }
        }
        customer { id email phone }
        shippingAddress { address1 zip phone }
        lineItems(first: 50) {
          nodes { sellingPlan { sellingPlanId } product { inCollection(id: $collection) } }
        }
      }
    }`,
    { id: toGid("Order", orderId), collection: COUPON_COLLECTION_GID },
  );
  const o = data.order;
  if (!o) return null;
  const lines = o.lineItems.nodes.map((li) => ({
    inCollection: li.product?.inCollection === true,
    hasSellingPlan: !!li.sellingPlan,
  }));
  const purchaseType = purchaseTypeOf(lines);
  const status = (o.displayFinancialStatus ?? "").toUpperCase();
  return {
    orderId: numericId(o.id) ?? orderId,
    name: o.name,
    createdAt: o.createdAt,
    sourceName: o.sourceName,
    isRenewal: isRenewalSource(o.sourceName),
    voided: !!o.cancelledAt || status === "REFUNDED" || status === "VOIDED",
    // Los códigos del pedido Y los títulos de sus descuentos. Seal aplica el código
    // de una sub como descuento MANUAL titulado con el código (verificado con
    // LITSTAY15 en #10291); se juntan los dos para que el consumo de una recompensa
    // no dependa de que Shopify lo liste además en `discountCodes`.
    discountCodes: [
      ...new Set(
        [
          ...(o.discountCodes ?? []),
          ...(o.discountApplications?.nodes ?? []).map((a) => a.code ?? a.title ?? ""),
        ]
          .map(normalizeCode)
          .filter(Boolean),
      ),
    ],
    customerId: numericId(o.customer?.id),
    email: o.customer?.email ?? o.email ?? null,
    phone: o.customer?.phone ?? o.phone ?? null,
    shippingAddress1: o.shippingAddress?.address1 ?? null,
    shippingZip: o.shippingAddress?.zip ?? null,
    shippingPhone: o.shippingAddress?.phone ?? null,
    hasLitBox: purchaseType !== "none",
    purchaseType,
  };
}

/**
 * Pedidos ANTERIORES del cliente que lo hacen cliente de LIT: cualquiera no
 * cancelado, creado ANTES de `beforeIso` y distinto de `excludeOrderId`, que
 * lleve algo más que el Discovery Set. No se usa la colección de cupones: solo
 * tiene los productos de hoy, y quien compró las cajas de antes (productos
 * archivados) pasaría por nuevo.
 *
 * Por fecha y no solo por id: la cualificación se reintenta hasta 7 días, y un
 * segundo pedido del amigo en ese tiempo no puede quitarle el premio a quien le
 * invitó.
 *
 * `null` si no se pudo leer (el llamante reintenta, nunca rechaza por esto).
 */
export async function countPriorLitOrders(
  customerId: string,
  excludeOrderId: string,
  beforeIso: string,
): Promise<number | null> {
  try {
    const data = await shopifyAdmin.graphql<{
      customer: {
        numberOfOrders: string;
        orders: {
          nodes: Array<{
            id: string;
            createdAt: string;
            cancelledAt: string | null;
            lineItems: { nodes: Array<{ sku: string | null; variant: { id: string } | null }> };
          }>;
        };
      } | null;
    }>(
      `query referralCustomerHistory($id: ID!) {
        customer(id: $id) {
          numberOfOrders
          orders(first: 25, sortKey: CREATED_AT) {
            nodes { id createdAt cancelledAt lineItems(first: 30) { nodes { sku variant { id } } } }
          }
        }
      }`,
      { id: toGid("Customer", customerId) },
    );
    const c = data.customer;
    if (!c) return 0;
    const exclude = toGid("Order", excludeOrderId);
    const before = Date.parse(beforeIso);
    let prior = 0;
    for (const o of c.orders.nodes) {
      if (o.id === exclude || o.cancelledAt) continue;
      if (Number.isFinite(before) && Date.parse(o.createdAt) >= before) continue;
      const onlyDiscovery = o.lineItems.nodes.every(
        (li) => li.sku === DISCOVERY_SKU || li.variant?.id === DISCOVERY_VARIANT_GID,
      );
      if (!onlyDiscovery) prior++;
    }
    // Con más de 25 pedidos la página no los trae todos, pero tampoco hace falta:
    // basta con uno anterior para no ser nuevo, y ahí ya hay 24.
    return prior;
  } catch (err) {
    console.warn("[referrals] no se pudo leer el historial del cliente", customerId, err);
    return null;
  }
}

export interface CustomerBasics {
  firstName: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
}

/** Nombre, email, teléfono y etiquetas: para generar el código y para el antifraude. */
export async function readCustomerBasics(customerId: string): Promise<CustomerBasics | null> {
  const data = await shopifyAdmin.graphql<{
    customer: { firstName: string | null; email: string | null; phone: string | null; tags: string[] } | null;
  }>(
    `query referralCustomerBasics($id: ID!) { customer(id: $id) { firstName email phone tags } }`,
    { id: toGid("Customer", customerId) },
  );
  const c = data.customer;
  if (!c) return null;
  return { firstName: c.firstName, email: c.email, phone: c.phone, tags: c.tags ?? [] };
}

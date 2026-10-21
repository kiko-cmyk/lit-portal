import { ApiHttpError } from "@/lib/api-helpers";
import type { SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";

/**
 * «Adelantar» solo cuando el primer pedido de la suscripción ya ha salido (21-oct-2026, Kiko).
 *
 * Seal crea cada renovación con las etiquetas que lleva en ese momento el pedido origen de la
 * suscripción. Quien compra el pack 3+1 con envíos programados tiene la etiqueta `botella` en
 * ese pedido; si adelanta antes de que salga del almacén, la renovación nace con la etiqueta y
 * Hive le mete una segunda botella. Kiko quita la etiqueta en cuanto el pedido sale, así que
 * después ya no hay riesgo. Vale para todas las suscripciones, no solo las de la etiqueta.
 *
 * Medido el 21-oct: Shopify marca FULFILLED entre 1 y 3 días después de la compra (los del
 * viernes, el lunes), aunque Hive ponga antes `hive_fulfillment_stage:shipped`.
 */

/** Lo que hace falta del pedido origen (de `shopifyAdmin.getOrderDetail`). */
export interface FirstOrderState {
  displayFulfillmentStatus: string;
  cancelledAt: string | null;
}

/**
 * ¿Se puede adelantar con el pedido origen en este estado? Sí cuando ya ha salido, y también
 * cuando no va a salir nunca (cancelado, o con todo devuelto al stock): sin primer envío no hay
 * botella doble. Cualquier otro estado (UNFULFILLED, PARTIALLY_FULFILLED, ON_HOLD…) espera.
 */
export function firstOrderAllowsChargeNow(order: FirstOrderState): boolean {
  if (order.cancelledAt) return true;
  return order.displayFulfillmentStatus === "FULFILLED" || order.displayFulfillmentStatus === "RESTOCKED";
}

/** A partir de cuántos días desde la compra se da por hecho que el primer pedido ya salió. */
export const FIRST_ORDER_ASSUMED_SHIPPED_DAYS = 7;

/**
 * Si Shopify no contesta (tras sus propios reintentos), ¿se deja adelantar? Depende de la
 * antigüedad del pedido origen, que Seal da en `order_placed` sin pasar por Shopify:
 * - Más de 7 días: sí. El primer pedido sale en 1-3 días, y bloquear por un fallo de Shopify
 *   dejaría sin Adelantar a todas las suscripciones a la vez.
 * - 7 días o menos, o fecha ilegible: no. Es justo la ventana en la que hay riesgo de botella
 *   doble, y el cliente puede volver a intentarlo en unos minutos.
 */
export function allowWhenFirstOrderUnreadable(orderPlaced: string | null | undefined, now = Date.now()): boolean {
  const placed = orderPlaced ? Date.parse(orderPlaced) : Number.NaN;
  if (!Number.isFinite(placed)) return false;
  return now - placed > FIRST_ORDER_ASSUMED_SHIPPED_DAYS * 86_400_000;
}

/**
 * Lanza 409 `first_order_not_shipped` si el pedido origen de la sub aún no ha salido, y 409
 * `first_order_unverified` si no se ha podido comprobar en una sub reciente. Va antes del
 * cerrojo y de `seal.chargeNow`: aquí aún no hay nada que soltar.
 */
export async function assertFirstOrderShipped(
  sub: Pick<SealSubscription, "id" | "order_id" | "order_placed">,
  customerId: string,
): Promise<void> {
  const orderId = String(sub.order_id ?? "").trim();
  // Sin pedido origen (sub creada a mano o importada) no hay etiquetas que heredar.
  if (!/^[1-9]\d*$/.test(orderId)) return;

  let order: Awaited<ReturnType<typeof shopifyAdmin.getOrderDetail>>;
  try {
    order = await shopifyAdmin.getOrderDetail(`gid://shopify/Order/${orderId}`);
  } catch (err) {
    const allow = allowWhenFirstOrderUnreadable(sub.order_placed);
    console.warn("[charge-now] no se pudo leer el primer pedido", {
      sealSubscriptionId: sub.id,
      orderId,
      orderPlaced: sub.order_placed,
      allow,
      msg: err instanceof Error ? err.message : String(err),
    });
    if (allow) return;
    throw new ApiHttpError(
      409,
      "first_order_unverified",
      "Could not check whether the first order has shipped. Try again in a few minutes.",
    );
  }

  // Pedido borrado o fuera del alcance del token: no hay nada que esperar.
  if (!order) {
    console.warn("[charge-now] primer pedido no encontrado en Shopify, se deja adelantar", {
      sealSubscriptionId: sub.id,
      orderId,
    });
    return;
  }
  // Como pide getOrderDetail: no se decide con un pedido de otro cliente. Pasa con subs que
  // cambiaron de cuenta, que son antiguas y cuyo primer pedido salió hace tiempo.
  if (order.customerNumericId !== customerId) {
    console.warn("[charge-now] el primer pedido es de otro cliente, se deja adelantar", {
      sealSubscriptionId: sub.id,
      orderId,
    });
    return;
  }

  if (!firstOrderAllowsChargeNow(order)) {
    throw new ApiHttpError(
      409,
      "first_order_not_shipped",
      "The first order of this subscription hasn't shipped yet.",
    );
  }
}

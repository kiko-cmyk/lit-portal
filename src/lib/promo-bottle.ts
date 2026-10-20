/**
 * La botella de regalo en los «Adelantar» mientras dura la promo (20-oct-2026).
 *
 * En la web la botella entra porque la casilla la mete en el carrito y el descuento
 * automático «Botella LIT de regalo» la deja a 0€. Un «Adelantar» no pasa por el
 * carrito: el pedido lo crea Seal desde la suscripción, así que salía sin botella, y
 * hubo clientes que adelantaron justo para llevársela. Añadirla al pedido después de
 * crearlo es una carrera contra Hive, que lo envía en 1-3 h (el 20-oct salieron tres
 * así sin botella).
 *
 * Así que entra ANTES del cobro, en la suscripción, como artículo de un solo uso a 0€:
 * Seal lo mete en el pedido que crea el «Adelantar» y lo quita después. Es el mismo
 * camino que usa atención cuando la añade a mano en Seal, y el pedido nace con ella.
 *
 * La promo la decide el descuento automático de Shopify: mientras esté ACTIVE, hay
 * botella. Si no se puede leer, manda la ventana anunciada. Nada de esto puede tumbar
 * un «Adelantar»: cualquier fallo se apunta y el cobro sigue sin botella.
 */

import { alertSlackError } from "@/lib/alert";
import { waitUntilSeal } from "@/lib/line-repair-runner";
import { seal, type SealSubscription } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";

export const PROMO_BOTTLE = {
  /** «Botella», SKU BOTTLE2-LIT: la que tiene Hive (ver reference_botella_producto_bueno). */
  variantId: "67543664951686",
  /** «Botella LIT de regalo», el BXGY automático de la web. */
  discountId: "gid://shopify/DiscountAutomaticNode/2511415509382",
  /** Si el descuento no se puede leer: la ventana anunciada (lunes 19-oct 13:21 a martes 23:59, Madrid). */
  fallbackStart: "2026-10-19T11:21:31Z",
  fallbackEnd: "2026-10-20T21:59:59Z",
  /** Propiedad oculta de la línea: distingue la botella automática de la que se añade a mano. */
  property: { key: "_lit_promo", value: "botella-adelantar" },
} as const;

/** Cuánto se espera a que Seal enseñe la botella antes de cobrar (el App Proxy corta a ~10 s). */
const VISIBLE_WAIT_MS = 3_000;
const CACHE_MS = 60_000;

let cached: { active: boolean; until: number } | null = null;

/** Solo para los tests: olvida el estado del descuento. */
export function resetPromoBottleCache(): void {
  cached = null;
}

/** ¿Está viva la promo? El estado del descuento automático, con un minuto de caché. */
export async function promoBottleActive(now: number = Date.now()): Promise<boolean> {
  if (cached && cached.until > now) return cached.active;
  let active: boolean;
  try {
    const d = await shopifyAdmin.graphql<{ discountNode: { discount: { status?: string } | null } | null }>(
      `query promoBottle($id: ID!) { discountNode(id: $id) { discount { ... on DiscountAutomaticBxgy { status } } } }`,
      { id: PROMO_BOTTLE.discountId },
    );
    const status = d.discountNode?.discount?.status;
    active = status ? status === "ACTIVE" : inFallbackWindow(now);
  } catch (e) {
    console.warn("[promo-bottle] no se pudo leer el descuento; manda la ventana anunciada", e);
    active = inFallbackWindow(now);
  }
  cached = { active, until: now + CACHE_MS };
  return active;
}

export function inFallbackWindow(now: number): boolean {
  return now >= Date.parse(PROMO_BOTTLE.fallbackStart) && now <= Date.parse(PROMO_BOTTLE.fallbackEnd);
}

/** La línea de la botella de la sub, si la tiene (de un solo uso o no, puesta a mano o no). */
export function bottleLineOf(sub: Pick<SealSubscription, "items">): { id: number } | null {
  const it = (sub.items ?? []).find((i) => String(i.variant_id) === PROMO_BOTTLE.variantId);
  return it ? { id: Number(it.id) } : null;
}

export type PromoBottleOutcome =
  | { kind: "inactive" }
  | { kind: "already" }
  | { kind: "added"; itemId: number }
  | { kind: "added_unseen" }
  | { kind: "failed"; error: string };

/**
 * Mete la botella a 0€ en la sub antes del cobro, si toca. Nunca lanza.
 *
 * - Fuera de la promo, nada.
 * - Si la sub ya lleva botella (atención la ha puesto a mano), nada: una por pedido.
 * - Si Seal no la enseña en `VISIBLE_WAIT_MS`, se cobra igual: casi siempre entra en el
 *   pedido, y si no, viaja en el siguiente.
 */
export async function addPromoBottleBeforeCharge(
  sub: SealSubscription,
  ctx: { customerId: string; path: string },
): Promise<PromoBottleOutcome> {
  try {
    if (!(await promoBottleActive())) return { kind: "inactive" };
    if (bottleLineOf(sub)) return { kind: "already" };
    const v = await shopifyAdmin.getVariantForSealAddItems(PROMO_BOTTLE.variantId);
    if (!v) throw new Error(`la variante ${PROMO_BOTTLE.variantId} no existe en Shopify`);
    await seal.addItems(sub.id, [
      {
        productId: v.productId,
        variantId: v.variantId,
        quantity: 1,
        title: v.title,
        sku: v.sku,
        taxable: v.taxable,
        requiresShipping: v.requiresShipping,
        price: "0.00",
        oneTime: true,
        properties: [{ ...PROMO_BOTTLE.property }],
      },
    ]);
    let line: { id: number } | null = null;
    await waitUntilSeal(
      sub.id,
      (s) => {
        line = bottleLineOf(s);
        return line !== null;
      },
      VISIBLE_WAIT_MS,
      600,
    );
    const seen = line as { id: number } | null;
    console.log("[promo-bottle] botella añadida antes del Adelantar", { sub: sub.id, visible: !!seen });
    return seen ? { kind: "added", itemId: seen.id } : { kind: "added_unseen" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[promo-bottle] no se pudo añadir la botella; el Adelantar sigue sin ella", { sub: sub.id, error });
    alertSlackError({
      path: ctx.path,
      code: "promo_bottle_not_added",
      msg: `sub ${sub.id}: el Adelantar sale SIN la botella de la promo (${error.slice(0, 160)}). Añadirla a mano si el pedido aún no ha salido.`,
      customerId: ctx.customerId,
    });
    return { kind: "failed", error };
  }
}

/**
 * Si Seal RECHAZA el cobro, la botella que acabamos de meter se quita: si no, viajaría
 * gratis en la siguiente renovación, ya fuera de la promo. Solo la nuestra (`added`), y
 * nunca ante un resultado ambiguo, que puede acabar cobrando. Nunca lanza.
 */
export async function removePromoBottleAfterRejection(
  subId: number,
  outcome: PromoBottleOutcome,
  ctx: { customerId: string; path: string },
): Promise<void> {
  if (outcome.kind !== "added") return;
  try {
    await seal.removeItems(subId, [outcome.itemId]);
  } catch (e) {
    alertSlackError({
      path: ctx.path,
      code: "promo_bottle_not_removed",
      msg: `sub ${subId}: el Adelantar falló y la botella de la promo se ha quedado en la sub (línea ${outcome.itemId}); saldría gratis en su próxima renovación. Quitarla en Seal si no debe. (${e instanceof Error ? e.message.slice(0, 120) : String(e)})`,
      customerId: ctx.customerId,
    });
  }
}

import { alertSlackError } from "@/lib/alert";
import { DISCOVERY_DISCOUNT_VALUE_EUR } from "@/lib/discovery-discount";
import { klaviyo } from "@/lib/klaviyo";
import {
  findAllAppliedDiscountCodeIds,
  getNextBillingAttempt,
  seal,
  type SealBillingAttempt,
  type SealSubscription,
} from "@/lib/seal";
import { formatShipDateEs } from "@/lib/ship-date-label";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Discovery Set + suscripción en el MISMO pedido: los 4,99 € del Set se
 * descuentan de la PRIMERA RENOVACIÓN de esa suscripción.
 *
 * ── Por qué existe ──
 *
 * La promesa del Set es "si te suscribes, te devolvemos los 4,99 €". Para quien
 * compra el Set solo, se cumple con un código por email que canjea en el
 * checkout de su suscripción (`mode = 'checkout'`). Pero el pedido #11724
 * (2026-10-09, vía pop-up de la PDP) trajo el Set Y la caja con suscripción en
 * el mismo carrito: el código ya no le servía (no hay "nueva suscripción" en la
 * que usarlo) y el flow de cinco emails le pedía suscribirse a alguien que ya lo
 * estaba. Decisión de Juan: en ese caso el importe va a su siguiente
 * renovación, "así nos aseguramos de que renueva".
 *
 * ── Cómo ──
 *
 * `orders/paid` emite un código de un solo uso y SIN caducidad, y guarda la
 * fila en `discovery_set_coupons` con `mode = 'renewal'`, `status =
 * 'pending_apply'`. No se manda al cliente. Este módulo lo aplica a la sub de
 * Seal que nació en ese pedido (`sub.order_id`) y lo retira después del primer
 * cobro, igual que el 15 % de retención (`lib/retention-discount.ts`), porque
 * un código de Seal se repite en CADA cobro hasta que alguien lo quita.
 *
 * El obstáculo es el orden de llegada: en `orders/paid` Seal todavía no ha
 * creado la sub (en el #11724, la guarda preguntó a Seal 2 s después del pedido
 * y no había nada). Por eso se intenta desde tres sitios, y aplica el que llegue
 * cuando ya están las dos cosas, la fila y la sub:
 *
 *   1. `orders/paid`, justo después de guardar la fila (si Seal ya la tiene).
 *   2. El webhook de Seal (`subscription/created` y `/updated`).
 *   3. El cron diario `discovery-renewal-credit-sweep`, la red que no falla:
 *      la renovación más corta es a 15 días, así que siempre llega antes.
 *
 * ── Invariantes de dinero ──
 *
 * `PUT /subscription-discount-code` NO es idempotente: aplicarlo dos veces deja
 * dos entradas y descuenta 9,98 € (incidente BONUS5, 2026-05-28). Así que:
 *   - antes de aplicar se RECLAMA la fila (`pending_apply` → `applying`) con una
 *     escritura condicionada: de dos procesos a la vez, solo uno pasa;
 *   - antes de aplicar se mira si el código YA está en la sub;
 *   - un error al aplicar NO significa "no aplicado" (timeout ≠ no aplicado,
 *     incidente 2-oct): se relee la sub antes de decidir.
 * Y para retirarlo después del cobro se quitan TODAS las entradas del código
 * (en una sub de varias líneas sale una por línea).
 */

const TABLE = "discovery_set_coupons";

/** Una fila que lleva este rato en `applying` es de un proceso que murió a
 *  medias. El cron la resuelve mirando en Seal si el código llegó a ponerse. */
export const STALE_APPLYING_MS = 15 * 60 * 1000;

/** Si tras el cobro el código ya no se ve en la sub (lo más probable: Shopify lo
 *  soltó por su `recurringCycleLimit: 1`), se cierra la fila pasado este margen.
 *  Antes no, por si es una lectura de Seal a medias. */
const CLOSE_AFTER_CHARGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Si una fila sigue sin sub de Seal pasado este tiempo, algo raro pasa (el
 *  pedido no generó sub, o cambió el email) y tiene que verlo una persona. */
export const PENDING_APPLY_ALERT_MS = 2 * 24 * 60 * 60 * 1000;

export type ApplyResult =
  | "no-row" // no hay fila pendiente para ese pedido
  | "no-sub-yet" // Seal aún no ha creado la sub del pedido
  | "claimed-elsewhere" // otro proceso la está aplicando o ya la aplicó
  | "transient" // Seal no contestó: se reintenta en el siguiente disparo
  | "void" // la sub se canceló antes de aplicarlo
  | "rejected" // Seal rechazó el código: avisado por Slack
  | "unknown" // error al aplicar y no se pudo releer: lo resuelve el cron
  | "applied";

export type ConsumeResult =
  | "no-row"
  | "transient"
  | "no-charge-yet"
  | "removed"
  | "no-visible-code"
  | "closed-no-code";

interface RenewalRow {
  customer_id: string;
  order_id: string;
  discount_code: string;
  discount_code_id: string | null;
  seal_subscription_id: string | null;
  applied_at: string | null;
  updated_at: string;
  status: string;
}

const ROW_COLUMNS =
  "customer_id, order_id, discount_code, discount_code_id, seal_subscription_id, applied_at, updated_at, status";

// ============ Funciones puras (cubiertas por scripts/test-discovery-renewal-credit.ts) ============

/**
 * La sub de Seal que nació en `orderId`. Seal guarda el pedido de origen en
 * `order_id` (verificado 2026-10-09: sub 16797052 ↔ pedido 19117326958982).
 *
 * Un pedido con dos cadencias distintas crea dos subs con el mismo `order_id`.
 * El crédito es uno solo, así que va a la que se cobra ANTES (es "su siguiente
 * renovación"), y nunca a una cancelada.
 */
export function subBornFromOrder(
  subs: SealSubscription[],
  orderId: string,
): SealSubscription | null {
  const candidates = subs.filter(
    (s) => String(s.order_id ?? "") === orderId && s.status !== "CANCELLED",
  );
  if (candidates.length <= 1) return candidates[0] ?? null;
  const nextDate = (s: SealSubscription) => getNextBillingAttempt(s)?.date ?? "9999";
  return [...candidates].sort((a, b) => nextDate(a).localeCompare(nextDate(b)))[0];
}

/**
 * El primer cobro que ha entrado desde `sinceMs`: la renovación con descuento.
 * Un intento FALLIDO no cuenta, a diferencia del 15 % de retención: si se
 * retirara el código tras un fallo, el reintento de Seal cobraría sin los 4,99 €
 * que le debemos.
 */
export function firstChargeSince(
  s: SealSubscription,
  sinceMs: number,
): SealBillingAttempt | null {
  const charges = (s.billing_attempts ?? [])
    .filter(
      (ba) =>
        !!ba.completed_at &&
        ba.status !== "failed" &&
        Date.parse(ba.completed_at) >= sinceMs,
    )
    .sort((a, b) => a.completed_at.localeCompare(b.completed_at));
  return charges[0] ?? null;
}

// ============ Aplicar ============

/**
 * Aplica el crédito a `sub` si hay una fila `pending_apply` para el pedido del
 * que nació. Es lo que llama el webhook de Seal con la sub del evento.
 */
export async function applyDiscoveryRenewalCreditForSub(
  sub: SealSubscription,
): Promise<ApplyResult> {
  const orderId = String(sub.order_id ?? "");
  if (!orderId) return "no-row";
  const { data: row, error } = await supabaseAdmin()
    .from(TABLE)
    .select(ROW_COLUMNS)
    .eq("order_id", orderId)
    .eq("mode", "renewal")
    .eq("status", "pending_apply")
    .maybeSingle<RenewalRow>();
  if (error) throw new Error(`discovery-renewal-credit read: ${error.message}`);
  if (!row) return "no-row";
  return claimAndApply(row, sub);
}

/**
 * Busca en Seal la sub que nació en `orderId` y le aplica el crédito. Es lo que
 * llaman `orders/paid` (justo después de guardar la fila) y el cron.
 */
export async function applyDiscoveryRenewalCreditForOrder(
  orderId: string,
  email: string,
): Promise<ApplyResult> {
  const subs = await seal.getSubscriptionsByEmail(email);
  const sub = subBornFromOrder(subs, orderId);
  if (!sub) return "no-sub-yet";
  return applyDiscoveryRenewalCreditForSub(sub);
}

async function claimAndApply(row: RenewalRow, sub: SealSubscription): Promise<ApplyResult> {
  const sb = supabaseAdmin();
  const claimedAt = new Date().toISOString();

  // ── Reclamar. De dos procesos a la vez (webhook de Seal + orders/paid, o un
  // webhook duplicado) solo uno ve la fila en `pending_apply`. El otro sale.
  const { data: claimed, error: claimErr } = await sb
    .from(TABLE)
    .update({ status: "applying", seal_subscription_id: String(sub.id), updated_at: claimedAt })
    .eq("customer_id", row.customer_id)
    .eq("mode", "renewal")
    .eq("status", "pending_apply")
    .select("customer_id");
  if (claimErr) throw new Error(`discovery-renewal-credit claim: ${claimErr.message}`);
  if (!claimed?.length) return "claimed-elsewhere";

  // A partir de aquí la fila es nuestra y TODA salida la deja coherente.
  const release = () =>
    sb
      .from(TABLE)
      .update({ status: "pending_apply", seal_subscription_id: null, updated_at: new Date().toISOString() })
      .eq("customer_id", row.customer_id)
      .eq("status", "applying")
      .eq("updated_at", claimedAt);

  // Estado fresco: el payload de un webhook puede ser una foto a medias.
  const fresh = await seal.getSubscriptionById(sub.id).catch(() => null);
  if (!fresh) {
    await release();
    return "transient";
  }

  if (fresh.status === "CANCELLED") {
    await sb
      .from(TABLE)
      .update({ status: "void", updated_at: new Date().toISOString() })
      .eq("customer_id", row.customer_id)
      .eq("status", "applying")
      .eq("updated_at", claimedAt);
    alertSlackError({
      path: "lib/discovery-renewal-credit",
      code: "discovery_credit_sub_cancelled",
      msg: `Discovery + suscripción (pedido ${row.order_id}): la sub ${fresh.id} está CANCELADA antes de aplicarle los 4,99 €. No se aplica. Si se reactiva, aplicar a mano el código ${row.discount_code}.`,
      customerId: row.customer_id,
    });
    return "void";
  }

  // ¿Ya está puesto? Un intento anterior pudo aplicarlo y morir antes de
  // apuntarlo. Aplicar otra vez lo DUPLICARÍA.
  let ids = findAllAppliedDiscountCodeIds(fresh, row.discount_code);
  if (ids.length === 0) {
    try {
      await seal.applyDiscountCode(fresh.id, row.discount_code);
    } catch (err) {
      // Error ≠ no aplicado. Releer antes de decidir nada.
      const again = await seal.getSubscriptionById(fresh.id).catch(() => null);
      const seen = again ? findAllAppliedDiscountCodeIds(again, row.discount_code) : [];
      if (seen.length > 0) {
        ids = seen;
      } else if (again) {
        // Seal lo ve sin el código: el rechazo es real. Se libera para que el
        // cron lo reintente, y se avisa porque probablemente no se arregla solo.
        await release();
        alertSlackError({
          path: "lib/discovery-renewal-credit",
          code: "discovery_credit_apply_rejected",
          msg: `No se pudo aplicar el crédito Discovery ${row.discount_code} a la sub ${fresh.id} (pedido ${row.order_id}): ${err instanceof Error ? err.message : String(err)}. El cron lo reintentará cada día.`,
          customerId: row.customer_id,
        });
        return "rejected";
      } else {
        // No sabemos si entró. Se deja en `applying`: pasado STALE_APPLYING_MS
        // el cron mira la sub y decide. Liberarla aquí arriesgaría un doble apply.
        alertSlackError({
          path: "lib/discovery-renewal-credit",
          code: "discovery_credit_apply_unknown",
          msg: `Crédito Discovery ${row.discount_code} → sub ${fresh.id}: el apply falló y Seal no deja releer. Queda en 'applying'; el cron lo resolverá. Error: ${err instanceof Error ? err.message : String(err)}`,
          customerId: row.customer_id,
        });
        return "unknown";
      }
    }
  }

  // Capturar el UUID para poder retirarlo. Si Seal aún no lo enseña se guarda
  // NULL: el consumidor lo vuelve a buscar por código.
  let after: SealSubscription | null = fresh;
  if (ids.length === 0) {
    after = await seal.getSubscriptionById(fresh.id).catch(() => null);
    ids = after ? findAllAppliedDiscountCodeIds(after, row.discount_code) : [];
  }

  const appliedAt = new Date().toISOString();
  const { error: markErr } = await sb
    .from(TABLE)
    .update({
      status: "pending_charge",
      applied_at: appliedAt,
      discount_code_id: ids[0] ?? null,
      updated_at: appliedAt,
    })
    .eq("customer_id", row.customer_id)
    .eq("status", "applying")
    .eq("updated_at", claimedAt);
  if (markErr) {
    // El código YA está en Seal. Si no queda apuntado, nadie lo retiraría tras
    // el cobro: tiene que verlo una persona.
    alertSlackError({
      path: "lib/discovery-renewal-credit",
      code: "discovery_credit_mark_failed",
      msg: `Crédito Discovery ${row.discount_code} APLICADO a la sub ${fresh.id} pero la fila no se pudo marcar (${markErr.message}). Revisar discovery_set_coupons del cliente ${row.customer_id}.`,
      customerId: row.customer_id,
    });
  }

  console.log("[discovery-renewal-credit] applied", {
    customerId: row.customer_id,
    sealSubId: fresh.id,
    orderId: row.order_id,
  });
  await notifyCreditApplied(row, after ?? fresh);
  return "applied";
}

/**
 * Evento de Klaviyo para avisar al cliente de que la renovación saldrá 4,99 €
 * más barata. Mientras no haya un flow colgado de esta métrica no manda nada;
 * existe para poder montarlo sin tocar código. Best-effort: un fallo aquí no
 * deshace el crédito.
 */
async function notifyCreditApplied(row: RenewalRow, sub: SealSubscription): Promise<void> {
  if (!sub.email) return;
  const next = getNextBillingAttempt(sub);
  await klaviyo
    .trackEvent(
      "Discovery Set Renewal Credit",
      sub.email,
      {
        discount_value: DISCOVERY_DISCOUNT_VALUE_EUR,
        next_charge_date: next?.date ?? null,
        // Ya formateada ("23 de noviembre"): el filtro |date de Klaviyo sobre un
        // string sale en blanco en silencio.
        next_charge_label: next ? formatShipDateEs(next.date) : "",
        order_id: row.order_id,
        seal_subscription_id: String(sub.id),
        first_name: sub.first_name,
      },
      { uniqueId: `discovery-credit-${row.customer_id}`, externalId: row.customer_id },
    )
    .catch((err) => console.warn("[discovery-renewal-credit] klaviyo event failed", err));
}

/**
 * Una fila que se quedó en `applying` (proceso muerto a medias). Mira en Seal si
 * el código llegó a ponerse: si está, la da por aplicada; si no, la libera para
 * que se aplique de nuevo. Solo la llama el cron, y solo pasado STALE_APPLYING_MS.
 */
export async function recoverStaleApplying(customerId: string): Promise<"recovered" | "released" | "transient" | "no-row"> {
  const sb = supabaseAdmin();
  const { data: row } = await sb
    .from(TABLE)
    .select(ROW_COLUMNS)
    .eq("customer_id", customerId)
    .eq("mode", "renewal")
    .eq("status", "applying")
    .maybeSingle<RenewalRow>();
  if (!row) return "no-row";
  if (Date.now() - Date.parse(row.updated_at) < STALE_APPLYING_MS) return "no-row";

  const subId = Number(row.seal_subscription_id);
  const fresh = subId ? await seal.getSubscriptionById(subId).catch(() => null) : null;
  if (subId && !fresh) return "transient";

  const ids = fresh ? findAllAppliedDiscountCodeIds(fresh, row.discount_code) : [];
  const now = new Date().toISOString();
  if (ids.length > 0) {
    // Entró. `applied_at` = la hora del reclamo, que es cuando se aplicó de
    // verdad: el consumidor espera un cobro POSTERIOR a esa hora.
    await sb
      .from(TABLE)
      .update({ status: "pending_charge", applied_at: row.updated_at, discount_code_id: ids[0], updated_at: now })
      .eq("customer_id", customerId)
      .eq("status", "applying")
      .eq("updated_at", row.updated_at);
    return "recovered";
  }
  await sb
    .from(TABLE)
    .update({ status: "pending_apply", seal_subscription_id: null, updated_at: now })
    .eq("customer_id", customerId)
    .eq("status", "applying")
    .eq("updated_at", row.updated_at);
  return "released";
}

// ============ Retirar tras el cobro ============

/**
 * Retira el código de la sub una vez cobrada la renovación con descuento.
 * Idempotente; mismo contrato que `consumeRetentionDiscountIfCharged`:
 *   - sin fila pending_charge                 → "no-row"
 *   - Seal no contesta                        → "transient"
 *   - aún no ha habido cobro desde applied_at → "no-charge-yet" (se le debe)
 *   - cobrado y el código se ve               → se quitan TODAS sus entradas → "removed"
 *   - cobrado y no se ve, reciente            → se deja → "no-visible-code"
 *   - cobrado y no se ve hace > 7 días        → se cierra → "closed-no-code"
 *
 * LIMITACIÓN CONOCIDA: si antes de la renovación el cliente cambia de plan o de
 * sabor (add_items + remove_items), Seal puede dejar el código "invisible" a
 * nivel de sub (feedback_seal_discount_code_after_swap). La ruta de plan solo
 * reengancha el código de RETENCIÓN, no este. El tope de Shopify
 * (`recurringCycleLimit: 1`, `usageLimit: 1`) es la red en ese caso.
 */
export async function consumeDiscoveryRenewalCreditIfCharged(
  sealSubId: number | string,
): Promise<ConsumeResult> {
  const sb = supabaseAdmin();
  const { data: row, error } = await sb
    .from(TABLE)
    .select(ROW_COLUMNS)
    .eq("seal_subscription_id", String(sealSubId))
    .eq("mode", "renewal")
    .eq("status", "pending_charge")
    .maybeSingle<RenewalRow>();
  if (error) throw new Error(`discovery-renewal-credit consume read: ${error.message}`);
  if (!row) return "no-row";

  const fresh = await seal.getSubscriptionById(Number(sealSubId));
  if (!fresh) return "transient";

  const appliedAtMs = row.applied_at ? Date.parse(row.applied_at) : 0;
  const charge = firstChargeSince(fresh, appliedAtMs);
  if (!charge) return "no-charge-yet";

  // Cierre condicionado por estado y por updated_at, como en retención: si
  // otro proceso tocó la fila desde que la leímos, no se pisa.
  const closeRow = () =>
    sb
      .from(TABLE)
      .update({ status: "removed", removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("customer_id", row.customer_id)
      .eq("status", "pending_charge")
      .eq("updated_at", row.updated_at);

  const ids = findAllAppliedDiscountCodeIds(fresh, row.discount_code);
  if (ids.length > 0) {
    for (const id of ids) {
      await seal.removeDiscountCode(fresh.id, id);
    }
    await closeRow();
    console.log("[discovery-renewal-credit] removed after first charge", {
      sealSubId,
      entries: ids.length,
    });
    return "removed";
  }

  if (Date.now() - Date.parse(charge.completed_at) > CLOSE_AFTER_CHARGE_MS) {
    await closeRow();
    console.log("[discovery-renewal-credit] charged, code no longer on the sub; row closed", { sealSubId });
    return "closed-no-code";
  }
  return "no-visible-code";
}

// ============ Al tocar las líneas de la sub (cambio de plan/sabor, reparación) ============
//
// Seal arrastra un código de descuento, INVISIBLE, de una línea que se quita a otra que
// se añade (incidente 2026-06-02, ver `seal.addItems`): sigue descontando, pero ya no sale
// en `item.discount_codes`, así que el consumidor no lo encuentra para retirarlo y los
// 4,99 € se repetirían en CADA envío. Quien toca líneas hace con este crédito lo mismo que
// con el 15 % de retención: lo suelta antes (todas sus entradas) y lo repone después con
// `ensureDiscoveryCreditAttached`.

/** El crédito Discovery pendiente de cobro de esta sub, o null. Lanza si la lectura falla:
 *  quien llama decide qué hacer (la ruta del plan avisa; el cron no toca la línea). */
export async function pendingDiscoveryCreditForSub(
  subId: number | string,
): Promise<{ customerId: string; code: string; codeId: string | null } | null> {
  const { data, error } = await supabaseAdmin()
    .from(TABLE)
    .select("customer_id, discount_code, discount_code_id")
    .eq("seal_subscription_id", String(subId))
    .eq("mode", "renewal")
    .eq("status", "pending_charge")
    .maybeSingle<{ customer_id: string; discount_code: string; discount_code_id: string | null }>();
  if (error) throw new Error(`discovery-renewal-credit pending read: ${error.message}`);
  return data
    ? { customerId: String(data.customer_id), code: data.discount_code, codeId: data.discount_code_id }
    : null;
}

export type EnsureAttachedResult = "attached" | "not-owed" | "lost";

/**
 * Deja el crédito puesto UNA vez después de tocar las líneas, y la fila apuntando a su
 * UUID vivo. Es el gemelo de `ensureRetentionDiscount` (cron) y de
 * `reattachRetentionDiscountNow` (ruta del plan), con una guarda más, porque aquí la
 * promesa es "solo el siguiente envío":
 *
 *   - Solo se repone si se le SIGUE DEBIENDO: fila en `pending_charge` y ningún cobro
 *     con éxito desde `applied_at`. Si la renovación se cobró mientras se tocaban las
 *     líneas, reponerlo descontaría OTRO envío: se quita lo que haya y se cierra la fila.
 *   - Mira antes de poner: si el código sigue visible no se aplica encima (sería doble).
 *   - Error al aplicar ≠ no aplicado: se decide releyendo.
 *   - Si la fila cambia entre la lectura y la escritura (un consumidor la cerró porque
 *     entró el cobro), se quita lo repuesto.
 *
 * Nunca lanza: los fallos acaban en un aviso de Slack con lo que hay que mirar a mano.
 */
export async function ensureDiscoveryCreditAttached(
  subId: number,
  code: string,
  path: string,
): Promise<EnsureAttachedResult> {
  const sb = supabaseAdmin();
  let customerId: string | undefined;
  try {
    const { data: row, error } = await sb
      .from(TABLE)
      .select(ROW_COLUMNS)
      .eq("seal_subscription_id", String(subId))
      .eq("mode", "renewal")
      .maybeSingle<RenewalRow>();
    if (error) throw new Error(`lectura de la fila: ${error.message}`);
    customerId = row?.customer_id;

    let fresh = await seal.getSubscriptionById(subId);
    if (!fresh) throw new Error("no se pudo releer la sub");
    let ids = findAllAppliedDiscountCodeIds(fresh, code);

    const appliedAtMs = row?.applied_at ? Date.parse(row.applied_at) : 0;
    const owed = !!row && row.status === "pending_charge" && !firstChargeSince(fresh, appliedAtMs);
    if (!owed) {
      for (const id of ids) await seal.removeDiscountCode(subId, id);
      if (row && row.status === "pending_charge") {
        const now = new Date().toISOString();
        await sb
          .from(TABLE)
          .update({ status: "removed", removed_at: now, updated_at: now })
          .eq("customer_id", row.customer_id)
          .eq("status", "pending_charge")
          .eq("updated_at", row.updated_at);
      }
      console.log("[discovery-renewal-credit] not owed after a line change, not re-applied", { subId, removed: ids.length });
      return "not-owed";
    }

    if (!ids.length) {
      try {
        await seal.applyDiscountCode(subId, code);
      } catch (e) {
        console.warn("[discovery-renewal-credit] re-apply errored, re-reading", { subId, msg: e instanceof Error ? e.message : String(e) });
      }
      fresh = await seal.getSubscriptionById(subId);
      ids = fresh ? findAllAppliedDiscountCodeIds(fresh, code) : [];
    }
    if (!ids.length) {
      alertSlackError({
        path,
        code: "discovery_credit_lost",
        msg: `sub ${subId}: se soltó el crédito Discovery ${code} para tocar las líneas y no se pudo reponer. Ponerlo a mano en Seal (UNA vez); la fila de discovery_set_coupons sigue en pending_charge.`,
        customerId,
      });
      return "lost";
    }

    const { data: updated, error: upErr } = await sb
      .from(TABLE)
      .update({ discount_code_id: ids[0], updated_at: new Date().toISOString() })
      .eq("customer_id", row!.customer_id)
      .eq("status", "pending_charge")
      .select("customer_id");
    if (upErr) {
      alertSlackError({
        path,
        code: "discovery_credit_track_failed",
        msg: `sub ${subId}: crédito Discovery ${code} repuesto, pero la fila no se actualizó (${upErr.message}). El consumidor lo busca por código; revisar discovery_set_coupons.`,
        customerId,
      });
    } else if (!updated?.length) {
      // La fila dejó de estar pendiente entre medias: el cobro entró. Lo repuesto sobra.
      for (const id of ids) await seal.removeDiscountCode(subId, id);
      console.log("[discovery-renewal-credit] row closed meanwhile, re-applied credit removed", { subId });
      return "not-owed";
    }
    console.log("[discovery-renewal-credit] re-attached after a line change", { subId, entries: ids.length });
    return "attached";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    alertSlackError({
      path,
      code: "discovery_credit_lost",
      msg: `sub ${subId}: no se pudo comprobar o reponer el crédito Discovery ${code} tras tocar las líneas (${msg}). Mirar en Seal que está puesto UNA vez y que discovery_set_coupons apunta a su UUID.`,
      customerId,
    });
    return "lost";
  }
}

// ============ Entrada desde el webhook de Seal ============

/**
 * Lo que llama el webhook de Seal con la sub del evento: aplica si había crédito
 * pendiente para el pedido del que nació, y retira si ya se cobró. NUNCA lanza:
 * el cron diario es la red, y un fallo aquí no puede tumbar el webhook (en
 * `subscription/created` la reserva no se libera y no habría reintento).
 */
export async function discoveryRenewalCreditOnSealEvent(
  sub: SealSubscription | null | undefined,
): Promise<void> {
  if (!sub?.id) return;
  try {
    await applyDiscoveryRenewalCreditForSub(sub);
  } catch (e) {
    console.error("[discovery-renewal-credit] apply on seal event failed (cron will retry)", {
      sealSubId: sub.id,
      msg: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    await consumeDiscoveryRenewalCreditIfCharged(sub.id);
  } catch (e) {
    console.error("[discovery-renewal-credit] consume on seal event failed (cron will retry)", {
      sealSubId: sub.id,
      msg: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Aviso de «3 días en el punto de recogida» (SUB-08, 2026-10-20).
 *
 * Cuando un pedido de la tarifa «GLS Punto de Recogida» lleva 3 días en el punto
 * sin que nadie lo recoja, se manda `pickup_point_reminder` a Klaviyo, una sola vez
 * por pedido. Lo dispara el flow `SDjGuF` de CRM (email y WhatsApp), que solo arranca
 * con `daysAtPickup` = 3 como NÚMERO.
 *
 * ── De dónde sale cada dato ──
 * - Los pedidos: Shopify, por la tarifa de envío. Son unos 30 al mes, de envíos
 *   recurrentes y de compras sueltas por igual.
 * - El punto: la dirección de envío del pedido, que es la del punto (`company` =
 *   «PS COPISTERIA BCN», «GLS Locker 24/7 …»). Es el mismo nombre que enseña GLS.
 * - Si espera en el punto: Hive (lib/hive.ts), con `delivery_status` =
 *   `awaiting_customer_pickup`. LIT no tiene cuenta propia de Sendcloud ni de GLS:
 *   las etiquetas las saca Hive.
 *
 * ── Lo que se comprobó contra el seguimiento de GLS (20-oct) ──
 * 33 envíos de la tarifa desde el 21-sep. Hive acierta con todos los que esperan,
 * pero a veces no se entera de la recogida: 3 de los 18 recogidos seguían como
 * `awaiting_customer_pickup` (los mismos 3 sin `deliveredAt` en Shopify, que lo
 * escribe Hive). No hay otra fuente para cazarlos, así que el email lleva «Si ya lo
 * has recogido, ignora este mensaje» (Juan, 20-oct). Los que llevan colgados más de
 * MAX_DAYS no se avisan: a esas alturas, o se recogió o el punto ya lo devolvió.
 *
 * ── Días ──
 * Hive no guarda la hora de llegada al punto, solo `updated_at`, la de su última
 * actualización: en los 4 que esperaban de verdad el 20-oct caía entre media hora y
 * dos horas y media después de la llegada que da GLS, el mismo día. Si Hive volviera a tocar el envío sin cambiar
 * de estado, la cuenta empezaría de nuevo: el aviso saldría más tarde, nunca antes.
 * Se cuentan días naturales de Madrid: un paquete que llega el jueves cuenta 3 días
 * el domingo, sea la hora que sea, y el cron diario lo avisa esa mañana. Si el cron lo
 * ve más tarde, se manda igual con 3, que es lo único con lo que arranca el flow.
 *
 * El envío va detrás de PICKUP_REMINDER (lib/flags.ts), apagado por defecto: apagado,
 * el cron dice en Slack lo que mandaría.
 */

import { klaviyo } from "@/lib/klaviyo";
import { pickupReminderScope } from "@/lib/flags";
import { getHiveShipmentsByOrderIds, hiveConfigured, type HiveShipment } from "@/lib/hive";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { customerLocale } from "@/lib/sub-event-props";
import { supabaseAdmin } from "@/lib/supabase";

export const PICKUP_REMINDER_TEMPLATE = "pickup_reminder";

const DAY = 24 * 60 * 60 * 1000;
export const REMIND_AFTER_DAYS = 3;
export const MAX_DAYS = 10;
/** Pedidos de hasta hace tantos días. Un punto de GLS guarda el paquete una semana o dos. */
const LOOKBACK_DAYS = 35;
const MAX_PER_RUN = 40;

// ── Reglas puras ─────────────────────────────────────────────────────────────

/** ¿El pedido va a un punto de recogida? Por el título de su línea de envío. */
export function isPickupShipping(titles: Array<string | null | undefined>): boolean {
  return titles.some((t) => /punto de recogida/i.test(t ?? ""));
}

/**
 * ¿Este envío de Hive va a un punto de GLS? Si Hive mandó el pedido con otro
 * transportista (pasó con #11596, por CTT), el punto de la dirección no es donde está
 * el paquete, y el email diría un sitio que no es.
 */
export function isGlsPickupShipment(s: Pick<HiveShipment, "shipment_provider" | "shipping_method">): boolean {
  return /parcel\s*point/i.test(s.shipping_method ?? "") || /^gls/i.test(s.shipment_provider ?? "");
}

export type PickupState =
  | { state: "waiting"; arrivedAt: string }
  | { state: "collected"; collectedAt: string }
  | { state: "returned"; at: string }
  | { state: "not_at_point" };

/** Dónde está el paquete según Hive. */
export function pickupState(
  s: Pick<HiveShipment, "delivery_status" | "delivered_at" | "updated_at">,
): PickupState {
  if (s.delivered_at || s.delivery_status === "delivered") {
    return { state: "collected", collectedAt: s.delivered_at ?? s.updated_at };
  }
  if (s.delivery_status === "returned_to_sender" || s.delivery_status === "return_initiated") {
    return { state: "returned", at: s.updated_at };
  }
  if (s.delivery_status === "awaiting_customer_pickup") return { state: "waiting", arrivedAt: s.updated_at };
  return { state: "not_at_point" };
}

const madridDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Días naturales de Madrid entre dos instantes: del jueves 23:59 al viernes 00:01 es 1. */
export function madridDaysBetween(fromIso: string, now: number): number {
  const a = madridDay.format(new Date(fromIso));
  const b = madridDay.format(new Date(now));
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

/**
 * Nombre del punto para el email. GLS antepone «PS » (parcel shop) y, en los de su
 * red, «PS GLS DIS »: es su código, no el nombre de la tienda. El resto se deja como
 * viene, mayúsculas incluidas, porque es como lo rotula GLS en su seguimiento.
 */
export function pickupName(company: string | null | undefined): string {
  const raw = (company ?? "").replace(/\s+/g, " ").trim();
  const name = raw.replace(/^PS\s+(GLS\s+DIS\s+)?/i, "").trim();
  return name || raw;
}

function cleanPart(s: string | null | undefined): string {
  // «Carrer Entença 30 lc 6 -», «Rúa Poeta Manuel María  - bajo -»: GLS rellena con guiones.
  return (s ?? "").replace(/\s+/g, " ").replace(/[\s,-]+$/, "").trim();
}

/** «Calle Mayor 5, 28013 Madrid». */
export function pickupAddress(a: {
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  city?: string | null;
}): string {
  const street = [cleanPart(a.address1), cleanPart(a.address2)].filter(Boolean).join(", ");
  const town = [cleanPart(a.zip), cleanPart(a.city)].filter(Boolean).join(" ");
  return [street, town].filter(Boolean).join(", ");
}

/** Lo que decide el cron por envío. Pura, para poder probarla con datos reales. */
export function decideReminder(input: {
  state: PickupState;
  shopifyDeliveredAt: string | null;
  now: number;
}): { send: true; arrivedAt: string; days: number } | { send: false; why: string } {
  if (input.shopifyDeliveredAt) return { send: false, why: "recogido_segun_shopify" };
  const s = input.state;
  if (s.state === "collected") return { send: false, why: "recogido" };
  if (s.state === "returned") return { send: false, why: "devuelto" };
  if (s.state === "not_at_point") return { send: false, why: "no_esta_en_el_punto" };
  const days = madridDaysBetween(s.arrivedAt, input.now);
  if (days < REMIND_AFTER_DAYS) return { send: false, why: "aun_no_3_dias" };
  if (days > MAX_DAYS) return { send: false, why: "demasiado_tarde" };
  return { send: true, arrivedAt: s.arrivedAt, days };
}

// ── El cron ──────────────────────────────────────────────────────────────────

interface ShopifyPickupOrder {
  legacyResourceId: string;
  name: string;
  email: string | null;
  customer: { legacyResourceId: string } | null;
  shippingLines: { nodes: Array<{ title: string | null }> };
  shippingAddress: {
    company: string | null;
    address1: string | null;
    address2: string | null;
    zip: string | null;
    city: string | null;
  } | null;
  fulfillments: Array<{
    createdAt: string;
    deliveredAt: string | null;
    status: string;
    trackingInfo: Array<{ number: string | null; url: string | null; company: string | null }>;
  }>;
}

const PICKUP_ORDERS_QUERY = `query pickupOrders($q: String!, $after: String) {
  orders(first: 50, query: $q, after: $after, sortKey: CREATED_AT, reverse: true) {
    nodes {
      legacyResourceId
      name
      email
      customer { legacyResourceId }
      shippingLines(first: 5) { nodes { title } }
      shippingAddress { company address1 address2 zip city }
      fulfillments(first: 5) {
        createdAt
        deliveredAt
        status
        trackingInfo(first: 3) { number url company }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function listPickupOrders(now: number): Promise<ShopifyPickupOrder[]> {
  const since = new Date(now - LOOKBACK_DAYS * DAY).toISOString().slice(0, 10);
  // La búsqueda por texto sí discrimina (comprobado el 20-oct: 38 pedidos con la
  // frase, 0 con una inventada). Aun así se vuelve a mirar la línea de envío abajo.
  const q = `created_at:>=${since} "Punto de Recogida"`;
  const out: ShopifyPickupOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: {
      orders: { nodes: ShopifyPickupOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } = await shopifyAdmin.graphql(PICKUP_ORDERS_QUERY, { q, after });
    out.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage || !data.orders.pageInfo.endCursor) break;
    after = data.orders.pageInfo.endCursor;
  }
  return out.filter((o) => isPickupShipping(o.shippingLines.nodes.map((n) => n.title)));
}

export interface PickupReminderTally {
  hive: boolean;
  mode: "off" | "allowlist" | "on";
  orders: number;
  notified: number;
  skipped: Record<string, number>;
  failed: number;
  /** Lo que se manda, o se mandaría con el flag encendido o sin dry run. */
  preview: Array<{
    orderNumber: string;
    trackingNumber: string;
    pickupName: string;
    arrivedAt: string;
    days: number;
    sent: boolean;
  }>;
}

export async function runPickupReminders(opts: { dryRun?: boolean; now?: number } = {}): Promise<PickupReminderTally> {
  const now = opts.now ?? Date.now();
  const scope = pickupReminderScope();
  const tally: PickupReminderTally = {
    hive: hiveConfigured(),
    mode: scope.mode,
    orders: 0,
    notified: 0,
    skipped: {},
    failed: 0,
    preview: [],
  };
  const skip = (why: string) => (tally.skipped[why] = (tally.skipped[why] ?? 0) + 1);
  if (!tally.hive) return tally;

  const orders = await listPickupOrders(now);
  tally.orders = orders.length;
  if (orders.length === 0) return tally;

  // Los ya avisados. Si esta lectura falla se para todo: un set vacío volvería a
  // avisar a todos (el uniqueId de Klaviyo frenaría el email, pero no la fila).
  const sb = supabaseAdmin();
  const { data: sent, error: sentErr } = await sb
    .from("email_logs")
    .select("metadata")
    .eq("template_id", PICKUP_REMINDER_TEMPLATE)
    .gte("sent_at", new Date(now - (LOOKBACK_DAYS + 30) * DAY).toISOString());
  if (sentErr) throw new Error(`email_logs: ${sentErr.message}`);
  const done = new Set(
    ((sent ?? []) as Array<{ metadata: { orderId?: string } | null }>).map((r) => String(r.metadata?.orderId ?? "")),
  );

  // Una sola consulta a Hive para todos los pendientes (50 pedidos por petición).
  const pending = orders.filter((o) => {
    if (done.has(o.legacyResourceId)) {
      skip("ya_avisado");
      return false;
    }
    if (o.fulfillments.length === 0) {
      skip("sin_enviar");
      return false;
    }
    return true;
  });
  if (pending.length === 0) return tally;
  const byOrder = new Map<string, HiveShipment[]>();
  for (const s of await getHiveShipmentsByOrderIds(pending.map((o) => o.legacyResourceId))) {
    const list = byOrder.get(String(s.merchant_order_id)) ?? [];
    list.push(s);
    byOrder.set(String(s.merchant_order_id), list);
  }

  let processed = 0;
  for (const order of pending) {
    const shipments = (byOrder.get(order.legacyResourceId) ?? []).filter(
      (s) => s.status === "shipped" && s.tracking_number,
    );
    if (shipments.length === 0) {
      skip("no_esta_en_hive");
      continue;
    }

    // Un paquete por pedido en la práctica; si hubiera varios, basta uno esperando.
    let hit: { arrivedAt: string; days: number; trackingNumber: string; trackingUrl: string | null } | null = null;
    let why = "no_es_de_gls";
    for (const s of shipments) {
      if (!isGlsPickupShipment(s)) continue;
      const fulfillment = order.fulfillments.find((f) => f.trackingInfo.some((t) => t.number === s.tracking_number));
      const decision = decideReminder({
        state: pickupState(s),
        shopifyDeliveredAt: fulfillment?.deliveredAt ?? null,
        now,
      });
      if (decision.send) {
        hit = {
          arrivedAt: decision.arrivedAt,
          days: decision.days,
          trackingNumber: s.tracking_number!,
          trackingUrl:
            fulfillment?.trackingInfo.find((t) => t.number === s.tracking_number)?.url ?? s.tracking_url ?? null,
        };
        break;
      }
      why = decision.why;
    }
    if (!hit) {
      skip(why);
      continue;
    }
    if (processed >= MAX_PER_RUN) {
      skip("tope_por_tirada");
      continue;
    }
    processed++;

    const addr = order.shippingAddress;
    const name = pickupName(addr?.company);
    const address = addr ? pickupAddress(addr) : "";
    if (!name || !address) {
      // El email pinta los dos: sin ellos, mejor no mandarlo.
      skip("sin_datos_del_punto");
      continue;
    }
    const email = (order.email ?? "").trim();
    if (!email) {
      skip("sin_email");
      continue;
    }
    const customerId = order.customer?.legacyResourceId ?? null;
    const allowed =
      scope.mode === "on" || (scope.mode === "allowlist" && !!customerId && scope.ids.includes(customerId));
    const willSend = !opts.dryRun && allowed;
    tally.preview.push({
      orderNumber: order.name,
      trackingNumber: hit.trackingNumber,
      pickupName: name,
      arrivedAt: hit.arrivedAt,
      days: hit.days,
      sent: willSend,
    });
    if (!willSend) {
      skip(opts.dryRun ? "dry_run" : scope.mode === "off" ? "flag_apagado" : "fuera_de_la_lista");
      continue;
    }

    try {
      await klaviyo.trackEvent(
        "pickup_point_reminder",
        email,
        {
          orderNumber: order.name,
          trackingNumber: hit.trackingNumber,
          ...(hit.trackingUrl ? { trackingUrl: hit.trackingUrl } : {}),
          pickupName: name,
          pickupAddress: address,
          // Siempre 3 y como número: el flow solo arranca con eso.
          daysAtPickup: REMIND_AFTER_DAYS,
          pickupArrivedAt: hit.arrivedAt,
          locale: await customerLocale(customerId),
        },
        {
          uniqueId: `pickup:${order.legacyResourceId}`,
          ...(customerId ? { externalId: customerId } : {}),
        },
      );
    } catch (err) {
      console.warn("[pickup-reminder] Klaviyo falló; mañana se reintenta", {
        order: order.name,
        msg: err instanceof Error ? err.message : String(err),
      });
      tally.failed++;
      tally.preview[tally.preview.length - 1]!.sent = false;
      continue;
    }
    const { error: logErr } = await sb.from("email_logs").insert({
      customer_id: customerId ?? `order:${order.legacyResourceId}`,
      template_id: PICKUP_REMINDER_TEMPLATE,
      metadata: {
        orderId: order.legacyResourceId,
        orderNumber: order.name,
        trackingNumber: hit.trackingNumber,
        arrivedAt: hit.arrivedAt,
        daysAtDetection: hit.days,
      },
    });
    if (logErr) {
      // El uniqueId de Klaviyo evita el doble email aunque esto falle.
      console.error("[pickup-reminder] avisado pero sin fila en email_logs", { order: order.name, msg: logErr.message });
    }
    tally.notified++;
  }
  return tally;
}

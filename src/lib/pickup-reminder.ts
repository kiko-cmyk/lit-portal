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
 * - Llegada y recogida: el seguimiento de Sendcloud (lib/sendcloud.ts). Shopify no
 *   tiene la llegada, y su `deliveredAt` (que es la recogida) falta a veces; aun
 *   así, si lo tiene, el pedido ya está recogido y no se avisa.
 *
 * ── Lo que se comprobó antes de escribir esto (20-oct) ──
 * En el seguimiento de GLS de 32 pedidos de la tarifa desde el 21-sep, el transportista
 * distingue siempre «Deposited in PS …» (llega al punto) de «Delivered» (lo recoge el
 * cliente). De los 22 que llegaron al punto, uno tardó 4 días en recogerse y dos
 * esperaban con 3 y 4 días. Lo que falta por ver con las claves es cómo traduce
 * Sendcloud esos dos estados a `phase`; se espera `pup` y `delivered`. Si Sendcloud
 * no diera `pup`, esto no manda nada: sin llegada al punto no hay aviso. Por eso el
 * envío va detrás de PICKUP_REMINDER (lib/flags.ts), apagado por defecto: el cron
 * dice lo que mandaría y se compara con GLS antes de encenderlo.
 *
 * ── Días ──
 * Días naturales de Madrid entre la llegada al punto y hoy. Un paquete que llega el
 * jueves a las 11:00 cuenta 3 días el domingo, sea la hora que sea, y el cron diario
 * lo avisa esa mañana. Si el cron lo detecta más tarde, se manda igual con 3 (el
 * flow solo arranca con 3), salvo que pasen de MAX_DAYS: a esas alturas el punto ya
 * lo está devolviendo y el email llegaría tarde.
 */

import { klaviyo } from "@/lib/klaviyo";
import { pickupReminderScope } from "@/lib/flags";
import { getSendcloudTracking, sendcloudConfigured, type SendcloudTrackingEvent } from "@/lib/sendcloud";
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

export type PickupState =
  | { state: "waiting"; arrivedAt: string }
  | { state: "collected"; arrivedAt: string | null; collectedAt: string }
  | { state: "returned"; at: string }
  | { state: "not_at_point" };

/** El paquete se ha movido: sale del punto. Si vuelve a `pup`, la espera empieza de nuevo. */
const MOVING_PHASES = new Set(["dropped", "accepted", "sorted", "in_transit", "customs", "in_delivery", "attempted"]);
/** Ya no se puede recoger: devuelto, rechazado o anulado. */
const GONE_EXCEPTIONS = new Set([
  "dropoff_expiration",
  "returned_sender",
  "refused",
  "cancelled",
  "cancelled_upstream",
]);

/**
 * Dónde está el paquete según los eventos de Sendcloud, en el orden en que pasaron.
 *
 * Las excepciones que no lo sacan del punto no cambian nada: `off_radar` («sin
 * novedades en días») es justo lo que pasa mientras espera, y `pup_expiration`
 * («se acaba el plazo de recogida») dice que sigue allí.
 */
export function pickupState(events: SendcloudTrackingEvent[]): PickupState {
  const sorted = events
    .filter((e) => e && e.event_type !== "claim" && typeof e.event_at === "string")
    .slice()
    .sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
  let state: PickupState = { state: "not_at_point" };
  let arrivedAt: string | null = null;
  for (const e of sorted) {
    const phase = (e.phase ?? "").toLowerCase();
    const exception = (e.exception ?? "").toLowerCase();
    if (phase === "delivered" || phase === "delivery_forced") {
      state = { state: "collected", arrivedAt, collectedAt: e.event_at };
    } else if (GONE_EXCEPTIONS.has(exception)) {
      state = { state: "returned", at: e.event_at };
      arrivedAt = null;
    } else if (phase === "pup" || exception === "pup_expiration") {
      if (state.state !== "waiting") {
        arrivedAt = e.event_at;
        state = { state: "waiting", arrivedAt };
      }
    } else if (MOVING_PHASES.has(phase)) {
      state = { state: "not_at_point" };
      arrivedAt = null;
    }
  }
  return state;
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
  sendcloud: boolean;
  mode: "off" | "allowlist" | "on";
  orders: number;
  checked: number;
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
    sendcloud: sendcloudConfigured(),
    mode: scope.mode,
    orders: 0,
    checked: 0,
    notified: 0,
    skipped: {},
    failed: 0,
    preview: [],
  };
  const skip = (why: string) => (tally.skipped[why] = (tally.skipped[why] ?? 0) + 1);
  if (!tally.sendcloud) return tally;

  const orders = await listPickupOrders(now);
  tally.orders = orders.length;

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

  for (const order of orders) {
    if (done.has(order.legacyResourceId)) {
      skip("ya_avisado");
      continue;
    }
    // Un paquete por pedido en la práctica; si hubiera varios, basta uno esperando.
    const shipped = order.fulfillments.filter((f) => f.status === "SUCCESS" && f.trackingInfo[0]?.number);
    if (shipped.length === 0) {
      skip(order.fulfillments.length === 0 ? "sin_enviar" : "sin_seguimiento");
      continue;
    }
    // Con `deliveredAt` en Shopify ya está recogido: ni se pregunta a Sendcloud.
    const notCollected = shipped.filter((f) => !f.deliveredAt);
    if (notCollected.length === 0) {
      skip("recogido_segun_shopify");
      continue;
    }
    // Antes de 3 días desde que sale del almacén no puede llevar 3 en el punto.
    const shipments = notCollected.filter((f) => Date.parse(f.createdAt) <= now - REMIND_AFTER_DAYS * DAY);
    if (shipments.length === 0) {
      skip("enviado_hace_poco");
      continue;
    }
    if (tally.checked >= MAX_PER_RUN) {
      skip("tope_por_tirada");
      continue;
    }

    let hit: { arrivedAt: string; days: number; trackingNumber: string; trackingUrl: string | null } | null = null;
    let why = "sin_seguimiento";
    let broke = false;
    for (const f of shipments) {
      const trackingNumber = f.trackingInfo[0]!.number!;
      tally.checked++;
      let tracking;
      try {
        tracking = await getSendcloudTracking(trackingNumber);
      } catch (err) {
        console.warn("[pickup-reminder] Sendcloud falló; mañana se reintenta", {
          order: order.name,
          msg: err instanceof Error ? err.message : String(err),
        });
        broke = true;
        continue;
      }
      if (!tracking) {
        why = "no_es_de_sendcloud";
        continue;
      }
      const decision = decideReminder({ state: pickupState(tracking.events), shopifyDeliveredAt: f.deliveredAt, now });
      if (decision.send) {
        hit = { arrivedAt: decision.arrivedAt, days: decision.days, trackingNumber, trackingUrl: f.trackingInfo[0]?.url ?? null };
        break;
      }
      why = decision.why;
    }
    if (!hit) {
      if (broke) tally.failed++;
      else skip(why);
      continue;
    }

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

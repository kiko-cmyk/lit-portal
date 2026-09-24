import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { awardDrops, DROPS_AMOUNTS, TIER_THRESHOLD } from "@/lib/drops";
import { compositionLabel, shortLabel } from "@/lib/mix";
import {
  boxCountFromOrderLines,
  compositionFromOrderLines,
  type OrderLine,
} from "@/lib/order-lines";
import { BOX_COUNT_BY_VARIANT, type FlavorKey, flavorKeyForVariant, FREQUENCY_BY_SELLING_PLAN } from "@/lib/seal-plans";
import { klaviyo } from "@/lib/klaviyo";
import { alertSlackErrorAwaited } from "@/lib/alert";
import {
  DISCOVERY_DISCOUNT_VALUE_EUR,
  issueDiscoveryDiscount,
  type IssuedDiscount,
} from "@/lib/discovery-discount";
import { mapToSubscription, seal } from "@/lib/seal";
import { formatShipDateEs } from "@/lib/ship-date-label";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

/**
 * POST /apps/portal/api/webhooks/shopify
 * Single endpoint, demuxed by `X-Shopify-Topic` header.
 * Handles: orders/paid, fulfillments/create, customers/update.
 *
 * Idempotency: each webhook delivery has a unique X-Shopify-Webhook-Id; we
 * insert into webhook_log with PK (provider, event_id) — duplicate deliveries
 * fail unique constraint and are skipped.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const topic = req.headers.get("x-shopify-topic");
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  const eventId = req.headers.get("x-shopify-webhook-id") ?? crypto.randomUUID();

  const rawBody = await req.text();

  // Fail-closed if the secret isn't configured (post-audit 2026-05-18). The
  // `verifyShopifyHmac` helper returns false when the secret is missing, but
  // we want a louder signal in logs and a 500 (misconfiguration) instead of
  // a 401 (signed-wrong) so the failure is debuggable rather than silent.
  if (!SHOPIFY_WEBHOOK_SECRET) {
    console.error("[shopify-webhook] SHOPIFY_WEBHOOK_SECRET not set — refusing payload");
    return NextResponse.json({ error: "webhook_misconfigured" }, { status: 500 });
  }
  if (!verifyShopifyHmac(rawBody, hmac)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  if (!topic) {
    return NextResponse.json({ error: "missing_topic" }, { status: 400 });
  }

  // Idempotency check
  const sb = supabaseAdmin();
  const dedup = await sb.from("webhook_log").insert({
    provider: "shopify",
    event_id: eventId,
    topic,
  });
  if (dedup.error?.code === "23505") {
    // KNOWN RESIDUAL (Juan's review): if a handler runs longer than Shopify's
    // ~5s timeout, Shopify fires a retry while the original is still running.
    // The retry hits this PK conflict and returns dedup:true (200), so Shopify
    // stops retrying — then if the original later throws, delete-on-failure
    // removes the reservation and the event is lost. We do NOT return 500 here
    // on processed_at-null instead: under real concurrency that would reprocess
    // in parallel and double-fire the non-idempotent confirmation_sent Klaviyo
    // event. Documented alongside the "process dies between reservation and
    // catch" residual; both are far rarer than the bug this PR fixes.
    return NextResponse.json({ ok: true, dedup: true });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    switch (topic) {
      case "orders/paid":
        await handleOrdersPaid(payload);
        break;
      case "fulfillments/create":
        await handleFulfillmentsCreate(payload);
        break;
      case "customers/update":
        await handleCustomersUpdate(payload);
        break;
      default:
        console.warn(`[shopify-webhook] unhandled topic ${topic}`);
    }
  } catch (err) {
    console.error(`[shopify-webhook] handler failed for ${topic}`, err);
    // Release the reservation so Shopify's retry RE-PROCESSES this event.
    // Without this, the retry hit the (provider,event_id) PK, returned
    // dedup:true, and the event (drops, confirmation/tier emails) was lost
    // forever. Replaying a FAILED handler is safe: box_shipped is idempotent
    // via drops_events.dedup_key; referral is gated by referral_conversions
    // unique (a retry won't double-award — note the pre-existing under-award
    // edge if the award throws after the conversion row commits); and
    // confirmation_sent is the LAST side effect in handleOrdersPaid, so any
    // throw happens before it and it fires exactly once across attempts;
    // tier_unlocked is gated by the pre-award snapshot. Only delete our own
    // un-processed reservation. NOTE: the processed_at mark is OUTSIDE this
    // try on purpose (below) — a failure to MARK must not trigger a replay,
    // because the side effects already committed.
    await sb
      .from("webhook_log")
      .delete()
      .eq("provider", "shopify")
      .eq("event_id", eventId)
      .is("processed_at", null);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  // Handler succeeded. Mark processed — BEST EFFORT. If this throws (transient
  // network blip) we do NOT delete the reservation: the work already ran, so a
  // replay would re-fire ungated side effects (e.g. confirmation_sent). Worst
  // case the row keeps processed_at = null; a duplicate delivery still hits the
  // PK and is skipped as a dedup, so no replay and no double email.
  try {
    await sb
      .from("webhook_log")
      .update({ processed_at: new Date().toISOString() })
      .eq("provider", "shopify")
      .eq("event_id", eventId);
  } catch (markErr) {
    console.warn(`[shopify-webhook] handler ran but processed_at mark failed for ${topic}`, markErr);
  }
  return NextResponse.json({ ok: true });
}

function verifyShopifyHmac(rawBody: string, hmacHeader: string | null): boolean {
  if (!hmacHeader || !SHOPIFY_WEBHOOK_SECRET) return false;
  const computed = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  const a = Buffer.from(computed);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface ShopifyOrderPayload {
  id?: number;
  order_number?: number;
  customer?: { id: number; email?: string; first_name?: string };
  email?: string;
  total_price?: string;
  currency?: string;
  note_attributes?: Array<{ name: string; value: string }>;
  line_items?: Array<{
    title: string;
    quantity: number;
    // El sku de la línea, cuando viene. Junto con `variant_id` es lo que detecta
    // el Discovery Set en `maybeIssueDiscoveryCoupon`; se miran los DOS porque
    // ninguno está garantizado por separado en el cuerpo del webhook.
    sku?: string | null;
    variant_id?: number;
    selling_plan_allocation?: { selling_plan?: { id: string; name?: string } };
  }>;
}

interface ShopifyFulfillmentPayload {
  // Shopify sends the fulfillment fields at the ROOT of the fulfillments/create
  // body (same as orders/paid), NOT nested under a `.fulfillment` key. Reading
  // `payload.fulfillment` here was always undefined, so the handler returned
  // early and box_shipped Drops were never awarded.
  id?: number;
  order_id?: number;
}

async function handleOrdersPaid(payload: ShopifyOrderPayload): Promise<void> {
  // 1. Referral attribution
  const refAttr = payload.note_attributes?.find((a) => a.name === "ref" || a.name === "referral_code");
  if (refAttr?.value) {
    const sb = supabaseAdmin();
    const { data: codeRow } = await sb
      .from("referral_codes")
      .select("customer_id")
      .eq("code", refAttr.value.toUpperCase())
      .maybeSingle();
    if (codeRow && payload.id) {
      const { error: convErr } = await sb.from("referral_conversions").insert({
        referrer_customer_id: codeRow.customer_id,
        converted_order_id: String(payload.id),
        drops_awarded: 250,
      });
      if (!convErr) {
        await awardDrops(codeRow.customer_id, "referral_converted", 250, {
          orderId: payload.id,
          code: refAttr.value,
        });
        // Notify referrer via Klaviyo (resolve their email from their customer ID)
        const referrerEmail = await shopifyAdmin
          .getCustomerEmail(codeRow.customer_id)
          .catch(() => null);
        if (referrerEmail) {
          await klaviyo
            .trackEvent("referral_converted" as never, referrerEmail, {
              orderId: payload.id,
              dropsAwarded: 250,
            })
            .catch(() => null);
        }
      }
    }
  }

  // 2. Confirmation email trigger — fires Klaviyo event with plan details
  const email = payload.customer?.email ?? payload.email;
  if (email && payload.line_items && payload.line_items.length > 0) {
    // The orders/paid payload does NOT carry selling-plan info, same as
    // fulfillments/create (see handleFulfillmentsCreate). Verified in production
    // 2026-07-29: order #8964 is a "Suscripción cada 15 días" in the Admin API, yet
    // its confirmation_sent event came out is_subscription:false, frequency:null,
    // selling_plan_name:null, box_count:1 and flavor "LIT Daily Hydration: Watermelon".
    // 26 of the last 30 orders were misreported the same way, so every plan field in
    // the welcome email was wrong or missing. Read the lines from the ORDER instead,
    // exactly as the Drops path already does.
    const resolved = await resolveOrderLines(payload.id, payload.line_items);
    // BOX COUNT — the LIT model puts the box count in the VARIANT (SL90 = 3 boxes),
    // with quantity almost always 1. Summing `quantity` (audit 2026-07-06, which
    // fixed the multi-line dimension but summed the wrong axis) therefore reported
    // **1 box / 30 sachets for every subscriber of more than one box** in the live
    // confirmation email. Map through the variant registry instead and multiply by
    // quantity, which is correct for all four shapes that exist in production:
    // pack × 1, 1-box × N (a mix), pack × N, and a portal-created mix.
    const subLines = resolved.filter((li) => li.selling_plan_allocation);
    const main = subLines[0] ?? resolved[0];
    const planId = main?.selling_plan_allocation?.selling_plan?.id
      ? String(main.selling_plan_allocation.selling_plan.id)
      : null;
    const boxCount = boxCountFromOrderLines(resolved);

    // Boxes per flavor, so the email can name a mix instead of only the first line.
    const composition = compositionFromOrderLines(subLines);
    const isMix = composition.length > 1;
    const planName = main?.selling_plan_allocation?.selling_plan?.name ?? null;
    // Cadence as our own code ("3mo"), not Seal's plan NAME. The name is raw Spanish
    // from the Seal admin ("Envío 3 meses") and has been renamed three times, so a
    // template can't branch on it — and an English email can't print it. With the code,
    // both language templates use the same mapping the 7-day reminder already uses.
    const frequency = planId ? FREQUENCY_BY_SELLING_PLAN[planId] ?? null : null;
    // A subscription order has at least one line item with a selling plan.
    // Exposed as a clean boolean so Klaviyo flows can branch on subscription
    // vs one-time purchases without parsing plan_label (e.g. the
    // "Área personal - Bienvenida" welcome triggers on is_subscription = true).
    const isSubscription = resolved.some((li) => li.selling_plan_allocation);
    // AWAIT: on Vercel the function can freeze once the response is sent, so a
    // fire-and-forget trackEvent (and the confirmation/welcome email it drives)
    // could be dropped after processed_at is marked, with no retry. Awaiting
    // lets the Klaviyo POST complete before we return; .catch keeps it non-fatal.
    await klaviyo
      .trackEvent("confirmation_sent", email, {
        order_id: payload.id,
        order_number: payload.order_number,
        first_name: payload.customer?.first_name,
        box_count: boxCount,
        sachets: boxCount * 30,
        plan_label: planName ?? `${boxCount} box${boxCount > 1 ? "es" : ""}`,
        is_subscription: isSubscription,
        selling_plan_name: planName,
        // A single flavor yields the plain label ("Salty Lemon") byte-for-byte, so
        // today's template and any Klaviyo segment keyed on it are unaffected. A mix
        // yields "2× Lemon · 1× Watermelon".
        flavor: composition.length ? compositionLabel(composition) : main?.title ?? "Lemon Drop",
        // Structured, so the template can branch and list the flavors.
        is_mix: isMix,
        flavor_mix: composition.map((c) => ({ flavor: shortLabel(c.flavor), boxes: c.boxes })),
        // "15d" | "1mo" | … | "6mo", or null for a legacy/unmapped plan.
        frequency,
        total: payload.total_price,
        currency: payload.currency,
      })
      .catch((err) => console.warn("[orders/paid] confirmation_sent klaviyo failed:", err));
  }

  // 3. Cupón del LIT Discovery Set.
  //
  // VA EL ÚLTIMO y en su propio try/catch, a propósito. Todo lo de arriba
  // (referidos, drops, confirmation_sent) ya ha corrido y ha hecho su trabajo;
  // si la emisión del cupón lanzara, el catch del POST borraría la reserva de
  // `webhook_log` y Shopify reintentaría el evento ENTERO, duplicando lo demás.
  // Un cupón sin emitir se recupera a mano desde la alerta de Slack; un
  // confirmation_sent duplicado es un segundo email al cliente.
  try {
    await maybeIssueDiscoveryCoupon(payload);
  } catch (err) {
    // No debería llegar aquí (la función se traga sus propios fallos y avisa),
    // pero si aparece un camino nuevo que lanza, NO se propaga.
    console.error("[orders/paid] cupón Discovery falló fuera de su guarda:", err);
  }
}

/** SKU y variante del LIT Discovery Set (5,95 €). Producto de una sola
 *  variante, verificado contra Shopify el 2026-09-24. */
const DISCOVERY_SKU = "LITDS";
const DISCOVERY_VARIANT_ID = "65812401652061";

/**
 * Emite el cupón de 5,95 € a quien acaba de comprar el LIT Discovery Set.
 *
 * La promesa del email es "te devolvemos los 5,95 € cuando pidas tu caja con
 * envíos programados", así que el cupón SOLO vale en suscripción (eso vive en
 * `discovery-discount.ts`) y solo lo recibe quien todavía no es suscriptor.
 *
 * Se cuelga de `orders/paid` y no de `orders/create` a propósito: un pedido que
 * no llega a cobrarse no genera cupón.
 *
 * Nunca lanza. Todos sus fallos terminan en un aviso de Slack, porque un throw
 * aquí replayaría el webhook entero (ver el comentario de la llamada).
 */
async function maybeIssueDiscoveryCoupon(payload: ShopifyOrderPayload): Promise<void> {
  // ── 1. ¿Lleva el Discovery Set? ────────────────────────────────────────────
  //
  // Se miran SKU y variante, y basta con que cuadre uno. No es cinturón y
  // tirantes gratuito: este mismo fichero documenta que el cuerpo del webhook
  // llega SIN `selling_plan_allocation` en producción, así que no es una fuente
  // en la que se pueda confiar campo a campo. Si el body no trae `sku`, la
  // variante lo salva, y al revés. El fallo que evita es el peor de todos: no
  // emitir nada, en silencio, para todo el mundo.
  //
  // El SKU es lo primario porque es estable si algún día se recrea el producto;
  // la variante cubre el caso de un body sin sku.
  const lines = payload.line_items ?? [];
  let hasDiscovery = lines.some(
    (li) => li.sku === DISCOVERY_SKU || String(li.variant_id ?? "") === DISCOVERY_VARIANT_ID,
  );

  // Si el body no traía NI sku NI variante en ninguna línea, no se puede
  // concluir que no está: se relee el pedido por la Admin API, que sí los trae.
  // Solo en ese caso, para no gastar una llamada en cada pedido normal.
  if (!hasDiscovery && payload.id && lines.every((li) => !li.sku && !li.variant_id)) {
    hasDiscovery = await orderHasDiscoverySet(payload.id);
  }

  if (!hasDiscovery) return;

  const customerId = payload.customer?.id ? String(payload.customer.id) : null;
  const email = payload.customer?.email ?? payload.email ?? null;
  if (!customerId || !email) {
    // Sin cliente no hay a quién atar el cupón (la idempotencia es por cliente)
    // y sin email no hay a quién mandarlo. Un pedido de invitado sin cuenta es
    // el caso real: se avisa para emitirlo a mano en vez de perderlo callando.
    await alertSlackErrorAwaited({
      path: "/api/webhooks/shopify",
      code: "discovery_coupon_no_customer",
      msg: `Discovery Set en el pedido ${payload.id} sin customer_id o sin email: cupón NO emitido, hay que hacerlo a mano.`,
      customerId: customerId ?? undefined,
    });
    return;
  }

  const sb = supabaseAdmin();

  // ── 2. ¿Ya tiene uno? ──────────────────────────────────────────────────────
  //
  // La idempotencia real. Quien compre un segundo Discovery Set (o cuyo webhook
  // se redeliverea después de que la reserva de `webhook_log` se haya borrado
  // por un fallo posterior) recibe EL MISMO código, no uno nuevo.
  const { data: prior, error: priorErr } = await sb
    .from("discovery_set_coupons")
    .select("discount_code, discount_issued_at, discount_expires_at")
    .eq("customer_id", customerId)
    .maybeSingle();

  if (priorErr) {
    // 42P01 = la tabla no existe: la migración no llegó a producción. Es el
    // fallo más probable el día del despliegue y se manifestaría en TODOS los
    // pedidos a la vez, así que tiene que verse en el primero.
    await alertSlackErrorAwaited({
      path: "/api/webhooks/shopify",
      code: "discovery_coupon_read_failed",
      msg: `No se pudo leer discovery_set_coupons (${priorErr.code ?? "?"}: ${priorErr.message}). Cupón NO emitido para el pedido ${payload.id}.`,
      customerId,
    });
    return;
  }

  if (prior?.discount_code) {
    // Ya lo tiene. No se reemite NI se vuelve a disparar el evento: el flow de
    // Klaviyo ya salió en su día y un segundo disparo son cinco emails
    // repetidos. (El `uniqueId` de Klaviyo también lo cubre, pero no se llega
    // a depender de eso.)
    console.log(`[orders/paid] cliente ${customerId} ya tenía cupón Discovery, no se reemite`);
    return;
  }

  // ── 3. ¿Le toca? La guarda de suscripción viva ─────────────────────────────
  //
  // Mismo criterio y mismo motivo que el cupón del perfilado: el 23-sep se
  // regalaron 3 cupones de 5 € a suscriptores activos por preguntar a una CACHÉ
  // en vez de a Seal.
  //
  // `getSubscriptionsByEmail` y NUNCA `resolveActiveSubFast`: ese atajo mira
  // solo la caché de Supabase, devuelve `null` en un cache miss (una sub ACTIVE
  // de alguien que nunca entró al portal tiene CERO filas) y además acaba en
  // `catch { return null }`, así que un fallo de Seal llega disfrazado de "no
  // tiene suscripción" y deja inalcanzable la propia guarda de abajo.
  //
  // FAIL-CLOSED: si Seal no contesta se asume que SÍ tiene suscripción y no se
  // emite. Perder un cupón recuperable a mano es preferible a regalárselo a
  // quien ya paga.
  let hadLiveSubscription: boolean;
  try {
    const subs = await seal.getSubscriptionsByEmail(email);
    hadLiveSubscription = subs.some((sub) => {
      const status = mapToSubscription(sub, customerId).status;
      // `paused` y `reactivating` CUENTAN como viva: una sub pausada sigue
      // siendo cliente de suscripción y no hay nada que convertir.
      return status === "active" || status === "paused" || status === "reactivating";
    });
  } catch (err) {
    console.warn("[orders/paid] Seal no contestó, sin cupón Discovery:", err);
    hadLiveSubscription = true;
  }

  if (hadLiveSubscription) return;

  // ── 4. Emitir ──────────────────────────────────────────────────────────────
  let discount: IssuedDiscount;
  try {
    discount = await issueDiscoveryDiscount(customerId);
  } catch (err) {
    // El fallo más probable el día del despliegue es que la app no tenga el
    // scope `write_discounts`, y saldría en TODOS los pedidos a la vez. Por eso
    // AVISA, no solo loguea: el cliente ya ha pagado su Discovery Set y alguien
    // tiene que emitirle el cupón a mano.
    console.error("[orders/paid] EMISIÓN DE CUPÓN DISCOVERY FALLIDA:", customerId, err);
    await alertSlackErrorAwaited({
      path: "/api/webhooks/shopify",
      code: "discovery_discount_failed",
      msg: `No se pudo emitir el cupón del Discovery Set (pedido ${payload.id}): ${err instanceof Error ? err.message : String(err)}`,
      customerId,
    });
    return;
  }

  // ── 5. Persistir ANTES de avisar a Klaviyo ─────────────────────────────────
  //
  // Este orden importa. Si se guardara después del evento y la escritura
  // fallara, el cliente tendría su email con el código y nosotros ninguna fila:
  // su siguiente Discovery Set le emitiría un SEGUNDO cupón.
  const { error: saveErr } = await sb.from("discovery_set_coupons").insert({
    customer_id: customerId,
    order_id: String(payload.id ?? ""),
    discount_code: discount.code,
    discount_issued_at: discount.issuedAt,
    discount_expires_at: discount.expiresAt,
  });

  if (saveErr) {
    // 23505 = ya existe una fila para este cliente: dos entregas del webhook en
    // paralelo. La otra ganó y ya disparó (o disparará) el evento, así que aquí
    // se para en seco. El cupón que acabamos de crear en Shopify queda huérfano
    // y sin repartir; caducará a los 30 días y el cron lo barrerá.
    if ((saveErr as { code?: string }).code === "23505") {
      console.warn(`[orders/paid] carrera de cupón Discovery para ${customerId}, no se avisa`);
      return;
    }
    // Cualquier otro fallo: el cupón EXISTE en Shopify pero no tenemos fila. NO
    // se dispara el evento, porque sin fila no podríamos impedir un segundo
    // cupón más adelante. Se avisa con el código dentro para poder repartirlo a
    // mano y arreglar la fila.
    await alertSlackErrorAwaited({
      path: "/api/webhooks/shopify",
      code: "discovery_coupon_save_failed",
      msg: `Cupón ${discount.code} CREADO en Shopify pero no guardado (${saveErr.message}). El cliente NO ha sido avisado: repartir a mano.`,
      customerId,
    });
    return;
  }

  // ── 6. El evento que dispara el flow de cinco emails ───────────────────────
  //
  // Solo se llega aquí con cupón emitido Y guardado. Si la emisión hubiera
  // fallado, este evento no debe salir: el primer email lleva el código en el
  // cuerpo y sin él sale roto, que es peor que no mandarlo.
  //
  // AWAIT y no fire-and-forget: en Vercel la función puede congelarse en cuanto
  // se devuelve la respuesta, y un POST a Klaviyo a medias se perdería sin
  // reintento. Mismo motivo por el que `confirmation_sent` se awaitea arriba.
  await klaviyo
    .trackEvent(
      "Discovery Set Purchased",
      email,
      {
        discount_code: discount.code,
        discount_expires_at: discount.expiresAt,
        // La fecha YA formateada ("24 de octubre"). El filtro |date de Django
        // devuelve '' en silencio sobre un string, que es como el recordatorio
        // de 7d salió con la fecha en blanco a 524 personas en julio.
        discount_expires_label: formatShipDateEs(discount.expiresAt),
        discount_value: DISCOVERY_DISCOUNT_VALUE_EUR,
        order_id: String(payload.id ?? ""),
        first_name: payload.customer?.first_name,
      },
      {
        // Klaviyo deduplica por aquí: una redelivery del webhook no dispara el
        // flow dos veces ni manda cinco emails repetidos.
        uniqueId: `discovery-${customerId}`,
        externalId: customerId,
      },
    )
    .catch(async (err) => {
      // El cupón ya está emitido y guardado, así que el cliente tiene código
      // pero NO tiene email. Eso no se puede perder en un log.
      console.error("[orders/paid] evento Discovery Set Purchased fallido:", customerId, err);
      await alertSlackErrorAwaited({
        path: "/api/webhooks/shopify",
        code: "discovery_event_failed",
        msg: `Cupón ${discount.code} emitido pero el evento Discovery Set Purchased no salió: ${err instanceof Error ? err.message : String(err)}. El cliente no ha recibido su código.`,
        customerId,
      });
    });
}

/**
 * ¿Lleva el pedido una línea del Discovery Set? Releído por la Admin API.
 *
 * Solo se llama cuando el cuerpo del webhook no trae NI sku NI variante en
 * ninguna línea, que es el único caso en el que "no está" no se puede concluir
 * del body. Ante un fallo devuelve `false`: sin poder confirmar la compra no se
 * emite un cupón, igual que el resto de guardas de esta ruta.
 */
async function orderHasDiscoverySet(orderId: number): Promise<boolean> {
  const res = await shopifyAdmin
    .graphql<{
      order: {
        lineItems: { nodes: Array<{ sku: string | null; variant: { id: string } | null }> };
      } | null;
    }>(
      `query orderLinesForDiscovery($id: ID!) {
        order(id: $id) {
          lineItems(first: 100) { nodes { sku variant { id } } }
        }
      }`,
      { id: `gid://shopify/Order/${orderId}` },
    )
    .catch((err) => {
      console.warn(`[orders/paid] no se pudieron releer las líneas de ${orderId}`, err);
      return null;
    });
  const nodes = res?.order?.lineItems?.nodes;
  if (!nodes?.length) return false;
  return nodes.some(
    (li) =>
      li.sku === DISCOVERY_SKU ||
      li.variant?.id === `gid://shopify/ProductVariant/${DISCOVERY_VARIANT_ID}`,
  );
}

/**
 * Line items WITH selling-plan and variant data, read from the order.
 *
 * The orders/paid webhook body omits `selling_plan_allocation` (verified in production:
 * a live "Suscripción cada 15 días" order arrived with no plan on any line), so every
 * plan field derived from it came out empty and the welcome email said "1 CAJA" with the
 * raw product title as the flavor. The Admin API does return it.
 *
 * Falls back to the webhook body on any failure: a degraded email beats no email, which
 * is what throwing here would cause (confirmation_sent is the last side effect and a
 * throw would replay the whole handler).
 */
async function resolveOrderLines(
  orderId: number | undefined,
  fallback: OrderLine[],
): Promise<OrderLine[]> {
  if (!orderId) return fallback;
  const res = await shopifyAdmin
    .graphql<{
      order: {
        lineItems: {
          nodes: Array<{
            title: string;
            quantity: number;
            variant: { id: string } | null;
            sellingPlan: { sellingPlanId: string; name: string } | null;
          }>;
        };
      } | null;
    }>(
      `query orderLinesForConfirmation($id: ID!) {
        order(id: $id) {
          lineItems(first: 100) {
            nodes {
              title
              quantity
              variant { id }
              sellingPlan { sellingPlanId name }
            }
          }
        }
      }`,
      { id: `gid://shopify/Order/${orderId}` },
    )
    .catch((err) => {
      console.warn(`[orders/paid] could not read lines for order ${orderId}`, err);
      return null;
    });
  const nodes = res?.order?.lineItems?.nodes;
  if (!nodes?.length) return fallback;
  const numeric = (gid: string | null | undefined, prefix: string) =>
    gid ? Number(gid.replace(prefix, "")) : undefined;
  return nodes.map((li) => ({
    title: li.title,
    quantity: li.quantity,
    variant_id: numeric(li.variant?.id, "gid://shopify/ProductVariant/"),
    // Rebuilt into the REST shape the rest of this handler already speaks, so the
    // box-count, composition and cadence logic below stays untouched.
    selling_plan_allocation: li.sellingPlan
      ? {
          selling_plan: {
            id: String(numeric(li.sellingPlan.sellingPlanId, "gid://shopify/SellingPlan/")),
            name: li.sellingPlan.name,
          },
        }
      : undefined,
  }));
}

async function handleFulfillmentsCreate(payload: ShopifyFulfillmentPayload): Promise<void> {
  // Fulfillment fields live at the payload root (see ShopifyFulfillmentPayload).
  // Reading payload.fulfillment was always undefined → box_shipped Drops were
  // never awarded (prod: 4,633 fulfillments/create processed, 0 box_shipped).
  const f = payload;
  if (!f.id || !f.order_id) return;

  // Look up the customer AND the order's subscription line items. box_shipped
  // Drops are for SUBSCRIPTION boxes only — a one-time / B2B / extras-only
  // fulfillment must earn nothing. The fulfillments/create payload doesn't carry
  // selling-plan info, so we read it from the order.
  const order = await shopifyAdmin
    .graphql<{
      order: {
        customer: { id: string } | null;
        lineItems: {
          nodes: Array<{
            quantity: number;
            sellingPlan: { name: string } | null;
            variant: { id: string } | null;
          }>;
        };
      } | null;
    }>(
      `query orderForDrops($id: ID!) {
        order(id: $id) {
          customer { id }
          lineItems(first: 100) { nodes { quantity sellingPlan { name } variant { id } } }
        }
      }`,
      { id: `gid://shopify/Order/${f.order_id}` },
    )
    .catch(() => null);
  const customerGid = order?.order?.customer?.id;
  if (!customerGid) {
    console.warn(`[fulfillments/create] no customer for order ${f.order_id}`);
    return;
  }
  const customerId = customerGid.replace(/^gid:\/\/shopify\/Customer\//, "");

  // Count SHIPMENTS, not quantities.
  //
  // Careful: this looks like a box count but it never was one. The LIT model puts the
  // box count in the VARIANT with quantity 1, so `Σ quantity` has always awarded 100
  // Drops per SHIPMENT regardless of how many boxes are in it — a 3-box subscriber
  // gets 100, not 300. `DROPS_AMOUNTS.box_shipped` says "per box" but the economics
  // in production are per shipment.
  //
  // That matters now because a flavor mix ships as several lines (SL30 ×2 + W30 ×1),
  // and summing quantities would suddenly award 300 Drops for the same shipment — a
  // 3× inflation that hits TIER_THRESHOLD in one go and breaks the reward ladder.
  // Switching to a real box count would inflate EVERY subscriber the same way, which
  // is a deliberate economics change, not something to smuggle in behind a flavor
  // feature. So: one unit per distinct selling plan (a LIT subscription shipment),
  // plus the legacy quantity sum for anything outside the registry.
  //
  // KNOWN, ACCEPTED REGRESSION: two separate subscriptions on the SAME cadence bought
  // in one checkout now award 100 instead of 200, because they share a selling plan
  // name. Rare, and under-awarding by 100 beats 3× inflating every mix.
  const subLines = (order?.order?.lineItems?.nodes ?? []).filter((li) => li.sellingPlan);
  const variantNumeric = (gid: string | null | undefined) =>
    gid ? gid.replace(/^gid:\/\/shopify\/ProductVariant\//, "") : "";
  const registryLines = subLines.filter(
    (li) => BOX_COUNT_BY_VARIANT[variantNumeric(li.variant?.id)] !== undefined,
  );
  const otherLines = subLines.filter(
    (li) => BOX_COUNT_BY_VARIANT[variantNumeric(li.variant?.id)] === undefined,
  );
  const subscriptionBoxes =
    new Set(registryLines.map((li) => li.sellingPlan!.name)).size +
    otherLines.reduce((s, li) => s + (li.quantity ?? 0), 0);
  // 0 subscription lines → B2B / one-time order, or extras only. B2B is live, so a
  // wholesale fulfillment must NOT mint Drops.
  if (subscriptionBoxes === 0) return;

  // Snapshot tier state before awarding (to detect first-time crossing)
  const sb = supabaseAdmin();
  const { data: pre } = await sb
    .from("drops_balances")
    .select("tier_earned_at, lifetime_earned")
    .eq("customer_id", customerId)
    .maybeSingle();
  const wasTierEarned = !!pre?.tier_earned_at;

  for (let i = 0; i < subscriptionBoxes; i++) {
    await awardDrops(
      customerId,
      "box_shipped",
      DROPS_AMOUNTS.box_shipped ?? 100,
      { fulfillmentId: f.id, orderId: f.order_id, boxIndex: i },
      // Idempotency key per ORDER, not per fulfillment (audit 2026-07-06). The
      // box count comes from the ORDER's subscription lines, so keying by
      // fulfillment id re-awarded the full order on every additional
      // fulfillments/create — 3PL partial shipments and cancelled+re-created
      // fulfillments (new id) doubled Drops. Keyed by order, every fulfillment
      // of the same order collides on the same keys: an order can never award
      // more than its subscription-box total. Webhook retries stay deduped too.
      `box_shipped:order:${f.order_id}:${i}`,
    );
  }

  // Check if this push crossed the INNER CIRCLE tier threshold for the first time
  const { data: post } = await sb
    .from("drops_balances")
    .select("tier_earned_at, lifetime_earned, balance")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!wasTierEarned && post?.tier_earned_at && (post?.lifetime_earned ?? 0) >= TIER_THRESHOLD) {
    const email = await shopifyAdmin.getCustomerEmail(customerId).catch(() => null);
    if (email) {
      await klaviyo
        .trackEvent("tier_unlocked", email, {
          earnedAt: post.tier_earned_at,
          lifetimeDrops: post.lifetime_earned,
          balance: post.balance,
        })
        .catch((err) => console.warn("[fulfillments/create] tier_unlocked klaviyo failed:", err));
    }
  }
}

async function handleCustomersUpdate(_payload: Record<string, unknown>): Promise<void> {
  // No-op for MVP. When Supabase has customer_preferences + we need to sync
  // changes from Shopify back, implement here.
}

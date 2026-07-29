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

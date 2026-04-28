import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { awardDrops, DROPS_AMOUNTS } from "@/lib/drops";
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
    await sb
      .from("webhook_log")
      .update({ processed_at: new Date().toISOString() })
      .eq("provider", "shopify")
      .eq("event_id", eventId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[shopify-webhook] handler failed for ${topic}`, err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
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
  customer?: { id: number; email?: string };
  email?: string;
  note_attributes?: Array<{ name: string; value: string }>;
}

interface ShopifyFulfillmentPayload {
  fulfillment?: {
    id: number;
    order_id: number;
    line_items?: Array<{ quantity: number; variant_id?: number }>;
  };
}

async function handleOrdersPaid(payload: ShopifyOrderPayload): Promise<void> {
  const refAttr = payload.note_attributes?.find((a) => a.name === "ref" || a.name === "referral_code");
  if (refAttr?.value) {
    // Look up referrer + record conversion + award +250 Drops
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
      // 23505 = already recorded — skip
      if (!convErr) {
        await awardDrops(codeRow.customer_id, "referral_converted", 250, {
          orderId: payload.id,
          code: refAttr.value,
        });
      }
    }
  }
}

async function handleFulfillmentsCreate(payload: ShopifyFulfillmentPayload): Promise<void> {
  const f = payload.fulfillment;
  if (!f) return;

  // Look up the customer for this order
  const order = await shopifyAdmin
    .graphql<{ order: { customer: { id: string } | null } | null }>(
      `query orderCustomer($id: ID!) { order(id: $id) { customer { id } } }`,
      { id: `gid://shopify/Order/${f.order_id}` },
    )
    .catch(() => null);
  const customerGid = order?.order?.customer?.id;
  if (!customerGid) {
    console.warn(`[fulfillments/create] no customer for order ${f.order_id}`);
    return;
  }
  const customerId = customerGid.replace(/^gid:\/\/shopify\/Customer\//, "");

  // Total boxes = sum of quantities of line items (excluding any one-time products
  // tagged as Extras — we'd ideally filter, but for MVP count all line items).
  const totalBoxes = (f.line_items ?? []).reduce((s, li) => s + (li.quantity ?? 0), 0);

  for (let i = 0; i < totalBoxes; i++) {
    await awardDrops(customerId, "box_shipped", DROPS_AMOUNTS.box_shipped ?? 100, {
      fulfillmentId: f.id,
      boxIndex: i,
    });
  }
}

async function handleCustomersUpdate(_payload: Record<string, unknown>): Promise<void> {
  // No-op for MVP. When Supabase has customer_preferences + we need to sync
  // changes from Shopify back, implement here.
}

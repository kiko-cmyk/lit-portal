import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { awardDrops, DROPS_AMOUNTS, TIER_THRESHOLD } from "@/lib/drops";
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
  fulfillment?: {
    id: number;
    order_id: number;
    line_items?: Array<{ quantity: number; variant_id?: number }>;
  };
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
          klaviyo
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
    const main = payload.line_items.find((li) => li.selling_plan_allocation) ?? payload.line_items[0];
    const boxCount = main?.quantity ?? 1;
    const planName = main?.selling_plan_allocation?.selling_plan?.name ?? null;
    klaviyo
      .trackEvent("confirmation_sent", email, {
        order_id: payload.id,
        order_number: payload.order_number,
        first_name: payload.customer?.first_name,
        box_count: boxCount,
        sachets: boxCount * 30,
        plan_label: planName ?? `${boxCount} box${boxCount > 1 ? "es" : ""}`,
        flavor: main?.title ?? "Lemon Drop",
        total: payload.total_price,
        currency: payload.currency,
      })
      .catch((err) => console.warn("[orders/paid] confirmation_sent klaviyo failed:", err));
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

  // Snapshot tier state before awarding (to detect first-time crossing)
  const sb = supabaseAdmin();
  const { data: pre } = await sb
    .from("drops_balances")
    .select("tier_earned_at, lifetime_earned")
    .eq("customer_id", customerId)
    .maybeSingle();
  const wasTierEarned = !!pre?.tier_earned_at;

  // Total boxes = sum of quantities of line items (excluding any one-time products
  // tagged as Extras — we'd ideally filter, but for MVP count all line items).
  const totalBoxes = (f.line_items ?? []).reduce((s, li) => s + (li.quantity ?? 0), 0);

  for (let i = 0; i < totalBoxes; i++) {
    await awardDrops(customerId, "box_shipped", DROPS_AMOUNTS.box_shipped ?? 100, {
      fulfillmentId: f.id,
      boxIndex: i,
    });
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
      klaviyo
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

import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { mapStatus, mapToSubscription, normalizeFrequency, type SealSubscription } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

const SEAL_WEBHOOK_SECRET = process.env.SEAL_WEBHOOK_SECRET;

/**
 * POST /apps/portal/api/webhooks/seal
 * Handles: subscription.created/updated/cancelled, billing.attempt.success/failure.
 *
 * Seal's exact signature header + algorithm should be verified once we have
 * dashboard access. Placeholder uses HMAC-SHA256 — adjust if Seal docs differ.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const signature = req.headers.get("x-seal-signature");
  const eventType = req.headers.get("x-seal-event") ?? "unknown";
  const eventId = req.headers.get("x-seal-event-id") ?? crypto.randomUUID();
  const rawBody = await req.text();

  // Fail-closed: refuse if the webhook secret isn't configured (post-audit
  // 2026-05-18). Previously the `&&` short-circuited and accepted unsigned
  // payloads when SEAL_WEBHOOK_SECRET was missing — a fail-open hole on
  // preview deploys or rotation accidents.
  if (!SEAL_WEBHOOK_SECRET) {
    console.error("[seal-webhook] SEAL_WEBHOOK_SECRET not set — refusing payload");
    return NextResponse.json({ error: "webhook_misconfigured" }, { status: 500 });
  }
  if (!verifySealSignature(rawBody, signature)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const sb = supabaseAdmin();
  const dedup = await sb.from("webhook_log").insert({
    provider: "seal",
    event_id: eventId,
    topic: eventType,
  });
  if (dedup.error?.code === "23505") {
    return NextResponse.json({ ok: true, dedup: true });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    switch (eventType) {
      case "subscription.created":
      case "subscription.updated":
        await syncSubscription(payload as { subscription: SealSubscription });
        break;
      case "subscription.cancelled":
        await syncSubscription(payload as { subscription: SealSubscription });
        // The portal-side cancel flow handles the 90d Drops hold; this is just
        // defensive sync if cancellation originates outside the portal.
        break;
      case "billing.attempt.success":
        // Charge succeeded → next ship moved. Update subscriptions cache.
        await syncSubscription(payload as { subscription: SealSubscription });
        break;
      case "billing.attempt.failure":
        // TODO: notify customer via Klaviyo + log
        break;
      default:
        console.warn(`[seal-webhook] unhandled event ${eventType}`);
    }
    await sb
      .from("webhook_log")
      .update({ processed_at: new Date().toISOString() })
      .eq("provider", "seal")
      .eq("event_id", eventId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[seal-webhook] handler failed for ${eventType}`, err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}

function verifySealSignature(rawBody: string, signature: string | null): boolean {
  if (!signature || !SEAL_WEBHOOK_SECRET) return false;
  const computed = crypto
    .createHmac("sha256", SEAL_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Mirror Seal subscription state into Supabase for fast queries on the portal side.
 * The Shopify customer_id is needed to key the row — Seal's email field is the
 * link, but we don't always have a Shopify customer ID at this point. For now,
 * use email as the lookup key when customer_id isn't available.
 *
 * TODO: when we have a customer_seal_mapping table, populate it here from
 * subscription.created so portal queries can skip the email-based pagination.
 */
async function syncSubscription(payload: { subscription: SealSubscription }): Promise<void> {
  const s = payload.subscription;
  if (!s) return;

  // Resolve Shopify customer ID from email via Shopify Admin
  // (lazy import to avoid loading Shopify client in webhook hot path if unused)
  const { shopifyAdmin } = await import("@/lib/shopify-admin");
  const customer = await shopifyAdmin
    .graphql<{ customers: { edges: Array<{ node: { id: string } }> } }>(
      `query findByEmail($q: String!) { customers(first: 1, query: $q) { edges { node { id } } } }`,
      { q: `email:${s.email}` },
    )
    .catch(() => null);
  const customerGid = customer?.customers.edges[0]?.node.id;
  if (!customerGid) {
    console.warn(`[seal-webhook] no Shopify customer for email ${s.email}`);
    return;
  }
  const customerId = customerGid.replace(/^gid:\/\/shopify\/Customer\//, "");

  // Upsert into subscriptions table
  const sb = supabaseAdmin();
  const mapped = mapToSubscription(s, customerId);
  await sb.from("subscriptions").upsert(
    {
      customer_id: customerId,
      seal_subscription_id: String(s.id),
      box_count: mapped.boxCount,
      frequency: normalizeFrequency(s.delivery_interval),
      flavor: mapped.flavor,
      next_ship_date: mapped.nextShipDate,
      next_box_number: mapped.nextBoxNumber,
      status: mapStatus(s),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "customer_id" },
  );
}

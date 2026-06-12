import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { isWithinCutoff } from "@/lib/cutoff";
import {
  getNextBillingAttempt,
  mapStatus,
  mapToSubscription,
  normalizeFrequency,
  pendingAttemptsBefore,
  seal,
  type SealSubscription,
} from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

// Seal signs each webhook with HMAC-SHA256 over the JSON body using the shop's
// "Seal API secret" (Seal app > Settings > General > API), sent in the
// X-Seal-Hmac-Sha256 header. Confirmed against Seal's official docs 2026-06-12.
// (The previous code read `x-seal-signature` with a guessed format — it never
// verified, which is partly why the portal webhook was never wired up.)
const SEAL_API_SECRET = process.env.SEAL_API_SECRET ?? process.env.SEAL_WEBHOOK_SECRET;

/**
 * POST /apps/portal/api/webhooks/seal
 *
 * Handles Seal webhook topics. The one that matters for the re-anchor flow is
 * `subscription/updated`, which Seal fires WHEN it finishes regenerating
 * billing_attempts after a frequency change — the only reliable moment to skip
 * the regenerated early attempts and preserve the customer's prior next-ship
 * date (see /api/subscription/plan and subscription_reanchor_intents).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Seal sends the topic with a slash (e.g. "subscription/updated").
  const eventType = req.headers.get("x-seal-topic") ?? req.headers.get("x-seal-event") ?? "unknown";
  const signature =
    req.headers.get("x-seal-hmac-sha256") ?? req.headers.get("x-seal-signature");
  const rawBody = await req.text();

  // Fail-closed: refuse if the secret isn't configured.
  if (!SEAL_API_SECRET) {
    console.error("[seal-webhook] SEAL_API_SECRET not set — refusing payload");
    return NextResponse.json({ error: "webhook_misconfigured" }, { status: 500 });
  }
  if (!verifySealSignature(rawBody, signature, SEAL_API_SECRET)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const sb = supabaseAdmin();
  // Dedup by a hash of the body (Seal doesn't send a stable event id header).
  const eventId = crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 32);
  const dedup = await sb.from("webhook_log").insert({
    provider: "seal",
    event_id: eventId,
    topic: eventType,
  });
  if (dedup.error?.code === "23505") {
    return NextResponse.json({ ok: true, dedup: true });
  }

  let payload: { subscription?: SealSubscription } | unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const topic = eventType.replace("/", ".");
    switch (topic) {
      case "subscription.created":
      case "subscription.updated":
        await syncSubscription(payload as { subscription: SealSubscription });
        await applyReanchorIfPending((payload as { subscription?: SealSubscription }).subscription);
        break;
      case "subscription.cancelled":
      case "subscription.expired":
      case "subscription.paused":
        await syncSubscription(payload as { subscription: SealSubscription });
        break;
      case "billing_attempt.succeeded":
        // Charge succeeded → next ship moved. Refresh the cache.
        await syncSubscription(payload as { subscription: SealSubscription });
        break;
      case "billing_attempt.failed":
        // TODO: notify customer via Klaviyo + log
        break;
      default:
        console.warn(`[seal-webhook] unhandled topic ${eventType}`);
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

/**
 * Verify Seal's HMAC-SHA256 signature. Seal's docs reference a PHP helper but
 * don't pin hex vs base64, so we accept either encoding (constant-time).
 */
function verifySealSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const hex = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const b64 = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return safeEqual(signature, hex) || safeEqual(signature, b64);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * If there's a pending re-anchor intent for this subscription, preserve the
 * customer's prior next-ship date: skip every regenerated pending attempt that
 * falls BEFORE preserve_date so the next charge holds on (or after) it.
 *
 * Idempotent + anti-loop: the skip itself fires another subscription/updated;
 * on that re-entry there are no early attempts left, so we just clear the
 * intent and stop. Re-reads live Seal state (the webhook payload may be a
 * mid-regeneration snapshot).
 */
async function applyReanchorIfPending(subFromPayload?: SealSubscription): Promise<void> {
  const sealSubId = subFromPayload?.id;
  if (!sealSubId) return;

  const sb = supabaseAdmin();
  const { data: intent } = await sb
    .from("subscription_reanchor_intents")
    .select("customer_id, preserve_date, status")
    .eq("seal_subscription_id", String(sealSubId))
    .eq("status", "pending")
    .maybeSingle();
  if (!intent) return;

  const preserve = String(intent.preserve_date).slice(0, 10);

  // Cutoff guard — never re-anchor onto a date already inside 24h.
  if (isWithinCutoff(`${preserve}T13:00:00Z`)) {
    await sb.from("subscription_reanchor_intents").delete().eq("customer_id", intent.customer_id);
    console.log("[seal-webhook] reanchor cleared (within cutoff)", { sealSubId, preserve });
    return;
  }

  // Read fresh state — the payload may be mid-regeneration.
  const sub = await seal.getSubscriptionById(Number(sealSubId));
  if (!sub) return; // transient; another webhook (or the cron/dashboard) retries

  const intermediates = pendingAttemptsBefore(sub, preserve);
  if (intermediates.length === 0) {
    // Either regen hasn't surfaced early attempts yet (0 pending), or they're
    // already gone. If there IS a pending attempt and it's >= preserve, we're
    // done; if there are NO pending at all, regen isn't finished — leave the
    // intent for the next webhook. Only clear when we can see a valid next
    // charge on/after preserve.
    const firstPending = getNextBillingAttempt(sub);
    if (firstPending && firstPending.date.slice(0, 10) >= preserve) {
      await sb.from("subscription_reanchor_intents").delete().eq("customer_id", intent.customer_id);
      console.log("[seal-webhook] reanchor converged", {
        sealSubId,
        preserve,
        nextCharge: firstPending.date.slice(0, 10),
      });
    } else {
      console.log("[seal-webhook] reanchor waiting for regen", {
        sealSubId,
        preserve,
        pending: (sub.billing_attempts ?? []).filter(
          (ba) => !ba.completed_at && !ba.status && !ba.skipped_on,
        ).length,
      });
    }
    return;
  }

  // Skip the early attempts. This fires another subscription/updated, which
  // re-enters here, finds no early attempts, and clears the intent.
  const skipped = await seal.skipIntermediateAttempts(Number(sealSubId), preserve);
  console.log("[seal-webhook] reanchor skipped intermediates", { sealSubId, preserve, skipped });
}

/**
 * Mirror Seal subscription state into Supabase for fast portal queries.
 */
async function syncSubscription(payload: { subscription: SealSubscription }): Promise<void> {
  const s = payload?.subscription;
  if (!s) return;

  const { shopifyAdmin } = await import("@/lib/shopify-admin");
  const customer = await shopifyAdmin
    .graphql<{ customers: { edges: Array<{ node: { id: string } }> } }>(
      `query findByEmail($q: String!) { customers(first: 1, query: $q) { edges { node { id } } } }`,
      { q: `email:"${s.email.replace(/"/g, '\\"')}"` },
    )
    .catch(() => null);
  const customerGid = customer?.customers.edges[0]?.node.id;
  if (!customerGid) {
    console.warn(`[seal-webhook] no Shopify customer for Seal sub ${s.id}`);
    return;
  }
  const customerId = customerGid.replace(/^gid:\/\/shopify\/Customer\//, "");

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

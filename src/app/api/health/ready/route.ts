import { NextResponse, type NextRequest } from "next/server";
import { seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/health/ready — DEEP readiness probe.
 *
 * Unlike /api/health (shallow, public, always 200), this verifies the three
 * upstreams the portal cannot serve a customer without: Supabase, Seal, and
 * Shopify Admin. It is the first thing to curl after every deploy (preview and
 * prod) and the gate the smoke test relies on.
 *
 * PROTECTED — it consumes Seal/Shopify quota and reveals infra, so it must not
 * be public. Pass `?token=<HEALTH_READY_TOKEN>` or a `Bearer <CRON_SECRET>`
 * header. If neither env var is configured, the endpoint stays locked (401).
 *
 * Probe targets are env-driven (no hardcoded ids):
 *   HEALTH_PROBE_SEAL_SUB_ID    — a known-good Seal subscription id
 *   HEALTH_PROBE_CUSTOMER_ID    — a known-good Shopify customer GID
 */
type Check = { ok: boolean; detail?: string };

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const expectedToken = process.env.HEALTH_READY_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");

  const tokenOk = !!expectedToken && token === expectedToken;
  const cronOk = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!tokenOk && !cronOk) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const checks: Record<string, Check> = {};

  // Supabase — trivial reachable query (proves DB + region placement).
  try {
    const sb = supabaseAdmin();
    const { error } = await sb.from("subscriptions").select("customer_id").limit(1);
    checks.supabase = { ok: !error, detail: error?.message };
  } catch (e) {
    checks.supabase = { ok: false, detail: (e as Error).message };
  }

  // Seal — 1 round-trip to a known sub (proves SEAL_API_TOKEN + reachability).
  try {
    const probeSub = process.env.HEALTH_PROBE_SEAL_SUB_ID;
    if (!probeSub) {
      checks.seal = { ok: false, detail: "HEALTH_PROBE_SEAL_SUB_ID not set" };
    } else {
      const sub = await seal.getSubscriptionById(Number(probeSub));
      checks.seal = { ok: !!sub, detail: sub ? undefined : "probe sub not found" };
    }
  } catch (e) {
    checks.seal = { ok: false, detail: (e as Error).message };
  }

  // Shopify Admin — resolve a known customer email (proves token + scopes).
  try {
    const probeCustomer = process.env.HEALTH_PROBE_CUSTOMER_ID;
    if (!probeCustomer) {
      checks.shopify = { ok: false, detail: "HEALTH_PROBE_CUSTOMER_ID not set" };
    } else {
      const email = await shopifyAdmin.getCustomerEmail(probeCustomer);
      checks.shopify = { ok: !!email, detail: email ? undefined : "no email resolved" };
    }
  } catch (e) {
    checks.shopify = { ok: false, detail: (e as Error).message };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    {
      ok,
      checks,
      region: process.env.VERCEL_REGION ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}

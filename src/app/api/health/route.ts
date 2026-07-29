import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/health — public, unauthenticated. For uptime probes.
 *
 * This used to return a static `{ ok: true }`, which made it a liar: on
 * 2026-06-08 Supabase was paused, the portal's auth was down with it (bearer
 * and OAuth sessions both live in `auth_sessions`), customers saw
 * `gateway_timeout` on CUENTA, and this endpoint kept answering green. A health
 * check that cannot fail is not a health check.
 *
 * Supabase is the only dependency worth probing here: a Seal or Shopify blip is
 * a degradation of one surface, Supabase being down means nobody can log in.
 */

/** This route is public, so don't let a prober turn it into a free DB hammer. */
const CACHE_MS = 15_000;

let cached: { at: number; supabase: "ok" | "down"; detail: string | null } | null = null;

async function checkSupabase(): Promise<{ supabase: "ok" | "down"; detail: string | null }> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return { supabase: cached.supabase, detail: cached.detail };
  }
  let supabase: "ok" | "down" = "ok";
  let detail: string | null = null;
  try {
    // One indexed row. supabase-js turns a timed-out fetch (5s deadline, see
    // lib/supabase.ts) into `{ error }` instead of throwing, so both the error
    // branch and the catch matter.
    const { error } = await supabaseAdmin()
      .from("auth_sessions")
      .select("customer_id")
      .limit(1);
    if (error) {
      supabase = "down";
      detail = error.message;
    }
  } catch (err) {
    supabase = "down";
    detail = err instanceof Error ? err.message : String(err);
  }
  cached = { at: Date.now(), supabase, detail };
  return { supabase, detail };
}

export async function GET() {
  const { supabase, detail } = await checkSupabase();
  const ok = supabase === "ok";
  return NextResponse.json(
    {
      ok,
      service: "lit-portal",
      timestamp: new Date().toISOString(),
      checks: { supabase },
      ...(detail ? { detail } : {}),
    },
    // Non-200 so an uptime probe actually pages someone. Anything that only
    // reads the body still sees `ok: false`.
    { status: ok ? 200 : 503 },
  );
}

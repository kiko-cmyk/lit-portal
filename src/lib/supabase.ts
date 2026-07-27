/**
 * Supabase client.
 *
 * - `supabaseAdmin`: service-role client used by API routes. Bypasses RLS.
 *   NEVER expose this to the browser.
 *
 * Note: there is intentionally NO anon client. All DB access goes through
 * server-side API routes with the service role; the anon key is never used,
 * so it never ships to / runs in the browser. (A previous unused `supabaseAnon`
 * helper was removed 2026-06-30 to keep that invariant explicit.)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { fetchDeadline } from "./http-timeout";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Deadline for every PostgREST call (incident 2026-07-27, see
// lib/http-timeout.ts). supabase-js passes no signal of its own, so a paused or
// wedged project used to mean a socket that never answered — the documented
// cause of the 2026-06-08 "gateway_timeout" on CUENTA. 5s is ~40x a healthy
// query (~120ms) and well inside the App Proxy's ~10s patience. supabase-js
// converts a rejected fetch into `{ error }` rather than throwing, so the
// existing `if (error)` branches keep working and fire-and-forget writes cannot
// become unhandled rejections.
const SUPABASE_TIMEOUT_MS = 5_000;

let _admin: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!_admin) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }
    _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => {
          const { signal } = fetchDeadline(SUPABASE_TIMEOUT_MS, init?.signal ?? null);
          return fetch(input, { ...init, signal });
        },
      },
    });
  }
  return _admin;
}

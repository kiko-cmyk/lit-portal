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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _admin: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!_admin) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }
    _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

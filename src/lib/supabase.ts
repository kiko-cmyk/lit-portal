/**
 * Supabase clients.
 *
 * - `supabaseAdmin`: service-role client used by API routes. Bypasses RLS.
 *   NEVER expose this to the browser.
 * - `supabaseAnon`: anon client. Reserved for any browser-side helper. Today
 *   we don't use it (all DB access goes through API routes), but kept for
 *   completeness.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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

let _anon: SupabaseClient | null = null;

export function supabaseAnon(): SupabaseClient {
  if (!_anon) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
    }
    _anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
  }
  return _anon;
}

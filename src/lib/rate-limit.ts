import { alertSlackError } from "@/lib/alert";
import { ApiHttpError } from "@/lib/api-helpers";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Fixed-window rate limiter backed by Supabase Postgres function
 * `rate_limit_check`. One bucket per (subject, endpoint).
 *
 * Audit 2026-05-21 finding #13. Pre-fix no endpoint had any rate
 * limit; mutations like /api/subscription/extras (accumulates
 * paid items on a sub) and /api/subscription/plan (3+ Seal mutations
 * per call) were vulnerable to abuse + DoS of Seal quota.
 *
 * In NODE_ENV !== "production" the limiter is a no-op so local
 * dev / preview deploys never accidentally lock testers out.
 */

export interface RateLimit {
  /** Max requests per window. */
  limit: number;
  /** Window length, ms. */
  windowMs: number;
}

const DEV = process.env.NODE_ENV !== "production";

/**
 * Check + increment the bucket. Throws `ApiHttpError(429)` when the
 * caller is over the limit. The error carries `retry_after_sec` in
 * the message so the caller can surface a "try again in N s" UX.
 *
 * Subject: typically the Shopify customer_id. For pre-auth endpoints
 * pass `ip:<remote>`. The function deduplicates by full (subject,
 * endpoint) pair so multiple endpoints don't share quota.
 */
export async function enforceRateLimit(
  subject: string,
  endpoint: string,
  cfg: RateLimit,
): Promise<void> {
  if (DEV) return;
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("rate_limit_check", {
    p_subject: subject,
    p_endpoint: endpoint,
    p_limit: cfg.limit,
    p_window_ms: cfg.windowMs,
  });
  if (error) {
    // The limiter is an abuse THROTTLE, not the auth boundary (that's the
    // OIDC/JWKS session check). So we FAIL OPEN on a transient RPC/DB blip:
    // better to briefly under-throttle than to lock legitimate customers out
    // of their portal over a hiccup — this matters most on login, where
    // fail-closed would lock people out on a DB blip. But no longer SILENTLY:
    // alert so a persistent limiter outage is visible instead of a blind spot.
    // (Audit 2026-06-30 / Kiko.)
    console.warn("[rate-limit] rpc error, allowing:", error);
    alertSlackError({
      path: `/rate-limit/${endpoint}`,
      code: "rate_limit_rpc_error",
      msg: `limiter failed open · subject=${subject} · ${error.message ?? String(error)}`,
    });
    return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) {
    const retry = row?.retry_after_sec ?? 60;
    throw new ApiHttpError(
      429,
      "rate_limited",
      `Too many requests. Retry in ${retry}s.`,
    );
  }
}

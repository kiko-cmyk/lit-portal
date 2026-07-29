import { NextResponse, type NextRequest } from "next/server";
import {
  buildAuthorizeUrl,
  endSessionUrl,
  idTokenIsFresh,
  SIGNED_OUT_PATH,
} from "@/lib/customer-oauth";
import type { Lang } from "@/lib/portal-link";
import { enforceRateLimit } from "@/lib/rate-limit";
import { hashSessionId } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /apps/portal/api/auth/logout
 *
 * Signs the customer out for real, which means killing TWO independent
 * sessions:
 *
 *   1. Ours — the `auth_sessions` row (deleted here) plus the localStorage
 *      token (dropped by the caller).
 *   2. Shopify's Customer Account session — a cookie we cannot touch. Only
 *      Shopify's OIDC `end_session` endpoint ends it, and that endpoint
 *      demands a valid `id_token_hint`: no hint is a 400, a bad hint is a
 *      401 (both measured against tracking.litsalt.com on 2026-07-29).
 *
 * Killing only ours is what the portal did until today, and it is why a
 * customer stuck in the WRONG Shopify account could never get out: with
 * Shopify's session still alive, the next login silently re-authenticates
 * the same customer and never asks for an email.
 *
 * ── Where the fresh id_token comes from ──
 *
 * Not from the refresh grant. Shopify's refresh response is typed
 * `Omit<AccessTokenResponse, 'id_token'>` — the id_token is minted once, at
 * the authorization_code exchange, and never renewed (Hydrogen carries the
 * original forward by hand for exactly this reason). Since ours expires in
 * ~10 minutes and portal sessions last 14 days, the stored one is stale for
 * essentially every real logout. Storing a refresh_token would buy nothing.
 *
 * So we mint a brand new one with `prompt=none`: a full authorize round trip
 * that shows the customer no UI at all. If Shopify still has a session it
 * hands back a code (→ callback exchanges it → fresh id_token → end_session);
 * if it does not, it answers `error=login_required`, which means there is
 * nothing left to log out of and the callback lands them on the signed-out
 * page. Either branch ends correctly. See /api/auth/callback.
 *
 * ── Response ──
 *
 * `{ logoutUrl }`, unchanged, because CancelTakeover has depended on this
 * shape since May. The caller MUST follow it as a browser navigation
 * (window.location), never fetch it: Shopify's logout route rejects any
 * Accept header other than text/html with a 406 and leaves the session
 * alive, which looks exactly like success.
 *
 * Idempotent: no session, an unknown token, a Supabase blip — all still
 * return a usable URL. Better to over-log-out than to strand someone.
 */

interface LogoutResponse {
  logoutUrl: string;
}

export async function POST(req: NextRequest): Promise<NextResponse<LogoutResponse>> {
  const lang: Lang = req.nextUrl.searchParams.get("lang") === "en" ? "en" : "es";
  const signedOutPath = SIGNED_OUT_PATH[lang];

  // Unauthenticated endpoint (the token it takes may well be garbage), so
  // throttle by IP like /login does. Each call costs a Supabase read plus a
  // delete. 20/min is far past any human: a real customer signs out once.
  // The limiter fails open on a DB blip by design, so this can't become the
  // reason someone is unable to leave an account.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  try {
    await enforceRateLimit(`ip:${ip}`, "logout", { limit: 20, windowMs: 60_000 });
  } catch {
    // Hand back the local landing page instead of a 429 body the FE would
    // have to special-case. The customer's own token is cleared client-side
    // either way, so they end up signed out of the portal regardless.
    return NextResponse.json({ logoutUrl: signedOutPath });
  }

  // X-LIT-Session is the live path — the FE moved to it on 2026-05-21 because
  // App Proxy intercepts Authorization on POST/PATCH/DELETE. Bearer stays for
  // back-compat. (Pre-fix this read Bearer only, so the header the FE actually
  // sent never reached the lookup and logout was a silent no-op.)
  const custom = req.headers.get("x-lit-session")?.trim();
  let sessionId: string | null = custom || null;
  if (!sessionId) {
    const auth = req.headers.get("authorization");
    sessionId =
      auth && auth.toLowerCase().startsWith("bearer ")
        ? auth.slice(7).trim() || null
        : null;
  }

  // Read the id_token BEFORE deleting the row: on the rare fast path (signing
  // out within ~10 min of signing in) it is still usable as a hint and saves
  // the whole prompt=none round trip.
  let idToken: string | null = null;
  if (sessionId) {
    try {
      const sb = supabaseAdmin();
      const tokenHash = hashSessionId(sessionId);
      const { data } = await sb
        .from("auth_sessions")
        .select("id_token")
        .eq("session_id_hash", tokenHash)
        .maybeSingle();
      idToken = (data?.id_token as string | null) ?? null;
      // Best-effort delete. A failure here is not fatal: the customer's local
      // token is dropped either way and the row dies with its 14-day TTL.
      await sb.from("auth_sessions").delete().eq("session_id_hash", tokenHash);
    } catch (e) {
      console.warn("[auth-logout] supabase op failed", e);
    }
  }

  if (idToken && idTokenIsFresh(idToken)) {
    return NextResponse.json({ logoutUrl: endSessionUrl(idToken) });
  }

  const clientId = process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;
  if (!clientId) {
    // Misconfigured environment. Our session is already gone, so the honest
    // move is to land them on the signed-out page rather than pretend we
    // reached Shopify.
    console.error("[auth-logout] SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID missing");
    return NextResponse.json({ logoutUrl: signedOutPath });
  }

  return NextResponse.json({
    logoutUrl: buildAuthorizeUrl({
      clientId,
      returnTo: signedOutPath,
      prompt: "none",
      logout: true,
    }),
  });
}

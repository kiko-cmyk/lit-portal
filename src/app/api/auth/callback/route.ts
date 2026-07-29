import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  endSessionUrl,
  exchangeCodeForTokens,
  SIGNED_OUT_PATH,
  verifyState,
  type TokenResponse,
} from "@/lib/customer-oauth";
import { IdTokenVerificationError, verifyShopifyIdToken } from "@/lib/oidc";
import { isSafeRelativePath } from "@/lib/safe-path";
import { hashSessionId } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/auth/callback
 *
 * Shopify Customer Account API redirige aquí después del login con
 * `?code=<auth_code>&state=<jwt>`. Lo que hacemos:
 *
 *   1. Validamos la firma del JWT (state) — incluye el code_verifier PKCE.
 *   2. POST a `tracking.litsalt.com/authentication/oauth/token` con
 *      grant_type=authorization_code + code + code_verifier → recibimos
 *      access_token + id_token.
 *   3. Decodificamos el id_token (JWT) para sacar el customer GID.
 *      Extraemos el numeric customer_id (matching el formato que usa
 *      App Proxy en `logged_in_customer_id`).
 *   4. Insertamos una fila en `auth_sessions` con session_id aleatorio →
 *      customer_id. Esto es nuestro propio session store, independiente
 *      de la storefront session de Shopify (que ESTE flow no establece).
 *   5. Redirigimos a /apps/portal/<locale>/auth/handoff?s=<session_id> —
 *      una página cliente que mueve session_id de URL → localStorage y
 *      sigue a /mi-lit. Todo API call posterior llevará el session_id
 *      en Authorization: Bearer <session_id>.
 *
 * Por qué no usamos cookies: Shopify App Proxy strippea Set-Cookie.
 * localStorage es la única forma fiable de persistir el token cliente-
 * side a través del round-trip por Shopify.
 *
 * SEGUNDO USO, desde 2026-07-29 — cerrar sesión. /api/auth/logout manda al
 * cliente por `prompt=none` (sin UI) con el claim `lo` en el state. Ese caso
 * NO crea sesión: gasta el id_token recién emitido como `id_token_hint` del
 * end_session de Shopify, que es la única forma de matar la sesión de
 * Customer Accounts. Cada rama que sigue tiene que distinguir los dos flujos,
 * porque terminar un logout creando una sesión volvería a meter al cliente en
 * la cuenta de la que acaba de salir.
 */

const PORTAL_BASE = "https://litsalt.com";
const FALLBACK_RETURN = "/apps/portal/es/cuenta";
const HANDOFF_PATH = "/apps/portal/es/auth/handoff";

// 14 días — bajado de 30d el 2026-05-22 (audit recomendaba ≤7, este
// es el compromiso). Refrescamos last_used_at en cada request, asi
// que clientes activos no se expulsan por inactividad ligera.
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

export async function GET(req: NextRequest) {
  const clientId = process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;
  if (!process.env.SHOPIFY_API_SECRET || !clientId) {
    return new NextResponse(
      "Server misconfigured: SHOPIFY_API_SECRET or SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID missing",
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Verify the state BEFORE handling `error`, because the state is what tells
  // us which flow this is. A logout that Shopify answers with an error must
  // land on the signed-out page, not on the login-error path — and the most
  // common answer to a logout round trip IS an error: `login_required` is
  // exactly what `prompt=none` returns when there is no Shopify session left,
  // which is a successful outcome for us, not a failure.
  const payload = state ? verifyState(state) : null;
  const isLogout = payload?.lo === 1;
  const logoutLanding = () => {
    const path =
      payload && isSafeRelativePath(payload.r) ? payload.r : SIGNED_OUT_PATH.es;
    return NextResponse.redirect(`${PORTAL_BASE}${path}`);
  };

  if (error) {
    if (isLogout) {
      // Nothing to end (no Customer Account session) or Shopify refused the
      // silent round trip. Our own session is already deleted by the logout
      // route, so the customer IS signed out of the portal either way.
      console.log("[oauth-callback] logout round trip returned", { error });
      return logoutLanding();
    }
    console.warn("[oauth-callback] Shopify returned error", {
      error,
      description: errorDescription,
    });
    return NextResponse.redirect(
      `${PORTAL_BASE}${FALLBACK_RETURN}?login_error=${encodeURIComponent(error)}`,
    );
  }

  if (!code || !state) {
    return new NextResponse("Missing code or state in OAuth callback", {
      status: 400,
    });
  }

  if (!payload) {
    console.error("[oauth-callback] state JWT verification failed");
    return new NextResponse(
      "Invalid OAuth state. Please try logging in again.",
      { status: 400 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    if (isLogout) return logoutLanding();
    return new NextResponse(
      "OAuth state expired. Please try logging in again.",
      { status: 400 },
    );
  }

  // ─────── 1) Token exchange ───────
  let tokens: TokenResponse;
  try {
    tokens = await exchangeCodeForTokens({
      clientId,
      code,
      codeVerifier: payload.v,
    });
  } catch (e) {
    console.error("[oauth-callback] token exchange failed", e);
    // On a logout there is nothing to retry and nothing to show: our session
    // is gone, so land them on the signed-out page. Shopify's own session may
    // survive, which is exactly the pre-2026-07-29 behaviour, never worse.
    if (isLogout) return logoutLanding();
    return new NextResponse("Token exchange failed", { status: 502 });
  }

  // ─────── 2) Verify id_token against Shopify's JWKS ───────
  // Audit 2026-05-21 finding #4: pre-fix we just decoded the JWT
  // without checking the signature, trusting "the network path".
  // Now we verify signature (RS256), issuer, audience, expiry, and
  // bind the nonce we sent at /authorize against the claim Shopify
  // echoes back. Any mismatch → 401 and login is rejected.
  let customerId: string;
  let customerEmail: string | null = null;
  try {
    const verified = await verifyShopifyIdToken(tokens.id_token, {
      clientId,
      expectedNonce: payload.nce,
    });
    // Shopify id_tokens carry the customer as a GID in `sub` —
    // e.g. `gid://shopify/Customer/12345`. Other shops sometimes
    // return just the numeric ID. Handle both.
    const numericMatch = verified.sub.match(/(\d+)$/);
    if (!numericMatch) {
      throw new IdTokenVerificationError(
        `id_token sub has no numeric customer id: ${verified.sub}`,
      );
    }
    customerId = numericMatch[1];
    customerEmail = verified.email ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // DEBUG: also decode unverified payload to inspect claims that
    // caused the mismatch. Sensitive info (sub/email) only goes to
    // server log, not to the client.
    let debugClaims: Record<string, unknown> | null = null;
    try {
      const parts = tokens.id_token.split(".");
      if (parts.length === 3) {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        debugClaims = JSON.parse(
          Buffer.from(b64, "base64").toString("utf8"),
        ) as Record<string, unknown>;
      }
    } catch { /* ignore */ }
    console.error("[oauth-callback] id_token verification failed:", msg, {
      claims: debugClaims
        ? {
            iss: debugClaims.iss,
            aud: debugClaims.aud,
            exp: debugClaims.exp,
            iat: debugClaims.iat,
            nonce: debugClaims.nonce,
            nonce_expected: payload.nce,
            sub_present: !!debugClaims.sub,
          }
        : "could_not_decode",
    });
    if (isLogout) return logoutLanding();
    return new NextResponse(
      "Login verification failed. Please try logging in again.",
      { status: 401 },
    );
  }

  // ─────── 2b) Logout round trip ends here ───────
  // The whole point of this detour was to hold a NON-EXPIRED id_token, the
  // one thing Shopify's end_session refuses to work without. Spend it now and
  // stop: creating a session would sign the customer straight back into the
  // account they asked to leave. The 302 matters as much as the URL — Shopify
  // answers a non-text/html Accept with 406 and leaves the session alive, so
  // this must stay a browser navigation and never become a fetch.
  if (isLogout) {
    console.log("[oauth-callback] logout: ending Shopify session", { customerId });
    return NextResponse.redirect(endSessionUrl(tokens.id_token));
  }

  // ─────── 3) Create our own session in Supabase ───────
  // The raw `sessionId` is sent to the FE (URL fragment, then
  // localStorage) and NEVER stored server-side. We persist only
  // its SHA-256 hash (audit 2026-05-21 LOW). Both columns store
  // the hash: `session_id_hash` is what the code reads, and the
  // legacy `session_id` (PK, NOT NULL, no readers) also gets the
  // hash so NO plaintext token is ever written at rest. (The
  // column itself is redundant and pending drop — gated by a
  // verified backup; see master plan 3.6.)
  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  try {
    const sb = supabaseAdmin();
    const sessionIdHash = hashSessionId(sessionId);
    const { error: insertErr } = await sb.from("auth_sessions").insert({
      // Legacy PK column: store the HASH (not the raw token). It has no
      // readers; writing the hash keeps the unique/NOT-NULL PK valid while
      // ensuring no plaintext session token is persisted. See comment above.
      session_id: sessionIdHash,
      session_id_hash: sessionIdHash,
      customer_id: customerId,
      email: customerEmail,
      expires_at: expiresAt.toISOString(),
      // id_token kept for back-compat with the logout flow, but no
      // longer used as id_token_hint (storefront /account/logout
      // path doesn't need it). Will be removed in a follow-up.
      id_token: tokens.id_token,
    });
    if (insertErr) throw insertErr;
  } catch (e) {
    console.error("[oauth-callback] session insert failed", e);
    return new NextResponse("Session storage failed", { status: 500 });
  }

  // ─────── 4) Hand off to client-side page that stores session ───────
  // Audit 2026-05-21 finding #2: pre-fix the redirect used a query
  // string (`?s=<sessionId>`), which leaks via Referer headers,
  // browser history, server logs, and any third-party script that
  // loaded on the handoff page. URL fragments (`#`) are NEVER sent
  // to servers — they live only client-side — so we use that instead.
  // The handoff page reads from `window.location.hash` and clears it
  // with `history.replaceState` before navigating.
  const safeReturn = isSafeRelativePath(payload.r) ? payload.r : FALLBACK_RETURN;
  const handoff = new URL(`${PORTAL_BASE}${HANDOFF_PATH}`);
  // URLSearchParams can't write to the fragment; do it manually.
  // Encode the `to` so a malicious return value can't break out.
  handoff.hash = `s=${encodeURIComponent(sessionId)}&to=${encodeURIComponent(safeReturn)}`;

  // PII sweep 2026-05-21: don't log email or session_id prefix in the
  // happy path. customerId is needed for tracing, expiry for debugging.
  console.log("[oauth-callback] session issued", {
    customerId,
    expires: expiresAt.toISOString(),
  });

  return NextResponse.redirect(handoff.toString());
}


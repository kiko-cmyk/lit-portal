import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { IdTokenVerificationError, verifyShopifyIdToken } from "@/lib/oidc";
import { isSafeRelativePath } from "@/lib/safe-path";
import { getOAuthStateKey } from "@/lib/secrets";
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
 */

const TOKEN_ENDPOINT =
  "https://tracking.litsalt.com/authentication/oauth/token";
const REDIRECT_URI = "https://litsalt.com/apps/portal/api/auth/callback";

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

  if (error) {
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

  const payload = verifyState(getOAuthStateKey(), state);
  if (!payload) {
    console.error("[oauth-callback] state JWT verification failed");
    return new NextResponse(
      "Invalid OAuth state. Please try logging in again.",
      { status: 400 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    return new NextResponse(
      "OAuth state expired. Please try logging in again.",
      { status: 400 },
    );
  }

  // ─────── 1) Token exchange ───────
  let tokens: TokenResponse;
  try {
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: payload.v,
    });
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: tokenBody.toString(),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      console.error("[oauth-callback] token exchange failed", {
        status: tokenRes.status,
        body: body.slice(0, 500),
      });
      return new NextResponse(
        `Token exchange failed (HTTP ${tokenRes.status})`,
        { status: 502 },
      );
    }
    tokens = (await tokenRes.json()) as TokenResponse;
  } catch (e) {
    console.error("[oauth-callback] token exchange exception", e);
    return new NextResponse("Token exchange network error", { status: 502 });
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
    return new NextResponse(
      "Login verification failed. Please try logging in again.",
      { status: 401 },
    );
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

interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface StatePayload {
  v: string;
  r: string;
  nce: string;
  iat: number;
  exp: number;
}

function verifyState(key: Buffer, token: string): StatePayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const data = `${header}.${body}`;
  const expectedSig = base64UrlEncode(
    crypto.createHmac("sha256", key).update(data).digest(),
  );
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64").toString("utf8"),
    ) as StatePayload;
    if (
      typeof payload.v !== "string" ||
      typeof payload.r !== "string" ||
      typeof payload.nce !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}


import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isSafeRelativePath } from "@/lib/safe-path";
import { getOAuthStateKey } from "@/lib/secrets";

/**
 * GET /apps/portal/api/auth/login
 *
 * Inicia el flujo OAuth de Shopify Customer Account API. Redirige al
 * cliente a la pantalla de login de Shopify (tracking.litsalt.com) con
 * nuestro client_id y redirect_uri. Después del login, Shopify rebota
 * directamente a /apps/portal/api/auth/callback — el cliente no pasa
 * nunca por el dashboard de tracking.
 *
 * Flow:
 *   1. Generar PKCE code_verifier/challenge.
 *   2. Empaquetar `verifier + return_to + nonce + exp` en un JWT firmado
 *      con SHOPIFY_API_SECRET y usarlo como `state`. NO usamos cookies
 *      porque Shopify App Proxy strippea Set-Cookie headers; un state
 *      firmado es la única forma fiable de pasar contexto entre el
 *      /login y el /callback.
 *   3. Redirigir a Shopify authorize.
 *
 * Query params soportados:
 *   - return_to (opcional): path relativo del portal al que volver tras
 *     el login. Default: /es/cuenta (Mi LIT es subscriber-only, Cuenta
 *     funciona para todos los clientes incluidos los one-shot).
 */

const SHOPIFY_AUTHORIZE_URL =
  "https://tracking.litsalt.com/authentication/oauth/authorize";

const CLIENT_ID = process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;

const REDIRECT_URI = "https://litsalt.com/apps/portal/api/auth/callback";

// Fallback con prefijo /apps/portal porque return_to viaja con la ruta
// completa (LoginScreen pasa window.location.pathname, que ya incluye
// el App Proxy mount prefix).
const DEFAULT_RETURN_TO = "/apps/portal/es/cuenta";

const STATE_TTL_SECONDS = 600; // 10 min

export async function GET(req: NextRequest) {
  if (!CLIENT_ID || !process.env.SHOPIFY_API_SECRET) {
    return new NextResponse(
      "Server misconfigured: SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID or SHOPIFY_API_SECRET missing",
      { status: 500 },
    );
  }

  // Pre-auth rate limit by IP. Vercel sets x-forwarded-for; fall back
  // to a constant so a missing header doesn't bypass the limit (rare,
  // but defensive). 30/min per IP is generous — bot abuse would hit it
  // well before a real customer does.
  // Resolve to a BARE ip and prefix once below. Previously this was
  // double-prefixed ("ip:ip:...") and the header-less fallback ("ip:unknown")
  // put every header-less caller in one shared bucket. Use || so an empty
  // string from a stray header also falls through to the next source.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  try {
    await enforceRateLimit(`ip:${ip}`, "login", { limit: 30, windowMs: 60_000 });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return new NextResponse(err.message ?? "Rate limited", {
      status: err.status ?? 429,
    });
  }

  const url = new URL(req.url);
  const requestedReturn = url.searchParams.get("return_to") ?? DEFAULT_RETURN_TO;
  const returnTo = isSafeRelativePath(requestedReturn)
    ? requestedReturn
    : DEFAULT_RETURN_TO;

  const codeVerifier = base64UrlEncode(crypto.randomBytes(48));
  const codeChallenge = base64UrlEncode(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );

  // OIDC nonce (audit 2026-05-21 finding #4). Sent to /authorize and
  // bound into the id_token by Shopify; the callback verifies the
  // claim matches `state.nce`. Defends against id_token replay /
  // confused-deputy where a stolen token from one flow is presented
  // to another.
  const nonce = crypto.randomBytes(16).toString("hex");

  // Pack everything into a signed JWT so the callback can recover it
  // without needing cookies (App Proxy strips Set-Cookie headers).
  // Key is HKDF-derived from SHOPIFY_API_SECRET (different label from
  // App Proxy HMAC) so a signing oracle in one context can't be used
  // to forge the other.
  const now = Math.floor(Date.now() / 1000);
  const stateKey = getOAuthStateKey();
  const state = signState(stateKey, {
    v: codeVerifier,
    r: returnTo,
    nce: nonce,
    iat: now,
    exp: now + STATE_TTL_SECONDS,
  });

  const authorizeUrl = new URL(SHOPIFY_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid email");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("nonce", nonce);

  return NextResponse.redirect(authorizeUrl.toString());
}

// ─────────────────────────── JWT-lite ───────────────────────────
//
// Tiny HS256 JWT impl. We avoid pulling in jose/jsonwebtoken just to
// sign/verify a state blob — keeps the bundle small and there are no
// edge-runtime surprises with crypto.subtle on Vercel.

interface StatePayload {
  v: string;   // PKCE code_verifier (caller stores, callback re-uses for token exchange)
  r: string;   // return_to (relative path)
  nce: string; // OIDC nonce — also sent to Shopify /authorize; callback verifies id_token.nonce matches
  iat: number;
  exp: number;
}

function signState(key: Buffer, payload: StatePayload): string {
  const header = base64UrlEncode(
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = base64UrlEncode(
    crypto.createHmac("sha256", key).update(data).digest(),
  );
  return `${data}.${sig}`;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}


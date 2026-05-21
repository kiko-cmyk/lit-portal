import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isSafeRelativePath } from "@/lib/safe-path";

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
 *     el login. Default: /es/mi-lit
 */

const SHOPIFY_AUTHORIZE_URL =
  "https://tracking.litsalt.com/authentication/oauth/authorize";

const CLIENT_ID = process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;

const REDIRECT_URI = "https://litsalt.com/apps/portal/api/auth/callback";

// Fallback con prefijo /apps/portal porque return_to viaja con la ruta
// completa (LoginScreen pasa window.location.pathname, que ya incluye
// el App Proxy mount prefix).
const DEFAULT_RETURN_TO = "/apps/portal/es/mi-lit";

const STATE_TTL_SECONDS = 600; // 10 min

export async function GET(req: NextRequest) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!CLIENT_ID || !secret) {
    return new NextResponse(
      "Server misconfigured: SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID or SHOPIFY_API_SECRET missing",
      { status: 500 },
    );
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

  // Pack everything into a signed JWT so the callback can recover it
  // without needing cookies (App Proxy strips Set-Cookie headers).
  const now = Math.floor(Date.now() / 1000);
  const state = signState(secret, {
    v: codeVerifier,
    r: returnTo,
    n: crypto.randomBytes(8).toString("hex"),
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

  return NextResponse.redirect(authorizeUrl.toString());
}

// ─────────────────────────── JWT-lite ───────────────────────────
//
// Tiny HS256 JWT impl. We avoid pulling in jose/jsonwebtoken just to
// sign/verify a state blob — keeps the bundle small and there are no
// edge-runtime surprises with crypto.subtle on Vercel.

interface StatePayload {
  v: string; // PKCE code_verifier (caller stores, callback re-uses for token exchange)
  r: string; // return_to (relative path)
  n: string; // nonce (CSRF safety)
  iat: number;
  exp: number;
}

function signState(secret: string, payload: StatePayload): string {
  const header = base64UrlEncode(
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = base64UrlEncode(
    crypto.createHmac("sha256", secret).update(data).digest(),
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


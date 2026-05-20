import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/**
 * GET /apps/portal/api/auth/login
 *
 * Inicia el flujo OAuth de Shopify Customer Account API. Redirige al
 * cliente a la pantalla de login de Shopify (tracking.litsalt.com) con
 * nuestro client_id y redirect_uri. Después del login, Shopify rebota
 * directamente a /apps/portal/auth/callback — el cliente no pasa nunca
 * por el dashboard de tracking.
 *
 * Flow:
 *   1. Generar state aleatorio + PKCE code_verifier/challenge.
 *   2. Guardar state + verifier + return_to en cookies httpOnly de corta
 *      duración (10 min).
 *   3. Construir URL OAuth de Shopify y redirigir.
 *
 * Query params soportados:
 *   - return_to (opcional): path relativo del portal al que volver tras
 *     el login. Default: /es/mi-lit
 */

const SHOPIFY_AUTHORIZE_URL =
  "https://tracking.litsalt.com/authentication/oauth/authorize";

const CLIENT_ID =
  process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID ?? process.env.SHOPIFY_API_KEY;

const REDIRECT_URI = "https://litsalt.com/apps/portal/auth/callback";

const DEFAULT_RETURN_TO = "/es/mi-lit";

// Cookies son litsalt.com-scoped porque Next.js sirve estas rutas desde
// nuestro dominio (via App Proxy). 10 min vida.
const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  maxAge: 600,
  path: "/",
};

export async function GET(req: NextRequest) {
  if (!CLIENT_ID) {
    return new NextResponse(
      "Server misconfigured: SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID missing",
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  // Sanitize return_to: only allow relative paths within the portal.
  const requestedReturn = url.searchParams.get("return_to") ?? DEFAULT_RETURN_TO;
  const returnTo = isSafeRelativePath(requestedReturn)
    ? requestedReturn
    : DEFAULT_RETURN_TO;

  const state = crypto.randomBytes(24).toString("hex");
  const codeVerifier = base64UrlEncode(crypto.randomBytes(48));
  const codeChallenge = base64UrlEncode(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );

  const authorizeUrl = new URL(SHOPIFY_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  // Scope mínimo: solo necesitamos identificación. Para llamar al
  // Customer Account API añadiríamos `customer-account-api:full`,
  // pero no hace falta (toda la lectura/escritura de subs va por
  // Admin API + Seal, ya autenticado server-side).
  authorizeUrl.searchParams.set("scope", "openid email");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const response = NextResponse.redirect(authorizeUrl.toString());
  response.cookies.set("lit_oauth_state", state, COOKIE_OPTS);
  response.cookies.set("lit_oauth_verifier", codeVerifier, COOKIE_OPTS);
  response.cookies.set("lit_oauth_return_to", returnTo, COOKIE_OPTS);
  return response;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Accept only relative paths that stay within the portal. Reject
 * `//evil.com`, `https://evil.com`, etc.
 */
function isSafeRelativePath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.startsWith("//")) return false;
  if (p.includes("://")) return false;
  return true;
}

import { NextResponse, type NextRequest } from "next/server";
import { buildAuthorizeUrl } from "@/lib/customer-oauth";
import { enforceRateLimit } from "@/lib/rate-limit";
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
 * Los pasos 1 y 2 viven en `lib/customer-oauth.buildAuthorizeUrl`, que
 * comparte con /api/auth/logout (que construye la misma URL con
 * `prompt=none` para poder cerrar la sesión de Shopify).
 *
 * Query params soportados:
 *   - return_to (opcional): path relativo del portal al que volver tras
 *     el login. Default: /es/cuenta (Mi LIT es subscriber-only, Cuenta
 *     funciona para todos los clientes incluidos los one-shot).
 */

const CLIENT_ID = process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;

// Fallback con prefijo /apps/portal porque return_to viaja con la ruta
// completa (LoginScreen pasa window.location.pathname, que ya incluye
// el App Proxy mount prefix).
const DEFAULT_RETURN_TO = "/apps/portal/es/cuenta";

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

  return NextResponse.redirect(
    buildAuthorizeUrl({ clientId: CLIENT_ID, returnTo }),
  );
}

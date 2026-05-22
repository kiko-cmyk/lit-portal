import { NextResponse, type NextRequest } from "next/server";
import { hashSessionId } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

const OIDC_END_SESSION = "https://tracking.litsalt.com/authentication/logout";
const STOREFRONT_LOGOUT = "https://litsalt.com/account/logout";
const POST_LOGOUT_REDIRECT = "https://litsalt.com/apps/portal/es/mi-lit";

/**
 * POST /apps/portal/api/auth/logout
 *
 * Cierra la sesión del portal completamente:
 *
 *   1. Lee el Bearer token (session_id) del header Authorization.
 *   2. Recupera id_token guardado en auth_sessions (necesario para
 *      `id_token_hint` del logout OIDC; sin él Shopify muestra un
 *      "are you sure?" extra que rompe el flow).
 *   3. Borra la fila de auth_sessions.
 *   4. Devuelve la URL del logout endpoint de Shopify para que el FE
 *      redirija ahí. Tras Shopify cerrar la sesión OIDC, vuelve a
 *      /apps/portal/es/mi-lit (registrado como post_logout_redirect_uri
 *      en el Headless channel).
 *
 * No-op idempotente: si no hay Bearer o la sesión ya está borrada,
 * devolvemos igualmente la URL del logout (el FE limpia localStorage
 * y redirige). Mejor cerrar de más que dejar sesiones huérfanas.
 */

// Logout strategy (re-revised 2026-05-22):
//   1. If id_token is still within its (~10min) validity window, use
//      Shopify OIDC end_session — that kills the Customer Account API
//      session AND will properly redirect to post_logout_redirect_uri.
//   2. Otherwise fall back to storefront /account/logout (clears
//      _shopify_essential cookie, which App Proxy reads for
//      logged_in_customer_id). Less complete than OIDC but better
//      than nothing — and many flows hit logout shortly after login.

interface LogoutResponse {
  logoutUrl: string;
}

export async function POST(req: NextRequest): Promise<NextResponse<LogoutResponse>> {
  // Read X-LIT-Session first (the active path — the FE moved to this header
  // on 2026-05-21 because Shopify App Proxy intercepts Authorization on
  // POST/PATCH/DELETE). Fall back to Authorization: Bearer only for
  // back-compat. Pre-fix this was Bearer-only, which meant the FE-issued
  // X-LIT-Session never reached the lookup → logout was a no-op and
  // sessions lived their full 30d (now 14d) TTL even after the user
  // clicked "Cerrar sesión".
  const custom = req.headers.get("x-lit-session")?.trim();
  let sessionId: string | null = custom || null;
  if (!sessionId) {
    const auth = req.headers.get("authorization");
    sessionId =
      auth && auth.toLowerCase().startsWith("bearer ")
        ? auth.slice(7).trim() || null
        : null;
  }

  // Read id_token BEFORE deleting the row so we can use it as
  // id_token_hint when still valid. Hashed lookup since 2026-05-22.
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
      // Best-effort delete.
      await sb.from("auth_sessions").delete().eq("session_id_hash", tokenHash);
    } catch (e) {
      console.warn("[auth-logout] supabase op failed", e);
    }
  }

  // If the id_token is still within its validity window, use the
  // proper OIDC end_session endpoint — it kills the Customer Account
  // API session (the one Shopify uses to re-auth via App Proxy).
  // Otherwise fall back to the storefront /account/logout, which at
  // least clears the storefront `_shopify_essential` cookie.
  const FRESH_BUFFER_SEC = 30;
  const tokenStillValid = idToken ? idTokenStillValid(idToken, FRESH_BUFFER_SEC) : false;

  let logoutUrl: URL;
  if (tokenStillValid && idToken) {
    logoutUrl = new URL(OIDC_END_SESSION);
    logoutUrl.searchParams.set("id_token_hint", idToken);
    logoutUrl.searchParams.set("post_logout_redirect_uri", POST_LOGOUT_REDIRECT);
  } else {
    logoutUrl = new URL(STOREFRONT_LOGOUT);
    logoutUrl.searchParams.set("return_url", "/apps/portal/es/mi-lit");
  }

  return NextResponse.json({ logoutUrl: logoutUrl.toString() });
}

/**
 * Decode (no verify) the id_token to check exp. We're trusting our
 * own auth_sessions row to have a valid token; verifying here is
 * redundant. Returns true if exp is at least `bufferSec` in the future.
 */
function idTokenStillValid(idToken: string, bufferSec: number): boolean {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return false;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      Buffer.from(b64, "base64").toString("utf8"),
    ) as { exp?: number };
    if (typeof payload.exp !== "number") return false;
    return payload.exp > Math.floor(Date.now() / 1000) + bufferSec;
  } catch {
    return false;
  }
}

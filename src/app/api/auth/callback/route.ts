import { NextResponse, type NextRequest } from "next/server";

/**
 * GET /apps/portal/api/auth/callback
 *
 * Shopify Customer Account API redirige aquí después del login con
 * `?code=<auth_code>&state=<state>`. Validamos el state contra el cookie
 * que sembramos en /api/auth/login y redirigimos al portal.
 *
 * No intercambiamos el `code` por un access token porque no llamamos al
 * Customer Account API desde nuestro frontend — toda la lectura/escritura
 * de la suscripción va por Admin API + Seal con auth server-side. El
 * efecto del login es que Shopify ha sembrado el cookie de sesión de
 * customer en *.litsalt.com, y el App Proxy verá `logged_in_customer_id`
 * cuando navegue a /apps/portal/mi-lit.
 *
 * Errores comunes:
 *   - state mismatch → posible CSRF, abortamos.
 *   - falta el code → Shopify abortó el login (usuario canceló).
 */

const PORTAL_BASE = "https://litsalt.com/apps/portal";
const FALLBACK_RETURN = "/es/mi-lit";

const CLEAR_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  maxAge: 0,
  path: "/",
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Shopify devuelve `error=...` si el usuario cancela o algo falla en
  // su lado. Mandamos al portal con un flag para que la FE muestre
  // mensaje, en lugar de un 500 frío.
  if (error) {
    console.warn("[oauth-callback] Shopify returned error", {
      error,
      description: errorDescription,
    });
    const redirect = NextResponse.redirect(
      `${PORTAL_BASE}${FALLBACK_RETURN}?login_error=${encodeURIComponent(error)}`,
    );
    clearOauthCookies(redirect);
    return redirect;
  }

  if (!code || !state) {
    return new NextResponse("Missing code or state in OAuth callback", {
      status: 400,
    });
  }

  const cookieState = req.cookies.get("lit_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    console.error("[oauth-callback] state mismatch", {
      cookiePresent: !!cookieState,
      paramPresent: !!state,
    });
    return new NextResponse(
      "Invalid OAuth state. Please try logging in again.",
      { status: 400 },
    );
  }

  const returnTo = req.cookies.get("lit_oauth_return_to")?.value ?? FALLBACK_RETURN;
  const safeReturn = isSafeRelativePath(returnTo) ? returnTo : FALLBACK_RETURN;

  // Trust Shopify to have set the customer session cookie on the parent
  // domain (.litsalt.com) during the login flow. When the browser
  // navigates to /apps/portal/<safeReturn>, the App Proxy will see
  // `logged_in_customer_id` automatically.
  const redirect = NextResponse.redirect(`${PORTAL_BASE}${safeReturn}`);
  clearOauthCookies(redirect);
  return redirect;
}

function clearOauthCookies(res: NextResponse) {
  res.cookies.set("lit_oauth_state", "", CLEAR_COOKIE_OPTS);
  res.cookies.set("lit_oauth_verifier", "", CLEAR_COOKIE_OPTS);
  res.cookies.set("lit_oauth_return_to", "", CLEAR_COOKIE_OPTS);
}

function isSafeRelativePath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.startsWith("//")) return false;
  if (p.includes("://")) return false;
  return true;
}

import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/**
 * GET /apps/portal/api/auth/callback
 *
 * Shopify Customer Account API redirige aquí después del login con
 * `?code=<auth_code>&state=<jwt>`. Validamos la firma del JWT (state) y
 * redirigimos al portal.
 *
 * No intercambiamos el `code` por un access token porque no llamamos al
 * Customer Account API desde nuestro frontend — toda la lectura/escritura
 * de la suscripción va por Admin API + Seal con auth server-side. El
 * efecto del login es que Shopify ha sembrado el cookie de sesión de
 * customer en *.litsalt.com, y el App Proxy verá `logged_in_customer_id`
 * cuando navegue a /apps/portal/mi-lit.
 *
 * Por qué JWT y no cookies: Shopify App Proxy strippea Set-Cookie
 * headers. Para pasar contexto entre /login y /callback usamos un JWT
 * firmado con SHOPIFY_API_SECRET dentro del propio param `state`.
 */

const PORTAL_BASE = "https://litsalt.com/apps/portal";
const FALLBACK_RETURN = "/es/mi-lit";

export async function GET(req: NextRequest) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    return new NextResponse("Server misconfigured: SHOPIFY_API_SECRET missing", {
      status: 500,
    });
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

  const payload = verifyState(secret, state);
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

  const safeReturn = isSafeRelativePath(payload.r) ? payload.r : FALLBACK_RETURN;

  // We trust Shopify to have set the customer session cookie on the
  // parent domain (.litsalt.com) during the login flow. When the browser
  // navigates to /apps/portal/<safeReturn>, the App Proxy will see
  // `logged_in_customer_id` automatically. No token exchange needed
  // because we don't call Customer Account API from the FE.
  return NextResponse.redirect(`${PORTAL_BASE}${safeReturn}`);
}

interface StatePayload {
  v: string;
  r: string;
  n: string;
  iat: number;
  exp: number;
}

function verifyState(secret: string, token: string): StatePayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const data = `${header}.${body}`;
  const expectedSig = base64UrlEncode(
    crypto.createHmac("sha256", secret).update(data).digest(),
  );
  // Constant-time compare
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
      typeof payload.n !== "string" ||
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

function isSafeRelativePath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.startsWith("//")) return false;
  if (p.includes("://")) return false;
  return true;
}

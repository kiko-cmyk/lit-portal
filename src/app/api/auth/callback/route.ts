import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
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
const FALLBACK_RETURN = "/apps/portal/es/mi-lit";
const HANDOFF_PATH = "/apps/portal/es/auth/handoff";

// 30 días — cliente queda logueado tanto como una sesión típica de
// Shopify. Refrescamos last_used_at en cada request para no expulsar
// usuarios activos.
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function GET(req: NextRequest) {
  const secret = process.env.SHOPIFY_API_SECRET;
  const clientId = process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;
  if (!secret || !clientId) {
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

  // ─────── 2) Decode id_token to recover customer identity ───────
  let customerId: string;
  let customerEmail: string | null = null;
  try {
    const claims = decodeJwtPayload(tokens.id_token);
    // Shopify id_tokens carry the customer as a GID in `sub` —
    // e.g. `gid://shopify/Customer/12345`. Other shops sometimes
    // return just the numeric ID. Handle both.
    const sub = String(claims.sub ?? "");
    const numericMatch = sub.match(/(\d+)$/);
    if (!numericMatch) {
      throw new Error(`id_token sub has no numeric customer id: ${sub}`);
    }
    customerId = numericMatch[1];
    if (typeof claims.email === "string") customerEmail = claims.email;
  } catch (e) {
    console.error("[oauth-callback] id_token decode failed", e);
    return new NextResponse("Could not parse id_token", { status: 502 });
  }

  // ─────── 3) Create our own session in Supabase ───────
  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  try {
    const sb = supabaseAdmin();
    const { error: insertErr } = await sb.from("auth_sessions").insert({
      session_id: sessionId,
      customer_id: customerId,
      email: customerEmail,
      expires_at: expiresAt.toISOString(),
      // Persist the id_token so /api/auth/logout can use it as
      // `id_token_hint` to skip Shopify's "are you sure?" interstitial.
      id_token: tokens.id_token,
    });
    if (insertErr) throw insertErr;
  } catch (e) {
    console.error("[oauth-callback] session insert failed", e);
    return new NextResponse("Session storage failed", { status: 500 });
  }

  // ─────── 4) Hand off to client-side page that stores session ───────
  // The handoff page lives under [locale]/auth/handoff. It reads `?s=`
  // from the URL, writes to localStorage, then routes to the final
  // destination. We can't set localStorage from a server redirect, so
  // a one-page client bounce is the cleanest pattern.
  const safeReturn = isSafeRelativePath(payload.r) ? payload.r : FALLBACK_RETURN;
  const handoff = new URL(`${PORTAL_BASE}${HANDOFF_PATH}`);
  handoff.searchParams.set("s", sessionId);
  handoff.searchParams.set("to", safeReturn);

  console.log("[oauth-callback] session issued", {
    customerId,
    email: customerEmail,
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

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  // We intentionally don't verify the id_token signature. The token came
  // from a direct server-side POST to Shopify's token endpoint over HTTPS
  // immediately before this call — the network path is the trust anchor.
  // If we ever surface this to untrusted contexts we should verify via
  // Shopify's JWKS.
  const body = parts[1];
  return JSON.parse(Buffer.from(body, "base64").toString("utf8"));
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

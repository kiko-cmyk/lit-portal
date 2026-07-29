import crypto from "node:crypto";
import type { Lang } from "@/lib/portal-link";
import { getOAuthStateKey } from "@/lib/secrets";

/**
 * Shopify Customer Account API OAuth — shared endpoints, signed `state`, and
 * URL builders.
 *
 * These lived duplicated across /api/auth/login and /api/auth/callback (two
 * copies of the same JWT-lite signer, the endpoint URLs written out three
 * times). That was survivable while login was the only flow. It stopped being
 * survivable on 2026-07-29, when logout started MINTING its own authorize URL
 * and the callback had to understand a claim the logout route signs: two
 * copies of a security primitive that must agree on a payload shape is how
 * you get a verifier that silently rejects a valid state.
 *
 * Client registration (verified 2026-07-29): the portal is a PUBLIC client
 * with PKCE. There is no OAuth client_secret anywhere in the codebase —
 * SHOPIFY_API_SECRET is only ever used to derive the HMAC key that signs
 * `state`. The `token_endpoint_auth_methods_supported: ["client_secret_basic"]`
 * in Shopify's discovery document is shop-level metadata about confidential
 * clients; it does not describe ours.
 */

export const AUTHORIZE_ENDPOINT =
  "https://tracking.litsalt.com/authentication/oauth/authorize";
export const TOKEN_ENDPOINT =
  "https://tracking.litsalt.com/authentication/oauth/token";
export const END_SESSION_ENDPOINT =
  "https://tracking.litsalt.com/authentication/logout";

/**
 * Must match, byte for byte, the Callback URL registered in the Headless
 * channel AND the value replayed in the token exchange. Shopify rejects the
 * grant on any difference, including a trailing slash.
 */
export const REDIRECT_URI = "https://litsalt.com/apps/portal/api/auth/callback";

const PORTAL_ORIGIN = "https://litsalt.com";

/** Where a customer lands once both sessions are dead. */
export const SIGNED_OUT_PATH: Record<Lang, string> = {
  es: "/apps/portal/es/sesion-cerrada",
  en: "/apps/portal/en/signed-out",
};

const STATE_TTL_SECONDS = 600; // 10 min

/**
 * The absolute URI handed to Shopify as `post_logout_redirect_uri`.
 *
 * Constraints that shape this (RP-Initiated Logout 1.0, which Shopify
 * implements):
 *   * "The OP MUST NOT perform post-logout redirection if the
 *     post_logout_redirect_uri value supplied does not exactly match one of
 *     the previously registered post_logout_redirect_uris values." So this
 *     string has to be registered under Headless channel → Application setup
 *     → Logout URL, character for character.
 *   * EXACT match means no query string. Never build this dynamically.
 *   * A mismatch does NOT surface as an error: Shopify still logs the
 *     customer out, then drops them on www.shopify.com instead of here. So
 *     a bad value degrades the landing, never the logout.
 *
 * One value, not one per locale, because the Logout URL field is singular.
 * An English customer lands on the Spanish path and the page itself bounces
 * them to /en/signed-out client-side (see that page's language hint).
 *
 * SHOPIFY_POST_LOGOUT_URI overrides it so the value can be realigned with
 * whatever is actually registered from Vercel, without a deploy — every
 * other OAuth URL in this file needs a code change to move, which is exactly
 * the friction you do not want while you are trying to match a string in a
 * Shopify admin panel.
 */
export function postLogoutRedirectUri(): string {
  return (
    process.env.SHOPIFY_POST_LOGOUT_URI ?? `${PORTAL_ORIGIN}${SIGNED_OUT_PATH.es}`
  );
}

/**
 * RP-initiated logout URL. MUST be followed as a real browser navigation
 * (302 / window.location), never fetched: Shopify's logout route answers any
 * Accept header other than text/html with a 406 and does not end the session.
 * The failure mode is the worst kind, the call looks like it succeeded and
 * the customer is still signed in.
 */
export function endSessionUrl(idToken: string): string {
  const url = new URL(END_SESSION_ENDPOINT);
  url.searchParams.set("id_token_hint", idToken);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri());
  return url.toString();
}

// ─────────────────────────── signed state ───────────────────────────
//
// Tiny HS256 JWT. We avoid pulling in jose/jsonwebtoken just to sign a state
// blob — keeps the bundle small and sidesteps edge-runtime surprises with
// crypto.subtle on Vercel.
//
// State is a signed JWT rather than a cookie because Shopify App Proxy strips
// Set-Cookie from our responses, so there is no other reliable way to carry
// context from /login to /callback.

export interface StatePayload {
  /** PKCE code_verifier — the callback replays it in the token exchange. */
  v: string;
  /** Relative path to land on when the flow completes. */
  r: string;
  /** OIDC nonce, echoed into the id_token and verified by the callback. */
  nce: string;
  iat: number;
  exp: number;
  /**
   * Logout intent. Set only by /api/auth/logout, which sends the customer
   * through `prompt=none` purely to mint a fresh id_token: the callback must
   * then spend that token on end_session and NOT create a session, which is
   * the exact opposite of what it does for every other state it sees.
   * Optional so states signed before this existed still verify.
   */
  lo?: 1;
}

export function signState(payload: StatePayload): string {
  const key = getOAuthStateKey();
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

export function verifyState(token: string): StatePayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const data = `${header}.${body}`;
  const expectedSig = base64UrlEncode(
    crypto.createHmac("sha256", getOAuthStateKey()).update(data).digest(),
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

export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ─────────────────────────── authorize ───────────────────────────

export interface AuthorizeOptions {
  clientId: string;
  /** Relative path to return to. Validated by the caller. */
  returnTo: string;
  /**
   * `prompt=none` asks Shopify to answer without ever showing UI: if the
   * customer still has a Customer Account session it returns a code straight
   * away, and if they do not it returns `error=login_required`. That is the
   * whole mechanism behind logout — see /api/auth/logout.
   */
  prompt?: "none";
  /** Marks the flow as a logout round trip (sets the `lo` claim). */
  logout?: boolean;
}

/**
 * Build a Shopify /authorize URL with a fresh PKCE pair and nonce, both
 * sealed into the signed state so the callback can finish the flow.
 */
export function buildAuthorizeUrl(opts: AuthorizeOptions): string {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(48));
  const codeChallenge = base64UrlEncode(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );
  // Bound into the id_token by Shopify; the callback checks the claim matches.
  // Defends against id_token replay / confused-deputy, where a token minted
  // for one flow is presented to another.
  const nonce = crypto.randomBytes(16).toString("hex");

  const now = Math.floor(Date.now() / 1000);
  const state = signState({
    v: codeVerifier,
    r: opts.returnTo,
    nce: nonce,
    iat: now,
    exp: now + STATE_TTL_SECONDS,
    ...(opts.logout ? { lo: 1 as const } : {}),
  });

  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", nonce);
  if (opts.prompt) url.searchParams.set("prompt", opts.prompt);
  return url.toString();
}

// ─────────────────────────── token exchange ───────────────────────────

export interface TokenResponse {
  access_token: string;
  id_token: string;
  /**
   * Shopify returns one, but it is useless for logout: the refresh grant
   * responds with `Omit<AccessTokenResponse, 'id_token'>`, i.e. it never
   * mints a new id_token (verified against Shopify's own docs and Hydrogen's
   * implementation, which carries the original id_token forward by hand).
   * That is why logout re-authenticates with `prompt=none` instead of
   * refreshing. We do not persist it.
   */
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

/**
 * Exchange an authorization code for tokens. PKCE only, no client secret.
 * Throws with a short, non-sensitive message the caller can log.
 */
export async function exchangeCodeForTokens(args: {
  clientId: string;
  code: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: args.clientId,
    code: args.code,
    redirect_uri: REDIRECT_URI,
    code_verifier: args.codeVerifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token exchange HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Is this id_token still worth sending as `id_token_hint`?
 *
 * Shopify's id_tokens live ~10 minutes while portal sessions live 14 days, so
 * this is false for essentially every real logout. It stays because when it
 * IS true (a customer who signs out right after signing in) it saves a whole
 * round trip through Shopify. Whether Shopify would accept an EXPIRED hint is
 * undocumented — the OIDC spec says the OP SHOULD, Shopify says nothing — and
 * a wrong guess lands the customer on an error page, so we never gamble on it.
 */
export function idTokenIsFresh(idToken: string, bufferSec = 30): boolean {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return false;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      exp?: number;
    };
    if (typeof payload.exp !== "number") return false;
    return payload.exp > Math.floor(Date.now() / 1000) + bufferSec;
  } catch {
    return false;
  }
}

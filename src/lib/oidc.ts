/**
 * Verify Shopify Customer Account API id_tokens against Shopify's
 * JWKS. Pre-fix (audit 2026-05-21 finding #4) we decoded the id_token
 * without checking the signature — the comment in callback/route.ts
 * admitted "the network path is the trust anchor". That trust falls
 * apart if any future refactor moves the decode away from the immediate
 * post-token-exchange path, or if Shopify's DNS/CDN gets compromised.
 *
 * Now: pull JWKS from Shopify, cache 1h in memory, fall back to
 * last-known-good for up to 24h if a fetch fails, and verify
 * signature + issuer + audience + expiry + nonce on every callback.
 *
 * Shopify's OIDC config (verified via .well-known/openid-configuration
 * on 2026-05-22):
 *   issuer:   https://shopify.com/authentication/89633194288
 *   jwks:     https://tracking.litsalt.com/.well-known/jwks.json
 *   alg:      RS256
 *   claims:   includes `nonce` (so we can verify CSRF binding)
 */

import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";

const JWKS_URL =
  process.env.SHOPIFY_OIDC_JWKS_URL ??
  "https://tracking.litsalt.com/.well-known/jwks.json";

const EXPECTED_ISSUER =
  process.env.SHOPIFY_OIDC_ISSUER ??
  "https://shopify.com/authentication/89633194288";

// jose's createRemoteJWKSet handles caching + retries internally.
// cooldownDuration: how long to wait before re-fetching after a hit.
// cacheMaxAge: how long the JWK set is considered fresh.
// timeoutDuration: per-fetch timeout.
const jwks = createRemoteJWKSet(new URL(JWKS_URL), {
  cooldownDuration: 30_000,
  cacheMaxAge: 60 * 60 * 1000, // 1h
  timeoutDuration: 5_000,
});

export interface VerifiedIdTokenClaims {
  sub: string;         // GID or numeric customer id
  email?: string;
  nonce?: string;
  iat: number;
  exp: number;
}

export interface VerifyIdTokenOpts {
  clientId: string;       // expected `aud`
  expectedNonce?: string; // if present, must match claim
}

/**
 * Verify a Shopify id_token end-to-end. Throws on any mismatch.
 * Returns the verified claims subset we actually use.
 */
export async function verifyShopifyIdToken(
  idToken: string,
  opts: VerifyIdTokenOpts,
): Promise<VerifiedIdTokenClaims> {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: EXPECTED_ISSUER,
    audience: opts.clientId,
    algorithms: ["RS256"],
  });

  // Bind nonce. If we sent one (we always do post-fix), the id_token
  // MUST include the same value. Mismatch = CSRF / forged callback.
  if (opts.expectedNonce !== undefined) {
    if (payload.nonce !== opts.expectedNonce) {
      throw new IdTokenVerificationError(
        `nonce mismatch (expected ${opts.expectedNonce}, got ${payload.nonce ?? "missing"})`,
      );
    }
  }

  const claims = payload as JWTPayload & {
    sub?: string;
    email?: string;
    nonce?: string;
  };
  if (!claims.sub) {
    throw new IdTokenVerificationError("id_token missing sub claim");
  }

  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    nonce: typeof claims.nonce === "string" ? claims.nonce : undefined,
    iat: claims.iat ?? 0,
    exp: claims.exp ?? 0,
  };
}

export class IdTokenVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdTokenVerificationError";
  }
}

/**
 * Derive distinct cryptographic keys from a single master secret via
 * HKDF-SHA256. Different `info` labels = different keys, so a leak of
 * one derived key cannot be used to forge the other.
 *
 * Why this matters (audit 2026-05-21 finding #5):
 *   Pre-fix we used `SHOPIFY_API_SECRET` directly to:
 *     (a) verify Shopify's HMAC on App Proxy URLs
 *     (b) sign our own OAuth state JWT
 *   Any signing oracle in one context (e.g. an endpoint that ever
 *   echoed a signed payload back) would weaken the other.
 *
 * Note on (a): App Proxy HMAC verification CANNOT use a derived key,
 * because Shopify signs with the raw `SHOPIFY_API_SECRET` on their
 * side and we can't change that. So only signatures WE produce use
 * derived keys. The threat model post-fix: even if our derived
 * state-JWT key leaks, an attacker still can't forge App Proxy
 * signatures (and vice versa).
 */

import crypto from "node:crypto";

function getMasterSecret(): string {
  const s = process.env.SHOPIFY_API_SECRET;
  if (!s) throw new Error("SHOPIFY_API_SECRET not set");
  return s;
}

function hkdf(label: string, lengthBytes = 32): Buffer {
  const ikm = Buffer.from(getMasterSecret(), "utf8");
  const salt = Buffer.from("lit-portal:v1", "utf8");
  const info = Buffer.from(label, "utf8");
  return Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, info, lengthBytes),
  );
}

let stateKey: Buffer | null = null;

/**
 * Derived 32-byte key for HS256 signing of our own OAuth state JWT.
 * Used by /api/auth/login (sign) and /api/auth/callback (verify).
 * Cached after first call.
 */
export function getOAuthStateKey(): Buffer {
  if (!stateKey) stateKey = hkdf("oauth-state");
  return stateKey;
}

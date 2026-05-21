/**
 * Shopify App Proxy signature verification.
 *
 * Every request that arrives at /apps/portal/* in Shopify is signed with
 * the app's API secret. We verify the signature on every API route to ensure
 * (a) the request actually came from Shopify, and (b) the customer ID is trusted.
 *
 * Reference: https://shopify.dev/docs/apps/build/online-store/display-dynamic-data
 */

import crypto from "node:crypto";
import type { NextRequest } from "next/server";

// Read the secret lazily — module load happens at build time on Vercel and
// throwing here would block builds when secrets are absent (e.g. preview env).
function getSecret(): string {
  const s = process.env.SHOPIFY_API_SECRET;
  if (!s) throw new AppProxyAuthError("SHOPIFY_API_SECRET not set");
  return s;
}

export interface AppProxyContext {
  customerId: string | null; // null if customer is logged out
  shop: string;
  pathPrefix: string;
  timestamp: number;
}

/**
 * Verify the App Proxy signature and return the trusted context.
 * Throws on invalid signature.
 *
 * **Dev bypass**: in `NODE_ENV=development`, if the request includes
 * `?__dev_customer=cust_xxx`, we trust it as if it came from a logged-in
 * customer. Lets us hit endpoints from curl/Postman without going through
 * Shopify. Strictly disabled in production.
 */
export function verifyAppProxyRequest(req: NextRequest): AppProxyContext {
  const url = new URL(req.url);
  const params = url.searchParams;

  if (process.env.NODE_ENV === "development") {
    const devCustomer = params.get("__dev_customer");
    if (devCustomer) {
      return {
        customerId: devCustomer,
        shop: params.get("shop") ?? "lit-tienda.myshopify.com",
        pathPrefix: "/apps/portal",
        timestamp: Math.floor(Date.now() / 1000),
      };
    }
  }

  const signature = params.get("signature");

  if (!signature) {
    throw new AppProxyAuthError("Missing signature");
  }

  // Build the canonical query string (everything except `signature`),
  // sorted alphabetically, joined without separator.
  const sortedKeys = [...params.keys()].filter((k) => k !== "signature").sort();
  const canonical = sortedKeys.map((k) => `${k}=${params.getAll(k).join(",")}`).join("");

  const expected = crypto.createHmac("sha256", getSecret()).update(canonical).digest("hex");

  // Constant-time compare
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new AppProxyAuthError("Invalid signature");
  }

  const customerIdRaw = params.get("logged_in_customer_id");
  const shop = params.get("shop");
  const pathPrefix = params.get("path_prefix") ?? "/apps/portal";
  const timestamp = Number(params.get("timestamp") ?? "0");

  if (!shop) {
    throw new AppProxyAuthError("Missing shop param");
  }

  return {
    customerId: customerIdRaw && customerIdRaw !== "" ? customerIdRaw : null,
    shop,
    pathPrefix,
    timestamp,
  };
}

/**
 * Convenience: verify and require an authenticated customer.
 * Throws AppProxyAuthError if logged out.
 */
export function requireCustomer(req: NextRequest): AppProxyContext & { customerId: string } {
  const ctx = verifyAppProxyRequest(req);
  if (!ctx.customerId) {
    throw new AppProxyAuthError("Customer not logged in");
  }
  return ctx as AppProxyContext & { customerId: string };
}

/**
 * Resolve customer identity for a request, trying TWO auth mechanisms:
 *
 *   1. App Proxy signature with `logged_in_customer_id` (legacy/standard
 *      path — works when the customer logged in via /account/login and
 *      has a storefront session cookie).
 *
 *   2. Session token from our Customer Account API OAuth flow. Accepted
 *      via TWO headers:
 *        - `X-LIT-Session: <token>` (preferred)
 *        - `Authorization: Bearer <token>` (legacy)
 *
 *      Why two? Shopify App Proxy intercepts `Authorization` on
 *      POST/PATCH/DELETE and returns the storefront 500 page instead
 *      of forwarding (verified 2026-05-21). Custom `X-*` headers pass
 *      through cleanly. We keep Authorization for backwards-compat
 *      and for the GET cases where it still works.
 *
 * For the bearer path, the caller (withCustomer) must do the Supabase
 * lookup — this function just returns the parsed token. We keep DB
 * access OUT of shopify-app-proxy to avoid a circular Supabase
 * dependency on this module.
 */
export function parseAuthRequest(req: NextRequest): {
  appProxy: AppProxyContext;
  bearerToken: string | null;
} {
  let appProxy: AppProxyContext;
  try {
    appProxy = verifyAppProxyRequest(req);
  } catch {
    // App Proxy signature missing/invalid — bearer path may still rescue.
    appProxy = {
      customerId: null,
      shop: "",
      pathPrefix: "/apps/portal",
      timestamp: 0,
    };
  }
  // Preferred path: custom header that survives App Proxy interception
  // on POST/PATCH/DELETE.
  const customSession = req.headers.get("x-lit-session")?.trim();
  let bearerToken: string | null = customSession || null;
  if (!bearerToken) {
    const auth = req.headers.get("authorization");
    bearerToken =
      auth && auth.toLowerCase().startsWith("bearer ")
        ? auth.slice(7).trim() || null
        : null;
  }
  return { appProxy, bearerToken };
}

export class AppProxyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppProxyAuthError";
  }
}

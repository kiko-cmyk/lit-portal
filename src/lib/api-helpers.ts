/**
 * Common helpers for API routes — auth wrapper + typed HTTP errors.
 *
 * Note: in Next.js 15+, dynamic route handlers receive `(req, { params })`
 * where `params` is a Promise. This wrapper passes the full framework context
 * through to the handler so dynamic routes can `await ctx.params`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { hashSessionId } from "./session";
import { AppProxyAuthError, parseAuthRequest, type AppProxyContext } from "./shopify-app-proxy";
import { supabaseAdmin } from "./supabase";

export type RouteContext<P = unknown> = { params: Promise<P> } | undefined;

export type AuthedHandler<T, P = unknown> = (
  req: NextRequest,
  proxyCtx: AppProxyContext & { customerId: string },
  routeCtx: RouteContext<P>,
) => Promise<T>;

/**
 * Throw this from any handler to return a specific HTTP status with a typed
 * error code. The wrapper translates it into the JSON error response.
 */
export class ApiHttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
    this.name = "ApiHttpError";
  }
}

/**
 * Wraps a route handler with customer authentication. Tries two paths:
 *
 *   A) App Proxy signature with `logged_in_customer_id` — the legacy
 *      path that works for customers who logged in via /account/login
 *      and got a storefront session cookie.
 *
 *   B) Bearer token in `Authorization` header — the OAuth path. The
 *      token is an opaque session_id we issued after a successful
 *      Customer Account API OAuth callback; we look it up in Supabase
 *      `auth_sessions` to recover the customer_id.
 *
 * The handler receives:
 *   - req: NextRequest
 *   - proxyCtx: synthesised auth context (always has customerId, but
 *     `shop` may be empty if we authed via Bearer)
 *   - routeCtx: framework-provided dynamic route context
 */
/**
 * Distinct auth-failure modes so the FE can react differently. Pre-2026-05-22
 * we just returned 'unauthorized' for everything, which meant the FE never
 * knew when to clear localStorage — users with an expired bearer would loop
 * on the same dead token until they manually logged out.
 */
class SessionExpiredError extends Error {
  constructor() { super("Session expired"); this.name = "SessionExpiredError"; }
}
class SessionInvalidError extends Error {
  constructor() { super("Session not found"); this.name = "SessionInvalidError"; }
}

export function withCustomer<T, P = unknown>(handler: AuthedHandler<T, P>) {
  return async (req: NextRequest, routeCtx?: RouteContext<P>): Promise<NextResponse> => {
    try {
      const { appProxy, bearerToken } = parseAuthRequest(req);
      let customerId: string | null = appProxy.customerId;
      let authMode: "app_proxy" | "bearer" | null =
        appProxy.customerId ? "app_proxy" : null;
      // Track auth failures with bearer so we can return a precise error
      // code (FE clears localStorage on session_expired/session_invalid).
      let bearerFailure: "expired" | "invalid" | null = null;

      if (!customerId && bearerToken) {
        // Lookup by SHA-256 hash of the raw token. The DB never sees
        // the raw value (audit 2026-05-21 LOW). The bearer the FE
        // sends IS the raw value (so the customer can keep using
        // their localStorage post-migration).
        const tokenHash = hashSessionId(bearerToken);
        const sb = supabaseAdmin();
        const { data, error } = await sb
          .from("auth_sessions")
          .select("customer_id, expires_at")
          .eq("session_id_hash", tokenHash)
          .maybeSingle();
        if (error) console.warn("[withCustomer] bearer lookup error", error);
        if (data) {
          if (new Date(data.expires_at).getTime() > Date.now()) {
            customerId = data.customer_id;
            authMode = "bearer";
            // Best-effort refresh of last_used_at — don't block on it.
            sb.from("auth_sessions")
              .update({ last_used_at: new Date().toISOString() })
              .eq("session_id_hash", tokenHash)
              .then(() => undefined);
          } else {
            bearerFailure = "expired";
          }
        } else {
          bearerFailure = "invalid";
        }
      }

      if (!customerId) {
        if (bearerFailure === "expired") throw new SessionExpiredError();
        if (bearerFailure === "invalid") throw new SessionInvalidError();
        throw new AppProxyAuthError("Customer not logged in");
      }

      const ctx: AppProxyContext & { customerId: string } = {
        customerId,
        shop: appProxy.shop,
        pathPrefix: appProxy.pathPrefix,
        timestamp: appProxy.timestamp,
      };
      // PII sweep: no `email` in the happy path. customerId is needed for
      // tracing; bearer token prefix only in the failure path below.
      console.log(
        `[withCustomer] path=${req.nextUrl.pathname} customerId=${customerId} auth=${authMode}`,
      );
      const result = await handler(req, ctx, routeCtx);
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return NextResponse.json(
          { error: "session_expired", message: "Session expired, please log in again" },
          { status: 401 },
        );
      }
      if (err instanceof SessionInvalidError) {
        return NextResponse.json(
          { error: "session_invalid", message: "Session not recognised, please log in again" },
          { status: 401 },
        );
      }
      if (err instanceof AppProxyAuthError) {
        return NextResponse.json({ error: "unauthorized", message: err.message }, { status: 401 });
      }
      if (err instanceof ApiHttpError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
      }
      // Internal error: full detail to the server log only, generic to the
      // client. Pre-2026-05-22 we returned `message` + stack frames in the
      // JSON, exposing Supabase column names and Seal internals. The audit
      // flagged this; now we strip both unless dev mode.
      const isDev = process.env.NODE_ENV !== "production";
      const internalMsg = err instanceof Error ? err.message : "Unknown error";
      const stack = err instanceof Error ? err.stack : undefined;
      console.error("[api-error]", { path: req.nextUrl.pathname, msg: internalMsg, stack });
      return NextResponse.json(
        isDev
          ? { error: "internal_error", message: internalMsg, stack: stack?.split("\n").slice(0, 8) }
          : { error: "internal_error", message: "Something went wrong. Please try again." },
        { status: 500 },
      );
    }
  };
}

export function jsonError(status: number, error: string, message?: string): NextResponse {
  return NextResponse.json({ error, message }, { status });
}

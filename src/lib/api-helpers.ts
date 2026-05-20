/**
 * Common helpers for API routes — auth wrapper + typed HTTP errors.
 *
 * Note: in Next.js 15+, dynamic route handlers receive `(req, { params })`
 * where `params` is a Promise. This wrapper passes the full framework context
 * through to the handler so dynamic routes can `await ctx.params`.
 */

import { NextResponse, type NextRequest } from "next/server";
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
export function withCustomer<T, P = unknown>(handler: AuthedHandler<T, P>) {
  return async (req: NextRequest, routeCtx?: RouteContext<P>): Promise<NextResponse> => {
    try {
      const { appProxy, bearerToken } = parseAuthRequest(req);
      let customerId: string | null = appProxy.customerId;
      let authMode: "app_proxy" | "bearer" | null =
        appProxy.customerId ? "app_proxy" : null;

      if (!customerId && bearerToken) {
        const sb = supabaseAdmin();
        const { data, error } = await sb
          .from("auth_sessions")
          .select("customer_id, expires_at")
          .eq("session_id", bearerToken)
          .maybeSingle();
        if (error) console.warn("[withCustomer] bearer lookup error", error);
        if (data) {
          if (new Date(data.expires_at).getTime() > Date.now()) {
            customerId = data.customer_id;
            authMode = "bearer";
            // Best-effort refresh of last_used_at — don't block on it.
            sb.from("auth_sessions")
              .update({ last_used_at: new Date().toISOString() })
              .eq("session_id", bearerToken)
              .then(() => undefined);
          } else {
            console.log("[withCustomer] bearer session expired", {
              session: bearerToken.slice(0, 8),
              expired_at: data.expires_at,
            });
          }
        }
      }

      if (!customerId) {
        throw new AppProxyAuthError("Customer not logged in");
      }

      const ctx: AppProxyContext & { customerId: string } = {
        customerId,
        shop: appProxy.shop,
        pathPrefix: appProxy.pathPrefix,
        timestamp: appProxy.timestamp,
      };
      console.log(
        `[withCustomer] path=${req.nextUrl.pathname} customerId=${customerId} auth=${authMode}`,
      );
      const result = await handler(req, ctx, routeCtx);
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof AppProxyAuthError) {
        return NextResponse.json({ error: "unauthorized", message: err.message }, { status: 401 });
      }
      if (err instanceof ApiHttpError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      const stack = err instanceof Error ? err.stack : undefined;
      console.error("[api-error]", err);
      return NextResponse.json(
        { error: "internal_error", message, stack: stack?.split("\n").slice(0, 8) },
        { status: 500 },
      );
    }
  };
}

export function jsonError(status: number, error: string, message?: string): NextResponse {
  return NextResponse.json({ error, message }, { status });
}

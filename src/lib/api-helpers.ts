/**
 * Common helpers for API routes — auth wrapper + typed HTTP errors.
 *
 * Note: in Next.js 15+, dynamic route handlers receive `(req, { params })`
 * where `params` is a Promise. This wrapper passes the full framework context
 * through to the handler so dynamic routes can `await ctx.params`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { AppProxyAuthError, requireCustomer, type AppProxyContext } from "./shopify-app-proxy";

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
 * Wraps a route handler with App Proxy signature verification.
 * The handler receives:
 *   - req: NextRequest
 *   - proxyCtx: trusted AppProxy context (always has customerId)
 *   - routeCtx: framework-provided dynamic route context (await ctx.params)
 */
export function withCustomer<T, P = unknown>(handler: AuthedHandler<T, P>) {
  return async (req: NextRequest, routeCtx?: RouteContext<P>): Promise<NextResponse> => {
    try {
      const proxyCtx = requireCustomer(req);
      const result = await handler(req, proxyCtx, routeCtx);
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof AppProxyAuthError) {
        return NextResponse.json({ error: "unauthorized", message: err.message }, { status: 401 });
      }
      if (err instanceof ApiHttpError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api-error]", err);
      return NextResponse.json({ error: "internal_error", message }, { status: 500 });
    }
  };
}

export function jsonError(status: number, error: string, message?: string): NextResponse {
  return NextResponse.json({ error, message }, { status });
}

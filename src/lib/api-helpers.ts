/**
 * Common helpers for API routes — auth wrapper + typed HTTP errors.
 *
 * Note: in Next.js 15+, dynamic route handlers receive `(req, { params })`
 * where `params` is a Promise. This wrapper passes the full framework context
 * through to the handler so dynamic routes can `await ctx.params`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { alertSlackError } from "./alert";
import { dryRunAllowedInProdFor } from "./flags";
import { UpstreamTimeoutError } from "./http-timeout";
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
    // Hoisted so the catch block can attribute a 5xx alert to the customer.
    let customerId: string | null = null;
    try {
      const { appProxy, bearerToken } = parseAuthRequest(req);
      customerId = appProxy.customerId;
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
        if (error) {
          // A FAILED lookup is not a bad session. Before this branch existed,
          // `data` came back null on any Supabase error and the code below
          // classified it as `session_invalid` — which the FE answers by
          // deleting the bearer from localStorage (see api-client.ts). So a
          // Supabase blip logged customers out for good, and while Supabase was
          // down they could not log back in either. Fail transient and loud, and
          // above all leave their session alone.
          console.warn("[withCustomer] bearer lookup error", error);
          alertSlackError({
            path: req.nextUrl.pathname,
            code: "auth_unavailable",
            msg: `auth_sessions lookup failed: ${error.message}`,
          });
          throw new ApiHttpError(
            503,
            "auth_unavailable",
            "Could not verify your session right now. Please try again in a moment.",
          );
        }
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
      // An upstream blew its deadline (Seal / Shopify Admin / Supabase stalled).
      // Transient, so the customer gets a retryable 503 and NOT a false
      // internal_error P0 — but it DOES alert, because before this existed a
      // stall produced zero signal anywhere: the function ran until Vercel
      // killed it, nothing threw, and the only trace was the customer writing
      // to support (incident 2026-07-27). alertSlackError dedupes per
      // (path, code) for 60s, so a real upstream outage can't spam the channel.
      if (err instanceof UpstreamTimeoutError) {
        console.warn(
          `[api] ${err.upstream} timeout on ${req.nextUrl.pathname} → 503 upstream_timeout`,
          { target: err.target, ms: err.ms },
        );
        alertSlackError({
          path: req.nextUrl.pathname,
          code: `upstream_timeout:${err.upstream}`,
          msg: err.message,
          customerId: customerId ?? undefined,
        });
        return NextResponse.json(
          {
            error: "upstream_timeout",
            message: "That took too long on our side. Please try again in a moment.",
          },
          { status: 503 },
        );
      }
      // A sustained Seal 429 (edge throttle) or 5xx (upstream outage) is
      // transient, not a bug in our code — the retries in seal.ts just couldn't
      // ride it out. Surface it as a retryable 503 so the customer sees a "try
      // again" and it does NOT page a false internal_error P0. Duck-typed to
      // avoid importing SealApiError here (no import cycle with lib/seal).
      const upstream = err as { name?: string; status?: number };
      if (upstream?.name === "SealApiError" && (upstream.status === 429 || (upstream.status ?? 0) >= 500)) {
        console.warn(`[api] Seal upstream ${upstream.status} on ${req.nextUrl.pathname} → 503 seal_busy (transient)`);
        return NextResponse.json(
          {
            error: "seal_busy",
            message: "Our subscription provider is busy right now. Please try again in a moment.",
          },
          { status: 503 },
        );
      }
      // Internal error: full detail to the server log only, generic to the
      // client. Pre-2026-05-22 we returned `message` + stack frames in the
      // JSON, exposing Supabase column names and Seal internals. The audit
      // flagged this; now we strip both unless dev mode.
      const isDev = process.env.NODE_ENV !== "production";
      const internalMsg = err instanceof Error ? err.message : "Unknown error";
      const stack = err instanceof Error ? err.stack : undefined;
      console.error("[api-error]", { path: req.nextUrl.pathname, msg: internalMsg, stack });
      // Fire-and-forget Slack alert (no-op when no webhook env set; dedupes).
      alertSlackError({
        path: req.nextUrl.pathname,
        code: "internal_error",
        msg: internalMsg,
        customerId: customerId ?? undefined,
      });
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

/**
 * Whether dry-run ("simulación") is permitted in this environment. Dry-run lets
 * a mutation route compute and return its projected result WITHOUT calling Seal /
 * Shopify / Klaviyo — so the skip retention flow (and future subscription
 * changes) can be exercised locally without mutating anything.
 *
 * Gated OFF in production. The dev App Proxy bypass (`__dev_customer`) already
 * requires NODE_ENV=development, so on a real signed prod request this is always
 * false — closing the audit concern about gating purely on NODE_ENV. The
 * explicit `ALLOW_DRY_RUN=true` escape hatch lets a non-prod preview opt in
 * deliberately without flipping NODE_ENV.
 */
export function dryRunAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_DRY_RUN === "true";
}

/**
 * Read the dry-run flag for a request: honoured only when {@link dryRunAllowed}.
 * Accepts it either in the JSON body (`{ dryRun: true }`) or as the `__dry_run`
 * query param (forwarded by the FE api-client alongside `__dev_customer`).
 */
export function isDryRunRequest(
  req: NextRequest,
  body?: { dryRun?: boolean },
  /**
   * Customer id, to allow dry-run in PRODUCTION for an allowlisted cohort.
   *
   * The portal has no staging (changes go straight to production and are tested in
   * the real portal), so this is the only way to walk the real UI end to end without
   * writing to Seal. Restricted to the mix allowlist — never to everyone — so it can
   * never become a switch that silently turns every customer's change into a no-op.
   */
  customerId?: string,
): boolean {
  const requested =
    body?.dryRun === true ||
    ["1", "true"].includes(new URL(req.url).searchParams.get("__dry_run") ?? "");
  if (!requested) return false;
  if (dryRunAllowed()) return true;
  return customerId ? dryRunAllowedInProdFor(customerId) : false;
}

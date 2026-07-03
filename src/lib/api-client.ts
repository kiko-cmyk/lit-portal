/**
 * Browser-side API client. Calls the portal's own /api/* routes (which then
 * verify App Proxy signature server-side). In dev mode, supports `?__dev_customer`
 * forwarding via query string for local testing without Shopify.
 */

const BASE = process.env.NEXT_PUBLIC_PORTAL_BASE_PATH ?? "";

function withDevParams(path: string): string {
  if (typeof window === "undefined") return path;
  const dev = new URLSearchParams(window.location.search);
  const devCustomer = dev.get("__dev_customer");
  const devEmail = dev.get("__dev_email");
  // `__dry_run` ("simulación"): forwarded so mutation routes return their
  // projected result without touching Seal/Shopify/Klaviyo. Honoured server-side
  // only in non-prod (see api-helpers.dryRunAllowed). Lets Juan walk the whole
  // skip retention flow locally (?__dev_customer=…&__dry_run=1) safely.
  const dryRun = dev.get("__dry_run");
  if (!devCustomer && !devEmail && !dryRun) return path;
  const sep = path.includes("?") ? "&" : "?";
  const extras: string[] = [];
  if (devCustomer) extras.push(`__dev_customer=${encodeURIComponent(devCustomer)}`);
  if (devEmail) extras.push(`__dev_email=${encodeURIComponent(devEmail)}`);
  if (dryRun) extras.push(`__dry_run=${encodeURIComponent(dryRun)}`);
  return `${path}${sep}${extras.join("&")}`;
}

/**
 * Forward the active URL locale (`/apps/portal/en/...` → "en") as `?lang=` so
 * server-rendered content (events, stories, moments, the Hub event card)
 * follows the language toggle in the same render, instead of trailing the
 * persisted Supabase preference. See `lib/request-lang.ts`. (2026-06-10)
 */
function withLang(path: string): string {
  if (typeof window === "undefined") return path;
  if (/[?&]lang=/.test(path)) return path;
  const m = window.location.pathname.match(/\/(en|es)(?:\/|$)/);
  if (!m) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}lang=${m[1]}`;
}

const SESSION_STORAGE_KEY = "lit_session";

function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Drop the session token (used on logout flows or when backend signals
 * that the bearer session is invalid).
 */
export function clearSessionToken() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${BASE}${withDevParams(withLang(path))}`;
  // Attach our own session token (issued after Customer Account API
  // OAuth). We send it as `X-LIT-Session`, NOT `Authorization: Bearer`:
  // Shopify App Proxy intercepts `Authorization` on POST/PATCH/DELETE
  // and refuses to forward the request to Vercel (returns the
  // storefront 500 HTML instead). Verified 2026-05-21 against
  // /api/subscription/cancel — GET+Bearer reached Vercel, POST+Bearer
  // never did. Custom X-* headers pass through cleanly.
  // The backend `withCustomer` reads either header for back-compat.
  const sessionToken = getSessionToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { "X-LIT-Session": sessionToken } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Read as text first so we can surface the raw body when Vercel or the
    // runtime returns an HTML / plain-text error page (504, function crash,
    // edge errors) — otherwise the UI degrades to "(unknown)" and we lose
    // the diagnostic entirely.
    const text = await res.text().catch(() => "");
    let parsed: { error?: string; message?: string } | null = null;
    try {
      parsed = text ? (JSON.parse(text) as { error?: string; message?: string }) : null;
    } catch {
      parsed = null;
    }

    // If the body is HTML (Vercel timeout / Shopify storefront fallback /
    // crashed function), the customer should not see raw markup or
    // analytics scripts in the error toast. Replace with a friendly
    // gateway-timeout code so the consuming UI can show its own copy.
    // We still log the full body to console for debugging.
    const isHtmlBody =
      !parsed &&
      /^\s*(<!doctype|<html|<\?xml)/i.test(text);
    const code = parsed?.error
      ?? (isHtmlBody ? "gateway_timeout" : `http_${res.status}`);
    const message = parsed?.message
      ?? (isHtmlBody
        ? `The service didn't respond in time (HTTP ${res.status}). Try again in a moment.`
        : (text ? text.slice(0, 240) : `HTTP ${res.status}`));

    console.warn(`[api] ${path} → ${res.status}`, parsed ?? text);

    // Session expired / invalid: clear our localStorage token so the
    // customer can re-login cleanly instead of looping on a dead bearer.
    // The consuming UI still receives the error so it can route to the
    // login screen (LoginScreen renders on subscription_not_found AND
    // unauthorized, plus the page itself handles 401-ish codes).
    if (code === "session_expired" || code === "session_invalid") {
      clearSessionToken();
    }

    throw new ApiClientError(res.status, code, message);
  }
  return res.json() as Promise<T>;
}

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
    this.name = "ApiClientError";
  }
}

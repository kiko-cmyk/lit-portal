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
  if (!devCustomer && !devEmail) return path;
  const sep = path.includes("?") ? "&" : "?";
  const extras: string[] = [];
  if (devCustomer) extras.push(`__dev_customer=${encodeURIComponent(devCustomer)}`);
  if (devEmail) extras.push(`__dev_email=${encodeURIComponent(devEmail)}`);
  return `${path}${sep}${extras.join("&")}`;
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
  const url = `${BASE}${withDevParams(path)}`;
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

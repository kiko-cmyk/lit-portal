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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${BASE}${withDevParams(path)}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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

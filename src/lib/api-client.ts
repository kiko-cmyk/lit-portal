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
    const body = await res.json().catch(() => ({ error: "unknown" }));
    throw new ApiClientError(res.status, body.error ?? "error", body.message);
  }
  return res.json() as Promise<T>;
}

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
    this.name = "ApiClientError";
  }
}

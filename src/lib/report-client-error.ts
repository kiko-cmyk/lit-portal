/**
 * Best-effort client-side error reporter, called from the error boundaries
 * ([locale]/error.tsx, global-error.tsx). A React crash that only happens in
 * the customer's browser never reaches the server, so without this we are blind
 * to it (the boundary's console.error is on THEIR device). This POSTs the error
 * to /api/client-error, which relays it to the same Slack channel as server
 * 5xx. Real case that motivated it: a subscriber whose portal crashed inside the
 * Outlook in-app browser (auto-translation breaking React) — we had to deduce
 * the cause from screenshots instead of seeing the actual error.
 *
 * Pure observability: it never changes what the customer sees, never throws,
 * never blocks. Uses the App Proxy base path so it resolves through
 * litsalt.com/apps/portal, same as the api-client.
 */
const BASE = process.env.NEXT_PUBLIC_PORTAL_BASE_PATH ?? "";

export function reportClientError(error: unknown, boundary: string): void {
  try {
    const err = error as { message?: string; digest?: string } | undefined;
    void fetch(`${BASE}/api/client-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // keepalive so the report still flushes if the boundary triggers a
      // navigation / the tab is closing.
      keepalive: true,
      body: JSON.stringify({
        message: `[${boundary}] ${err?.message ?? String(error)}`,
        digest: err?.digest,
        path: typeof window !== "undefined" ? window.location.pathname : "",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      }),
    }).catch(() => {});
  } catch {
    // Reporting must NEVER throw inside an error boundary — swallow everything.
  }
}

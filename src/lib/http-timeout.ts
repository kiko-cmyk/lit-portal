/**
 * Deadlines for outbound fetches.
 *
 * Why this exists (incident 2026-07-27): a subscriber pressed "Guardar
 * dirección" and saw `gateway_timeout`. Nothing was written to Seal or Shopify
 * and NO alert reached #server-errors, because nothing ever threw — the request
 * simply hung. None of our upstream clients (Seal, Shopify Admin, Supabase)
 * passed a signal to `fetch`, and the retry logic in those clients only fires on
 * a *rejection*, never on a socket that stays open. So one stalled connection
 * burned the route's whole 60s `maxDuration` while Shopify's App Proxy gave up
 * at ~10s and replaced the response with storefront HTML, which `api-client.ts`
 * reports to the customer as `gateway_timeout`.
 *
 * A hang must become a fast, typed, *alertable* failure. Two knobs:
 *   - per-attempt timeout: caps a single stalled socket.
 *   - total budget: caps attempt + retries + backoff, so a client that retries
 *     can never sum its way past the proxy's patience.
 */

/** A single outbound call blew its deadline. Transient by definition. */
export class UpstreamTimeoutError extends Error {
  constructor(
    public upstream: "seal" | "shopify" | "supabase",
    public target: string,
    public ms: number,
  ) {
    super(`${upstream} timed out after ${ms}ms on ${target}`);
    this.name = "UpstreamTimeoutError";
  }
}

export interface TimeoutHandle {
  signal: AbortSignal;
  /** True when OUR deadline fired, false for a caller-driven cancellation. */
  timedOut: () => boolean;
}

/**
 * A signal that aborts on our deadline OR on the caller's own signal.
 *
 * `timedOut()` distinguishes the two: callers must never retry (or alert on) a
 * cancellation the caller asked for, and the reason attached to a rejected
 * `fetch` is not portable enough to rely on across runtimes.
 */
export function fetchDeadline(ms: number, caller?: AbortSignal | null): TimeoutHandle {
  // Node's AbortSignal.timeout uses an unref'd timer, so it never keeps a
  // serverless invocation alive on its own — no cleanup needed.
  const deadline = AbortSignal.timeout(ms);
  const timedOut = () => deadline.aborted;
  if (!caller) return { signal: deadline, timedOut };
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([caller, deadline]), timedOut };
  }
  // Runtime without AbortSignal.any (Node < 20.3): forward by hand.
  const ctrl = new AbortController();
  if (caller.aborted) ctrl.abort(caller.reason);
  else caller.addEventListener("abort", () => ctrl.abort(caller.reason), { once: true });
  deadline.addEventListener("abort", () => ctrl.abort(deadline.reason), { once: true });
  return { signal: ctrl.signal, timedOut };
}

/** Absolute epoch-ms deadline `ms` from now. */
export function deadlineIn(ms: number): number {
  return Date.now() + ms;
}

/** Milliseconds left before `deadline` (never negative). */
export function msLeft(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

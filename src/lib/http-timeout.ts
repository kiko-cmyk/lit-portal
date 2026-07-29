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
 * A hang must become a fast, typed, *alertable* failure. Three knobs:
 *   - per-attempt timeout: caps a single stalled socket.
 *   - total budget: caps attempt + retries + backoff, so a client that retries
 *     can never sum its way past the proxy's patience.
 *   - request deadline: caps a whole route, so several sequential upstreams
 *     cannot sum their way past it either (added 2026-07-29).
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient, request-scoped wall-clock deadline.
 *
 * The per-call budgets above bound ONE upstream. They do not bound a route that
 * makes several in sequence: the address route reads the rate limiter (Supabase,
 * 5s), then the customer email (Shopify, 9s), then the subscription (Seal, 9s),
 * so a bad day still adds up to ~23s while Shopify's App Proxy stops waiting at
 * ~10s and hands the customer storefront HTML — the original `gateway_timeout`,
 * back again through the front door.
 *
 * A route opts into a single budget for the whole request with
 * `runWithRequestDeadline`, and from then on every `fetchDeadline` inside it
 * (whoever opens it, however deep) is clamped to the time that is actually
 * left. The last call in a chain gets whatever remains, not a fresh 9s.
 *
 * AsyncLocalStorage rather than a module variable because route handlers run
 * concurrently in one instance and would otherwise share the deadline.
 */
const requestDeadline = new AsyncLocalStorage<number>();

/** Run `fn` under a wall-clock budget of `ms` shared by every upstream call inside it. */
export function runWithRequestDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return requestDeadline.run(deadlineIn(ms), fn);
}

/**
 * Run `fn` with NO ambient deadline, even if the caller has one.
 *
 * Needed for `after()` work: those callbacks are created inside the request
 * scope but run once the response is already flushed, when the request budget
 * is spent by definition. Without this they would inherit an exhausted deadline
 * and abort instantly — the Shopify address sync would look broken again.
 */
export function runWithoutRequestDeadline<T>(fn: () => Promise<T>): Promise<T> {
  return requestDeadline.exit(fn);
}

/** Milliseconds left in the ambient request budget, or null when there is none. */
export function requestDeadlineLeft(): number | null {
  const at = requestDeadline.getStore();
  return at === undefined ? null : msLeft(at);
}

/**
 * A client's own total budget, clamped by the ambient request deadline.
 * Returns an absolute epoch-ms deadline, like `deadlineIn`.
 */
export function budgetWithin(totalMs: number): number {
  const own = deadlineIn(totalMs);
  const at = requestDeadline.getStore();
  return at === undefined ? own : Math.min(own, at);
}

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
  // Never outlive the ambient request budget, when the route set one. Clamping
  // here covers every client at once, including supabase-js, which only ever
  // asks for its own flat 5s.
  const left = requestDeadlineLeft();
  const effective = left === null ? ms : Math.max(0, Math.min(ms, left));
  // Node's AbortSignal.timeout uses an unref'd timer, so it never keeps a
  // serverless invocation alive on its own — no cleanup needed.
  const deadline = AbortSignal.timeout(effective);
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

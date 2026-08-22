/**
 * Seal Subscriptions Merchant API client.
 *
 * Base: https://app.sealsubscriptions.com/shopify/merchant/api
 * Auth header: X-Seal-Token: <token>
 *
 * Seal indexes subscriptions by email, not by Shopify customer ID. Callers must
 * resolve the customer's email from Shopify Admin first.
 *
 * See `reference_seal_api.md` for known gotchas (skipped attempts count for
 * "close date", regenerated attempts after reschedule, etc).
 */

import {
  budgetWithin,
  deadlineIn,
  fetchDeadline,
  isBackgroundJob,
  msLeft,
  UpstreamTimeoutError,
} from "./http-timeout";

const SEAL_API_BASE = "https://app.sealsubscriptions.com/shopify/merchant/api";

// Transient-failure retry budget for idempotent GETs. A single hiccup talking
// to Seal used to surface to active subscribers as "no subscription" (the
// email scan returned [] on a swallowed error → the Hub rendered EmptyState).
// Retrying GETs absorbs the common case; persistent failures now propagate.
const SEAL_MAX_RETRIES = 2;
const SEAL_BACKOFF_MS = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// OUR OWN deadline is retriable too (see the catch in req()) — but only for a
// BACKGROUND job, and at most once.
//
// Only background: an interactive route has to surface its typed 503 before
// Shopify's App Proxy gives up at ~10s. A retry fits inside the 9s total budget,
// so allowing it would push the observable failure from ~6s to ~9s and leave
// under a second of margin — on the routes without a request deadline, plus a
// Shopify or Supabase call ahead of it, that is the 2026-07-27 gateway_timeout
// coming back through the front door. A cron has no proxy waiting on the far
// end, and the cron is where the 2026-07-30 incident actually happened.
//
// At most once, on its OWN counter: a blown deadline is almost always a dead
// socket, and a fresh connection answers in ~300ms, so one extra shot buys
// nearly all of the recovery for a fraction of the budget. The counter is
// SEPARATE from `attempt` on purpose — sharing it meant a page that had already
// retried a 429 got no second chance against a stall, which is exactly the
// mixed regime (throttle + slowness) of a bad Seal night. Wall clock is still
// bounded by the total budget below, so a separate counter cannot run away.
const SEAL_MAX_TIMEOUT_RETRIES = 1;

// Below this there is no point sleeping the backoff: the attempt that follows
// would be born already expired.
const MIN_USEFUL_ATTEMPT_MS = 500;

/**
 * Deadlines (incident 2026-07-27, see lib/http-timeout.ts).
 *
 * INTERACTIVE (`attemptMs` / `totalMs`) — DO NOT LOOSEN. Seal answers in
 * ~150-400ms in the healthy case, so 6s per attempt is already 15-40x normal:
 * anything slower is a stall, not slowness. The 9s total caps attempt + retries
 * + backoff together, which matters more than the per-attempt cap — 3 attempts
 * of 6s plus backoff would otherwise sum past the App Proxy's ~10s patience and
 * reproduce the exact bug we're fixing.
 *
 * BACKGROUND (`cronAttemptMs` / `cronTotalMs` / `sweepMs`, added 2026-07-30).
 * A cron has no App Proxy in front, only the route's 60s `maxDuration`, so the
 * interactive budget was protecting a caller that does not exist: the 7d
 * reminder died because ONE page crossed 6s, and the heavy list endpoint
 * (with-items + with-billing-attempts) legitimately does that under
 * concurrency. 10s per attempt inside a 25s per-page budget.
 *
 * `sweepMs` is the wall clock for a WHOLE `listAllSubscriptions`, on top of each
 * page's own budget. The arithmetic, with the real page count — the book is ~51
 * pages (measured 2026-07-06, see the comment in `getSubscriptionsByEmail`; the
 * "33 pages" that used to be quoted around here is from May and is stale):
 *   - 51 pages at POOL 8 = 1 + ceil(50/8) = 8 sequential waves.
 *   - Healthy, that is ~1-3s per heavy wave under concurrency 8, so 8-24s.
 *   - One stalled page costs its 10s window plus a retry that normally answers
 *     on a fresh socket in ~0.3s, so ~11s. A page that stalls PERSISTENTLY
 *     throws on its own (20.5s) and the sweep never gets to matter.
 *   - 45s therefore covers a healthy sweep plus two bad pages, and still leaves
 *     15s of the 60s `maxDuration` for the Klaviyo fan-out (~130 candidates at
 *     the month-end spike / POOL 6 = ~22 waves = 5-9s).
 * Crossing 45s means several pages are broken at once and the run is lost
 * either way. We would rather lose it LOUDLY than have Vercel kill the function
 * at 60s: a kill throws nothing, so nobody is alerted and half the customers
 * got their email while the rest did not.
 *
 * If the book grows past ~70 pages, or the fan-out grows, these three numbers
 * have to be re-derived TOGETHER — `sweepMs` is not independent of POOL.
 */
export interface SealTimings {
  attemptMs: number;
  totalMs: number;
  cronAttemptMs: number;
  cronTotalMs: number;
  /** Wall clock for a whole `listAllSubscriptions` sweep. Background only. */
  sweepMs: number;
}

const DEFAULT_TIMINGS: SealTimings = {
  attemptMs: 6_000,
  totalMs: 9_000,
  cronAttemptMs: 10_000,
  cronTotalMs: 25_000,
  sweepMs: 45_000,
};

// Backoff with jitter, honouring Seal's `Retry-After` header when present.
// Jitter avoids retry stampedes across concurrent requests; Retry-After avoids
// hammering an already-throttled Seal (which just deepens the throttle). Capped.
function backoffMs(attempt: number, res?: Response): number {
  const raSec = Number(res?.headers.get("retry-after") ?? 0);
  const retryAfter = Number.isFinite(raSec) && raSec > 0 ? raSec * 1000 : 0;
  const base = SEAL_BACKOFF_MS * (attempt + 1);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(Math.max(base, retryAfter) + jitter, 5000);
}

function token(): string {
  const t = process.env.SEAL_API_TOKEN;
  if (!t) throw new Error("SEAL_API_TOKEN not set");
  return t;
}

// ============ Raw API shapes ============

export interface SealBillingAttempt {
  id: number;
  date: string; // ISO 8601 with timezone
  status: "" | "succeeded" | "failed" | "pending";
  order_id: string;
  error_code: string;
  error_message: string;
  triggered_manually: string;
  customer_authentication_challenge_url: string;
  completed_at: string;
  skipped_on?: string;
}

export interface SealDiscountCode {
  id: string; // UUID — required to remove via DELETE /subscription-discount-code
  code: string;
  amount: string;
}

export interface SealItem {
  id: number;
  product_id: string;
  variant_id: string;
  title: string;
  variant_sku: string;
  quantity: number;
  price: string;
  total_discount: string;
  taxable: number;
  requires_shipping: number;
  original_price: string;
  original_amount: number;
  final_price: string;
  final_amount: number;
  is_one_time_item: 0 | 1;
  selling_plan_id: string;
  selling_plan_name: string;
  /** Discount codes applied to this line (from Seal). The `id` UUID is required
   *  to remove a code via DELETE /subscription-discount-code. */
  discount_codes?: SealDiscountCode[];
  /** Shopify line-item properties. Seal returns an ARRAY of {key,value} (confirmed
   *  against a real item 2026-07-27), matching the documented add_items contract —
   *  NOT the object shape the addItems() param used to imply. Unused so far. */
  properties?: SealItemProperty[];
}

/** A Shopify line-item property (== order line `customAttributes`). */
export interface SealItemProperty {
  key: string;
  value: string;
}

export interface SealSubscription {
  id: number;
  internal_id: number;
  order_placed: string;
  delivery_interval: string; // e.g. "1 month", "15 days", "3 months"
  billing_interval: string;
  order_id: string;
  /**
   * Id numérico del cliente en Shopify (sin el prefijo `gid://`). Seal lo
   * devuelve siempre en `/subscription?id=` — verificado en vivo el 2026-08-04
   * contra la sub 14030060. Lo necesita la entrada máquina a máquina del cambio
   * de dirección, que no tiene sesión de la que sacar el `customerId` y aun así
   * debe sincronizar la dirección por defecto en Shopify.
   */
  customer_id?: string;
  email: string;
  currency: string;
  first_name: string;
  last_name: string;
  s_first_name: string;
  s_last_name: string;
  s_address1: string;
  s_address2?: string;
  s_phone: string;
  s_city: string;
  s_zip: string;
  s_province: string;
  s_country: string;
  s_country_code: string;
  s_province_code: string;
  total_value: number;
  status: "ACTIVE" | "PAUSED" | "CANCELLED" | string;
  cancellation_reason: string;
  cancelled_on: string;
  paused_on: string;
  cancellation_scheduled_for: string;
  card_expiry_month: string;
  card_expiry_year: string;
  delivery_method_title: string;
  edit_url: string;
  items: SealItem[];
  billing_attempts: SealBillingAttempt[];
  subscription_type: number;
}

interface SealListResponse<T> {
  success: boolean;
  payload: { subscriptions?: T[]; page?: number; total_pages?: number };
}

// ============ Client ============

export class SealClient {
  /**
   * `timings` is injectable ONLY so scripts/test-seal-retry.ts can exercise the
   * real retry path in milliseconds instead of waiting 6-10s for each deadline
   * to fire for real. Production uses the `seal` singleton and the defaults.
   */
  constructor(private readonly timings: SealTimings = DEFAULT_TIMINGS) {}

  /** Per-attempt cap and total budget for the kind of caller we run under. */
  private budgets(): { attemptMs: number; totalMs: number } {
    const t = this.timings;
    return isBackgroundJob()
      ? { attemptMs: t.cronAttemptMs, totalMs: t.cronTotalMs }
      : { attemptMs: t.attemptMs, totalMs: t.totalMs };
  }

  private async req<T>(
    path: string,
    init?: RequestInit,
    attempt = 0,
    deadline?: number,
    /** Retries spent on OUR OWN deadline. Separate from `attempt` — see
     *  SEAL_MAX_TIMEOUT_RETRIES for why sharing one counter was a bug. */
    timeoutRetries = 0,
  ): Promise<T> {
    // Retry transient failures (network error, 429, 5xx) — but ONLY on
    // idempotent GETs. Mutations (PUT/POST) must never be retried: Seal
    // regenerates billing_attempts on every write, so a retried skip /
    // reschedule / charge-now could double-apply.
    const method = (init?.method ?? "GET").toUpperCase();
    const retriable = method === "GET";
    // Which budget applies depends on WHO is calling: an interactive route is
    // racing Shopify's App Proxy, a cron is not (see lib/http-timeout.ts).
    const { attemptMs, totalMs } = this.budgets();
    // Budget spans the whole call including retries; set once on attempt 0 and
    // threaded through the recursion.
    const budget = deadline ?? budgetWithin(totalMs);
    const left = msLeft(budget);
    // Report 0, not `totalMs`. This attempt got exactly zero milliseconds: the
    // budget (ours, or an ambient request/sweep deadline clamped on top of it)
    // was already spent before we could open a socket. Printing the CONSTANT
    // here is how the first cut of this fix ended up telling the on-call "seal
    // timed out after 25000ms on ...&page=14" about a request that never left
    // the building. "after 0ms" says the opposite, and says it truthfully.
    if (left <= 0) throw new UpstreamTimeoutError("seal", path, 0);
    // What this attempt actually got, which is not always the cap: the last
    // attempt of a retry chain, or a page near the end of a sweep, gets the
    // remainder. Report THAT in the error — "timed out after 830ms" and "after
    // 10000ms" are different diagnoses and the Slack alert prints the number.
    const attemptWindow = Math.min(attemptMs, left);
    const { signal, timedOut } = fetchDeadline(attemptWindow, init?.signal ?? null);
    try {
      const res = await fetch(`${SEAL_API_BASE}${path}`, {
        ...init,
        headers: {
          "X-Seal-Token": token(),
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        // After the spread: a caller-supplied signal is folded into `signal`
        // above, so this must win.
        signal,
      });
      if (!res.ok) {
        if (
          retriable &&
          attempt < SEAL_MAX_RETRIES &&
          (res.status === 429 || res.status >= 500)
        ) {
          const wait = backoffMs(attempt, res);
          // Only retry if the budget can still fit the backoff plus a usable
          // attempt; otherwise fail now instead of sleeping into a timeout.
          if (msLeft(budget) > wait + MIN_USEFUL_ATTEMPT_MS) {
            await sleep(wait);
            return this.req<T>(path, init, attempt + 1, budget, timeoutRetries);
          }
        }
        const body = await res.text().catch(() => "");
        throw new SealApiError(res.status, body);
      }
      return (await res.json()) as T;
    } catch (err) {
      // Our own deadline fired: a stalled socket, not an error Seal reported.
      if (timedOut()) {
        // Until 2026-07-30 this threw RIGHT HERE, above the retry block below,
        // which made our own deadline the ONLY failure mode without a second
        // chance: 429s, 5xx and connection resets all retried, a stall did not.
        // One stalled page of the ~51 that the renewal reminder sweeps was
        // enough to kill the whole run and leave everybody without their email.
        //
        // Background only, and on its own counter: see SEAL_MAX_TIMEOUT_RETRIES.
        if (retriable && isBackgroundJob() && timeoutRetries < SEAL_MAX_TIMEOUT_RETRIES) {
          const wait = backoffMs(attempt);
          if (msLeft(budget) > wait + MIN_USEFUL_ATTEMPT_MS) {
            await sleep(wait);
            return this.req<T>(path, init, attempt + 1, budget, timeoutRetries + 1);
          }
        }
        // Still a stall after the retry: surface it typed so api-helpers can
        // alert and return a retryable 503 rather than letting it hang out the
        // route's full maxDuration, and so a cron fails loud instead of quiet.
        throw new UpstreamTimeoutError("seal", path, attemptWindow);
      }
      // fetch() itself rejected (DNS / connection reset). Retry idempotent
      // calls. Never retry aborts (caller-driven cancellation) or a
      // SealApiError we already chose not to retry above.
      const name = (err as { name?: string }).name;
      if (
        retriable &&
        attempt < SEAL_MAX_RETRIES &&
        name !== "AbortError" &&
        !(err instanceof SealApiError) &&
        !(err instanceof UpstreamTimeoutError)
      ) {
        const wait = backoffMs(attempt);
        if (msLeft(budget) > wait + MIN_USEFUL_ATTEMPT_MS) {
          await sleep(wait);
          return this.req<T>(path, init, attempt + 1, budget, timeoutRetries);
        }
      }
      throw err;
    }
  }

  /**
   * List subscriptions filtered by email.
   *
   * Seal's API does NOT support server-side filtering (verified 2026-04-27 —
   * `?email=`, `?customer_email=`, `?q=` are all silently ignored). We have
   * to paginate and filter client-side.
   *
   * Strategy: scan up to `maxPages` (default 6 = 300 most recent subs) before
   * giving up. This covers the vast majority of customers. For older customers
   * with subs deeper in history, the per-customer mapping in Supabase
   * (`customer_seal_mapping` table) will eliminate the scan once that's wired up.
   *
   * TODO: when Supabase is ready, cache (shopify_customer_id, email) → seal_id
   *       in `customer_seal_mapping` and bypass scan on hits.
   */
  async getSubscriptionsByEmail(email: string): Promise<SealSubscription[]> {
    const target = email.trim().toLowerCase();
    const fetchPage = (page: number) => {
      const params = new URLSearchParams({
        // Server-side email filter. WITHOUT this, Seal returns EVERY
        // subscription in the store (now 51 pages) and we filter client-side —
        // which fires ~50 parallel page reads on every call and reliably trips
        // Seal's rate limit (429 → this throws → the whole portal reads as "no
        // subscription"). With `query`, Seal returns just this email's subs
        // (total_pages=1 for a normal customer), turning a 51-page store scan
        // into a single cheap call. `query` is Seal's fuzzy search (email +
        // name), so we STILL apply the exact-email filter below as a guard.
        // Fixes the chooser vanishing for multi-sub customers + the sustained
        // 429s Kiko flagged. (2026-07-06)
        query: target,
        "with-items": "true",
        "with-billing-attempts": "true",
        page: String(page),
      });
      // No silent `.catch(() => null)` here. A failed page must propagate so
      // the caller throws (→ 500 → the FE shows a retryable error state)
      // instead of returning a truncated/empty list that the Hub and Account
      // would misread as "this customer has no subscription". req() already
      // retries transient GET failures before this rejects.
      return this.req<SealListResponse<SealSubscription>>(
        `/subscriptions?${params.toString()}`,
      );
    };

    // Round 1: page 1 alone, to learn how many pages there are (usually 1 now
    // that the result set is scoped to a single email).
    const page1 = await fetchPage(1);
    const totalPages = page1?.payload?.total_pages ?? 1;

    // Round 2: pages 2..N in parallel. Total wall-clock ≈ 2 × single request.
    const rest =
      totalPages > 1
        ? await Promise.all(
            Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2)),
          )
        : [];

    const matches: SealSubscription[] = [];
    for (const data of [page1, ...rest]) {
      if (!data) continue;
      for (const s of data.payload?.subscriptions ?? []) {
        if (s.email?.trim().toLowerCase() === target) matches.push(s);
      }
    }
    return matches;
  }

  /**
   * List EVERY subscription Seal has, paginated, with items + billing attempts.
   *
   * Seal is the source of truth for subscriptions; the Supabase `subscriptions`
   * table is only a partial, webhook-populated cache (it lags new/charged subs
   * and never backfilled the existing book). Crons that must act on the WHOLE
   * active book — e.g. the renewal reminder, which has to see every upcoming
   * charge, not the ~20% the cache happens to hold — read from here instead.
   *
   * Pages are fetched with bounded concurrency: page 1 first to learn
   * total_pages, then the rest in waves of `POOL`. A failed page propagates
   * (no silent truncation) so the caller fails loud rather than acting on a
   * partial book. That guarantee is why every knob below is a DEADLINE and
   * never a "skip this page": running out of time also fails loud.
   *
   * The per-page retry lives in `req()`, deliberately not here: that is where
   * the jitter and the `Retry-After` handling already are, and a second retry
   * layer stacked on top would MULTIPLY attempts instead of adding to them, and
   * turn a bad night into the stampede that tripped Seal's rate limit in
   * 2026-07-06.
   */
  async listAllSubscriptions(signal?: AbortSignal): Promise<SealSubscription[]> {
    // POOL stays at 8. Halving it was tempting — this is the HEAVY endpoint and
    // parallel pressure on it is a known trigger (firing ~50 pages at once is
    // what tripped Seal's rate limit in getSubscriptionsByEmail, 2026-07-06) —
    // but nobody has MEASURED per-page latency at 4 vs 8, and with the book at
    // ~51 pages POOL 4 means 14 sequential waves instead of 8. That makes the
    // sweep SLOWER, which is the opposite of what this fix is for, and it would
    // also make the first production readings uninterpretable by moving two
    // knobs at once. Followup: measure, then decide.
    const POOL = 8;

    // Wall clock for the WHOLE sweep, on top of each page's own budget. Without
    // it a bad night multiplies (8 waves x attempt + retry) past the route's 60s
    // maxDuration and Vercel kills the function — a kill throws nothing, so it
    // alerts nobody, and some customers got their email while the rest did not.
    // Interactive callers get NO sweep budget: their per-call deadline is
    // exactly what it is today.
    const sweepDeadline = isBackgroundJob() ? deadlineIn(this.timings.sweepMs) : null;
    const sweepStart = Date.now();
    let pagesFetched = 0;

    /**
     * Never START a wave that cannot fit a useful round trip. Doing the check
     * here rather than only clamping the per-page deadline is what keeps the
     * error honest: a page launched with 40ms of sweep left would otherwise
     * report a 40ms Seal timeout, which is true of the socket and a lie about
     * what actually failed.
     */
    const requireSweepBudget = (totalPages: number) => {
      if (sweepDeadline === null || msLeft(sweepDeadline) >= MIN_USEFUL_ATTEMPT_MS) return;
      throw new SealSweepTimeoutError(Date.now() - sweepStart, pagesFetched, totalPages);
    };

    const fetchPage = async (page: number, totalPages: number) => {
      const params = new URLSearchParams({
        "with-items": "true",
        "with-billing-attempts": "true",
        page: String(page),
      });
      const own = budgetWithin(this.budgets().totalMs);
      try {
        return await this.req<SealListResponse<SealSubscription>>(
          `/subscriptions?${params.toString()}`,
          { signal },
          0,
          sweepDeadline === null ? own : Math.min(own, sweepDeadline),
        );
      } catch (err) {
        // A page can still be cut off mid-flight when the sweep runs out under
        // it. Re-label it: blaming Seal for a truncated window sends the on-call
        // to debug Seal instead of our own cap.
        if (
          err instanceof UpstreamTimeoutError &&
          sweepDeadline !== null &&
          msLeft(sweepDeadline) <= 0
        ) {
          throw new SealSweepTimeoutError(Date.now() - sweepStart, pagesFetched, totalPages);
        }
        throw err;
      }
    };

    const page1 = await fetchPage(1, 1);
    const totalPages = page1?.payload?.total_pages ?? 1;
    pagesFetched = 1;

    const all: SealSubscription[] = [...(page1?.payload?.subscriptions ?? [])];
    for (let start = 2; start <= totalPages; start += POOL) {
      requireSweepBudget(totalPages);
      const size = Math.min(POOL, totalPages - start + 1);
      const wave = Array.from({ length: size }, (_, i) => fetchPage(start + i, totalPages));
      for (const data of await Promise.all(wave)) {
        all.push(...(data?.payload?.subscriptions ?? []));
      }
      pagesFetched += size;
    }
    return all;
  }

  /**
   * Fetch a single subscription by id WITHOUT pagination.
   *
   * Re-discovered 2026-05-21: the SINGULAR `/subscription?id=X` endpoint
   * (not the plural `/subscriptions` list) honours the `id` query param
   * and returns just that subscription's payload. Costs ~1 round-trip
   * instead of the 33-page scan `getSubscription` does. Use this when
   * you already know the id (fast-path callers from /plan, /cancel, etc).
   */
  async getSubscriptionById(
    id: number,
    signal?: AbortSignal,
    opts?: {
      /**
       * Rethrow transient Seal failures (429 / 5xx after req()'s retries)
       * instead of returning null. Callers resolving an EXPLICIT customer
       * selection must use this: a swallowed throttle reads as "not found",
       * the route 404s subscription_not_found, and the FE treats that as
       * permanent — showing "no subscription" and clearing the multi-sub
       * selection (audit 2026-07-06). With the throw, api-helpers classifies
       * it as a retryable 503 seal_busy instead.
       */
      throwTransient?: boolean;
    },
  ): Promise<SealSubscription | null> {
    const params = new URLSearchParams({
      id: String(id),
      "with-items": "true",
      "with-billing-attempts": "true",
    });
    try {
      const res = await this.req<{ success?: boolean; payload?: SealSubscription }>(
        `/subscription?${params.toString()}`,
        { signal },
      );
      const sub = res?.payload;
      if (!sub || !sub.id) return null;
      // Defensive: ensure Seal actually returned the requested one.
      if (Number(sub.id) !== Number(id)) return null;
      return sub;
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") throw e;
      // A blown deadline is NOT "not found". Swallowing it to null is what
      // turns a stall into the customer-visible lie "no tienes suscripción"
      // (and, on an explicit multi-sub selection, clears their choice). Always
      // propagate so api-helpers can return a retryable 503 and alert.
      if (e instanceof UpstreamTimeoutError) throw e;
      if (
        opts?.throwTransient &&
        e instanceof SealApiError &&
        (e.status === 429 || e.status >= 500)
      ) {
        throw e;
      }
      return null;
    }
  }

  /**
   * @deprecated Full-store paginated scan (no server-side filter): with the
   * store at ~50 pages it fires them in one Promise.all and reliably trips
   * Seal's rate limit — the same stampede removed from getSubscriptionsByEmail
   * on 2026-07-06. Use getSubscriptionById (singular endpoint, 1 call). Kept
   * only until the next cleanup confirms no external callers remain.
   */
  async getSubscription(id: number, signal?: AbortSignal): Promise<SealSubscription | null> {
    // Seal silently ignores `?id=` (verified 2026-04-27, re-confirmed
    // 2026-05-14 — passing id=12635109 returned the first sub of page 1
    // unfiltered). We have to paginate and match client-side, same pattern
    // as getSubscriptionsByEmail.
    const fetchPage = (page: number) => {
      const params = new URLSearchParams({
        "with-items": "true",
        "with-billing-attempts": "true",
        page: String(page),
      });
      // Pass signal through so callers can cancel the whole paginated
      // scan (used by plan-change verify to enforce a tight 4 s budget).
      return this.req<SealListResponse<SealSubscription>>(
        `/subscriptions?${params.toString()}`,
        { signal },
      ).catch((e) => {
        // Re-throw aborts so the caller can detect them; swallow other
        // network errors so partial results still return null/best-effort.
        if ((e as { name?: string }).name === "AbortError") throw e;
        return null;
      });
    };

    const page1 = await fetchPage(1);
    const hit1 = page1?.payload?.subscriptions?.find((s) => s.id === id);
    if (hit1) return hit1;
    const totalPages = page1?.payload?.total_pages ?? 1;
    if (totalPages <= 1) return null;

    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2)),
    );
    for (const data of rest) {
      const hit = data?.payload?.subscriptions?.find((s) => s.id === id);
      if (hit) return hit;
    }
    return null;
  }

  // ────── Subscription-level mutations (PUT /subscription) ──────
  //
  // Probed 2026-04-27: Seal supports actions { pause, cancel, reactivate, edit }
  // and (per error message) `edit` requires an `edit` array of key-value pairs.
  // Exact key names for delivery_interval/items not yet verified end-to-end —
  // first prod test will need a sandbox/test customer.

  /**
   * Edit subscription fields. Seal's `edit` action expects an array of key-value
   * pairs. Common keys (best-guess until verified against sandbox):
   *   - delivery_interval: e.g. "3 months"
   *   - billing_interval: same
   *   - s_address1, s_city, s_zip, s_country_code, s_province_code, s_phone
   *   - items: array of line items (for box count / quantity changes)
   */
  async editSubscription(
    subscriptionId: number,
    edits: Record<string, unknown>,
  ): Promise<void> {
    // Seal accepts the PUT but signals failure via `success: false` + an
    // error message in the response body. Treat that as an error so the
    // portal surfaces it instead of silently lying about the change.
    const res = await this.req<{ success?: boolean; message?: string; payload?: unknown }>(
      "/subscription",
      {
        method: "PUT",
        body: JSON.stringify({
          action: "edit",
          id: subscriptionId,
          edit: edits,
        }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(
        200,
        `Seal edit rejected: ${res.message ?? JSON.stringify(res)}`,
      );
    }
    console.log("[seal-edit] response:", JSON.stringify(res));
  }

  /**
   * Reschedule a single billing attempt to a specific date.
   * date format: YYYY-MM-DD; time HH:MM (no seconds); timezone +HH:MM.
   * See reference_seal_api.md for gotchas (Seal regenerates attempts; skipped
   * attempts count for "close to date" validation).
   */
  async rescheduleBillingAttempt(
    attemptId: number,
    subscriptionId: number,
    date: string, // YYYY-MM-DD
    time = "13:00",
    timezone = "+00:00",
  ): Promise<void> {
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription-billing-attempt",
      {
        method: "PUT",
        body: JSON.stringify({
          action: "reschedule",
          id: attemptId,
          subscription_id: subscriptionId,
          date,
          time,
          timezone,
        }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal reschedule rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  /**
   * THERE IS NO pauseSubscription() HERE, ON PURPOSE.
   *
   * A `pauseSubscription()` wrapper for Seal's `pause` action existed from the
   * first version of this client and never had a single caller: pausing is not a
   * product we offer. What we offer instead is the skip / spacing retention
   * wizard (see /api/subscription/skip), which keeps the subscription alive.
   *
   * It was removed on 2026-07-28 while investigating 86 customer-side pauses,
   * all of them made inside Seal's own customer portal. Dead code whose only
   * possible effect is to stop billing a paying customer is a liability, and its
   * presence made the pauses look for a while like they might have been ours.
   *
   * To un-pause, use `resumeSubscription` below.
   */

  /**
   * Bring a PAUSED subscription back to ACTIVE.
   *
   * VERIFIED against Seal 2026-07-29 on sub 14692586: pause -> PAUSED (paused_on
   * set) -> resume -> ACTIVE with paused_on CLEARED. Response payload is
   * "Subscription was reactivated." for both verbs, but Seal's own log
   * distinguishes them: "Merchant resumed the subscription through API."
   *
   * Uses `resume`, not `reactivate`. Seal's docs say the two are interchangeable:
   * "There is almost no difference in the resume and reactivate actions, except
   * that you generally resume paused subscriptions and reactivate the cancelled
   * subscriptions. But you can use any of these two actions." What is NOT
   * interchangeable is the webhook Seal fires afterwards: `resume` emits
   * subscription/resumed and `reactivate` emits subscription/reactivated. Using
   * the verb that matches the state keeps the audit trail honest.
   *
   * Kept as its own method rather than having callers reach for
   * `reactivateSubscription` because the two flows must stay apart: resuming a
   * pause restores no Drops and must not touch cancel_count.
   *
   * Like reactivate, Seal regenerates billing_attempts asynchronously, so the
   * list can be briefly empty right after this returns.
   */
  async resumeSubscription(subscriptionId: number): Promise<void> {
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription",
      {
        method: "PUT",
        body: JSON.stringify({ action: "resume", id: subscriptionId }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal resume rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  updatePlan(_subscriptionId: number, _changes: { boxCount?: number; frequency?: string }): Promise<SealSubscription> {
    throw new Error("Not implemented yet — use editSubscription + rescheduleBillingAttempt directly");
  }

  /**
   * Add one or more items to a subscription. Used together with `removeItems`
   * to swap a variant — Seal has no direct swap endpoint, confirmed by
   * Seal support 2026-05-14: "the only way to swap products in a subscription
   * via the API is to add the new product, and then remove the old product."
   *
   * VERIFIED 2026-07-27 (scripts/probe-mix.mjs): a SINGLE add_items call with N
   * items creates all N at once (no partial application), each stays recurring, and
   * Seal honours a custom per-unit `price` — SL30 went in at 22.64 when its
   * catalogue price is 28.35. `total_value` comes back as Σ(price × quantity).
   *
   * GOTCHA: `price` is per-unit, not total. With quantity=2 and price=10,
   * Seal charges 20. To preserve a desired total, divide first. And it is
   * REQUIRED, not optional: omitting it returns "Item is missing price value."
   * (contradicting an earlier comment here that claimed Seal would default to
   * the Shopify price).
   *
   * GOTCHA: any discount_codes active on a REMOVED item carry over to the
   * newly-added item. Caller that wants to drop a discount on swap must
   * call DELETE /subscription-discount-code afterwards.
   *
   * `selling_plan_id` — accepted but effectively IGNORED: Seal overwrites it with
   * the plan matching the subscription's current `delivery_interval`, so change the
   * interval first and let Seal align every line. Confirmed in prod.
   */
  async addItems(
    subscriptionId: number,
    items: Array<{
      productId: string;
      variantId: string;
      quantity: number;
      title: string;
      sku: string;
      taxable?: boolean;
      requiresShipping?: boolean;
      price?: string;       // per-unit; REQUIRED by Seal in practice
      sellingPlanId?: string;
      /** Shopify line-item properties. Seal's contract is an ARRAY of {key,value}
       *  (was mistyped as an object here until 2026-07-27). */
      properties?: SealItemProperty[];
      /** Add-to-next-order only: Seal removes it after the next renewal. */
      oneTime?: boolean;
    }>,
  ): Promise<void> {
    if (!items.length) return;
    const body = {
      action: "add_items",
      id: subscriptionId,
      add_items: items.map((it) => ({
        product_id: it.productId,
        variant_id: it.variantId,
        quantity: it.quantity,
        title: it.title,
        sku: it.sku,
        taxable: it.taxable === false ? 0 : 1,
        requires_shipping: it.requiresShipping === false ? 0 : 1,
        one_time: it.oneTime ? 1 : 0,
        ...(it.price !== undefined ? { price: it.price } : {}),
        ...(it.sellingPlanId !== undefined ? { selling_plan_id: it.sellingPlanId } : {}),
        ...(it.properties !== undefined ? { properties: it.properties } : {}),
      })),
    };
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription",
      { method: "PUT", body: JSON.stringify(body) },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal add_items rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  /**
   * Edit EXISTING lines in place, by Seal item id — quantity, per-unit price,
   * one_time and/or properties.
   *
   * VERIFIED 2026-07-27 (scripts/probe-mix.mjs): Seal answers "Items were edited in
   * the subscription.", the quantity and price change, and **the item ids do NOT
   * change**. The billing_attempts schedule is untouched.
   *
   * This is the safe primitive and should be preferred over add_items+removeItems
   * whenever the set of variants isn't changing. Because nothing is removed, it
   * cannot trigger the invisible discount-code carry-over; because item ids survive,
   * a client's cached `mainItemId` stays valid; and because there is no window with
   * both an old and a new line present, it cannot leave a customer paying for two.
   * That window is exactly what overcharged 7 subscriptions in June-July 2026 (see
   * scripts/repair-duplicate-lines.mjs).
   *
   * `price` is per-unit, same as add_items.
   */
  async editItems(
    subscriptionId: number,
    edits: Array<{
      itemId: number;
      quantity?: number;
      /** per-unit, 2dp string */
      price?: string;
      oneTime?: boolean;
      properties?: SealItemProperty[];
    }>,
  ): Promise<void> {
    if (!edits.length) return;
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription",
      {
        method: "PUT",
        body: JSON.stringify({
          action: "edit_items",
          id: subscriptionId,
          edit_items: edits.map((e) => ({
            id: e.itemId,
            ...(e.quantity !== undefined ? { quantity: e.quantity } : {}),
            ...(e.price !== undefined ? { price: e.price } : {}),
            ...(e.oneTime !== undefined ? { one_time: e.oneTime ? 1 : 0 } : {}),
            ...(e.properties !== undefined ? { properties: e.properties } : {}),
          })),
        }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal edit_items rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  /**
   * Remove items by their Seal item ID (`SealItem.id`, NOT variant_id).
   */
  async removeItems(subscriptionId: number, itemIds: number[]): Promise<void> {
    if (!itemIds.length) return;
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription",
      {
        method: "PUT",
        body: JSON.stringify({
          action: "remove_items",
          id: subscriptionId,
          remove_items: itemIds,
        }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal remove_items rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  /**
   * Retention discount (cancel flow): apply a Shopify discount code to a
   * subscription. Contract per Seal merchant API docs (verified 2026-07-03):
   *   PUT /subscription-discount-code { subscription_id, action:"apply", discount_code }
   *
   * IMPORTANT: a Seal discount code recurs on EVERY future charge until removed.
   * The "15% next charge only" guarantee comes from removing it after the first
   * discounted charge via lib/retention-discount (webhook + daily cron sweep).
   * There is NO Shopify-side cap: Seal's recurring charges bypass Shopify's
   * usageLimit / appliesOncePerCustomer entirely, so API removal is the only
   * thing that stops the recurrence (incident 2026-07-23).
   */
  async applyDiscountCode(subscriptionId: number, code: string): Promise<void> {
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription-discount-code",
      {
        method: "PUT",
        body: JSON.stringify({ subscription_id: subscriptionId, action: "apply", discount_code: code }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal apply-discount rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  /**
   * Remove a discount code from a subscription so it stops applying to future
   * charges. `discountCodeId` is the UUID from item.discount_codes[].id.
   * DELETE /subscription-discount-code?subscription_id=X&discount_code_id=Y
   */
  async removeDiscountCode(subscriptionId: number, discountCodeId: string): Promise<void> {
    const qs = new URLSearchParams({
      subscription_id: String(subscriptionId),
      discount_code_id: discountCodeId,
    });
    const res = await this.req<{ success?: boolean; message?: string }>(
      `/subscription-discount-code?${qs.toString()}`,
      { method: "DELETE" },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal remove-discount rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  /**
   * Skip a specific billing attempt.
   * Per reference_seal_api.md: action="skip" needs id + subscription_id.
   *
   * Seal returns HTTP 200 with `{success: false, message}` when it rejects
   * the action (same pattern as `editSubscription`). We must surface that
   * as an error — otherwise the portal claims "Saltado" while Seal didn't
   * actually skip anything (Juan 2026-05-21 audit, after a skip apparently
   * vanished post-plan-change).
   */
  async skipBillingAttempt(attemptId: number, subscriptionId: number): Promise<void> {
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription-billing-attempt",
      {
        method: "PUT",
        body: JSON.stringify({ action: "skip", id: attemptId, subscription_id: subscriptionId }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal skip rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  async unskipBillingAttempt(attemptId: number, subscriptionId: number): Promise<void> {
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription-billing-attempt",
      {
        method: "PUT",
        body: JSON.stringify({ action: "unskip", id: attemptId, subscription_id: subscriptionId }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal unskip rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  /**
   * Re-anchor the regenerated schedule to the customer's prior next-ship date.
   *
   * Why: a frequency change makes Seal DELETE and REGENERATE the whole
   * billing_attempts schedule anchored on "last completed charge + interval",
   * ignoring any prior skip — e.g. a customer who had their next charge on
   * 27-Jul ends up with the schedule re-anchored to 11-Jul. Business rule
   * (Juan 2026-06-12): EVERY change counts FROM the date the customer already
   * had; the next charge must never move earlier, and the new cadence runs
   * from that preserved date.
   *
   * Mechanism (verified against the live Seal API 2026-06-12):
   *   - reschedule moves a single attempt but does NOT re-space the rest, and
   *     it rejects moving an attempt onto a date where one already exists
   *     ("another attempt scheduled close to the desired date").
   *   - Seal's regenerated attempts ARE correctly spaced for the new frequency
   *     among themselves (e.g. exactly 45 days apart); they're just anchored on
   *     the wrong start date.
   *   - So we SHIFT the whole schedule by a uniform offset = (preserve − first
   *     pending date), preserving Seal's own spacing (works for day- and
   *     month-based intervals alike without hardcoding interval lengths) while
   *     moving the first charge onto the preserved date. We reschedule each
   *     pending attempt FURTHEST-FIRST so we never drop one onto a slot still
   *     occupied by an un-moved attempt (avoids the "close to date" rejection).
   *
   * Only shifts FORWARD (offset > 0): if Seal's first charge is already on/after
   * preserve, there's nothing to fix (we never pull a charge earlier — that's
   * charge-now's job). Idempotent: re-reads live state; once the first pending
   * equals preserve, the offset is 0 and it's a no-op. Sequential reschedules —
   * Seal regenerates on every mutation, so concurrent calls would race.
   *
   * Returns the number of attempts moved.
   */
  async reanchorCadence(
    subscriptionId: number,
    preserveYYYYMMDD: string,
  ): Promise<number> {
    const sub = await this.getSubscriptionById(subscriptionId);
    if (!sub) return 0;

    const pending = (sub.billing_attempts ?? [])
      .filter((ba) => !ba.completed_at && !ba.status && !ba.skipped_on)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (pending.length === 0) return 0;

    const firstDay = pending[0].date.slice(0, 10);
    // Only act when Seal anchored EARLIER than the preserved date.
    if (firstDay >= preserveYYYYMMDD) return 0;

    const offsetDays = daysBetween(firstDay, preserveYYYYMMDD); // > 0
    if (offsetDays <= 0) return 0;

    // Compute each attempt's target = its current date + offset, then move
    // furthest-first so we never collide with an un-moved attempt.
    const moves = pending
      .map((ba) => ({ id: ba.id, cur: ba.date.slice(0, 10), tgt: addDaysYYYYMMDD(ba.date.slice(0, 10), offsetDays) }))
      .filter((m) => m.cur !== m.tgt)
      .sort((a, b) => b.tgt.localeCompare(a.tgt));

    let moved = 0;
    for (const m of moves) {
      await this.rescheduleBillingAttempt(m.id, subscriptionId, m.tgt);
      moved++;
      // Seal needs a beat to settle its regenerator between mutations.
      await sleep(SEAL_BACKOFF_MS);
    }
    return moved;
  }

  /**
   * Charge the subscription's next order RIGHT NOW ("adelantar pedido").
   *
   * Hits Seal's dedicated `/subscription-create-charge-now` endpoint, which
   * bills the payment method on file immediately and (with
   * `reset_schedule: "true"`) recreates the rest of the billing schedule
   * anchored on today — i.e. the next order moves to ~today + one cycle.
   * Without `reset_schedule`, Seal keeps the previously-queued future
   * attempts, which would double-bill the customer; so callers who want the
   * "bring forward" behaviour MUST pass `resetSchedule: true`.
   *
   * NOTE: `id` here is the SUBSCRIPTION id, not a billing-attempt id (unlike
   * skip/reschedule). `reset_schedule` is the STRING "true" — Seal's API uses
   * string booleans throughout.
   *
   * Seal returns HTTP 200 with `{success:false,message}` on rejection (e.g.
   * card declined), same as skip/edit — we surface that as an error so the
   * UI never claims success on a failed charge.
   */
  async chargeNow(subscriptionId: number, opts?: { resetSchedule?: boolean }): Promise<void> {
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription-create-charge-now",
      {
        method: "PUT",
        body: JSON.stringify({
          id: subscriptionId,
          ...(opts?.resetSchedule ? { reset_schedule: "true" } : {}),
        }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal charge-now rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  /**
   * Update shipping address fields on a subscription via `edit` action.
   * Maps the portal's clean address shape to Seal's `s_*` keys.
   */
  async updateShippingAddress(
    subscriptionId: number,
    address: {
      address1: string;
      address2?: string;
      city: string;
      postalCode: string;
      country: string;
      countryCode: string;
      province?: string;
      provinceCode?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
    },
  ): Promise<void> {
    const edit: Record<string, string> = {
      s_address1: address.address1,
      s_city: address.city,
      s_zip: address.postalCode,
      s_country: address.country,
      s_country_code: address.countryCode,
    };
    // `address2` se manda si el llamante lo ha decidido, AUNQUE VENGA VACIO.
    //
    // Con el `if (address.address2)` de antes, una direccion nueva sin piso no
    // mandaba la clave, Seal conservaba el piso de la direccion ANTERIOR y la
    // caja salia a la calle nueva con el piso viejo pegado. Medido el
    // 2026-08-12: un cambio de Madrid a Barcelona dejo el "3B" de Madrid.
    // `undefined` sigue significando "no lo toques"; `""` significa "borralo",
    // que es lo que hace falta para que alguien pueda mudarse a una casa.
    if (address.address2 !== undefined) edit.s_address2 = address.address2;
    if (address.province) edit.s_province = address.province;
    if (address.provinceCode) edit.s_province_code = address.provinceCode;
    if (address.firstName) edit.s_first_name = address.firstName;
    if (address.lastName) edit.s_last_name = address.lastName;
    if (address.phone) edit.s_phone = address.phone;
    await this.editSubscription(subscriptionId, edit);
  }

  /**
   * Cancel via Seal's `cancel` action. Per probe 2026-04-27 this returns
   * "Subscription was cancelled" — Seal sets cancelled_on immediately.
   * For "effective after next delivery" semantics, we wait for the next attempt
   * to complete and THEN cancel — that's a higher-level flow, not this method.
   * NOTE: destructive — must be wrapped by an authenticated portal endpoint
   * with explicit user confirmation.
   */
  async cancelSubscription(subscriptionId: number, _opts: { reason?: string } = {}): Promise<void> {
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription",
      {
        method: "PUT",
        body: JSON.stringify({ action: "cancel", id: subscriptionId }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal cancel rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  /**
   * Reactivate via Seal's `reactivate` action. Per probe 2026-04-27 this works
   * and Seal asynchronously regenerates billing_attempts (may be empty briefly
   * after reactivate; populated within seconds).
   */
  async reactivateSubscription(subscriptionId: number): Promise<void> {
    const res = await this.req<{ success?: boolean; message?: string }>(
      "/subscription",
      {
        method: "PUT",
        body: JSON.stringify({ action: "reactivate", id: subscriptionId }),
      },
    );
    if (res?.success === false) {
      throw new SealApiError(200, `Seal reactivate rejected: ${res.message ?? JSON.stringify(res)}`);
    }
  }

  /**
   * Add a one-time product to the NEXT order (Seal removes it after that
   * renewal). Used by Extras (add-to-box) and rewards/claim (Bottle, Merch).
   *
   * Correct Seal contract (verified against the Merchant API docs 2026-07-04):
   * the SAME `add_items` action used for plan swaps, with `one_time: 1` on the
   * item — NOT a separate `one_time_items` key. The old key was an unverified
   * guess that silently no-op'd (Seal returned success while adding nothing).
   * add_items needs the full line (product_id, title, price, …), so we resolve
   * it from Shopify first.
   */
  async addOneTimeProduct(
    subscriptionId: number,
    variantId: string,
    quantity: number,
  ): Promise<void> {
    const { shopifyAdmin } = await import("@/lib/shopify-admin");
    const v = await shopifyAdmin.getVariantForSealAddItems(variantId);
    if (!v) {
      throw new SealApiError(400, `addOneTimeProduct: variant ${variantId} not found in Shopify`);
    }
    await this.addItems(subscriptionId, [
      {
        productId: v.productId,
        variantId: v.variantId,
        quantity,
        title: v.title,
        sku: v.sku,
        taxable: v.taxable,
        requiresShipping: v.requiresShipping,
        price: v.price,
        oneTime: true,
      },
    ]);
  }
}

export const seal = new SealClient();

export class SealApiError extends Error {
  constructor(public status: number, body: string) {
    super(`Seal API error ${status}: ${body}`);
    this.name = "SealApiError";
  }
}

/**
 * The WHOLE `listAllSubscriptions` sweep ran out of its own wall clock
 * (`SealTimings.sweepMs`). Nothing here says anything about how Seal behaved.
 *
 * A distinct error on purpose. The first cut of the sweep budget reused
 * `UpstreamTimeoutError` and posted `seal timed out after 25000ms on
 * /subscriptions?...&page=14` to #server-errors — for a page that had never been
 * sent, naming an arbitrary pending page instead of the one that stalled. The
 * on-call reads that and goes to debug Seal. The message has to name the cap,
 * the elapsed time and how far the sweep actually got.
 *
 * Still a subclass of `UpstreamTimeoutError` so api-helpers keeps classifying it
 * as a transient upstream problem (retryable 503) rather than an internal fault.
 */
export class SealSweepTimeoutError extends UpstreamTimeoutError {
  constructor(
    public readonly elapsedMs: number,
    public readonly pagesFetched: number,
    public readonly totalPages: number,
  ) {
    super("seal", "listAllSubscriptions", elapsedMs);
    this.name = "SealSweepTimeoutError";
    // No em dash in the message itself: it is copy that lands in Slack.
    this.message =
      `seal sweep gave up after ${elapsedMs}ms with ${pagesFetched}/${totalPages} pages fetched. ` +
      `This is OUR cap on the whole sweep (SealTimings.sweepMs), not one Seal call timing out.`;
  }
}

/**
 * Seal replies HTTP 503 `"Could not create charge. This subscription already
 * has an attempt scheduled for processing. Try again in 15 minutes."` when a
 * charge attempt is already queued for the subscription — e.g. the customer
 * already tapped "adelantar pedido", or Seal has an imminent scheduled attempt.
 *
 * This is an EXPECTED, transient business condition, NOT an internal fault:
 * Seal is correctly refusing a second charge that would double-bill the card.
 * Callers should translate it to a clean 4xx (never a 500) so it doesn't page
 * `#n8n-errors` and the customer sees a calm "already processing" message.
 *
 * Matched on the message text (not the 503 status) so a genuine Seal outage —
 * a 503 with a different body — still surfaces as a real internal_error alert.
 */
export function isChargeAlreadyScheduledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /already has an attempt scheduled/i.test(msg);
}

// ============ Mapping helpers — Seal raw → portal Subscription ============

import type { Frequency, Subscription, SubscriptionStatus } from "./types";
import { CUTOFF_HOURS, cutoffEndsAt, isWithinCutoff } from "./cutoff";
import { mixEnabledForCustomer } from "./flags";
import {
  DEFAULT_FLAVOR,
  PACK4_BY_VARIANT,
  flavorKeyForProductId,
  flavorKeyForVariant,
  flavorLabel,
} from "./seal-plans";
import {
  boxesForVariantQuantity,
  chargeTotalCents as sumLineCharges,
  compositionFromLines,
  compositionLabel,
  MAX_BOXES,
  shapeFor,
  type FlavorComposition,
  type SubscriptionLine,
  type SubscriptionShape,
} from "./mix";

/**
 * Normalize Seal's free-text interval ("1 month", "15 days", "3 months") to
 * our enum (`1mo`, `15d`, `3mo`, ...).
 */
export function normalizeFrequency(deliveryInterval: string): Frequency {
  const s = deliveryInterval.toLowerCase().trim();
  if (s.includes("15") && s.includes("day")) return "15d";
  if (s.includes("45") && s.includes("day")) return "45d";
  const monthMatch = s.match(/(\d+)\s*month/);
  if (monthMatch) {
    const n = monthMatch[1];
    if (n === "1") return "1mo";
    if (n === "2") return "2mo";
    if (n === "3") return "3mo";
    if (n === "4") return "4mo";
    if (n === "5") return "5mo";
    if (n === "6") return "6mo";
  }
  // Fallback: assume monthly. Caller should log/alert on this.
  console.warn(`[seal] unknown delivery_interval "${deliveryInterval}" — defaulting to 1mo`);
  return "1mo";
}

export function mapStatus(s: SealSubscription): SubscriptionStatus {
  if (s.status === "CANCELLED") {
    // If a cancellation is scheduled but not yet effective (last shipment pending), portal-side this is "post_cancel"
    if (s.cancellation_scheduled_for) return "post_cancel";
    return "expired";
  }
  if (s.cancellation_scheduled_for) return "post_cancel";
  if (s.paused_on || s.status === "PAUSED") return "paused";
  return "active";
}

/** Every RECURRING line. `is_one_time_item` is the extras/rewards discriminator. */
export function getRecurringItems(s: SealSubscription): SealItem[] {
  return (s.items ?? []).filter((it) => !it.is_one_time_item);
}

/**
 * The subscription's recurring lines, normalized.
 *
 * Replaces the `items.find(it => !it.is_one_time_item) ?? items[0]` that every
 * reader used to do. That collapse was wrong for the 11 ACTIVE multi-line subs and
 * the 90 with `quantity != 1` that already exist in production: a 3-box mix created
 * at checkout reported "1 box, Salty Lemon".
 *
 * Sorted by boxes desc so `lines[0]` is the DOMINANT line — that is what keeps
 * `mainItemId` / `currentVariantId` / `flavor` meaningful for clients that predate
 * the mix and for the fast path.
 */
export function getLines(s: SealSubscription): SubscriptionLine[] {
  return getRecurringItems(s)
    .map((it) => {
      const quantity = Math.max(1, Number(it.quantity) || 1);
      // Una línea PACK4 es multi-sabor: su verdad vive en `composition` (la de la
      // variante × quantity) y `flavor` queda como dominante para el back-compat.
      // Sin este reconocimiento, los contratos migrados al pack se leían como
      // "1 caja Salty Lemon" (fallback de variante desconocida) y cualquier
      // edición razonaba sobre esa mentira.
      const pack = PACK4_BY_VARIANT[String(it.variant_id)];
      return {
        itemId: it.id,
        productId: String(it.product_id),
        variantId: String(it.variant_id),
        // Legacy/manual/bundle variants aren't in the registry; attribute them to the
        // product's flavor, then to the default, exactly as extractFlavor always did.
        flavor:
          pack?.composition[0].flavor ??
          flavorKeyForVariant(String(it.variant_id)) ??
          flavorKeyForProductId(String(it.product_id)) ??
          DEFAULT_FLAVOR,
        boxes: boxesForVariantQuantity(String(it.variant_id), quantity),
        quantity,
        unitPrice: String(it.price ?? "0"),
        sellingPlanId: String(it.selling_plan_id ?? ""),
        ...(pack
          ? {
              composition: pack.composition.map((c) => ({
                flavor: c.flavor,
                boxes: c.boxes * quantity,
              })),
            }
          : {}),
      } satisfies SubscriptionLine;
    })
    .sort((a, b) => b.boxes - a.boxes || a.itemId - b.itemId);
}

/** The line that stands in for the whole subscription in back-compat fields. */
export function dominantLine(s: SealSubscription): SubscriptionLine | null {
  return getLines(s)[0] ?? null;
}

/** Boxes per flavor, aggregated across lines. */
export function getComposition(s: SealSubscription): FlavorComposition[] {
  return compositionFromLines(getLines(s));
}

export function getShape(s: SealSubscription): SubscriptionShape {
  return shapeFor(getComposition(s));
}

/** Σ quantity × unit price over recurring lines, in cents. NOT Seal's
 *  `total_value`, which nets out discount codes (verified: a sub on LITSTAY15 has
 *  items summing 56.70 but total_value 48.20). */
export function getChargeTotalCents(s: SealSubscription): number {
  return sumLineCharges(getLines(s));
}

/**
 * Total boxes per shipment = Σ over recurring lines of (variant box count × quantity).
 *
 * Correct for all four shapes in production: pack + qty 1 (every pure sub), 1-box +
 * qty N (checkout-created mixes), pack + qty N (`SL90 ×2` = 6 boxes, 90 active subs)
 * and portal-created mixes.
 *
 * Still clamped to 1..6 because `subscriptions.box_count` has that CHECK and an
 * out-of-range value silently failed the webhook + hub cache upserts. But a raw sum
 * above 6 is now reported instead of vanishing: it is the signature of a failed swap
 * that left duplicate lines, which is how 4 ACTIVE subs ended up charging double
 * without anyone noticing.
 */
export function getBoxCount(s: SealSubscription): number {
  const lines = getLines(s);
  if (!lines.length) return 1;
  const raw = lines.reduce((sum, l) => sum + l.boxes, 0);
  if (raw < 1 || raw > MAX_BOXES) {
    console.warn(
      `[getBoxCount] sub ${s.id}: raw box sum ${raw} outside 1..${MAX_BOXES} — ` +
        `clamping. Lines: ${lines.map((l) => `${l.variantId}×${l.quantity}`).join(", ")}. ` +
        `A sum above ${MAX_BOXES} usually means duplicate lines from a failed swap.`,
    );
  }
  return Math.min(MAX_BOXES, Math.max(1, raw));
}

/**
 * Pick the next pending billing attempt: not completed, not skipped, no terminal status.
 * Matches the filter in reference_seal_api.md.
 */
export function getNextBillingAttempt(s: SealSubscription): SealBillingAttempt | null {
  // EARLIEST pending attempt by date — not array order. Seal regenerates the
  // whole billing_attempts schedule on every write and does not guarantee
  // chronological order, so we sort rather than trust [0]/.find() (matches the
  // sort every other consumer already does: hub/dashboard, reanchorCadence,
  // pendingAttemptsBefore). A stable earliest also keeps the renewal-reminder
  // cron's window decision and dedup key deterministic across daily runs.
  const pending = (s.billing_attempts ?? [])
    .filter((ba) => !ba.completed_at && !ba.status && !ba.skipped_on && ba.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  return pending[0] ?? null;
}

/**
 * Date (ISO) of the most recent COMPLETED charge — the anchor Seal uses when it
 * regenerates the schedule after a frequency change ("last completed charge +
 * interval"). Used by the skip retention flow to compute the natural next-ship
 * date when a customer spaces out their cadence instead of skipping. Returns
 * null for a brand-new subscription with no completed charges yet.
 */
export function getLastCompletedChargeDate(s: SealSubscription): string | null {
  const completed = (s.billing_attempts ?? [])
    .filter((ba) => ba.completed_at && ba.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  return completed[0]?.date ?? null;
}

/**
 * UUID of an applied discount code on a subscription (searched across items),
 * matched by code string (case-insensitive). Returns null if not applied.
 * Used to remove the retention discount after its first (discounted) charge.
 */
export function findAppliedDiscountCodeId(s: SealSubscription, code: string): string | null {
  const target = code.trim().toLowerCase();
  for (const it of s.items ?? []) {
    for (const dc of it.discount_codes ?? []) {
      if (dc.code?.trim().toLowerCase() === target) return dc.id;
    }
  }
  return null;
}

/**
 * Pending attempts whose date falls strictly before `preserveYYYYMMDD`,
 * sorted ascending. Same "pending" filter as getNextBillingAttempt
 * (not completed, no terminal status, not skipped). Used to decide whether a
 * re-anchor is needed after a plan change regenerated the schedule earlier
 * than the customer had it.
 */
export function pendingAttemptsBefore(
  s: SealSubscription,
  preserveYYYYMMDD: string,
): SealBillingAttempt[] {
  return (s.billing_attempts ?? [])
    .filter((ba) => !ba.completed_at && !ba.status && !ba.skipped_on)
    .filter((ba) => ba.date.slice(0, 10) < preserveYYYYMMDD)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Whole days from `fromYYYYMMDD` to `toYYYYMMDD` (positive if `to` is later). */
function daysBetween(fromYYYYMMDD: string, toYYYYMMDD: string): number {
  const a = Date.parse(`${fromYYYYMMDD}T00:00:00Z`);
  const b = Date.parse(`${toYYYYMMDD}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Add `days` to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC, no tz drift). */
function addDaysYYYYMMDD(yyyymmdd: string, days: number): string {
  return new Date(Date.parse(`${yyyymmdd}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Box number = count of completed billing attempts + 1 (the upcoming one).
 * For a brand-new subscription with no charges yet, returns 1.
 */
export function getNextBoxNumber(s: SealSubscription): number {
  const completed = (s.billing_attempts ?? []).filter((ba) => ba.completed_at).length;
  return completed + 1;
}

/**
 * Resolve the flavor label for a subscription from its MAIN (non-one-time) item.
 *
 * Each flavor is its own Shopify product with 6 box-count variants (see the
 * FLAVORS registry in seal-plans). We map product_id → flavor first (stable even
 * if Shopify ever re-creates a variant), then fall back to variant_id, then to
 * the default flavor for legacy / manual / bundle subs whose product isn't in
 * the registry. Returns the UI label ("Salty Lemon" / "Salty Watermelon").
 */
export function extractFlavor(s: SealSubscription): string {
  return flavorLabel(dominantLine(s)?.flavor ?? DEFAULT_FLAVOR);
}

/**
 * Customer-facing flavor string INCLUDING the mix: "Salty Lemon" for a single
 * flavor (byte-identical to extractFlavor, so no cached row churns and no Klaviyo
 * segment breaks) or "2× Lemon · 1× Watermelon" for a mix.
 *
 * `extractFlavor` stays the DOMINANT label because `account/page.tsx` derives its
 * short name with `flavor.split(" ").slice(1)`, which turns a mix label into
 * garbage. Display surfaces migrate to this one explicitly.
 */
export function extractFlavorSummary(s: SealSubscription): string {
  const composition = getComposition(s);
  return composition.length ? compositionLabel(composition) : flavorLabel(DEFAULT_FLAVOR);
}

/**
 * ALL UUIDs of an applied discount code, across every line.
 *
 * `findAppliedDiscountCodeId` returns only the first. On a multi-line sub the same
 * code can surface once per line with distinct UUIDs, and removing one would leave a
 * permanent discount on the others — the money-leak class of incident 2026-07-23,
 * reintroduced by multi-line. Callers that REMOVE a code must loop over this.
 */
export function findAllAppliedDiscountCodeIds(s: SealSubscription, code: string): string[] {
  const target = code.trim().toLowerCase();
  const ids = new Set<string>();
  for (const it of s.items ?? []) {
    for (const dc of it.discount_codes ?? []) {
      if (dc.code?.trim().toLowerCase() === target && dc.id) ids.add(dc.id);
    }
  }
  return [...ids];
}

/**
 * Map a raw Seal subscription to our portal Subscription type.
 *
 * PURE and SYNCHRONOUS on purpose: the Seal webhook, 3 crons and 5 routes call it.
 * The mix needs no DB read because the composition is derived from Seal's own items,
 * so Seal stays the single source of truth.
 */
export function mapToSubscription(s: SealSubscription, customerId: string): Subscription {
  const next = getNextBillingAttempt(s);
  const nextShipDate = next?.date ?? null;
  const frequency = normalizeFrequency(s.delivery_interval);
  const lines = getLines(s);
  // Back-compat fields describe the DOMINANT line. Falling back to a one-time item
  // (extras / rewards) the way `items[0]` used to would hand the FE an item id that
  // a plan change then rejects with item_ownership_mismatch, so a sub with no
  // recurring line reports zeros and the UI treats it as unusable instead.
  const main = lines[0] ?? null;
  if (!main) {
    console.warn(
      `[mapToSubscription] sub ${s.id} has NO recurring line ` +
        `(${(s.items ?? []).length} item(s), all one-time) — plan actions will be unavailable`,
    );
  }
  const composition = compositionFromLines(lines);
  const boxCount = getBoxCount(s);
  const status = mapStatus(s);
  return {
    customerId,
    sealSubscriptionId: String(s.id),
    mainItemId: main?.itemId ?? 0,
    currentVariantId: main?.variantId ?? "",
    boxCount,
    lines,
    composition,
    shape: shapeFor(composition),
    flavorSummary: composition.length ? compositionLabel(composition) : flavorLabel(DEFAULT_FLAVOR),
    chargeTotalCents: sumLineCharges(lines),
    // Gate for the mix BUILDER only. Reading an existing mix is never gated: if the
    // flag flipping off changed how a mixed sub reads, those subscribers would start
    // seeing a single flavor in the portal and in their emails.
    canEditMix: boxCount >= 2 && status === "active" && mixEnabledForCustomer(customerId),
    frequency,
    frequencyLabel: s.delivery_interval,
    flavor: extractFlavor(s),
    nextShipDate,
    nextBoxNumber: getNextBoxNumber(s),
    status,
    createdAt: s.order_placed,
    withinCutoff: nextShipDate ? isWithinCutoff(nextShipDate) : false,
    cutoffEndsAt: nextShipDate ? cutoffEndsAt(nextShipDate).toISOString() : null,
    shippingAddress: {
      firstName: s.s_first_name ?? "",
      lastName: s.s_last_name ?? "",
      address1: s.s_address1 ?? "",
      address2: s.s_address2 ?? null,
      city: s.s_city ?? "",
      postalCode: s.s_zip ?? "",
      province: s.s_province ?? null,
      provinceCode: s.s_province_code ?? null,
      country: s.s_country ?? "",
      countryCode: s.s_country_code ?? "",
      phone: s.s_phone ?? null,
    },
    payment: {
      cardExpiryMonth: s.card_expiry_month || null,
      cardExpiryYear: s.card_expiry_year || null,
      // `s.edit_url` is deliberately NOT mapped — see the comment on
      // Subscription["payment"] in lib/types.ts.
    },
  };
}

export const _CUTOFF_HOURS = CUTOFF_HOURS; // re-export for tests

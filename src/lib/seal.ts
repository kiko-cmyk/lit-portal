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

const SEAL_API_BASE = "https://app.sealsubscriptions.com/shopify/merchant/api";

// Transient-failure retry budget for idempotent GETs. A single hiccup talking
// to Seal used to surface to active subscribers as "no subscription" (the
// email scan returned [] on a swallowed error → the Hub rendered EmptyState).
// Retrying GETs absorbs the common case; persistent failures now propagate.
const SEAL_MAX_RETRIES = 2;
const SEAL_BACKOFF_MS = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
}

export interface SealSubscription {
  id: number;
  internal_id: number;
  order_placed: string;
  delivery_interval: string; // e.g. "1 month", "15 days", "3 months"
  billing_interval: string;
  order_id: string;
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

class SealClient {
  private async req<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
    // Retry transient failures (network error, 429, 5xx) — but ONLY on
    // idempotent GETs. Mutations (PUT/POST) must never be retried: Seal
    // regenerates billing_attempts on every write, so a retried skip /
    // reschedule / charge-now could double-apply.
    const method = (init?.method ?? "GET").toUpperCase();
    const retriable = method === "GET";
    try {
      const res = await fetch(`${SEAL_API_BASE}${path}`, {
        ...init,
        headers: {
          "X-Seal-Token": token(),
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        if (
          retriable &&
          attempt < SEAL_MAX_RETRIES &&
          (res.status === 429 || res.status >= 500)
        ) {
          await sleep(SEAL_BACKOFF_MS * (attempt + 1));
          return this.req<T>(path, init, attempt + 1);
        }
        const body = await res.text().catch(() => "");
        throw new SealApiError(res.status, body);
      }
      return res.json() as Promise<T>;
    } catch (err) {
      // fetch() itself rejected (DNS / connection reset / timeout). Retry
      // idempotent calls. Never retry aborts (caller-driven cancellation) or
      // a SealApiError we already chose not to retry above.
      const name = (err as { name?: string }).name;
      if (
        retriable &&
        attempt < SEAL_MAX_RETRIES &&
        name !== "AbortError" &&
        !(err instanceof SealApiError)
      ) {
        await sleep(SEAL_BACKOFF_MS * (attempt + 1));
        return this.req<T>(path, init, attempt + 1);
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

    // Round 1: page 1 alone, to learn how many pages there are.
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
   * Fetch a single subscription by id WITHOUT pagination.
   *
   * Re-discovered 2026-05-21: the SINGULAR `/subscription?id=X` endpoint
   * (not the plural `/subscriptions` list) honours the `id` query param
   * and returns just that subscription's payload. Costs ~1 round-trip
   * instead of the 33-page scan `getSubscription` does. Use this when
   * you already know the id (fast-path callers from /plan, /cancel, etc).
   */
  async getSubscriptionById(id: number, signal?: AbortSignal): Promise<SealSubscription | null> {
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
      return null;
    }
  }

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
   * Apply Seal's `pause` action. Subscriber stops being billed; can be reactivated.
   * NOTE: this is destructive. Caller must confirm intent.
   */
  async pauseSubscription(subscriptionId: number): Promise<void> {
    await this.req("/subscription", {
      method: "PUT",
      body: JSON.stringify({ action: "pause", id: subscriptionId }),
    });
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
   * GOTCHA: `price` is per-unit, not total. With quantity=2 and price=10,
   * Seal charges 20. To preserve a desired total, divide first. We omit
   * `price` here when caller doesn't pass it — Seal then defaults to the
   * variant's current Shopify price (safer for routine plan changes).
   *
   * GOTCHA: any discount_codes active on a REMOVED item carry over to the
   * newly-added item. Caller that wants to drop a discount on swap must
   * call DELETE /subscription-discount-code afterwards.
   *
   * `selling_plan_id` — undocumented but appears to be accepted per Seal's
   * own portal mutations. We pass it when caller wants a per-line cadence
   * (variant + plan combined change). Seal may also need a separate
   * `edit { delivery_interval }` call to make the subscription-level
   * cadence match — to be confirmed when this code runs against prod.
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
      price?: string;       // per-unit; omit to let Seal use Shopify default
      sellingPlanId?: string;
      properties?: Record<string, unknown>;
    }>,
  ): Promise<void> {
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
        one_time: 0,
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
   * Remove items by their Seal item ID (`SealItem.id`, NOT variant_id).
   */
  async removeItems(subscriptionId: number, itemIds: number[]): Promise<void> {
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
    if (address.address2) edit.s_address2 = address.address2;
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
   * Add a one-time product to the next billing/shipment.
   * Used by Extras (rewards: Bottle, Merch) and Add-to-Box.
   * Best-guess key: `one_time_items` array. To be verified against sandbox.
   */
  async addOneTimeProduct(
    subscriptionId: number,
    variantId: string,
    quantity: number,
  ): Promise<void> {
    const numericVariantId = variantId.replace(/^gid:\/\/shopify\/ProductVariant\//, "");
    await this.editSubscription(subscriptionId, {
      one_time_items: [{ variant_id: numericVariantId, quantity }],
    });
  }
}

export const seal = new SealClient();

export class SealApiError extends Error {
  constructor(public status: number, body: string) {
    super(`Seal API error ${status}: ${body}`);
    this.name = "SealApiError";
  }
}

// ============ Mapping helpers — Seal raw → portal Subscription ============

import type { Frequency, Subscription, SubscriptionStatus } from "./types";
import { CUTOFF_HOURS, cutoffEndsAt, isWithinCutoff } from "./cutoff";
import { BOX_COUNT_BY_VARIANT } from "./seal-plans";

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

/**
 * "Box count" per LIT model = which SL30/SL60/SL90/SL120/SL150/SL180 variant
 * is on the subscription. Quantity stays at 1 — plan changes swap the variant
 * (add_items + remove_items), they don't bump the line quantity. Falls back
 * to `quantity` only if the variant_id isn't in our mapping (legacy/manual
 * subs), which lets the UI keep working while we surface the missing map.
 */
export function getBoxCount(s: SealSubscription): number {
  const main = s.items.find((it) => !it.is_one_time_item) ?? s.items[0];
  if (!main) return 1;
  const fromVariant = BOX_COUNT_BY_VARIANT[String(main.variant_id)];
  if (fromVariant) return fromVariant;
  return main.quantity ?? 1;
}

/**
 * Pick the next pending billing attempt: not completed, not skipped, no terminal status.
 * Matches the filter in reference_seal_api.md.
 */
export function getNextBillingAttempt(s: SealSubscription): SealBillingAttempt | null {
  const pending = (s.billing_attempts ?? []).find(
    (ba) => !ba.completed_at && !ba.status && !ba.skipped_on,
  );
  return pending ?? null;
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
 * Phase 1 reality: LIT ships a single flavor (Lemon Drop). Variant SKUs
 * (SL30/SL60/SL90/...) encode box count, not flavor, so returning the SKU
 * here surfaces the wrong string in the Hub hero. Hardcode for now; when
 * new flavors launch, read from a Shopify metafield on the variant.
 *
 * The `_s` arg is kept so callers don't need to change when we wire real
 * flavor lookup.
 */
export function extractFlavor(_s: SealSubscription): string {
  return "Salty Lemon";
}

/**
 * Map a raw Seal subscription to our portal Subscription type.
 */
export function mapToSubscription(s: SealSubscription, customerId: string): Subscription {
  const next = getNextBillingAttempt(s);
  const nextShipDate = next?.date ?? null;
  const frequency = normalizeFrequency(s.delivery_interval);
  const mainItem = s.items.find((it) => !it.is_one_time_item) ?? s.items[0];
  return {
    customerId,
    sealSubscriptionId: String(s.id),
    mainItemId: mainItem?.id ?? 0,
    currentVariantId: mainItem?.variant_id ?? "",
    boxCount: getBoxCount(s),
    frequency,
    frequencyLabel: s.delivery_interval,
    flavor: extractFlavor(s),
    nextShipDate,
    nextBoxNumber: getNextBoxNumber(s),
    status: mapStatus(s),
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
      sealEditUrl: s.edit_url || null,
    },
  };
}

export const _CUTOFF_HOURS = CUTOFF_HOURS; // re-export for tests

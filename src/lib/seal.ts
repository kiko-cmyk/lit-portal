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
  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${SEAL_API_BASE}${path}`, {
      ...init,
      headers: {
        "X-Seal-Token": token(),
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new SealApiError(res.status, body);
    }
    return res.json() as Promise<T>;
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
      return this.req<SealListResponse<SealSubscription>>(
        `/subscriptions?${params.toString()}`,
      ).catch(() => null);
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

  async getSubscription(id: number): Promise<SealSubscription | null> {
    const params = new URLSearchParams({
      "with-items": "true",
      "with-billing-attempts": "true",
      id: String(id),
    });
    const data = await this.req<SealListResponse<SealSubscription>>(
      `/subscriptions?${params.toString()}`,
    );
    return data.payload?.subscriptions?.[0] ?? null;
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
    await this.req("/subscription", {
      method: "PUT",
      body: JSON.stringify({
        action: "edit",
        id: subscriptionId,
        edit: edits,
      }),
    });
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
    await this.req("/subscription-billing-attempt", {
      method: "PUT",
      body: JSON.stringify({
        action: "reschedule",
        id: attemptId,
        subscription_id: subscriptionId,
        date,
        time,
        timezone,
      }),
    });
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
   * Skip a specific billing attempt.
   * Per reference_seal_api.md: action="skip" needs id + subscription_id.
   */
  async skipBillingAttempt(attemptId: number, subscriptionId: number): Promise<void> {
    await this.req("/subscription-billing-attempt", {
      method: "PUT",
      body: JSON.stringify({ action: "skip", id: attemptId, subscription_id: subscriptionId }),
    });
  }

  async unskipBillingAttempt(attemptId: number, subscriptionId: number): Promise<void> {
    await this.req("/subscription-billing-attempt", {
      method: "PUT",
      body: JSON.stringify({ action: "unskip", id: attemptId, subscription_id: subscriptionId }),
    });
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
    await this.req("/subscription", {
      method: "PUT",
      body: JSON.stringify({ action: "cancel", id: subscriptionId }),
    });
  }

  /**
   * Reactivate via Seal's `reactivate` action. Per probe 2026-04-27 this works
   * and Seal asynchronously regenerates billing_attempts (may be empty briefly
   * after reactivate; populated within seconds).
   */
  async reactivateSubscription(subscriptionId: number): Promise<void> {
    await this.req("/subscription", {
      method: "PUT",
      body: JSON.stringify({ action: "reactivate", id: subscriptionId }),
    });
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
 * "Box count" per LIT model = quantity of the main subscription item.
 * Extras (one-time products) are excluded.
 */
export function getBoxCount(s: SealSubscription): number {
  const main = s.items.find((it) => !it.is_one_time_item) ?? s.items[0];
  return main?.quantity ?? 1;
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
 * Best-effort flavor extraction. Today LIT has a single flavor (Lemon Salt),
 * so the variant title doesn't differentiate. When new flavors launch, this
 * needs to either (a) parse variant title, or (b) read a metafield.
 *
 * For now: returns variant_sku as a stable placeholder.
 */
export function extractFlavor(s: SealSubscription): string {
  const main = s.items.find((it) => !it.is_one_time_item) ?? s.items[0];
  return main?.variant_sku ?? main?.title ?? "LEMON";
}

/**
 * Map a raw Seal subscription to our portal Subscription type.
 */
export function mapToSubscription(s: SealSubscription, customerId: string): Subscription {
  const next = getNextBillingAttempt(s);
  const nextShipDate = next?.date ?? null;
  const frequency = normalizeFrequency(s.delivery_interval);
  return {
    customerId,
    sealSubscriptionId: String(s.id),
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
  };
}

export const _CUTOFF_HOURS = CUTOFF_HOURS; // re-export for tests

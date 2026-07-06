import { seal, type SealSubscription } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * The sub a request explicitly targets: body value first, else the
 * `?seal_subscription_id` param api-client injects on every call once a
 * multi-sub customer picks a subscription in the chooser. Null = nothing
 * requested (single-sub behaviour).
 */
export function requestedSubIdFrom(
  req: { url: string },
  bodyId?: number | string | null,
): string | null {
  if (bodyId !== undefined && bodyId !== null && String(bodyId).length > 0) {
    return String(bodyId);
  }
  return new URL(req.url).searchParams.get("seal_subscription_id");
}

/**
 * Multi-sub slow-path guard (audit 2026-07-06): when the request names a
 * specific subscription, the email-scan fallback must resolve THAT sub — never
 * silently act on "the first ACTIVE" one, which for a multi-sub customer can be
 * a DIFFERENT subscription (wrong-sub charge/skip/cancel/plan/discount). The
 * pre-fix pattern hit exactly that whenever the fast-path missed: the cache
 * lacks most multi-sub second rows, so verifyOwnershipFast=false → email scan →
 * first ACTIVE. Returns null when the requested sub isn't in the customer's
 * list (callers 404 — the scan is email-scoped, so ownership is inherent).
 * With no requested id, auto-picks the first ACTIVE sub (unchanged).
 */
export function pickRequestedSub(
  subs: SealSubscription[],
  requestedSubId: string | null,
): SealSubscription | null {
  if (requestedSubId) {
    return subs.find((s) => String(s.id) === requestedSubId) ?? null;
  }
  return subs.find((s) => s.status === "ACTIVE") ?? null;
}

/**
 * Fast-resolve the customer's ACTIVE Seal subscription via the cached
 * `seal_subscription_id` in Supabase `subscriptions` (populated by the Hub),
 * using Seal's singular by-id endpoint — ~1 quick call instead of the full
 * multi-page `getSubscriptionsByEmail` scan that drives most of the portal's
 * perceived slowness and the intermittent "subscription_not_found" on save.
 *
 * Returns null on a cache miss, a stale/cancelled cached id, an email
 * mismatch, or any Seal/DB hiccup — the caller then falls back to the email
 * scan (which also re-populates the cache). The status + email checks make a
 * stale cache safe: a cancelled-then-resubscribed customer falls through to
 * the scan, which finds the current ACTIVE sub.
 */
export async function resolveActiveSubFast(
  customerId: string,
  email: string,
  sealSubId?: number | string | null,
): Promise<SealSubscription | null> {
  try {
    // Explicit sub requested (multi-sub selector / ?seal_subscription_id): resolve
    // that exact sub and only return it if it belongs to this customer (email
    // match = ownership). Status is validated by the caller — routes reject a
    // non-active sub where they must — so we don't force ACTIVE here: a selected
    // scheduled-to-cancel sub is still viewable.
    if (sealSubId !== undefined && sealSubId !== null && String(sealSubId).length > 0) {
      const sub = await seal.getSubscriptionById(Number(sealSubId));
      if (sub && sub.email?.trim().toLowerCase() === email.trim().toLowerCase()) {
        return sub;
      }
      return null;
    }

    // Default (no explicit id): auto-pick from the cache. `.order().limit(1)`
    // avoids the PostgREST ">1 row" throw once a customer has multiple cached
    // subs (after the multi-sub PK flip) — deterministically picks the
    // soonest-ship cached row. For single-sub this is the only row, identical
    // to before.
    const { data } = await supabaseAdmin()
      .from("subscriptions")
      .select("seal_subscription_id")
      .eq("customer_id", customerId)
      .order("next_ship_date", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const cachedId = data?.seal_subscription_id;
    if (!cachedId) return null;
    const sub = await seal.getSubscriptionById(Number(cachedId));
    if (
      sub &&
      sub.status === "ACTIVE" &&
      sub.email?.trim().toLowerCase() === email.trim().toLowerCase()
    ) {
      return sub;
    }
    return null;
  } catch {
    return null;
  }
}

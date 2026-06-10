import { seal, type SealSubscription } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";

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
): Promise<SealSubscription | null> {
  try {
    const { data } = await supabaseAdmin()
      .from("subscriptions")
      .select("seal_subscription_id")
      .eq("customer_id", customerId)
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

import { supabaseAdmin } from "@/lib/supabase";

/**
 * Fast ownership check: does this Seal subscription id belong to the
 * given Shopify customer, per our Supabase mapping? ~50 ms vs the
 * 5–10 s Seal pagination scan it replaces in the cancel/skip/plan
 * routes' fast-path.
 *
 * Audit 2026-05-21 finding #9 (tightened 2026-05-22):
 *   Pre-fix the query only filtered by customer_id, then compared the
 *   returned `seal_subscription_id` against the requested one in JS.
 *   With multiple subs per customer that breaks (`.maybeSingle()`
 *   throws on >1 row → catch → returns false → slow path silently
 *   picked the first ACTIVE sub, NOT necessarily the requested one).
 *   Now both filters are on the SQL side; either the exact row exists
 *   or it doesn't.
 *
 * Returns false on any miss or db hiccup so the caller falls back to
 * the slow `getSubscriptionsByEmail` path.
 */
export async function verifyOwnershipFast(
  sealSubscriptionId: number,
  shopifyCustomerId: string,
): Promise<boolean> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb
      .from("subscriptions")
      .select("seal_subscription_id")
      .eq("customer_id", shopifyCustomerId)
      .eq("seal_subscription_id", String(sealSubscriptionId))
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}


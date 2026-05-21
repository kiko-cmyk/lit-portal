import { supabaseAdmin } from "@/lib/supabase";

/**
 * Fast ownership check: does this Seal subscription id belong to the
 * given Shopify customer, per our Supabase mapping? ~50 ms vs the
 * 5–10 s Seal pagination scan it replaces in the cancel/skip/plan
 * routes' fast-path.
 *
 * Returns false on any miss or db hiccup so the caller falls back to
 * the slow `getSubscriptionsByEmail` path.
 *
 * Juan 2026-05-21: extracted from /plan and /cancel after /skip got
 * the same treatment.
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
      .maybeSingle();
    if (!data?.seal_subscription_id) return false;
    return String(data.seal_subscription_id) === String(sealSubscriptionId);
  } catch {
    return false;
  }
}

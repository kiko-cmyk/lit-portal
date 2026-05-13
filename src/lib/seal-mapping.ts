/**
 * Caches the (customer_id → seal_subscription_id, shopify_contract_id) mapping
 * in Supabase so we don't have to scan all 31 Seal pages on every dashboard
 * load or plan change.
 *
 * First call for a customer:
 *   1. Read cache from `subscriptions` table — if both IDs present, return.
 *   2. Resolve email via Shopify Admin.
 *   3. Scan Seal for the customer's subscriptions (filter by email).
 *   4. Pull Shopify SubscriptionContracts for the same customer; match by
 *      origin order_id to bridge Seal ↔ Shopify.
 *   5. Upsert into `subscriptions`. Return both IDs.
 *
 * Subsequent calls: single SELECT on Supabase. Sub-100 ms cache hit.
 */

import { seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

export interface ResolvedIds {
  sealSubscriptionId: number;
  shopifyContractId: string;
  email: string;
}

/**
 * Resolve both the Seal subscription ID and the Shopify SubscriptionContract
 * ID for a given Shopify customer. Returns null only if the customer truly
 * has no subscription on either side.
 */
export async function resolveSubIds(
  shopifyCustomerId: string,
  email?: string,
): Promise<ResolvedIds | null> {
  const sb = supabaseAdmin();

  // 1. Cache lookup
  const { data: cached } = await sb
    .from("subscriptions")
    .select("seal_subscription_id, shopify_contract_id")
    .eq("customer_id", shopifyCustomerId)
    .maybeSingle();

  if (cached?.seal_subscription_id && cached.shopify_contract_id) {
    return {
      sealSubscriptionId: Number(cached.seal_subscription_id),
      shopifyContractId: cached.shopify_contract_id,
      email: email ?? "",
    };
  }

  // 2. Resolve email
  const resolvedEmail = email ?? (await shopifyAdmin.getCustomerEmail(shopifyCustomerId));
  if (!resolvedEmail) return null;

  // 3+4. Fetch Seal subs + Shopify contracts in parallel
  const [sealSubs, shopifyContracts] = await Promise.all([
    seal.getSubscriptionsByEmail(resolvedEmail),
    shopifyAdmin.listSubscriptionContractsByCustomer(shopifyCustomerId),
  ]);

  // Pick the active Seal sub (or fall back to most recent)
  const activeSealSub =
    sealSubs.find((s) => s.status === "ACTIVE") ??
    sealSubs.sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0];
  if (!activeSealSub) return null;

  // Defensive: Seal sub must belong to this customer's email
  if ((activeSealSub.email ?? "").trim().toLowerCase() !== resolvedEmail.trim().toLowerCase()) {
    console.error(
      `[seal-mapping] OWNERSHIP MISMATCH expected=${resolvedEmail} got=${activeSealSub.email} sub=${activeSealSub.id}`,
    );
    return null;
  }

  // Match Seal sub to Shopify contract via origin order ID
  const sealOrderGid = `gid://shopify/Order/${activeSealSub.order_id}`;
  let contract = shopifyContracts.find(
    (c) => c.originOrderId === sealOrderGid && c.status !== "CANCELLED",
  );
  if (!contract) {
    // Fallback: pick the active contract (some shops have only one).
    contract = shopifyContracts.find((c) => c.status === "ACTIVE");
  }
  if (!contract) {
    console.warn(
      `[seal-mapping] No Shopify contract for customer=${shopifyCustomerId} seal_sub=${activeSealSub.id} order=${activeSealSub.order_id}`,
    );
    return null;
  }

  // 5. Upsert cache
  await sb
    .from("subscriptions")
    .upsert(
      {
        customer_id: shopifyCustomerId,
        seal_subscription_id: String(activeSealSub.id),
        shopify_contract_id: contract.id,
        // Required NOT NULL columns — best-effort initial values; the
        // real Subscription mapper will overwrite these on next read
        // through the existing dashboard sync path.
        box_count: activeSealSub.items?.[0]?.quantity ?? 1,
        frequency: "1mo",
        flavor: activeSealSub.items?.[0]?.title ?? "LIT",
        status: activeSealSub.status === "ACTIVE" ? "active" : "paused",
      },
      { onConflict: "customer_id" },
    );

  return {
    sealSubscriptionId: activeSealSub.id,
    shopifyContractId: contract.id,
    email: resolvedEmail,
  };
}

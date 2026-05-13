import { ApiHttpError } from "@/lib/api-helpers";
import type { SealSubscription } from "@/lib/seal";

/**
 * Defensive ownership check. Throws if the Seal subscription's email doesn't
 * match the authenticated customer's email.
 *
 * Added 2026-05-13 after a near-incident: a UI test surfaced sub data for a
 * different customer (Ignacio) when the authenticated session belonged to
 * Juan. Root cause still under investigation. Until that's understood, EVERY
 * mutation endpoint must call this before touching Seal or Shopify state.
 *
 * Also logs both emails so that, if there's a mismatch, we can trace where
 * the wrong sub crept in.
 */
export function assertSubscriptionBelongsToCustomer(
  sub: SealSubscription,
  expectedEmail: string,
  context: string,
): void {
  const subEmail = (sub.email ?? "").trim().toLowerCase();
  const customerEmail = expectedEmail.trim().toLowerCase();

  if (subEmail !== customerEmail) {
    console.error(
      `[sub-guard:${context}] OWNERSHIP MISMATCH sub.id=${sub.id} sub.email=${sub.email} customer.email=${expectedEmail}`,
    );
    throw new ApiHttpError(
      403,
      "subscription_ownership_mismatch",
      `Subscription ${sub.id} does not belong to ${expectedEmail}`,
    );
  }
}

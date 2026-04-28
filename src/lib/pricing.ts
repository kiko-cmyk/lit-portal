/**
 * Pricing matrix for subscription plans.
 *
 * MVP uses a flat €14/box placeholder (Juan, 2026-04-27). Real progressive
 * pricing will be set on MVP launch — change this single constant.
 *
 * Frequency does NOT affect per-shipment price (LIT-Portal-Master-Spec § 4).
 */

export const PRICE_PER_BOX_EUR: readonly number[] = [14, 14, 14, 14, 14, 14] as const;

export const CURRENCY = "EUR" as const;

export const IS_PLACEHOLDER = true;

export const PRICING_LAST_UPDATED = "2026-04-27";

export function priceForBoxCount(boxCount: number): number {
  if (boxCount < 1 || boxCount > 6) {
    throw new Error(`Invalid box count ${boxCount} — must be 1..6`);
  }
  return PRICE_PER_BOX_EUR[boxCount - 1];
}

export function totalForShipment(boxCount: number): number {
  return boxCount * priceForBoxCount(boxCount);
}

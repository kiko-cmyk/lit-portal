/**
 * Reading LIT plan data out of a Shopify order's line items.
 *
 * Extracted from the orders/paid webhook so it can be verified without spinning up a
 * route: `scripts/verify-confirmation-props.ts` runs these against real production
 * orders as fixtures.
 */
import {
  BOX_COUNT_BY_VARIANT,
  PACK4_BY_VARIANT,
  type FlavorKey,
  flavorKeyForVariant,
} from "@/lib/seal-plans";

/** A line item in the shape this module and the confirmation event speak. */
export type OrderLine = {
  title: string;
  quantity: number;
  variant_id?: number;
  selling_plan_allocation?: { selling_plan?: { id: string; name?: string } };
};

/**
 * Boxes per flavor from an order's subscription lines, aggregating several lines of
 * the same flavor (a mix ships as one line per flavor). Lines outside the variant
 * registry are ignored: they have no flavor we can name.
 */
export function compositionFromOrderLines(
  lines: Array<{ variant_id?: number; quantity: number }>,
): Array<{ flavor: FlavorKey; boxes: number }> {
  const byFlavor = new Map<FlavorKey, number>();
  for (const li of lines) {
    const vid = String(li.variant_id ?? "");
    // Una línea PACK4 (suscripción o compra única) aporta la composición de su
    // variante de mezcla — no tiene UN sabor.
    const pack = PACK4_BY_VARIANT[vid];
    if (pack) {
      for (const c of pack.composition) {
        byFlavor.set(c.flavor, (byFlavor.get(c.flavor) ?? 0) + c.boxes * (li.quantity ?? 1));
      }
      continue;
    }
    const boxesPerUnit = BOX_COUNT_BY_VARIANT[vid];
    const flavor = flavorKeyForVariant(vid);
    if (boxesPerUnit === undefined || !flavor) continue;
    byFlavor.set(flavor, (byFlavor.get(flavor) ?? 0) + boxesPerUnit * (li.quantity ?? 1));
  }
  return [...byFlavor]
    .map(([flavor, boxes]) => ({ flavor, boxes }))
    .sort((a, b) => b.boxes - a.boxes);
}

/**
 * How many boxes this order is worth.
 *
 * The LIT model puts the box count in the VARIANT (SL90 = 3 boxes) with quantity almost
 * always 1, so summing `quantity` reported **1 box for every subscriber of more than one
 * box**. Map through the variant registry and multiply by quantity, which is correct for
 * all four shapes in production: pack × 1, 1-box × N (a mix), pack × N, and a
 * portal-created mix.
 */
export function boxCountFromOrderLines(lines: OrderLine[]): number {
  const subLines = lines.filter((li) => li.selling_plan_allocation);
  const main = subLines[0] ?? lines[0];
  const knownLines = subLines.filter(
    (li) => BOX_COUNT_BY_VARIANT[String(li.variant_id)] !== undefined,
  );
  if (knownLines.length > 0) {
    return knownLines.reduce(
      (s, li) => s + BOX_COUNT_BY_VARIANT[String(li.variant_id)]! * (li.quantity ?? 1),
      0,
    );
  }
  // Non-registry subscription lines (B2B, a retired variant): fall back to the old
  // quantity sum rather than reporting 0.
  if (subLines.length > 0) return subLines.reduce((s, li) => s + (li.quantity ?? 0), 0);
  // Pedido SIN líneas de suscripción (compra única): las variantes del registro
  // saben sus cajas (un pack de compra única son 4, un SL90 son 3 — el fallback
  // por cantidad decía 1 para ambos).
  const knownAll = lines.filter(
    (li) => BOX_COUNT_BY_VARIANT[String(li.variant_id)] !== undefined,
  );
  if (knownAll.length > 0) {
    return knownAll.reduce(
      (s, li) => s + BOX_COUNT_BY_VARIANT[String(li.variant_id)]! * (li.quantity ?? 1),
      0,
    );
  }
  return main?.quantity ?? 1;
}

/**
 * Shared order-status localization + badge styling.
 *
 * `/api/orders` returns Shopify's raw `displayFulfillmentStatus` enum
 * (FULFILLED, UNFULFILLED, IN_TRANSIT, PARTIALLY_FULFILLED, …) plus a few
 * normalized values used elsewhere (scheduled/upcoming/shipped). Both the Hub
 * (OrderHistory) and the Account page must render these the same way and in
 * the right language — previously Account printed the raw enum ("FULFILLED")
 * while the Hub translated it ("Entregada").
 */
type Lang = "en" | "es";

const LABELS: Record<string, { en: string; es: string }> = {
  // Shopify displayFulfillmentStatus
  fulfilled: { en: "Delivered", es: "Entregada" },
  unfulfilled: { en: "Processing", es: "En proceso" },
  partially_fulfilled: { en: "Partial", es: "Parcial" },
  in_transit: { en: "In transit", es: "En tránsito" },
  out_for_delivery: { en: "Out for delivery", es: "En reparto" },
  attempted_delivery: { en: "Delivery attempted", es: "Entrega intentada" },
  delivered: { en: "Delivered", es: "Entregada" },
  scheduled: { en: "Scheduled", es: "Programada" },
  on_hold: { en: "On hold", es: "En espera" },
  pending_fulfillment: { en: "Pending", es: "Pendiente" },
  open: { en: "Open", es: "Abierto" },
  restocked: { en: "Restocked", es: "Restock" },
  // Normalized / financial values used in other surfaces
  shipped: { en: "Shipped", es: "Enviada" },
  upcoming: { en: "Upcoming", es: "Próxima" },
  paid: { en: "Paid", es: "Pagada" },
  refunded: { en: "Refunded", es: "Reembolsada" },
  cancelled: { en: "Cancelled", es: "Cancelada" },
};

export function translateOrderStatus(s: string, lang: Lang): string {
  const key = (s || "").toLowerCase();
  return LABELS[key]?.[lang] ?? s;
}

export function orderStatusStyle(s: string): { background: string; color: string } {
  const key = (s || "").toLowerCase();
  if (key === "delivered" || key === "fulfilled") {
    return { background: "var(--color-success)", color: "var(--color-cream)" };
  }
  if (key === "scheduled" || key === "upcoming" || key === "in_transit" || key === "out_for_delivery") {
    return { background: "var(--color-bold-yellow)", color: "var(--color-lit-grey)" };
  }
  if (key === "refunded" || key === "cancelled" || key === "attempted_delivery") {
    return { background: "var(--color-danger)", color: "var(--color-cream)" };
  }
  return { background: "rgba(50, 55, 67, 0.12)", color: "var(--color-lit-grey)" };
}

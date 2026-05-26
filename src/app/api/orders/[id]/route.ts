import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { enforceRateLimit } from "@/lib/rate-limit";
import { shopifyAdmin } from "@/lib/shopify-admin";
import type { OrderDetail } from "@/lib/types";

/**
 * GET /apps/portal/api/orders/{id}
 *
 * Full detail of a single order belonging to the authenticated customer.
 * Used by the portal's order detail page to replace Shopify's Shop-branded
 * order status page (which broke the LIT brand experience).
 *
 * The `id` param is the numeric Shopify Order id (e.g. "17150366712157");
 * we reconstruct the GID server-side. Reject if the order doesn't belong
 * to this customer with a generic 404 (don't leak existence of other
 * customers' orders).
 */
export const GET = withCustomer<OrderDetail, { id: string }>(async (_req, ctx, routeCtx) => {
  await enforceRateLimit(ctx.customerId, "order-detail", { limit: 60, windowMs: 60_000 });

  const { id } = (await routeCtx?.params) ?? { id: "" };
  if (!id) throw new ApiHttpError(400, "missing_order_id", "");
  // Accept either bare numeric id or full GID (FE typically sends numeric).
  const numeric = id.replace(/^gid:\/\/shopify\/Order\//, "");
  if (!/^\d+$/.test(numeric)) {
    throw new ApiHttpError(400, "invalid_order_id", "order id must be numeric");
  }
  const gid = `gid://shopify/Order/${numeric}`;

  const raw = await shopifyAdmin.getOrderDetail(gid);
  if (!raw) {
    throw new ApiHttpError(404, "order_not_found", "");
  }

  // Ownership check: this order must belong to the authed customer.
  // Generic 404 (not 403) to avoid leaking that the GID exists at all.
  if (!raw.customerNumericId || raw.customerNumericId !== ctx.customerId) {
    throw new ApiHttpError(404, "order_not_found", "");
  }

  // Map Shopify GraphQL shape → OrderDetail (the type the FE consumes).
  const total = parseFloat(raw.currentTotalPrice.amount);
  const subtotal = raw.subtotalPrice ? parseFloat(raw.subtotalPrice.amount) : total;
  const shippingPrice = raw.totalShippingPrice ? parseFloat(raw.totalShippingPrice.amount) : 0;
  const tax = raw.totalTax ? parseFloat(raw.totalTax.amount) : 0;
  const currency = raw.currentTotalPrice.currencyCode;

  const fulfillment = (() => {
    if (raw.cancelledAt) {
      return {
        status: "cancelled" as const,
        shippedAt: null,
        deliveredAt: null,
        trackingNumber: null,
        trackingUrl: null,
        carrier: null,
      };
    }
    const f = raw.fulfillments[0];
    if (!f) {
      return {
        status: "pending" as const,
        shippedAt: null,
        deliveredAt: null,
        trackingNumber: null,
        trackingUrl: null,
        carrier: null,
      };
    }
    const status = f.deliveredAt
      ? ("fulfilled" as const)
      : ("in_transit" as const);
    return {
      status,
      shippedAt: f.createdAt,
      deliveredAt: f.deliveredAt,
      trackingNumber: f.trackingNumber,
      trackingUrl: f.trackingUrl,
      carrier: f.trackingCompany,
    };
  })();

  const mapAddress = (a: typeof raw.shippingAddress) =>
    a
      ? {
          firstName: a.firstName ?? "",
          lastName: a.lastName ?? "",
          address1: a.address1 ?? "",
          address2: a.address2 ?? null,
          city: a.city ?? "",
          postalCode: a.zip ?? "",
          province: a.province,
          country: a.country ?? "",
          phone: a.phone,
        }
      : null;

  const contactName = [raw.customer?.firstName, raw.customer?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  const detail: OrderDetail = {
    id: raw.id,
    orderNumber: raw.name,
    date: raw.createdAt,
    confirmationDate: raw.createdAt,
    total,
    currency,
    status: raw.displayFulfillmentStatus,
    invoiceUrl: null, // intentionally hidden in the portal per product decision
    contact: {
      name: contactName,
      email: raw.customer?.email ?? "",
      phone: raw.customer?.phone ?? null,
    },
    shippingAddress: mapAddress(raw.shippingAddress),
    billingAddress: mapAddress(raw.billingAddress),
    items: raw.lineItems.map((li) => ({
      id: li.id,
      title: li.title,
      variantTitle: li.variantTitle,
      quantity: li.quantity,
      price: parseFloat(li.originalUnitPrice),
      imageUrl: li.imageUrl,
      sku: li.sku,
    })),
    subtotal,
    shippingPrice,
    tax,
    fulfillment,
    shippingMethodTitle: raw.shippingMethodTitle,
    cancelledAt: raw.cancelledAt,
    canReorder: !raw.cancelledAt,
  };

  return detail;
});

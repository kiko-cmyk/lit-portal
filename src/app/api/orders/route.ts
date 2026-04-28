import { withCustomer } from "@/lib/api-helpers";
import { shopifyAdmin } from "@/lib/shopify-admin";
import type { OrderHistoryItem } from "@/lib/types";

// GET /apps/portal/api/orders?limit=10
export const GET = withCustomer<OrderHistoryItem[]>(async (req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "10", 10)));
  return shopifyAdmin.listOrdersByCustomer(ctx.customerId, limit);
});

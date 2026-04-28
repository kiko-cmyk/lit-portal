import { withCustomer } from "@/lib/api-helpers";
import { shopifyAdmin } from "@/lib/shopify-admin";
import type { TimelineEntry } from "@/lib/types";

// GET /apps/portal/api/timeline?limit=5
// Returns recent shipments (Shopify fulfillments) as timeline entries.
// The "next" upcoming entry comes from GET /api/subscription, not here.
export const GET = withCustomer<TimelineEntry[]>(async (req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get("limit") ?? "5", 10)));
  return shopifyAdmin.listFulfillmentsByCustomer(ctx.customerId, limit);
});

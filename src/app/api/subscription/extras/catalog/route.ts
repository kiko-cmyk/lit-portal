import { withCustomer } from "@/lib/api-helpers";
import { shopifyAdmin } from "@/lib/shopify-admin";

// GET /apps/portal/api/subscription/extras/catalog
// Returns Shopify products tagged `add-to-box` — managed from Shopify Admin
// (no custom panel; per locked decision 2026-04-27).
export const GET = withCustomer(async (_req, _ctx) => {
  const items = await shopifyAdmin.listExtrasCatalog();
  return { items };
});

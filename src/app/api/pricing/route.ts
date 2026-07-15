import { NextResponse } from "next/server";
import { CURRENCY, getPricing } from "@/lib/pricing";
import { DEFAULT_FLAVOR, isFlavorKey } from "@/lib/seal-plans";
import type { PricingResponse } from "@/lib/types";

// GET /apps/portal/api/pricing?flavor=salty-lemon
// Reads variant prices dynamically from Shopify (5min cache, per flavor).
// Prices are identical across flavors today; the param keeps the box-count
// price preview correct if a flavor is ever priced independently.
export async function GET(req: Request): Promise<NextResponse> {
  try {
    const flavorParam = new URL(req.url).searchParams.get("flavor");
    const flavor = isFlavorKey(flavorParam) ? flavorParam : DEFAULT_FLAVOR;
    const { perBox, compareAtPerBox, isPlaceholder, lastUpdated } = await getPricing(flavor);
    const body: PricingResponse & { compareAtPerBox: (number | null)[] } = {
      currency: CURRENCY,
      perBox,
      compareAtPerBox,
      isPlaceholder,
      lastUpdated,
    };
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown";
    return NextResponse.json({ error: "pricing_unavailable", message }, { status: 503 });
  }
}

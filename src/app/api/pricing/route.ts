import { NextResponse } from "next/server";
import { CURRENCY, getPricing } from "@/lib/pricing";
import type { PricingResponse } from "@/lib/types";

// GET /apps/portal/api/pricing
// Reads variant prices dynamically from Shopify (5min cache).
export async function GET(): Promise<NextResponse> {
  try {
    const { perBox, compareAtPerBox, isPlaceholder, lastUpdated } = await getPricing();
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

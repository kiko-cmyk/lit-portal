import { NextResponse } from "next/server";
import {
  CURRENCY,
  IS_PLACEHOLDER,
  PRICE_PER_BOX_EUR,
  PRICING_LAST_UPDATED,
} from "@/lib/pricing";
import type { PricingResponse } from "@/lib/types";

// GET /apps/portal/api/pricing
// Public — no customer auth required, but App Proxy signature still verified at edge.
export function GET() {
  const body: PricingResponse = {
    currency: CURRENCY,
    perBox: PRICE_PER_BOX_EUR,
    isPlaceholder: IS_PLACEHOLDER,
    lastUpdated: PRICING_LAST_UPDATED,
  };
  return NextResponse.json(body);
}

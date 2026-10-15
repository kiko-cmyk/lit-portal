import { NextResponse } from "next/server";
import { alertSlackError } from "@/lib/alert";
import { CURRENCY, getPricing, PricingConfigError } from "@/lib/pricing";
import { DEFAULT_FLAVOR, isFlavorKey } from "@/lib/seal-plans";
import type { PricingResponse } from "@/lib/types";

// GET /apps/portal/api/pricing?flavor=salty-lemon
// Subscription prices computed from Shopify (variant price × (1 − selling plan %),
// 60 s cache, per flavor). Prices are identical across flavors today; the param
// keeps the box-count price preview correct if a flavor is ever priced independently.
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
    // Una configuración de precios incoherente en Shopify (planes que no coinciden,
    // cambio de planes y precios a medias…) se avisa: es justo lo que nadie vería si
    // solo devolviéramos el 503 (6-oct-2026). Un fallo de red sigue siendo un 503 mudo.
    if (err instanceof PricingConfigError) {
      alertSlackError({ path: "/api/pricing", code: `pricing_config:${err.code}`, msg: err.message });
    }
    const message = err instanceof Error ? err.message : "Unknown";
    return NextResponse.json({ error: "pricing_unavailable", message }, { status: 503 });
  }
}

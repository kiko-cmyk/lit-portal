import { NextResponse, type NextRequest } from "next/server";
import { seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/diag — diagnostic endpoint, no auth.
 *
 * Times each external dependency individually so we can pinpoint which one
 * makes the dashboard handler exceed the Vercel function timeout. Returns
 * JSON with millisecond timings + envvar presence checks.
 *
 * Temporary — remove once the hub dashboard works reliably.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const out: Record<string, unknown> = {
    env: {
      SHOPIFY_API_SECRET: !!process.env.SHOPIFY_API_SECRET,
      SHOPIFY_ADMIN_TOKEN: !!process.env.SHOPIFY_ADMIN_TOKEN,
      SEAL_API_TOKEN: !!process.env.SEAL_API_TOKEN,
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
  };

  const t = async <T>(label: string, fn: () => Promise<T>): Promise<void> => {
    const start = Date.now();
    try {
      const result = await fn();
      out[label] = { ms: Date.now() - start, ok: true, sample: summarize(result) };
    } catch (err) {
      out[label] = {
        ms: Date.now() - start,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  await t("shopifyAdmin_ping", () =>
    shopifyAdmin.graphql<{ shop: { name: string } }>(`{ shop { name } }`),
  );

  // Hit Seal page 1 directly to inspect total_pages reporting
  await t("seal_page1_raw", async () => {
    const r = await fetch(
      "https://app.sealsubscriptions.com/shopify/merchant/api/subscriptions?page=1&with-items=true&with-billing-attempts=true",
      { headers: { "X-Seal-Token": process.env.SEAL_API_TOKEN ?? "" } },
    );
    const json = (await r.json()) as { success?: boolean; payload?: { total_pages?: number; subscriptions?: unknown[] } };
    return {
      status: r.status,
      success: json.success,
      total_pages: json.payload?.total_pages,
      subs_in_page: json.payload?.subscriptions?.length,
    };
  });

  await t("seal_full_scan_juan", () => seal.getSubscriptionsByEmail("juan@litsalt.com"));
  await t("supabase_select", async () => {
    const r = await supabaseAdmin().from("drops_balances").select("customer_id").limit(1);
    return r;
  });

  return NextResponse.json(out);
}

function summarize(v: unknown): unknown {
  if (Array.isArray(v)) return { type: "array", length: v.length };
  if (v && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).slice(0, 5);
    return { type: "object", keys };
  }
  return v;
}

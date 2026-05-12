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
  await t("seal_page1", () => seal.getSubscriptionsByEmail("noone@example.com", 1));
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

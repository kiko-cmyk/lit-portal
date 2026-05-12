import { NextResponse, type NextRequest } from "next/server";

/**
 * GET /apps/portal/api/auth/shopify/callback
 *
 * Shopify OAuth install/grant callback. Exchanges the `code` returned by
 * Shopify for a permanent Admin API access token (shpat_...).
 *
 * One-time use to capture the token after re-authorizing the LIT Portal app.
 * Returns the token as plain JSON so it can be copied into Vercel env.
 * Remove this endpoint (or make it write-only to Supabase) once stable.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("shop");

  if (!code || !shop) {
    return NextResponse.json({ error: "missing_code_or_shop", got: { code: !!code, shop } }, { status: 400 });
  }

  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: "missing_env", message: "SHOPIFY_API_KEY/SECRET not set" }, { status: 500 });
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
  });

  const body = await res.text();
  if (!res.ok) {
    return NextResponse.json({ error: "token_exchange_failed", status: res.status, body }, { status: 502 });
  }

  const json = JSON.parse(body) as { access_token: string; scope: string };
  return NextResponse.json({
    success: true,
    shop,
    access_token: json.access_token,
    scope: json.scope,
    instructions: "Copy access_token into Vercel env as SHOPIFY_ADMIN_TOKEN, then redeploy.",
  });
}

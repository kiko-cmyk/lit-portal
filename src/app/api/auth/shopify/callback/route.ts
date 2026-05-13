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

  // Support two Partners apps that share this callback URL:
  //   - lit-portal-v3 (default): handles App Proxy + webhooks
  //   - lit-portal-admin: subscription_contracts scopes
  // Caller can hint which one with ?client_id=...; otherwise we try both.
  const APPS: Array<{ apiKey: string; apiSecret: string }> = [
    {
      apiKey: process.env.SHOPIFY_API_KEY ?? "",
      apiSecret: process.env.SHOPIFY_API_SECRET ?? "",
    },
    {
      apiKey: process.env.SHOPIFY_API_KEY_ADMIN ?? "",
      apiSecret: process.env.SHOPIFY_API_SECRET_ADMIN ?? "",
    },
  ].filter((a) => a.apiKey && a.apiSecret);

  const hinted = url.searchParams.get("client_id");
  const candidates = hinted ? APPS.filter((a) => a.apiKey === hinted) : APPS;
  if (candidates.length === 0) {
    return NextResponse.json(
      { error: "no_app_credentials", message: `No matching app for client_id=${hinted ?? "(none)"}` },
      { status: 500 },
    );
  }

  let res: Response | null = null;
  let body = "";
  let lastApiKey = "";
  for (const app of candidates) {
    res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: app.apiKey, client_secret: app.apiSecret, code }),
    });
    body = await res.text();
    lastApiKey = app.apiKey;
    if (res.ok) break;
  }

  if (!res || !res.ok) {
    return NextResponse.json(
      { error: "token_exchange_failed", status: res?.status ?? 0, body, triedApiKey: lastApiKey },
      { status: 502 },
    );
  }

  const json = JSON.parse(body) as { access_token: string; scope: string };
  return NextResponse.json({
    success: true,
    shop,
    matched_client_id: lastApiKey,
    access_token: json.access_token,
    scope: json.scope,
    instructions: "Copy access_token into Vercel env as SHOPIFY_ADMIN_TOKEN, then redeploy.",
  });
}

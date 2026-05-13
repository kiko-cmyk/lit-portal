import { NextResponse, type NextRequest } from "next/server";

/**
 * GET /apps/portal/api/auth/shopify/callback
 *
 * Shopify OAuth install/grant callback. Exchanges the `code` returned by
 * Shopify for a permanent Admin API access token (shpat_...).
 *
 * The shop has two Partners apps that share this callback URL:
 *   - lit-portal-v3: App Proxy + webhooks (default)
 *   - lit-portal-admin: subscription_contracts scopes
 *
 * The install URL must pass `state=app_admin` to use the admin credentials.
 * Otherwise we default to v3. OAuth codes are bound to the client_id used
 * during install, so we cannot blindly retry against both apps — the first
 * failed exchange burns the code.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("shop");
  const state = url.searchParams.get("state");

  if (!code || !shop) {
    return NextResponse.json({ error: "missing_code_or_shop", got: { code: !!code, shop } }, { status: 400 });
  }

  const useAdminApp = state === "app_admin";
  const apiKey = useAdminApp ? process.env.SHOPIFY_API_KEY_ADMIN : process.env.SHOPIFY_API_KEY;
  const apiSecret = useAdminApp ? process.env.SHOPIFY_API_SECRET_ADMIN : process.env.SHOPIFY_API_SECRET;

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      {
        error: "no_app_credentials",
        message: `Env vars missing for ${useAdminApp ? "admin" : "v3"} app`,
        envVarsExpected: useAdminApp
          ? "SHOPIFY_API_KEY_ADMIN + SHOPIFY_API_SECRET_ADMIN"
          : "SHOPIFY_API_KEY + SHOPIFY_API_SECRET",
      },
      { status: 500 },
    );
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
  });

  const body = await res.text();
  if (!res.ok) {
    return NextResponse.json(
      { error: "token_exchange_failed", status: res.status, body, triedAs: useAdminApp ? "admin" : "v3" },
      { status: 502 },
    );
  }

  const json = JSON.parse(body) as { access_token: string; scope: string };
  return NextResponse.json({
    success: true,
    shop,
    matched_app: useAdminApp ? "lit-portal-admin" : "lit-portal-v3",
    access_token: json.access_token,
    scope: json.scope,
    instructions: "Copy access_token into Vercel env as SHOPIFY_ADMIN_TOKEN, then redeploy.",
  });
}

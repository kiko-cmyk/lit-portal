import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/**
 * GET /apps/portal/api/auth/shopify/callback
 *
 * Shopify OAuth install/grant callback. Exchanges the `code` returned by
 * Shopify for a permanent Admin API access token (shpat_...).
 *
 * Security (post-audit 2026-05-18):
 *   - The `state` parameter is validated as an HMAC over `shop` using
 *     SHOPIFY_OAUTH_STATE_SECRET. Without this guard, anyone could trick
 *     a partner into completing an install they didn't initiate.
 *   - The exchanged `access_token` is NEVER returned to the browser.
 *     During development, the token is logged server-side. In production,
 *     persisting it should happen here (Vercel KV / Supabase) and the
 *     handler should redirect to a "Install complete" page.
 *
 * The shop has two Partners apps that share this callback URL:
 *   - lit-portal-v3: App Proxy + webhooks (default)
 *   - lit-portal-admin: subscription_contracts scopes
 *
 * Convention: pre-pend `app_admin:` to the state to use the admin app.
 *   state = "app_admin:" + signed_state
 *   state = signed_state
 * Otherwise we default to v3.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("shop");
  const state = url.searchParams.get("state");
  const hmac = url.searchParams.get("hmac");

  if (!code || !shop || !state) {
    return NextResponse.json(
      { error: "missing_required_params", got: { code: !!code, shop: !!shop, state: !!state } },
      { status: 400 },
    );
  }

  if (!isValidShop(shop)) {
    return NextResponse.json({ error: "invalid_shop" }, { status: 400 });
  }

  // Validate state to mitigate CSRF on the install flow.
  const stateSecret = process.env.SHOPIFY_OAUTH_STATE_SECRET;
  if (!stateSecret) {
    console.error("[auth-callback] SHOPIFY_OAUTH_STATE_SECRET not set — refusing OAuth completion");
    return NextResponse.json({ error: "oauth_misconfigured" }, { status: 500 });
  }
  const adminPrefix = "app_admin:";
  const useAdminApp = state.startsWith(adminPrefix);
  const signedPart = useAdminApp ? state.slice(adminPrefix.length) : state;
  if (!verifyState(signedPart, shop, stateSecret)) {
    return NextResponse.json({ error: "invalid_state" }, { status: 403 });
  }

  // Optional but recommended: also validate Shopify's hmac param on the callback URL.
  // Shopify signs the *other* params with the app's client secret.
  if (hmac) {
    const apiSecretForHmac = useAdminApp ? process.env.SHOPIFY_API_SECRET_ADMIN : process.env.SHOPIFY_API_SECRET;
    if (apiSecretForHmac && !verifyShopifyCallbackHmac(url, hmac, apiSecretForHmac)) {
      return NextResponse.json({ error: "invalid_hmac" }, { status: 403 });
    }
  }

  const apiKey = useAdminApp ? process.env.SHOPIFY_API_KEY_ADMIN : process.env.SHOPIFY_API_KEY;
  const apiSecret = useAdminApp ? process.env.SHOPIFY_API_SECRET_ADMIN : process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: "no_app_credentials", message: `Env vars missing for ${useAdminApp ? "admin" : "v3"} app` },
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
      { error: "token_exchange_failed", status: res.status, triedAs: useAdminApp ? "admin" : "v3" },
      { status: 502 },
    );
  }

  const json = JSON.parse(body) as { access_token: string; scope: string };

  // Token is logged server-side only. The installer (typically Juan or a
  // partner) needs to read the Vercel log and copy it into SHOPIFY_ADMIN_TOKEN.
  // This stays in-team because audit logs are admin-only on Vercel.
  console.log(
    `[auth-callback] OAuth complete shop=${shop} app=${useAdminApp ? "admin" : "v3"} scope=${json.scope}`,
  );
  console.log(`[auth-callback] access_token (one-time, copy to Vercel env): ${json.access_token}`);

  return NextResponse.json({
    success: true,
    shop,
    matched_app: useAdminApp ? "lit-portal-admin" : "lit-portal-v3",
    scope: json.scope,
    instructions:
      "Token captured server-side. An admin must check Vercel function logs " +
      "for the access_token, copy it into SHOPIFY_ADMIN_TOKEN env, and redeploy.",
  });
}

function isValidShop(shop: string): boolean {
  // Shopify shop domains: <name>.myshopify.com — alphanumeric + dashes, no
  // userinfo, no paths. This is the canonical recommendation in their docs.
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
}

function verifyState(state: string, shop: string, secret: string): boolean {
  // state is `<random_nonce>.<hex_hmac>` — we accept the nonce as long as the
  // hmac matches HMAC_SHA256(secret, shop + nonce). The install URL generator
  // (typically a side script) signs `shop+nonce` with the same secret.
  const lastDot = state.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = state.slice(0, lastDot);
  const signature = state.slice(lastDot + 1);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(shop + payload, "utf8")
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyShopifyCallbackHmac(
  url: URL,
  receivedHmac: string,
  apiSecret: string,
): boolean {
  // Reconstruct the message Shopify signed: alphabetical-sorted query params
  // joined as `key=value&key2=value2`, excluding `hmac` itself.
  const params: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "hmac" || k === "signature") continue;
    params.push([k, v]);
  }
  params.sort((a, b) => a[0].localeCompare(b[0]));
  const message = params.map(([k, v]) => `${k}=${v}`).join("&");
  const expected = crypto
    .createHmac("sha256", apiSecret)
    .update(message, "utf8")
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(receivedHmac);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

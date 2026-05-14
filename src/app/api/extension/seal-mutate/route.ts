import { NextResponse, type NextRequest } from "next/server";

/**
 * POST /apps/portal/api/extension/seal-mutate
 *
 * Bridge between our Customer Account UI Extension popup and Seal's hidden
 * customer-facing endpoint (edit-subscription-v04.php). Seal accepts only
 * Shopify-signed JWTs in the Authorization header — we obtain that JWT
 * from inside the extension and forward it untouched.
 *
 * Open questions resolved by this spike:
 *   - Does Seal accept a JWT minted for our app's audience? (Their portal
 *     uses a JWT with aud=their-client-id; ours will have aud=ours.)
 *
 * Body: { action: string, payload: any }
 *   action e.g. "add_remove_products", "change_interval", etc.
 *   payload e.g. { subscriptionId, deleted_items, ... } — forwarded verbatim.
 *
 * Returns Seal's response wrapped with a `success` boolean we can read
 * from the popup's postMessage receiver in the parent portal.
 */

const SEAL_ENDPOINT =
  "https://app.sealsubscriptions.com/shopify/public/proxy/extension/api/edit-subscription-v04.php";

// Customer Account UI Extensions run in a Web Worker with origin `null`,
// so the response must allow any origin and we need an OPTIONS preflight
// handler for the custom Authorization header.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
} as const;

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json(
      { success: false, error: "missing_jwt", message: "Authorization: Bearer <jwt> required" },
      { status: 401, headers: CORS_HEADERS },
    );
  }
  const jwt = auth.slice("Bearer ".length);

  // Decode JWT body for telemetry (no signature verification — Seal does that)
  let claims: Record<string, unknown> | null = null;
  try {
    const payloadSeg = jwt.split(".")[1];
    if (payloadSeg) {
      const decoded = Buffer.from(payloadSeg, "base64url").toString("utf8");
      claims = JSON.parse(decoded);
    }
  } catch {
    // Non-fatal — let Seal reject if the JWT is malformed
  }

  let body: { action?: string; payload?: Record<string, unknown> } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "invalid_body", message: "JSON body required" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (!body.action || !body.payload) {
    return NextResponse.json(
      { success: false, error: "missing_fields", message: "action + payload required" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const forwardBody = { action: body.action, ...body.payload };

  console.log(
    `[seal-mutate] sub=${claims?.sub ?? "?"} aud=${claims?.aud ?? "?"} action=${body.action} payload=${JSON.stringify(body.payload)}`,
  );

  const sealRes = await fetch(SEAL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      // Mimic the Origin Seal's CORS allowlist expects (browsers would set
      // this automatically when called from extensions.shopifycdn.com; from
      // our backend we set it explicitly).
      Origin: "https://extensions.shopifycdn.com",
      Referer: "https://extensions.shopifycdn.com/",
    },
    body: JSON.stringify(forwardBody),
  });

  const sealText = await sealRes.text();
  let sealJson: unknown = null;
  try {
    sealJson = JSON.parse(sealText);
  } catch {
    sealJson = { raw: sealText };
  }

  console.log(`[seal-mutate] seal_status=${sealRes.status} seal_response=${sealText.slice(0, 500)}`);

  const sealSuccess =
    sealRes.ok &&
    typeof sealJson === "object" &&
    sealJson !== null &&
    (sealJson as { success?: unknown }).success === true;

  return NextResponse.json(
    {
      success: sealSuccess,
      sealStatus: sealRes.status,
      seal: sealJson,
      jwtClaims: claims,
    },
    // Pass through Seal's success status so the popup's caller can branch
    {
      status: sealSuccess ? 200 : sealRes.status >= 400 ? sealRes.status : 502,
      headers: CORS_HEADERS,
    },
  );
}

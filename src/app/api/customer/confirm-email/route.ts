import { NextResponse, type NextRequest } from "next/server";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Customer-initiated email-change confirmation (see PATCH /api/customer).
 *
 * The link mailed to the NEW inbox is
 *   /apps/portal/api/customer/confirm-email?token=<64-hex>
 * and possession of the token is the auth (it proves control of the new
 * mailbox). The URL is built by PATCH /api/customer and passed to Klaviyo as an
 * event property, so this route can change shape without any template edit.
 *
 * TWO-STEP, to survive email link scanners (Outlook SafeLinks, Gmail image
 * proxy, AV crawlers) that issue a GET to every link in an inbox and would
 * otherwise silently consume the one-time token before the customer clicks:
 *   GET  → renders a confirmation page with a "confirm" button. IDEMPOTENT, no
 *          mutation — a scanner prefetch just loads the page.
 *   POST → applies the change in Shopify, marks the row consumed, redirects
 *          back to the portal. Scanners don't submit forms, so only a real
 *          click mutates.
 *
 * No `withCustomer` wrapper: the token + DB row is the capability. Re-submitting
 * a consumed / expired token just renders an informational page (safe).
 *
 * NOTE: every HTML response is 200 on purpose. The Shopify App Proxy substitutes
 * upstream 5xx with the storefront theme HTML, which would hide our page — so we
 * carry the outcome in the page copy, not the status code.
 */

type Locale = "en" | "es";

const TOKEN_RE = /^[a-f0-9]{64}$/i;
const CONFIRM_PATH = "/apps/portal/api/customer/confirm-email";

interface ChangeRow {
  token: string;
  customer_id: string;
  new_email: string;
  expires_at: string;
  consumed_at: string | null;
}

type Lookup =
  | { state: "invalid" }
  | { state: "not_found" }
  | { state: "consumed"; row: ChangeRow }
  | { state: "expired"; row: ChangeRow }
  | { state: "valid"; row: ChangeRow };

async function lookupToken(token: string | null): Promise<Lookup> {
  if (!token || !TOKEN_RE.test(token)) return { state: "invalid" };
  const { data: row, error } = await supabaseAdmin()
    .from("email_change_requests")
    .select("token, customer_id, new_email, expires_at, consumed_at")
    .eq("token", token)
    .maybeSingle();
  if (error || !row) return { state: "not_found" };
  const r = row as ChangeRow;
  if (r.consumed_at) return { state: "consumed", row: r };
  if (new Date(r.expires_at).getTime() < Date.now()) return { state: "expired", row: r };
  return { state: "valid", row: r };
}

async function resolveLocale(customerId?: string): Promise<Locale> {
  if (!customerId) return "es";
  try {
    const pref = await shopifyAdmin.getCustomerMetafield(customerId, "lit_portal", "language_pref");
    return pref === "en" ? "en" : "es";
  } catch {
    return "es";
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function shell(locale: Locale, title: string, inner: string): NextResponse {
  const doc = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#f4f1ea; color:#1a1a1a; padding:16px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .card { background:#fff; max-width:420px; width:100%; padding:40px 32px;
    border-radius:14px; box-shadow:0 8px 40px rgba(0,0,0,.08); text-align:center; }
  .brand { font-weight:800; letter-spacing:.28em; font-size:13px; margin-bottom:28px; }
  h1 { font-size:20px; line-height:1.3; margin:0 0 12px; font-weight:700; }
  p { font-size:15px; line-height:1.55; color:#4a4a4a; margin:0 0 8px; }
  .email { font-weight:700; color:#1a1a1a; word-break:break-all; }
  form { margin-top:28px; }
  button { width:100%; border:0; cursor:pointer; padding:15px 20px; border-radius:8px;
    background:#1a1a1a; color:#f4f1ea; font-size:13px; font-weight:800; letter-spacing:.16em;
    text-transform:uppercase; }
  .muted { font-size:12px; color:#8a8a8a; margin-top:18px; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">LIT</div>
    ${inner}
  </main>
</body>
</html>`;
  return new NextResponse(doc, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function infoPage(locale: Locale, title: string, body: string): NextResponse {
  return shell(locale, title, `<h1>${esc(title)}</h1><p>${esc(body)}</p>`);
}

function confirmPage(locale: Locale, token: string, newEmail: string): NextResponse {
  const t =
    locale === "en"
      ? {
          title: "Confirm your new email",
          lead: "Confirm you want to use this address for your LIT account:",
          btn: "Confirm change",
          muted: "If you didn't request this, you can safely ignore this page.",
        }
      : {
          title: "Confirma tu nuevo email",
          lead: "Confirma que quieres usar esta dirección en tu cuenta LIT:",
          btn: "Confirmar cambio",
          muted: "Si no solicitaste esto, puedes ignorar esta página sin problema.",
        };
  const inner =
    `<h1>${esc(t.title)}</h1>` +
    `<p>${esc(t.lead)}</p>` +
    `<p class="email">${esc(newEmail)}</p>` +
    `<form method="POST" action="${CONFIRM_PATH}?token=${esc(token)}">` +
    `<button type="submit">${esc(t.btn)}</button>` +
    `</form>` +
    `<p class="muted">${esc(t.muted)}</p>`;
  return shell(locale, t.title, inner);
}

function renderState(locale: Locale, look: Lookup, token: string | null): NextResponse {
  const en = locale === "en";
  switch (look.state) {
    case "valid":
      return confirmPage(locale, token as string, look.row.new_email);
    case "consumed":
      return infoPage(
        locale,
        en ? "Already confirmed" : "Ya confirmado",
        en
          ? "This email change has already been confirmed. Nothing else to do."
          : "Este cambio de email ya se confirmó. No hay nada más que hacer.",
      );
    case "expired":
      return infoPage(
        locale,
        en ? "Link expired" : "Enlace caducado",
        en
          ? "This confirmation link has expired. Request the change again from your account."
          : "Este enlace de confirmación ha caducado. Solicita el cambio de nuevo desde tu cuenta.",
      );
    default: // "invalid" | "not_found"
      return infoPage(
        locale,
        en ? "Invalid link" : "Enlace no válido",
        en
          ? "This confirmation link is invalid or unknown."
          : "Este enlace de confirmación no es válido o no se reconoce.",
      );
  }
}

/** Render the confirm page (or an informational page). Never mutates. */
export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get("token");
  const look = await lookupToken(token);
  const locale = await resolveLocale("row" in look ? look.row.customer_id : undefined);
  return renderState(locale, look, token);
}

/** Apply the email change. Only a real form submit reaches here. */
export async function POST(req: NextRequest) {
  const token = new URL(req.url).searchParams.get("token");
  const look = await lookupToken(token);
  const locale = await resolveLocale("row" in look ? look.row.customer_id : undefined);

  // Anything but a live, valid token → render the matching info page (a
  // double-submit of an already-consumed token lands here and is harmless).
  if (look.state !== "valid") return renderState(locale, look, token);

  // Apply in Shopify, THEN mark consumed. If Shopify rejects (e.g. the email is
  // already in use) we leave the row pending so a fresh PATCH can retry.
  try {
    await shopifyAdmin.updateCustomer(look.row.customer_id, { email: look.row.new_email });
  } catch (e) {
    console.error("[confirm-email] Shopify update failed:", e instanceof Error ? e.message : String(e));
    return infoPage(
      locale,
      locale === "en" ? "Something went wrong" : "Algo salió mal",
      locale === "en"
        ? "We couldn't apply your email change. Please try again from your account or contact support."
        : "No pudimos aplicar el cambio de email. Inténtalo de nuevo desde tu cuenta o contacta con soporte.",
    );
  }
  // Single-fire the consume: a rapid double-submit (double-click / button+Enter)
  // could reach here twice before either marks the row. updateCustomer above is
  // idempotent (same target email) so a duplicate is harmless, but gate the
  // consume on consumed_at IS NULL so we never double-write it.
  await supabaseAdmin()
    .from("email_change_requests")
    .update({ consumed_at: new Date().toISOString() })
    .eq("token", look.row.token)
    .is("consumed_at", null);

  // Back to the portal (in the customer's language) with the success flag the
  // account page renders as a toast. 303 so the browser GETs the page after the
  // POST instead of re-POSTing.
  const slug = locale === "en" ? "account" : "cuenta";
  const back = new URL(`https://litsalt.com/apps/portal/${locale}/${slug}`);
  back.searchParams.set("email_changed", "1");
  return NextResponse.redirect(back.toString(), 303);
}

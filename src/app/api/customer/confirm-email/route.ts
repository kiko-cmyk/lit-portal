import { NextResponse, type NextRequest } from "next/server";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/customer/confirm-email?token=<32-bytes-hex>
 *
 * Magic-link endpoint that finalises a customer-initiated email
 * change (see PATCH /api/customer). The token itself is the auth —
 * possession of the link in the new inbox proves the customer
 * controls that mailbox.
 *
 * No `withCustomer` wrapper: we don't need the session here. The
 * token + DB row is sufficient. Mismatched / expired / consumed
 * tokens return 400 with a generic message.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token || token.length !== 64 || !/^[a-f0-9]+$/i.test(token)) {
    return NextResponse.json(
      { error: "invalid_token", message: "Invalid confirmation link" },
      { status: 400 },
    );
  }

  const sb = supabaseAdmin();
  const { data: row, error: lookupErr } = await sb
    .from("email_change_requests")
    .select("token, customer_id, new_email, expires_at, consumed_at")
    .eq("token", token)
    .maybeSingle();
  if (lookupErr || !row) {
    return NextResponse.json(
      { error: "invalid_token", message: "Invalid or unknown confirmation link" },
      { status: 400 },
    );
  }
  if (row.consumed_at) {
    return NextResponse.json(
      { error: "already_used", message: "This confirmation link has already been used" },
      { status: 400 },
    );
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return NextResponse.json(
      { error: "expired", message: "Confirmation link has expired. Request a new one." },
      { status: 400 },
    );
  }

  // Apply the change in Shopify, then mark the row consumed. Order
  // matters: if Shopify rejects (e.g. email already in use by another
  // customer) we leave the row pending so a retry is allowed via a
  // fresh PATCH.
  try {
    await shopifyAdmin.updateCustomer(row.customer_id, { email: row.new_email });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[confirm-email] Shopify update failed:", msg);
    return NextResponse.json(
      { error: "shopify_update_failed", message: "Could not apply email change. Try again or contact support." },
      { status: 502 },
    );
  }
  await sb
    .from("email_change_requests")
    .update({ consumed_at: new Date().toISOString() })
    .eq("token", token);

  // Send the customer back to the portal with a flag the FE can render
  // as a success toast.
  const back = new URL("https://litsalt.com/apps/portal/es/cuenta");
  back.searchParams.set("email_changed", "1");
  return NextResponse.redirect(back.toString());
}

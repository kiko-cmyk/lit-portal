import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { enforceRateLimit } from "@/lib/rate-limit";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";
import type { BarcelonaWaitlistResponse } from "@/lib/types";

// POST /apps/portal/api/the-world/barcelona-waitlist
// Enrols the authenticated customer in the Barcelona waitlist.
export const POST = withCustomer<BarcelonaWaitlistResponse>(async (_req, ctx) => {
  await enforceRateLimit(ctx.customerId, "barcelona-waitlist", { limit: 5, windowMs: 60_000 });

  // Use the authenticated customer's OWN email, never an arbitrary one from
  // the body — otherwise a logged-in user could enrol third parties.
  const email = await shopifyAdmin.getCustomerEmail(ctx.customerId);
  if (!email) throw new ApiHttpError(404, "customer_not_found", "No email on file");
  const normalized = email.trim().toLowerCase();

  const sb = supabaseAdmin();
  const { error } = await sb.from("barcelona_waitlist").insert({ email: normalized });

  // 23505 = already on list — not really an error, return current position
  if (error && error.code !== "23505") {
    throw new Error(`barcelona_waitlist: ${error.message}`);
  }

  const { data: row } = await sb
    .from("barcelona_waitlist")
    .select("position")
    .eq("email", normalized)
    .maybeSingle();

  return { joined: true, position: row?.position ?? 0 };
});

import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { supabaseAdmin } from "@/lib/supabase";
import type { BarcelonaWaitlistResponse } from "@/lib/types";

// POST /apps/portal/api/the-world/barcelona-waitlist
// Body: { email: string }
export const POST = withCustomer<BarcelonaWaitlistResponse>(async (req, _ctx) => {
  const body = (await req.json().catch(() => ({}))) as { email?: string };
  if (!body.email || !/^[^@]+@[^@]+\.[^@]+$/.test(body.email)) {
    throw new ApiHttpError(400, "invalid_email", "valid email required");
  }

  const sb = supabaseAdmin();
  const { error } = await sb
    .from("barcelona_waitlist")
    .insert({ email: body.email.trim().toLowerCase() });

  // 23505 = already on list — not really an error, return current position
  if (error && error.code !== "23505") {
    throw new Error(`barcelona_waitlist: ${error.message}`);
  }

  const { data: row } = await sb
    .from("barcelona_waitlist")
    .select("position")
    .eq("email", body.email.trim().toLowerCase())
    .maybeSingle();

  return { joined: true, position: row?.position ?? 0 };
});

import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { supabaseAdmin } from "@/lib/supabase";

// POST /apps/portal/api/events/{eventId}/save  — toggle bookmark
export const POST = withCustomer<{ saved: boolean }, { eventId: string }>(
  async (_req, ctx, routeCtx) => {
    const { eventId } = (await routeCtx?.params) ?? { eventId: "" };
    if (!eventId) throw new ApiHttpError(400, "missing_event_id", "");

    const sb = supabaseAdmin();
    const { data: existing } = await sb
      .from("event_bookmarks")
      .select("event_id")
      .eq("customer_id", ctx.customerId)
      .eq("event_id", eventId)
      .maybeSingle();

    if (existing) {
      const { error } = await sb
        .from("event_bookmarks")
        .delete()
        .eq("customer_id", ctx.customerId)
        .eq("event_id", eventId);
      if (error) throw new Error(`event_bookmarks delete: ${error.message}`);
      return { saved: false };
    }

    const { error } = await sb
      .from("event_bookmarks")
      .insert({ customer_id: ctx.customerId, event_id: eventId });
    if (error) throw new Error(`event_bookmarks insert: ${error.message}`);
    return { saved: true };
  },
);

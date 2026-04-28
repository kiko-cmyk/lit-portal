import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { supabaseAdmin } from "@/lib/supabase";
import type { EventListItem, EventsResponse } from "@/lib/types";

// GET /apps/portal/api/events?city={madrid|barcelona}
export const GET = withCustomer<EventsResponse>(async (req, ctx) => {
  const url = new URL(req.url);
  const city = url.searchParams.get("city") ?? "madrid";
  if (city !== "madrid" && city !== "barcelona") {
    throw new ApiHttpError(400, "invalid_city", "city must be 'madrid' or 'barcelona'");
  }

  const sb = supabaseAdmin();
  const lang = await getLanguagePref(ctx.customerId);

  const [eventsRes, savesRes] = await Promise.all([
    sb
      .from("events")
      .select("id, city, title_en, title_es, description_en, description_es, datetime, hero_image, ticket_url")
      .eq("city", city)
      .eq("status", "active")
      .gte("datetime", new Date().toISOString())
      .order("datetime", { ascending: true }),
    sb.from("event_bookmarks").select("event_id").eq("customer_id", ctx.customerId),
  ]);

  if (eventsRes.error) throw new Error(`events: ${eventsRes.error.message}`);
  if (savesRes.error) throw new Error(`event_bookmarks: ${savesRes.error.message}`);

  const savedSet = new Set((savesRes.data ?? []).map((r) => r.event_id));
  const items: EventListItem[] = (eventsRes.data ?? []).map((e) => ({
    id: e.id,
    city: e.city as "madrid" | "barcelona",
    title: lang === "es" ? e.title_es : e.title_en,
    description: lang === "es" ? e.description_es ?? "" : e.description_en ?? "",
    datetime: e.datetime,
    heroImage: e.hero_image,
    ticketUrl: e.ticket_url,
    saved: savedSet.has(e.id),
  }));

  return {
    city: city as "madrid" | "barcelona",
    heroEvent: items[0] ?? null,
    upcoming: items.slice(1),
  };
});

async function getLanguagePref(customerId: string): Promise<"en" | "es"> {
  const { data } = await supabaseAdmin()
    .from("customer_preferences")
    .select("language")
    .eq("customer_id", customerId)
    .maybeSingle();
  return (data?.language as "en" | "es") ?? "en";
}

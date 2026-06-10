import { withCustomer } from "@/lib/api-helpers";
import { resolveLang } from "@/lib/request-lang";
import { supabaseAdmin } from "@/lib/supabase";
import type { MomentItem } from "@/lib/types";

// GET /apps/portal/api/moments?limit=10
export const GET = withCustomer<MomentItem[]>(async (req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "10", 10)));

  const sb = supabaseAdmin();
  const lang = await resolveLang(req, ctx.customerId);

  const { data, error } = await sb
    .from("moments")
    .select("id, image_url, caption_en, caption_es")
    .order("position", { ascending: true })
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`moments: ${error.message}`);

  return (data ?? []).map((m) => ({
    id: m.id,
    imageUrl: m.image_url,
    caption: lang === "es" ? m.caption_es ?? "" : m.caption_en ?? "",
  }));
});

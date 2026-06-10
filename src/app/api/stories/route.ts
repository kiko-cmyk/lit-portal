import { withCustomer } from "@/lib/api-helpers";
import { resolveLang } from "@/lib/request-lang";
import { supabaseAdmin } from "@/lib/supabase";
import type { StoryItem } from "@/lib/types";

// GET /apps/portal/api/stories?limit=3
export const GET = withCustomer<StoryItem[]>(async (req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get("limit") ?? "3", 10)));

  const sb = supabaseAdmin();
  const lang = await resolveLang(req, ctx.customerId);

  const { data, error } = await sb
    .from("stories")
    .select("id, type, slug, title_en, title_es, body_en, body_es, cover_image")
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`stories: ${error.message}`);

  return (data ?? []).map((s) => ({
    id: s.id,
    type: s.type as "feature" | "letter" | "recap",
    title: lang === "es" ? s.title_es : s.title_en,
    slug: s.slug,
    coverImage: s.cover_image,
    excerpt: extractExcerpt(lang === "es" ? s.body_es : s.body_en),
  }));
});

function extractExcerpt(body: string | null): string | null {
  if (!body) return null;
  return body.replace(/[#*_>`]/g, "").slice(0, 200).trim();
}

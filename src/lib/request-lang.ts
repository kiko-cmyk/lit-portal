import type { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Language resolution for server-rendered content (events, stories, moments,
 * the Hub event card).
 *
 * Priority:
 *   1. `?lang=` on the request. The in-portal LangToggle drives the `[locale]`
 *      URL segment, and the api-client forwards that locale as `?lang=` on
 *      every call — so content follows the toggle INSTANTLY, in the same
 *      render, without waiting on a metafield/Supabase write to land.
 *   2. `customer_preferences.language` in Supabase — the persisted preference
 *      (set at first login, and now also mirrored by the language toggle).
 *   3. "en" fallback.
 *
 * Why this exists: before 2026-06-10 the content routes read ONLY (2), but the
 * toggle wrote only the Shopify metafield + the URL — it never touched
 * `customer_preferences`. So flipping the language left events / stories /
 * moments stuck in the onboarding language, which read as "the English version
 * is half-translated / outdated".
 */
export function langFromRequest(req: NextRequest): "en" | "es" | null {
  const q = new URL(req.url).searchParams.get("lang");
  return q === "es" || q === "en" ? q : null;
}

export async function resolveLang(
  req: NextRequest,
  customerId: string,
): Promise<"en" | "es"> {
  const fromUrl = langFromRequest(req);
  if (fromUrl) return fromUrl;
  const { data } = await supabaseAdmin()
    .from("customer_preferences")
    .select("language")
    .eq("customer_id", customerId)
    .maybeSingle();
  return (data?.language as "en" | "es") ?? "en";
}

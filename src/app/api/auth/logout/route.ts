import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /apps/portal/api/auth/logout
 *
 * Cierra la sesión del portal completamente:
 *
 *   1. Lee el Bearer token (session_id) del header Authorization.
 *   2. Recupera id_token guardado en auth_sessions (necesario para
 *      `id_token_hint` del logout OIDC; sin él Shopify muestra un
 *      "are you sure?" extra que rompe el flow).
 *   3. Borra la fila de auth_sessions.
 *   4. Devuelve la URL del logout endpoint de Shopify para que el FE
 *      redirija ahí. Tras Shopify cerrar la sesión OIDC, vuelve a
 *      /apps/portal/es/mi-lit (registrado como post_logout_redirect_uri
 *      en el Headless channel).
 *
 * No-op idempotente: si no hay Bearer o la sesión ya está borrada,
 * devolvemos igualmente la URL del logout (el FE limpia localStorage
 * y redirige). Mejor cerrar de más que dejar sesiones huérfanas.
 */

const SHOPIFY_LOGOUT_ENDPOINT =
  "https://tracking.litsalt.com/authentication/logout";
const POST_LOGOUT_REDIRECT = "https://litsalt.com/apps/portal/es/mi-lit";

interface LogoutResponse {
  logoutUrl: string;
}

export async function POST(req: NextRequest): Promise<NextResponse<LogoutResponse>> {
  // Read X-LIT-Session first (the active path — the FE moved to this header
  // on 2026-05-21 because Shopify App Proxy intercepts Authorization on
  // POST/PATCH/DELETE). Fall back to Authorization: Bearer only for
  // back-compat. Pre-fix this was Bearer-only, which meant the FE-issued
  // X-LIT-Session never reached the lookup → logout was a no-op and
  // sessions lived their full 30d (now 14d) TTL even after the user
  // clicked "Cerrar sesión".
  const custom = req.headers.get("x-lit-session")?.trim();
  let sessionId: string | null = custom || null;
  if (!sessionId) {
    const auth = req.headers.get("authorization");
    sessionId =
      auth && auth.toLowerCase().startsWith("bearer ")
        ? auth.slice(7).trim() || null
        : null;
  }

  let idToken: string | null = null;
  if (sessionId) {
    try {
      const sb = supabaseAdmin();
      const { data } = await sb
        .from("auth_sessions")
        .select("id_token")
        .eq("session_id", sessionId)
        .maybeSingle();
      idToken = (data?.id_token as string | null) ?? null;
      // Best-effort delete. If it fails (e.g. row doesn't exist), we still
      // return logoutUrl so the FE proceeds with localStorage cleanup.
      await sb.from("auth_sessions").delete().eq("session_id", sessionId);
    } catch (e) {
      console.warn("[auth-logout] supabase op failed", e);
    }
  }

  const logoutUrl = new URL(SHOPIFY_LOGOUT_ENDPOINT);
  if (idToken) logoutUrl.searchParams.set("id_token_hint", idToken);
  logoutUrl.searchParams.set("post_logout_redirect_uri", POST_LOGOUT_REDIRECT);

  return NextResponse.json({ logoutUrl: logoutUrl.toString() });
}

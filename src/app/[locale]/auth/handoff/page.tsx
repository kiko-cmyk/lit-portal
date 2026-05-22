"use client";

import { useEffect } from "react";
import { T } from "@/lib/i18n";
import { isSafeRelativePath } from "@/lib/safe-path";

/**
 * /[locale]/auth/handoff?s=<session_id>&to=<return_path>
 *
 * Esta página existe porque Shopify App Proxy strippea Set-Cookie de
 * nuestras respuestas, así que no podemos persistir la sesión vía
 * cookie. En su lugar: el OAuth callback nos manda aquí con el
 * session_id en la URL; este componente lo mueve a localStorage,
 * limpia la URL, y redirige al destino final.
 *
 * El api-client lee `lit_session` de localStorage y lo envía como
 * `Authorization: Bearer <session_id>` en cada llamada al backend.
 */

const SESSION_STORAGE_KEY = "lit_session";
const FALLBACK_TO = "/apps/portal/es/mi-lit";

export default function AuthHandoffPage() {
  useEffect(() => {
    // Read from URL fragment (`#s=...&to=...`), not query string.
    // Audit 2026-05-21 finding #2: fragments are never sent in
    // Referer headers nor logged by proxies, so the token can't
    // leak via outbound links from this page.
    const rawHash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(rawHash);
    const sessionId = params.get("s");
    const to = params.get("to") ?? FALLBACK_TO;

    // Back-compat: also accept the legacy `?s=` if present, for any
    // OAuth flow in flight from before the deploy.
    const legacyId = !sessionId
      ? new URL(window.location.href).searchParams.get("s")
      : null;
    const effectiveSessionId = sessionId ?? legacyId;

    if (effectiveSessionId) {
      try {
        window.localStorage.setItem(SESSION_STORAGE_KEY, effectiveSessionId);
      } catch (e) {
        console.error("[handoff] localStorage write failed", e);
      }
    } else {
      console.error("[handoff] no session_id in URL");
    }

    // Strip the fragment so it doesn't survive in history. replaceState
    // is the cleanest way; the next replace navigates away anyway.
    try {
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      // ignore — history API not available
    }

    const safeTo = isSafeRelativePath(to) ? to : FALLBACK_TO;
    window.location.replace(`${window.location.origin}${safeTo}`);
  }, []);

  return (
    <main className="zone-cream flex flex-1 items-center justify-center min-h-screen">
      <p className="text-xs uppercase tracking-[0.2em] opacity-50">
        <T en="Signing you in…" es="Iniciando sesión…" />
      </p>
    </main>
  );
}


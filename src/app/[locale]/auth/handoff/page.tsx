"use client";

import { useEffect } from "react";
import { T } from "@/lib/i18n";

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
    const url = new URL(window.location.href);
    const sessionId = url.searchParams.get("s");
    const to = url.searchParams.get("to") ?? FALLBACK_TO;

    if (sessionId) {
      try {
        window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
      } catch (e) {
        console.error("[handoff] localStorage write failed", e);
      }
    } else {
      console.error("[handoff] no session_id in URL");
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

function isSafeRelativePath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.startsWith("//")) return false;
  if (p.includes("://")) return false;
  return true;
}

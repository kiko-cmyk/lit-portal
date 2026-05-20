"use client";

import { useState } from "react";
import { api, clearSessionToken } from "@/lib/api-client";
import { useLangValue } from "@/lib/i18n";

interface DangerZoneProps {
  onCancel: () => void;
  /**
   * Kept for backward compat: legacy callers passed a Shopify logout URL
   * directly. Ignored now — the new auth path manages logout via the
   * /api/auth/logout endpoint (clears Supabase session + builds the right
   * Shopify OIDC logout URL with id_token_hint).
   */
  signoutUrl?: string;
}

interface LogoutResponse {
  logoutUrl: string;
}

/**
 * Dark "Zona oscura" footer block per the v2 Account proposal. Reserves
 * the cancellation flow as the visual climax of the page: high-contrast
 * dark surface, oversized two-tone headline, pill-shaped action buttons.
 *
 * Sign-out flow (2026-05-20):
 *   1. Click "Cerrar sesión"
 *   2. POST /api/auth/logout — deletes our auth_sessions row, returns the
 *      Shopify OIDC logout URL with id_token_hint + post_logout_redirect_uri.
 *   3. Clear lit_session from localStorage.
 *   4. window.location to Shopify logout URL.
 *   5. Shopify clears OIDC session, redirects back to /apps/portal/es/mi-lit.
 *   6. Portal sees no auth → LoginScreen → fresh login.
 */
export function DangerZone({ onCancel }: DangerZoneProps) {
  const lang = useLangValue();
  const [busy, setBusy] = useState(false);

  const handleSignout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { logoutUrl } = await api<LogoutResponse>("/api/auth/logout", {
        method: "POST",
      });
      clearSessionToken();
      window.location.replace(logoutUrl);
    } catch (e) {
      console.warn("[danger-zone] logout call failed, clearing local state anyway", e);
      // Even if the API call failed, clean local state and bounce to portal.
      // The user might have a half-broken session; better to log them out
      // visually than to leave them stuck.
      clearSessionToken();
      window.location.replace("/apps/portal/es/mi-lit");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="relative mx-6 mt-14 overflow-hidden rounded-[22px] bg-[color:var(--color-lit-grey)] px-7 pt-8 pb-7 text-[color:var(--color-brisky-cream)] md:mx-0 md:px-10 md:pt-10 md:pb-9"
    >
      {/* Soft yellow corner glow */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(at 90% 100%, rgba(235, 238, 98, 0.22) 0%, transparent 50%)",
        }}
      />

      <h2
        className="relative mb-7 font-semibold uppercase leading-[0.95] tracking-[-0.025em] text-[color:var(--color-brisky-cream)]"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(28px, 7.2vw, 44px)",
        }}
      >
        {lang === "es" ? (
          <>
            ¿Quieres{" "}
            <em className="not-italic text-[color:var(--color-bold-yellow)]">
              salir del círculo
            </em>
            ?
          </>
        ) : (
          <>
            Want to{" "}
            <em className="not-italic text-[color:var(--color-bold-yellow)]">
              leave the circle
            </em>
            ?
          </>
        )}
      </h2>

      <div className="relative flex flex-wrap gap-2.5">
        <button
          type="button"
          onClick={handleSignout}
          disabled={busy}
          className="inline-flex items-center rounded-full bg-[color:var(--color-bold-yellow)] px-6 py-3.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)] transition-transform duration-200 ease-out hover:-translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-50"
          style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
        >
          {busy ? (
            lang === "es" ? "Cerrando..." : "Signing out..."
          ) : (
            lang === "es" ? "Cerrar sesión" : "Sign out"
          )}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center rounded-full border border-[color:var(--color-bold-yellow)]/40 px-6 py-3.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-bold-yellow)] transition-colors duration-150 hover:border-[color:var(--color-danger)] hover:text-[#ff9b9b]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
        >
          {lang === "es" ? "Cancelar suscripción" : "Cancel subscription"}
        </button>
      </div>
    </section>
  );
}

"use client";

import { useCallback, useState } from "react";
import { api, clearSelectedSubscription, clearSessionToken } from "@/lib/api-client";
import { T, useLangValue } from "@/lib/i18n";
import { portalHref } from "@/lib/portal-link";

/**
 * "Sign in with another email" / "Entrar con otro correo".
 *
 * Not a generic logout button, on purpose. What customers actually need is a
 * way OUT of the wrong account: Shopify creates an empty customer on the fly
 * for any email with no orders (checkout typo, "Login with Shop" identity, a
 * work address), and until now landing in one was a dead end. Between
 * 2026-05-27 and 2026-07-29, 25 customers tried to escape through the email
 * field in Cuenta and none succeeded, so the copy names the destination
 * rather than the action.
 *
 * Flow: POST /api/auth/logout (deletes the server-side session and returns
 * the Shopify URL that kills the Customer Account session too) → clear
 * localStorage → follow that URL. Shopify bounces back to /signed-out, which
 * is the only portal page that does not auto-start a login.
 *
 * Never leaves the customer stranded: if the POST fails we still wipe the
 * local session and go to /signed-out. Worst case Shopify's own session
 * survives and the next login silently re-enters the same account, which is
 * exactly today's behaviour, so a failure here is never a regression.
 */

function useSwitchAccount(): { busy: boolean; go: () => void } {
  const lang = useLangValue();
  const [busy, setBusy] = useState(false);

  const go = useCallback(() => {
    if (busy) return;
    setBusy(true);
    const fallback = portalHref(lang, "signedOut");
    // Shopify's post-logout redirect can only point at ONE registered URI, so
    // everyone comes back to the Spanish page. Leave a note for the English
    // customers to be bounced back across (read by the signed-out page).
    try {
      window.localStorage.setItem("lit_lang_hint", lang);
    } catch {
      // ignore
    }
    api<{ logoutUrl: string }>("/api/auth/logout", { method: "POST" })
      .then((res) => {
        clearSessionToken();
        clearSelectedSubscription();
        try {
          window.localStorage.removeItem("lit_sub_count_hint");
        } catch {
          // ignore
        }
        window.location.replace(res?.logoutUrl || fallback);
      })
      .catch((e) => {
        console.warn("[switch-account] logout call failed, exiting anyway", e);
        clearSessionToken();
        clearSelectedSubscription();
        window.location.replace(fallback);
      });
  }, [busy, lang]);

  return { busy, go };
}

/**
 * Understated text link. Used on the empty state (where a customer in the
 * wrong account lands) and anywhere the primary action is something else.
 */
export function SwitchAccountLink({ className }: { className?: string }) {
  const { busy, go } = useSwitchAccount();
  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className={`font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] underline-offset-2 transition-colors duration-150 hover:text-[color:var(--color-lit-grey)] hover:underline disabled:opacity-50 ${className ?? ""}`}
      style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
    >
      {busy ? (
        <T en="Signing out…" es="Cerrando sesión…" />
      ) : (
        <T en="Not your account? Use another email" es="¿No es tu cuenta? Entrar con otro correo" />
      )}
    </button>
  );
}

/**
 * Row variant for the Account surface, styled to sit under "Mis datos"
 * without competing with the danger zone below it.
 */
export function SwitchAccountRow() {
  const { busy, go } = useSwitchAccount();
  return (
    <div className="mx-6 border-t border-[color:var(--color-lit-grey)]/8 pt-4 md:mx-0">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)] underline decoration-[color:var(--color-lit-grey)]/30 underline-offset-4 transition-colors duration-150 hover:decoration-[color:var(--color-lit-grey)] disabled:opacity-50"
        style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
      >
        {busy ? (
          <T en="Signing out…" es="Cerrando sesión…" />
        ) : (
          <T en="Sign in with another email" es="Entrar con otro correo" />
        )}
      </button>
      <p className="mt-2 text-[12px] leading-[1.5] text-[color:var(--color-warm-gray)]">
        <T
          en="Signs you out of this account so you can use a different email. Your subscription is not affected."
          es="Cierra la sesión de esta cuenta para que puedas entrar con otro correo. Tu suscripción no se ve afectada."
        />
      </p>
    </div>
  );
}

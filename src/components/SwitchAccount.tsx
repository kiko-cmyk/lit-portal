"use client";

import { useCallback, useState } from "react";
import { api, clearSelectedSubscription, clearSessionToken } from "@/lib/api-client";
import { T, useLangValue } from "@/lib/i18n";
import { portalHref } from "@/lib/portal-link";

/**
 * "Log out or use another email" / "Cerrar sesión o entrar con otro email".
 *
 * Not a generic logout button, on purpose. What customers actually need is a
 * way OUT of the wrong account: Shopify creates an empty customer on the fly
 * for any email with no orders (checkout typo, "Login with Shop" identity, a
 * work address), and until now landing in one was a dead end. Between
 * 2026-05-27 and 2026-07-29, 25 customers tried to escape through the email
 * field in Cuenta and none succeeded, so the copy always spells out where it
 * takes you and never stops at the bare word "logout".
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
          window.localStorage.removeItem("lit_account_only_hint");
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
        <T en="Not your account? Use another email" es="¿No es tu cuenta? Entrar con otro email" />
      )}
    </button>
  );
}

/**
 * Header variant: plain "CERRAR SESIÓN", sitting where the nav capsule sits.
 *
 * Only used in wholesale mode, where Cuenta is the only page: a nav with a
 * single tab that points at the page you are already on says nothing, so the
 * space goes to the one action that was missing from the top of the screen
 * (Juan 2026-07-29). Same pill shape as the "Cambiar" control so the header
 * keeps one visual language.
 */
export function SignOutPill() {
  const { busy, go } = useSwitchAccount();
  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className="shrink-0 self-stretch inline-flex cursor-pointer items-center rounded-full border border-[color:var(--color-lit-grey)]/40 bg-[color:var(--color-sharp-white)]/70 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-lit-grey)]/80 shadow-[0_1px_2px_rgba(50,40,30,0.08)] transition-colors hover:text-[color:var(--color-lit-grey)] disabled:opacity-50"
    >
      {busy ? <T en="Signing out…" es="Cerrando…" /> : <T en="Sign out" es="Cerrar sesión" />}
    </button>
  );
}

/**
 * Row variant for the Account surface, under "Mis datos".
 *
 * Same outlined pill as "Cambiar cajas o frecuencia" in the section above
 * (Juan 2026-07-29): both are "take me somewhere to change something" actions,
 * so they should read as the same kind of control. Deliberately NOT the filled
 * yellow-on-dark treatment, which the portal reserves for primary actions, and
 * deliberately not in the Zona oscura, which is styled to make you hesitate.
 */
export function SwitchAccountRow({ variant = "row" }: { variant?: "row" | "card" } = {}) {
  const { busy, go } = useSwitchAccount();
  // `card`: el pie de la tarjeta «Tus datos» del rediseño lp2 (2026-10-13), una
  // píldora a todo el ancho con el icono de salir, sin la raya ni el margen de
  // la fila; la tarjeta ya separa el pie con su propio hueco.
  if (variant === "card") {
    return (
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-full border border-[#2F343D]/18 px-3 py-[13px] text-[9.5px] font-bold uppercase tracking-[0.1em] text-[#2F343D] transition-colors hover:border-[#2F343D]/45 disabled:opacity-50 md:gap-2.5 md:px-5 md:py-3.5 md:text-[10.5px] md:tracking-[0.16em]"
      >
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
          <path d="M10 17l5-5-5-5" />
          <path d="M15 12H4" />
        </svg>
        {busy ? (
          <T en="Signing out…" es="Cerrando sesión…" />
        ) : (
          <T en="Log out or use another email" es="Cerrar sesión o entrar con otro email" />
        )}
      </button>
    );
  }
  return (
    <div className="mx-6 border-t border-[color:var(--color-lit-grey)]/8 pt-5 md:mx-0">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        // Ancho completo en MÓVIL, automático en desktop: mismo criterio que el
        // CTA del banner del formulario y que el botón de "Mi suscripción"
        // (Juan 2026-09-15). Solo afecta a SwitchAccountRow, que vive en Cuenta;
        // SwitchAccountLink (Hub y detalle de pedido) es otro componente.
        className="w-full rounded-full border border-[color:var(--color-lit-grey)]/40 px-6 py-3 text-[11px] font-bold uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] transition-colors hover:border-[color:var(--color-lit-grey)] disabled:opacity-50 md:w-auto"
      >
        {busy ? (
          <T en="Signing out…" es="Cerrando sesión…" />
        ) : (
          <T
            en="Log out or use another email"
            es="Cerrar sesión o entrar con otro email"
          />
        )}
      </button>
    </div>
  );
}

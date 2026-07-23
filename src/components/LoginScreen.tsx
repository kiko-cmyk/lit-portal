"use client";

import { useCallback, useEffect, useState } from "react";
import { Logo } from "@/components/Logo";
import { T, useLang } from "@/lib/i18n";
import { detectInAppBrowser } from "@/lib/in-app-browser";

/**
 * When unauthenticated, kick off our Customer Account API OAuth flow via
 * /api/auth/login:
 *
 *   1. Browser → /api/auth/login (builds Shopify OAuth URL + PKCE)
 *   2. → tracking.litsalt.com/authentication/oauth/authorize (LIT-branded
 *      login, the ONLY tracking surface the customer sees).
 *   3. Customer logs in → /api/auth/callback → /es/auth/handoff → /es/mi-lit.
 *
 * EXCEPTION — in-app browsers: embedded webviews (Outlook, Gmail, Instagram,
 * Facebook…) routinely fail to complete that cross-domain OAuth handoff,
 * leaving the customer on the webview's native "could not load" page with no
 * way forward (real case: a subscriber who thought the portal was "blocked so
 * he couldn't cancel", opened from the Outlook mail app, 2026-07-23). We
 * detect those and show an interstitial asking them to open the page in
 * Safari/Chrome instead of firing a redirect the webview can't finish. A
 * "continue anyway" link preserves the old behaviour for any false positive.
 */
const OAUTH_LOGIN = "/apps/portal/api/auth/login";

function startLogin() {
  const returnTo = window.location.pathname + window.location.search;
  const url = new URL(OAUTH_LOGIN, window.location.origin);
  url.searchParams.set("return_to", returnTo);
  window.location.replace(url.toString());
}

export function LoginScreen() {
  const t = useLang();
  const [inApp, setInApp] = useState<{ app: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Environment detection can only run after mount — navigator is undefined
    // during SSR — so a one-time setState here is the intended pattern, not a
    // cascade. Either we show the interstitial or we redirect; never both.
    const { inApp: isInApp, app } = detectInAppBrowser(navigator.userAgent);
    if (isInApp) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInApp({ app });
      return;
    }
    startLogin();
  }, []);

  const copyLink = useCallback(async () => {
    const href = window.location.href;
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard API is blocked in some webviews — fall back to a prompt so
      // the customer can still select and copy the URL by hand.
      window.prompt(t({ en: "Copy this link:", es: "Copia este enlace:" }), href);
    }
  }, [t]);

  if (inApp) {
    return (
      <main className="zone-cream flex min-h-screen flex-1 flex-col items-center justify-center gap-6 px-8 py-12 text-center">
        <Logo className="h-8 w-auto" />
        <div className="max-w-sm">
          <h1 className="font-display text-3xl font-black uppercase leading-tight text-[color:var(--color-lit-grey)]">
            <T en="Open in your browser" es="Ábrelo en tu navegador" />
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-[color:var(--color-lit-grey)]/80">
            <T
              en="To sign in securely and manage your subscription, open this page in Safari or Chrome. This app's built-in viewer can't complete the login."
              es="Para iniciar sesión de forma segura y gestionar tu suscripción, abre esta página en Safari o Chrome. El visor interno de esta app no permite completar el inicio de sesión."
            />
          </p>
        </div>

        <div className="flex w-full max-w-xs flex-col items-center gap-3">
          <button
            type="button"
            onClick={copyLink}
            className="w-full rounded-full bg-[color:var(--color-lit-grey)] px-6 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)]"
          >
            {copied ? (
              <T en="Link copied" es="Enlace copiado" />
            ) : (
              <T en="Copy link" es="Copiar enlace" />
            )}
          </button>
          <p className="text-[11px] uppercase tracking-[0.15em] text-[color:var(--color-lit-grey)]/50">
            <T en="Then paste it into Safari or Chrome" es="Luego pégalo en Safari o Chrome" />
          </p>
        </div>

        <button
          type="button"
          onClick={startLogin}
          className="mt-2 text-[11px] uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]/50 underline underline-offset-4"
        >
          <T en="Continue anyway" es="Continuar de todas formas" />
        </button>
      </main>
    );
  }

  return (
    <main className="zone-cream flex flex-1 items-center justify-center">
      <p className="text-xs uppercase tracking-[0.2em] opacity-50">
        <T en="Redirecting…" es="Redirigiendo…" />
      </p>
    </main>
  );
}

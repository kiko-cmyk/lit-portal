"use client";

import { useState } from "react";
import { T } from "@/lib/i18n";

/**
 * Login screen — shown when customer is not authenticated.
 *
 * Per Phase 1 design (2026-05-06): one-time takeover after checkout,
 * or whenever the App Proxy delivers customer_id = null. Offers Shop OAuth,
 * Google OAuth, and email magic link.
 *
 * The actual auth flows are handled by Shopify customer accounts. We just
 * deep-link out and Shopify handles login + redirects back to the portal.
 *
 * Storefront customer-accounts login lives at one of:
 *   - https://litsalt.com/account/login  (legacy customer accounts)
 *   - https://shopify.com/<shop_id>/account/login  (new customer accounts)
 *
 * Default: storefront `/account/login` because that's the public-facing entry.
 */

const LOGIN_BASE = "https://litsalt.com/account/login";

function buildLoginUrl(provider: "shop" | "google" | "email", returnTo?: string) {
  const url = new URL(LOGIN_BASE);
  if (provider !== "email") url.searchParams.set("provider", provider);
  if (returnTo) url.searchParams.set("return_url", returnTo);
  return url.toString();
}

export function LoginScreen() {
  const returnTo = typeof window !== "undefined" ? window.location.pathname : "/your-lit";
  const [email, setEmail] = useState("");
  const [newsOk, setNewsOk] = useState(false);

  return (
    <main className="zone-cream flex min-h-full items-center justify-center bg-[color:var(--background)] p-6 text-[color:var(--foreground)]">
      <div className="w-full max-w-sm">
        <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
          <T en="Start here" es="Empieza aquí" />
        </div>
        <h1 className="mt-2 font-display text-5xl font-black uppercase leading-none">
          <T en="Sign in" es="Inicia sesión" />
          <span className="text-[color:var(--color-bold-yellow)]">.</span>
        </h1>
        <p className="mt-3 text-sm opacity-70">
          <T
            en="Sign in or create an account. One minute."
            es="Inicia sesión o crea una cuenta. Es un minuto."
          />
        </p>

        <div className="mt-7 space-y-3">
          <a
            href={buildLoginUrl("shop", returnTo)}
            className="flex w-full items-center justify-center gap-2 rounded-sm bg-[color:var(--color-lit-grey)] py-3.5 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-brisky-cream)]"
          >
            <T en="Continue with Shop" es="Continuar con Shop" />
          </a>
          <a
            href={buildLoginUrl("google", returnTo)}
            className="flex w-full items-center justify-center gap-2 rounded-sm border border-[color:var(--color-lit-grey)]/15 bg-[color:var(--color-sharp-white)] py-3.5 text-xs font-bold uppercase tracking-[0.18em]"
          >
            <T en="Continue with Google" es="Continuar con Google" />
          </a>
        </div>

        <div className="my-5 flex items-center gap-3 text-[10px] uppercase tracking-[0.25em] opacity-50">
          <span className="h-px flex-1 bg-current opacity-30" />
          <T en="Or" es="O" />
          <span className="h-px flex-1 bg-current opacity-30" />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const url = new URL(LOGIN_BASE);
            url.searchParams.set("email", email);
            url.searchParams.set("return_url", returnTo);
            window.location.href = url.toString();
          }}
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-sm border border-[color:var(--color-lit-grey)]/20 bg-[color:var(--color-sharp-white)] px-4 py-3 text-sm placeholder:opacity-40 focus:border-[color:var(--color-lit-grey)] focus:outline-none"
          />
          <button
            type="submit"
            disabled={!email}
            className="mt-3 w-full rounded-sm bg-[color:var(--color-bold-yellow)] py-3.5 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] disabled:opacity-30"
          >
            <T en="Continue" es="Continuar" />
          </button>
        </form>

        <label className="mt-5 flex items-center gap-2 text-[11px] opacity-70">
          <input
            type="checkbox"
            checked={newsOk}
            onChange={(e) => setNewsOk(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <T
            en="Email me about news and offers"
            es="Quiero recibir novedades y ofertas"
          />
        </label>

        <div className="mt-10 text-center text-[10px] uppercase tracking-[0.25em] opacity-40">
          <T en="Stay LIT." es="Stay LIT." /> · Madrid · 2026
        </div>
      </div>
    </main>
  );
}

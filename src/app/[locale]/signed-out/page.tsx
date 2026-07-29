"use client";

import { useCallback, useEffect } from "react";
import { Logo } from "@/components/Logo";
import {
  clearSelectedSubscription,
  clearSessionToken,
} from "@/lib/api-client";
import { T, useLangValue, usePageTitle } from "@/lib/i18n";
import { portalHref } from "@/lib/portal-link";

/**
 * /[locale]/signed-out  (ES: /es/sesion-cerrada)
 *
 * The one portal page that must NEVER auto-start the OAuth flow.
 *
 * Every other page renders <LoginScreen/> when there's no session, and
 * LoginScreen immediately redirects to Shopify. That is right everywhere
 * else and fatal here: this page is where the customer lands right after
 * signing out, and bouncing them straight back into the login would either
 * loop them into the very account they just left (if Shopify's own session
 * survived) or make "sign out" look like it did nothing.
 *
 * So: no session check, no redirect, no data fetching. Just a dead end with
 * two doors, sign in again (with whichever email they choose) or leave.
 *
 * Why it exists at all: a customer logged into the WRONG Shopify account
 * (Shopify mints an empty customer on the fly for any email that has no
 * orders) had no way out of the portal. The full flow, the Shopify contract
 * it works around, and what has to be registered in the Headless channel are
 * in docs/AUTH_LOGOUT.md.
 */

const OAUTH_LOGIN = "/apps/portal/api/auth/login";
/** Written by SwitchAccount right before leaving, read back here. */
const LANG_HINT_KEY = "lit_lang_hint";
/** Storefront (classic) session cookie killer. Same origin, so cookies ride along. */
const STOREFRONT_LOGOUT = "/account/logout";

export default function SignedOutPage() {
  const lang = useLangValue();
  usePageTitle({ en: "Signed out · LIT", es: "Sesión cerrada · LIT" });

  // One effect, in this order, on purpose.
  //
  // First the language bounce: Shopify's "Logout URL" field holds ONE
  // registered URI, so every post-logout redirect lands on the Spanish path no
  // matter who the customer is. English ones get sent across using the hint
  // their own browser left before departing. No hint (direct visit, cleared
  // storage) → stay put. When we bounce we return immediately and let the
  // clean-up run on the page we are about to land on, rather than starting
  // work the navigation would cut in half.
  useEffect(() => {
    let hint: string | null = null;
    try {
      hint = window.localStorage.getItem(LANG_HINT_KEY);
    } catch {
      // ignore
    }
    if ((hint === "en" || hint === "es") && hint !== lang) {
      window.location.replace(portalHref(hint, "signedOut"));
      return;
    }

    // Belt and braces. The logout route already deleted the server-side session
    // and the caller cleared localStorage, but this page is also the landing
    // spot for Shopify's post-logout redirect, which arrives as a fresh
    // top-level navigation from another origin. If anything upstream failed
    // (network drop mid-logout, a stale tab restored from bfcache), the token
    // could still be sitting in localStorage, and leaving it there would sign
    // the customer straight back into the account they just left.
    clearSessionToken();
    clearSelectedSubscription();
    try {
      window.localStorage.removeItem("lit_sub_count_hint");
      window.localStorage.removeItem("lit_account_only_hint");
      window.localStorage.removeItem(LANG_HINT_KEY);
    } catch {
      // ignore — private mode / storage disabled
    }

    // Third session, easy to forget: the classic storefront cookie. `withCustomer`
    // trusts App Proxy's `logged_in_customer_id` BEFORE our own bearer token, so a
    // customer who also signed in on litsalt.com itself would still be recognised
    // by every portal API call after "signing out". Shopify's OIDC end_session
    // does not clear that cookie; only the storefront route does. Same origin
    // here (App Proxy serves us from litsalt.com), so the cookie rides along.
    // Fire and forget: it is a hardening step, not a precondition for the page.
    // redirect:"manual" because the storefront answers with a 302 to the home
    // page: the cookie clearing rides on that response either way, and not
    // following it saves pulling the whole storefront HTML down behind a page
    // whose entire job is to be a dead end.
    fetch(STOREFRONT_LOGOUT, {
      credentials: "same-origin",
      redirect: "manual",
    }).catch(() => {
      // ignore — worst case the storefront cookie outlives the session
    });
  }, [lang]);

  const signIn = useCallback(() => {
    const url = new URL(OAUTH_LOGIN, window.location.origin);
    // Land on Cuenta, not Mi LIT: whoever just switched accounts may well be a
    // one-shot customer with no subscription, and Cuenta works for everyone.
    url.searchParams.set("return_to", portalHref(lang, "account"));
    window.location.replace(url.toString());
  }, [lang]);

  return (
    <main className="zone-cream flex min-h-screen flex-1 flex-col items-center justify-center gap-6 px-8 py-12 text-center">
      <Logo className="h-8 w-auto" />

      <div className="max-w-sm">
        <span
          className="font-semibold uppercase tracking-[0.32em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
        >
          <T en="Your LIT account" es="Tu cuenta LIT" />
        </span>

        <h1
          className="mt-4 font-display font-medium uppercase leading-[0.9] tracking-[-0.035em] text-[color:var(--color-lit-grey)]"
          style={{ fontSize: "clamp(2.2rem, 8vw, 3.2rem)" }}
        >
          <T en="Signed out" es="Sesión cerrada" />
        </h1>

        <p className="mt-5 text-[14px] leading-[1.55] text-[color:var(--color-warm-gray)]">
          <T
            en="You can now sign in with a different email. If you have more than one LIT account, use the address you placed your order with."
            es="Ya puedes entrar con otro email. Si tienes más de una cuenta en LIT, usa la dirección con la que hiciste el pedido."
          />
        </p>
      </div>

      <div className="flex w-full max-w-xs flex-col items-center gap-4">
        <button
          type="button"
          onClick={signIn}
          className="inline-flex w-full items-center justify-center rounded-full bg-[color:var(--color-lit-grey)] px-7 py-3.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-bold-yellow)] transition-transform duration-200 ease-out hover:-translate-y-[2px]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 12 }}
        >
          <T en="Sign in with another email" es="Entrar con otro email" />
        </button>

        <a
          href="https://litsalt.com/"
          className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] underline-offset-2 hover:text-[color:var(--color-lit-grey)] hover:underline"
          style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
        >
          <T en="Back to litsalt.com" es="Volver a litsalt.com" />
        </a>
      </div>
    </main>
  );
}

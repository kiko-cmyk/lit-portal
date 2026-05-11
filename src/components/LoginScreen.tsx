"use client";

import { useEffect } from "react";
import { T } from "@/lib/i18n";

/**
 * When unauthenticated, jump straight to Shopify Customer Accounts.
 * No interstitial form — Shopify already collects email + sends the 6-digit
 * code, so a second input here was duplicate work for the user.
 *
 * Decision 2026-05-11 (Juan): keep the flow as short as possible. Branding
 * lives inside the portal, not in the login chrome.
 */
const LOGIN_BASE = "https://litsalt.com/account/login";

export function LoginScreen() {
  useEffect(() => {
    const returnTo = window.location.pathname + window.location.search;
    const url = new URL(LOGIN_BASE);
    url.searchParams.set("return_url", returnTo);
    window.location.replace(url.toString());
  }, []);

  return (
    <main className="zone-cream flex flex-1 items-center justify-center">
      <p className="text-xs uppercase tracking-[0.2em] opacity-50">
        <T en="Redirecting…" es="Redirigiendo…" />
      </p>
    </main>
  );
}

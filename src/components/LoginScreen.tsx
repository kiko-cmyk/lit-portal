"use client";

import { useEffect } from "react";
import { T } from "@/lib/i18n";

/**
 * When unauthenticated, redirect through OUR OAuth endpoint
 * (`/api/auth/login`) instead of Shopify's standard `/account/login`. Why:
 *
 *  - The standard `/account/login` flow lands the customer on the
 *    Shopify customer account dashboard (tracking.litsalt.com), NOT on
 *    our portal. Its `return_url` param is silently ignored.
 *  - `/api/auth/login` builds a Customer Account API OAuth URL pointing
 *    at `/apps/portal/auth/callback`, so Shopify rebound the customer
 *    DIRECTLY to our portal after login. They never see tracking.
 *
 * Credentials live on the Headless Sales Channel ("Lit Headless")
 * installed in Shopify Admin 2026-05-20. The Customer Account API
 * client_id (UUID format) is exposed to Vercel as
 * SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID.
 */
const OAUTH_LOGIN = "/apps/portal/api/auth/login";

export function LoginScreen() {
  useEffect(() => {
    const returnTo = window.location.pathname + window.location.search;
    const url = new URL(OAUTH_LOGIN, window.location.origin);
    url.searchParams.set("return_to", returnTo);
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

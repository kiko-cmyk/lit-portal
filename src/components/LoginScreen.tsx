"use client";

import { useEffect } from "react";
import { T } from "@/lib/i18n";

/**
 * When unauthenticated, redirect through OUR OAuth endpoint
 * (`/api/auth/login`) instead of going directly to Shopify's standard
 * `/account/login`. Why:
 *
 *  - The standard `/account/login` flow lands the customer on the
 *    Shopify customer account dashboard (tracking.litsalt.com) post
 *    login, NOT on our portal. The `return_url` param Shopify exposes
 *    is silently ignored.
 *  - Our `/api/auth/login` builds a Customer Account API OAuth URL
 *    with `redirect_uri=https://litsalt.com/apps/portal/auth/callback`,
 *    so Shopify rebound the customer directly to our portal after
 *    successful login. They never see the tracking dashboard.
 *
 * Decision 2026-05-20 (Juan): zero-flash login experience. Customer sees
 * Shopify-hosted login form (LIT-branded, OK) → directly into our portal.
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

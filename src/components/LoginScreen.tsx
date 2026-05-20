"use client";

import { useEffect } from "react";
import { T } from "@/lib/i18n";

/**
 * When unauthenticated, kick off our Customer Account API OAuth flow
 * via /api/auth/login. The flow:
 *
 *   1. Browser → /api/auth/login (builds Shopify OAuth URL + PKCE)
 *   2. → tracking.litsalt.com/authentication/oauth/authorize (login UI,
 *      Shopify-hosted but LIT-branded — the ONLY tracking surface the
 *      customer ever sees, per [[feedback-no-tracking-portal]]).
 *   3. Customer logs in.
 *   4. → /api/auth/callback (token exchange + session insert)
 *   5. → /es/auth/handoff?s=<session_id> (moves token to localStorage)
 *   6. → /es/mi-lit
 *
 * Customer NEVER sees tracking dashboard / orders / profile / anything
 * beyond the LIT-branded login form. The auth_sessions table + bearer
 * token + withCustomer hybrid is what makes this possible without
 * relying on App Proxy's logged_in_customer_id (which Customer Account
 * API OAuth doesn't set).
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

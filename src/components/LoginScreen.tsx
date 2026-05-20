"use client";

import { useEffect } from "react";
import { T } from "@/lib/i18n";

/**
 * When unauthenticated, jump straight to Shopify Customer Accounts.
 *
 * Background 2026-05-20: probamos OAuth Customer Account API via
 * /api/auth/login para evitar el bounce por tracking dashboard. Llegamos
 * a tener OAuth + JWT state + redirect correcto, pero descubrimos un
 * blocker arquitectónico: Customer Account API OAuth y la "storefront
 * session" que ve App Proxy son DOS sistemas distintos. Completar
 * OAuth no autentica al cliente para App Proxy → loop infinito.
 *
 * Volvemos al /account/login original. El cliente termina en tracking
 * dashboard tras login. Vías futuras posibles:
 *   - Banner manual via UI Extension dentro del dashboard de tracking.
 *   - Refactor completo de auth: usar Customer Account API tokens en
 *     todos los API routes (4-5 días de trabajo).
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

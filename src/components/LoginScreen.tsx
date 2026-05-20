"use client";

import { useEffect } from "react";
import { T } from "@/lib/i18n";

/**
 * When unauthenticated, jump straight to Shopify Customer Accounts.
 *
 * NOTA 2026-05-20: probamos a redirigir a /api/auth/login (OAuth Customer
 * Account API) para que el cliente aterrice directo en el portal tras el
 * login. Shopify rechazó nuestro client_id con "Las credenciales del
 * cliente no son válidas" — Customer Account API OAuth requiere acceso
 * adicional que nuestra app no tiene. Hasta que activemos Headless
 * Sales Channel o equivalente, volvemos al flow original.
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

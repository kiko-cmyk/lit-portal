"use client";

import { useEffect } from "react";
import { Logo } from "@/components/Logo";
import { T } from "@/lib/i18n";

/**
 * Route-level error boundary for every [locale] portal page. Turns an
 * unexpected client render error into a branded, actionable LIT screen instead
 * of the browser's raw crash page. It renders inside LangProvider (the
 * [locale] layout sits above it in the tree), so <T> resolves to the
 * customer's language.
 *
 * Scope note: this only catches React render errors. A page that never loads
 * at all (e.g. an in-app browser that can't complete OAuth) is handled in
 * LoginScreen, not here. See [[in-app-browser]].
 */
export default function PortalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // Full detail to the console for debugging; the customer only ever sees
    // the friendly copy below.
    console.error("[portal-error-boundary]", error);
  }, [error]);

  return (
    <main className="zone-cream flex min-h-screen flex-1 flex-col items-center justify-center gap-6 px-8 py-12 text-center">
      <Logo className="h-8 w-auto" />
      <div className="max-w-sm">
        <h1 className="font-display text-3xl font-black uppercase leading-tight text-[color:var(--color-lit-grey)]">
          <T en="Something didn't load" es="Algo no cargó bien" />
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-[color:var(--color-lit-grey)]/80">
          <T
            en="Sorry, this page didn't load correctly. Try again. If it keeps happening, open litsalt.com/apps/portal/es/cuenta in Safari or Chrome, or write to us."
            es="Perdona, esta página no cargó bien. Vuelve a intentarlo. Si te sigue pasando, abre litsalt.com/apps/portal/es/cuenta en Safari o Chrome, o escríbenos."
          />
        </p>
      </div>
      <button
        type="button"
        onClick={() => unstable_retry()}
        className="rounded-full bg-[color:var(--color-lit-grey)] px-6 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)]"
      >
        <T en="Try again" es="Reintentar" />
      </button>
    </main>
  );
}

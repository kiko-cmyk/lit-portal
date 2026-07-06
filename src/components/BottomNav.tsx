"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { useSubscriptionSwitch } from "@/components/SubscriptionGate";
import { LangToggle, useLang, useLangValue } from "@/lib/i18n";
import { activeRoute, portalHref, type PortalRoute } from "@/lib/portal-link";

/**
 * Bottom navigation — Phase 1 MVP has 3 slots: Hub / Collection / Account.
 *
 * Collection is shown BLURRED in Phase 1 and is `inactive: true` — visible in
 * the nav so customers know it's coming but rendered as a muted, non-clickable
 * label with a "SOON" suffix. Drops + The World are NOT in Phase 1 nav.
 *
 * Per locked decision 2026-05-06 and refresh 2026-05-18.
 */
const ITEMS: {
  route: PortalRoute;
  en: string;
  es: string;
  inactive?: boolean;
}[] = [
  { route: "home", en: "Subscription", es: "Suscripción" },
  { route: "account", en: "Account", es: "Cuenta" },
  { route: "collection", en: "Collection", es: "Colección", inactive: true },
];

export function BottomNav() {
  const pathname = usePathname();
  const lang = useLangValue();
  const t = useLang();
  // Match the active route against the user-visible slug in EITHER locale —
  // usePathname returns the localized slug (mi-lit / cuenta / coleccion), not
  // the canonical EN one, so a plain "=== canonical" check never matched for
  // Spanish users and nothing was ever highlighted.
  const current = activeRoute(pathname);
  return (
    <nav
      // fixed (not sticky) so it stays anchored to the bottom of the viewport
      // even on short pages like the no-subscription state.
      className="fixed bottom-0 left-0 right-0 z-40 grid grid-cols-3 border-t border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-3.5 pt-2.5 pb-6 md:hidden"
      aria-label="Primary"
    >
      {ITEMS.map((it) => {
        const active = current === it.route;
        if (it.inactive) {
          return (
            <span
              key={it.route}
              aria-disabled
              className="flex cursor-not-allowed flex-col items-center justify-center gap-1.5 py-2 text-[9px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-warm-gray)]/55"
              title={t({ en: "Coming soon", es: "Próximamente" })}
            >
              <span>{t({ en: it.en, es: it.es })}</span>
              <span className="text-[7px] font-extrabold tracking-[0.18em] text-[color:var(--color-warm-gray)]/70">
                {t({ en: "Soon", es: "Pronto" })}
              </span>
            </span>
          );
        }
        return (
          <Link
            key={it.route}
            href={portalHref(lang, it.route)}
            aria-current={active ? "page" : undefined}
            className={`flex flex-col items-center justify-center gap-1.5 py-2 text-[9px] uppercase tracking-[0.1em] cursor-pointer transition-colors ${
              active
                ? "font-black text-[color:var(--color-lit-grey)]"
                : "font-semibold text-[color:var(--color-warm-gray)]/50 hover:text-[color:var(--color-lit-grey)]"
            }`}
          >
            <span>{t({ en: it.en, es: it.es })}</span>
            <span
              className={`h-px w-7 rounded-full transition-colors ${
                active ? "bg-[color:var(--color-bold-yellow)]" : "bg-transparent"
              }`}
            />
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Top nav for desktop — shown only on md+. Logo on left, nav links horizontal.
 */
export function TopNav() {
  const pathname = usePathname();
  const lang = useLangValue();
  const t = useLang();
  const current = activeRoute(pathname);
  const { canSwitch, openChooser } = useSubscriptionSwitch();
  return (
    <nav
      className="fixed top-0 left-0 right-0 z-40 hidden border-b border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-brisky-cream)]/90 backdrop-blur-md md:block"
      aria-label="Primary"
    >
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-8 py-5">
        <Logo />
        <div className="flex items-center gap-8">
          {ITEMS.map((it) => {
            const active = current === it.route;
            if (it.inactive) {
              return (
                <span
                  key={it.route}
                  aria-disabled
                  className="cursor-not-allowed text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)]/35"
                  title={t({ en: "Coming soon", es: "Próximamente" })}
                >
                  {t({ en: it.en, es: it.es })}{" "}
                  <span className="ml-1 text-[8px] font-extrabold tracking-[0.2em] text-[color:var(--color-warm-gray)]/80">
                    {t({ en: "SOON", es: "PRONTO" })}
                  </span>
                </span>
              );
            }
            return (
              <Link
                key={it.route}
                href={portalHref(lang, it.route)}
                aria-current={active ? "page" : undefined}
                className={`text-[11px] font-bold uppercase tracking-[0.18em] cursor-pointer transition-colors hover:text-[color:var(--color-lit-grey)] ${
                  active ? "text-[color:var(--color-lit-grey)] underline underline-offset-4" : "text-[color:var(--color-lit-grey)]/55"
                }`}
              >
                {t({ en: it.en, es: it.es })}
              </Link>
            );
          })}
          {/* LangToggle siempre visible — el cliente lo quiere en el header
              tanto en mobile como en desktop (Juan 2026-05-19). */}
          <LangToggle />
          {/* Multi-sub switch: pill al extremo derecho, etiqueta corta
              "CAMBIAR" para que quepa (Juan 2026-07-06). */}
          {canSwitch && (
            <button
              type="button"
              onClick={openChooser}
              className="cursor-pointer rounded-full border border-[color:var(--color-lit-grey)]/25 bg-[color:var(--color-sharp-white)]/60 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-[color:var(--color-lit-grey)]/70 transition hover:border-[color:var(--color-lit-grey)]/50 hover:text-[color:var(--color-lit-grey)]"
            >
              {t({ en: "Switch", es: "Cambiar" })}
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}

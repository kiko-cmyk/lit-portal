"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { useSubscriptionSwitch } from "@/components/SubscriptionGate";
import { SignOutPill } from "@/components/SwitchAccount";
import { useLang, useLangValue } from "@/lib/i18n";
import { COLLECTION_ENABLED } from "@/lib/portal-link";
import { activeRoute, portalHref, type PortalRoute } from "@/lib/portal-link";
import type { ReactNode } from "react";

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

/** Lo que se pinta de verdad. La Colección está oculta mientras la función no exista
 *  (COLLECTION_ENABLED en lib/portal-link.ts); antes salía como "Pronto", pero es una
 *  pestaña que no lleva a nada. El nav móvil es un grid, así que el número de columnas
 *  se calcula de aquí — si no, al quitar un item quedaba un hueco. */
const VISIBLE_ITEMS = ITEMS.filter(
  (it) => it.route !== "collection" || COLLECTION_ENABLED,
);

/** Line icons for the mobile bottom nav (20px, stroke = currentColor). */
const NAV_ICONS: Record<string, ReactNode> = {
  home: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8l-9-5-9 5 9 5 9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
    </svg>
  ),
  account: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
    </svg>
  ),
  collection: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  ),
};

export function BottomNav() {
  const pathname = usePathname();
  const lang = useLangValue();
  const t = useLang();
  const { accountOnly } = useSubscriptionSwitch();
  // Match the active route against the user-visible slug in EITHER locale —
  // usePathname returns the localized slug (mi-lit / cuenta / coleccion), not
  // the canonical EN one, so a plain "=== canonical" check never matched for
  // Spanish users and nothing was ever highlighted.
  const current = activeRoute(pathname);
  // Wholesale mode has a single destination, so there is nothing to navigate:
  // the bar would be one tab pointing at the page you are already on. Dropped
  // whole, and the header carries CERRAR SESIÓN instead (Juan 2026-07-29).
  // Nobody gets stranded on the order detail: it has its own "← Cuenta" link.
  if (accountOnly) return null;
  return (
    <nav
      // fixed (not sticky) so it stays anchored to the bottom of the viewport
      // even on short pages like the no-subscription state. Estilo PRE: icono
      // por pestaña, activo en círculo amarillo (mismo lenguaje que la pastilla
      // activa del header desktop).
      className={`fixed bottom-0 left-0 right-0 z-40 grid ${VISIBLE_ITEMS.length === 2 ? "grid-cols-2" : "grid-cols-3"} border-t border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)]/95 px-3.5 pt-1.5 pb-5 backdrop-blur-md md:hidden`}
      aria-label="Primary"
    >
      {VISIBLE_ITEMS.map((it) => {
        const active = current === it.route;
        const icon = NAV_ICONS[it.route];
        if (it.inactive) {
          return (
            <span
              key={it.route}
              aria-disabled
              className="flex cursor-not-allowed flex-col items-center justify-center gap-1 py-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-warm-gray)]/50"
              title={t({ en: "Coming soon", es: "Próximamente" })}
            >
              <span className="flex h-8 w-8 items-center justify-center">{icon}</span>
              <span className="flex items-center gap-1">
                {t({ en: it.en, es: it.es })}
                <span className="text-[7px] font-extrabold tracking-[0.18em] text-[color:var(--color-warm-gray)]/60">
                  {t({ en: "Soon", es: "Pronto" })}
                </span>
              </span>
            </span>
          );
        }
        return (
          <Link
            key={it.route}
            href={portalHref(lang, it.route)}
            aria-current={active ? "page" : undefined}
            className={`flex flex-col items-center justify-center gap-1 py-1 text-[9px] uppercase tracking-[0.12em] cursor-pointer transition-colors ${
              active
                ? "font-black text-[color:var(--color-lit-grey)]"
                : "font-semibold text-[color:var(--color-warm-gray)]/55 hover:text-[color:var(--color-lit-grey)]"
            }`}
          >
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                active
                  ? "bg-[color:var(--color-bold-yellow)] text-[color:var(--color-lit-grey)]"
                  : "text-[color:var(--color-warm-gray)]/70"
              }`}
            >
              {icon}
            </span>
            <span>{t({ en: it.en, es: it.es })}</span>
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
  const { canSwitch, openChooser, accountOnly } = useSubscriptionSwitch();
  return (
    <nav
      className="fixed top-0 left-0 right-0 z-40 hidden border-b border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-brisky-cream)]/90 backdrop-blur-md md:block"
      aria-label="Primary"
    >
      {/* Header tema web PRE: logo a la IZQUIERDA del todo; a la DERECHA
          CAMBIAR (a la izquierda del resto) + la cápsula de nav (viñeta ○/●
          por item, activo en pastilla amarilla). */}
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-8 py-4">
        {/* Izquierda del todo — logo */}
        <Logo />
        {/* Derecha — CAMBIAR + cápsula de nav */}
        <div className="flex items-center gap-3">
          {canSwitch && (
            <button
              type="button"
              onClick={openChooser}
              className="inline-flex cursor-pointer items-center gap-1.5 self-stretch rounded-full border border-[color:var(--color-lit-grey)]/40 bg-[color:var(--color-sharp-white)]/70 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-lit-grey)]/80 shadow-[0_1px_2px_rgba(50,40,30,0.08)] transition-colors hover:text-[color:var(--color-lit-grey)]"
            >
              <span aria-hidden className="inline-block h-[6px] w-[6px] rounded-full border border-current opacity-70" />
              {t({ en: "Switch", es: "Cambiar" })}
            </button>
          )}
          {/* Wholesale: no tabs, just the way out. Same reasoning as BottomNav. */}
          {accountOnly && <SignOutPill />}
          {!accountOnly && (
          <div className="inline-flex items-center gap-1 rounded-full border border-[color:var(--color-lit-grey)]/12 bg-[color:var(--color-sharp-white)]/55 p-1 backdrop-blur-sm">
          {VISIBLE_ITEMS.map((it) => {
            const active = current === it.route;
            const label = t({ en: it.en, es: it.es });
            if (it.inactive) {
              return (
                <span
                  key={it.route}
                  aria-disabled
                  title={t({ en: "Coming soon", es: "Próximamente" })}
                  className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-lit-grey)]/35"
                >
                  <span aria-hidden className="inline-block h-[6px] w-[6px] rounded-full border border-current opacity-70" />
                  {label}
                  <span className="ml-0.5 text-[8px] font-extrabold tracking-[0.2em] text-[color:var(--color-warm-gray)]/80">
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
                className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] transition-colors ${
                  active
                    ? "bg-[color:var(--color-bold-yellow)] text-[color:var(--color-lit-grey)]"
                    : "text-[color:var(--color-lit-grey)]/55 hover:text-[color:var(--color-lit-grey)]"
                }`}
              >
                <span
                  aria-hidden
                  className={`inline-block h-[6px] w-[6px] rounded-full ${active ? "bg-current" : "border border-current opacity-70"}`}
                />
                {label}
              </Link>
            );
          })}
          </div>
          )}
        </div>
      </div>
    </nav>
  );
}

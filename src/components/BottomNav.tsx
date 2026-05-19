"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { LangToggle, useLang, useLangValue } from "@/lib/i18n";
import { portalHref, type PortalRoute } from "@/lib/portal-link";

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
  canonical: string;
  en: string;
  es: string;
  inactive?: boolean;
}[] = [
  { route: "home", canonical: "my-lit", en: "My LIT", es: "Mi LIT" },
  { route: "account", canonical: "account", en: "Account", es: "Cuenta" },
  {
    route: "collection",
    canonical: "collection",
    en: "Collection",
    es: "Colección",
    inactive: true,
  },
];

function isActive(pathname: string | null, canonical: string): boolean {
  // pathname comes from usePathname, which reflects post-proxy.ts rewrite
  // (always the canonical EN slug). Match `/[locale]/<canonical>` and
  // `/[locale]/<canonical>/...`.
  if (!pathname) return false;
  const re = new RegExp(`^/(en|es)/${canonical}(/|$)`);
  return re.test(pathname);
}

export function BottomNav() {
  const pathname = usePathname();
  const lang = useLangValue();
  const t = useLang();
  return (
    <nav
      className="sticky bottom-0 left-0 right-0 z-40 grid grid-cols-3 border-t border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-3.5 pt-2.5 pb-6 md:hidden"
      aria-label="Primary"
    >
      {ITEMS.map((it) => {
        const active = isActive(pathname, it.canonical);
        if (it.inactive) {
          return (
            <span
              key={it.canonical}
              aria-disabled
              className="flex cursor-not-allowed flex-col items-center justify-center gap-1 py-2 text-[9px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-warm-gray)]/55"
              title={t({ en: "Coming soon", es: "Próximamente" })}
            >
              <span>{t({ en: it.en, es: it.es })}</span>
              <span className="text-[7px] font-extrabold tracking-[0.18em] text-[color:var(--color-warm-gray)]/70">
                Soon
              </span>
            </span>
          );
        }
        return (
          <Link
            key={it.canonical}
            href={portalHref(lang, it.route)}
            className={`flex flex-col items-center justify-center gap-1 py-2 text-[9px] font-bold uppercase tracking-[0.1em] cursor-pointer ${
              active
                ? "font-black text-[color:var(--color-lit-grey)]"
                : "text-[color:var(--color-warm-gray)] hover:text-[color:var(--color-lit-grey)]"
            }`}
          >
            <span>{t({ en: it.en, es: it.es })}</span>
            <span
              className={`h-1 w-1 rounded-full ${active ? "bg-[color:var(--color-bold-yellow)]" : "bg-transparent"}`}
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
  return (
    <nav
      className="fixed top-0 left-0 right-0 z-40 hidden border-b border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-brisky-cream)]/90 backdrop-blur-md md:block"
      aria-label="Primary"
    >
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-8 py-5">
        <Link href={portalHref(lang, "home")} aria-label="LIT" className="cursor-pointer">
          <Logo />
        </Link>
        <div className="flex items-center gap-8">
          {ITEMS.map((it) => {
            const active = isActive(pathname, it.canonical);
            if (it.inactive) {
              return (
                <span
                  key={it.canonical}
                  aria-disabled
                  className="cursor-not-allowed text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)]/35"
                  title={t({ en: "Coming soon", es: "Próximamente" })}
                >
                  {t({ en: it.en, es: it.es })}{" "}
                  <span className="ml-1 text-[8px] font-extrabold tracking-[0.2em] text-[color:var(--color-warm-gray)]/80">
                    SOON
                  </span>
                </span>
              );
            }
            return (
              <Link
                key={it.canonical}
                href={portalHref(lang, it.route)}
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
        </div>
      </div>
    </nav>
  );
}

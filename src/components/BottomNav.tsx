"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { useLang, useLangValue } from "@/lib/i18n";
import { portalHref, type PortalRoute } from "@/lib/portal-link";

/**
 * Bottom navigation — Phase 1 MVP has 3 slots: Hub / Collection / Account.
 *
 * Collection is shown BLURRED in Phase 1 (cards locked, no real progression yet
 * — physical cards not in production). Drops + The World are NOT in Phase 1
 * navigation but their code is preserved for Phase 2 reactivation.
 *
 * Per locked decision 2026-05-06.
 */
const ITEMS: { route: PortalRoute; canonical: string; en: string; es: string }[] = [
  { route: "home", canonical: "your-lit", en: "Your LIT", es: "Tu LIT" },
  { route: "collection", canonical: "collection", en: "Collection", es: "Colección" },
  { route: "account", canonical: "account", en: "Account", es: "Cuenta" },
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
      className="sticky bottom-0 left-0 right-0 z-40 grid grid-cols-3 border-t border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-brisky-cream)] md:hidden"
      aria-label="Primary"
    >
      {ITEMS.map((it) => {
        const active = isActive(pathname, it.canonical);
        return (
          <Link
            key={it.canonical}
            href={portalHref(lang, it.route)}
            className={`flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-bold uppercase tracking-[0.15em] cursor-pointer ${
              active
                ? "text-[color:var(--color-lit-grey)]"
                : "text-[color:var(--color-lit-grey)]/45"
            }`}
          >
            <span>{t({ en: it.en, es: it.es })}</span>
            <span
              className={`h-[2px] w-6 ${active ? "bg-[color:var(--color-bold-yellow)]" : "bg-transparent"}`}
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
      className="hidden border-b border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-brisky-cream)] md:block"
      aria-label="Primary"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between px-8 py-5">
        <Link href={portalHref(lang, "home")} aria-label="LIT" className="cursor-pointer">
          <Logo />
        </Link>
        <div className="flex items-center gap-8">
          {ITEMS.map((it) => {
            const active = isActive(pathname, it.canonical);
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
        </div>
      </div>
    </nav>
  );
}

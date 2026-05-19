"use client";

/**
 * Bilingual EN/ES support. Locale is driven by the URL — the `[locale]`
 * segment in the App Router is the single source of truth. The LangToggle
 * navigates to the equivalent URL in the other locale instead of mutating
 * local state.
 */

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api } from "@/lib/api-client";
import { swapLocale, type Lang } from "@/lib/portal-link";

export type { Lang };

interface LangContext {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const LangCtx = createContext<LangContext | null>(null);

export function LangProvider({
  children,
  locale,
}: {
  children: ReactNode;
  locale: Lang;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const setLang = (l: Lang) => {
    if (l === locale) return;
    // Persist to Shopify customer metafield so the choice survives sessions
    // and is picked up by other surfaces (emails, etc.). Fire-and-forget —
    // the URL swap drives the UI either way. Was previously done by the
    // standalone LanguagePicker inside Account; since the toggle moved into
    // the header, persistence had to move with it. (2026-05-19)
    api("/api/customer/language", {
      method: "PATCH",
      body: JSON.stringify({ language: l }),
    }).catch(() => {});
    router.push(swapLocale(pathname, l));
  };

  return <LangCtx.Provider value={{ lang: locale, setLang }}>{children}</LangCtx.Provider>;
}

export function useLang(): (opts: { en: string; es: string }) => string {
  const ctx = useContext(LangCtx);
  const lang = ctx?.lang ?? "en";
  return ({ en, es }) => (lang === "es" ? es : en);
}

export function useLangValue(): Lang {
  const ctx = useContext(LangCtx);
  return ctx?.lang ?? "en";
}

export function useLangSetter(): (l: Lang) => void {
  const ctx = useContext(LangCtx);
  return ctx?.setLang ?? (() => {});
}

/**
 * Inline bilingual text element. Renders the active language.
 */
export function T({ en, es }: { en: string; es: string }) {
  const t = useLang();
  return <>{t({ en, es })}</>;
}

/**
 * Sets `document.title` to a locale-aware string for the current page.
 *
 * The root layout pre-renders "LIT" as a fallback (SSR). Client pages call
 * this hook with the page-specific title so the browser tab updates as soon
 * as the locale or page changes. Since the portal is authenticated and
 * not indexed, missing SSR for titles is acceptable.
 */
export function usePageTitle(title: { en: string; es: string }) {
  const lang = useLangValue();
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.title = lang === "es" ? title.es : title.en;
    }
  }, [lang, title.en, title.es]);
}

/**
 * EN/ES toggle — rounded-pill style per Juan 2026-05-18 round 4. Two
 * buttons share a single pill outline; active state fills with lit-grey
 * + yellow text, inactive stays muted. Click navigates to the equivalent
 * URL slug in the other locale (real URL swap, not just state).
 */
export function LangToggle({ className }: { className?: string }) {
  const lang = useLangValue();
  const setLang = useLangSetter();
  return (
    <div
      className={`inline-flex flex-shrink-0 items-center rounded-full border border-[color:var(--color-lit-grey)]/40 bg-[color:var(--color-sharp-white)]/70 p-[3px] shadow-[0_1px_2px_rgba(50,40,30,0.08)] ${className ?? ""}`}
    >
      {(["es", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-label={l === "es" ? "Español" : "English"}
          aria-pressed={lang === l}
          className={`rounded-full px-2.5 py-[5px] font-bold uppercase tracking-[0.18em] transition-colors duration-150 cursor-pointer ${
            lang === l
              ? "bg-[color:var(--color-lit-grey)] text-[color:var(--color-bold-yellow)]"
              : "text-[color:var(--color-lit-grey)]/55 hover:text-[color:var(--color-lit-grey)]"
          }`}
          style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

"use client";

/**
 * Bilingual EN/ES support. Locale is driven by the URL — the `[locale]`
 * segment in the App Router is the single source of truth. The LangToggle
 * navigates to the equivalent URL in the other locale instead of mutating
 * local state.
 */

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
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
 * EN/ES toggle matching the hi-fi `.lang-toggle`. Renders 2 tiny buttons inside
 * a faint grey pill. Active button gets dark bg + yellow text. Navigates to
 * the equivalent URL in the other locale — the slug changes per language so
 * `/en/your-lit` ↔ `/es/tu-lit` is a real URL swap, not just a state toggle.
 */
export function LangToggle({ className }: { className?: string }) {
  const lang = useLangValue();
  const setLang = useLangSetter();
  return (
    <div
      className={`flex gap-[1px] rounded-sm bg-[color:var(--color-lit-grey)]/8 p-0.5 ${className ?? ""}`}
    >
      {(["en", "es"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          className={`rounded-[1px] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.1em] cursor-pointer ${
            lang === l
              ? "bg-[color:var(--color-lit-grey)] text-[color:var(--color-bold-yellow)]"
              : "text-[color:var(--color-warm-gray)] hover:text-[color:var(--color-lit-grey)]"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

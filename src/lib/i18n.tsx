"use client";

/**
 * Bilingual EN/ES support. Locale is driven by the URL — the `[locale]`
 * segment in the App Router is the single source of truth. The LangToggle
 * navigates to the equivalent URL in the other locale instead of mutating
 * local state.
 */

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";
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
 * Toggle button — `EN | ES`. Click navigates to the equivalent page in the
 * other locale.
 */
export function LangToggle({ className }: { className?: string }) {
  const lang = useLangValue();
  const setLang = useLangSetter();
  return (
    <div
      className={`flex gap-1 rounded-sm bg-[color:var(--color-sharp-white)] p-0.5 ${className ?? ""}`}
    >
      {(["en", "es"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          className={`px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] rounded-sm cursor-pointer ${
            lang === l
              ? "bg-[color:var(--color-lit-grey)] text-[color:var(--color-brisky-cream)]"
              : "opacity-50 hover:opacity-80"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

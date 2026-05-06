"use client";

/**
 * Bilingual EN/ES support.
 *
 * Mirror of the `data-en` / `data-es` pattern Diane uses in the hi-fi HTMLs.
 * Locale comes from:
 *   1. localStorage `lit_lang` (user toggle)
 *   2. /api/customer.languagePref (Shopify metafield) — default
 *   3. Browser language fallback to "en"
 *
 * Usage:
 *   import { T, useLang } from "@/lib/i18n";
 *   <T en="Open your LIT account" es="Abrir tu cuenta LIT" />
 *   const t = useLang();
 *   t({ en: "Hello", es: "Hola" })
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "es";

interface LangContext {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const LangCtx = createContext<LangContext | null>(null);

const STORAGE_KEY = "lit_lang";

export function LangProvider({
  children,
  initial = "en",
}: {
  children: ReactNode;
  initial?: Lang;
}) {
  const [lang, setLangState] = useState<Lang>(initial);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved === "en" || saved === "es") {
      setLangState(saved);
      return;
    }
    // Fall back to browser language
    if (typeof navigator !== "undefined") {
      const nav = navigator.language?.toLowerCase() ?? "";
      if (nav.startsWith("es")) setLangState("es");
    }
  }, []);

  const setLang = (l: Lang) => {
    setLangState(l);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, l);
  };

  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
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
 * Use for short strings; for HTML-rich strings use `dangerouslySetInnerHTML`.
 */
export function T({ en, es }: { en: string; es: string }) {
  const t = useLang();
  return <>{t({ en, es })}</>;
}

/**
 * Toggle button — `EN | ES`.
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
          className={`px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] rounded-sm ${
            lang === l
              ? "bg-[color:var(--color-lit-grey)] text-[color:var(--color-brisky-cream)]"
              : "opacity-50"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

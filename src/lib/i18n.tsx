"use client";

/**
 * Bilingual EN/ES support. Locale is driven by the URL — the `[locale]`
 * segment in the App Router is the single source of truth. The LangToggle
 * navigates to the equivalent URL in the other locale instead of mutating
 * local state.
 */

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
    router.push(
      swapLocale(pathname, l, typeof window !== "undefined" ? window.location.search : ""),
    );
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
/**
 * Selector de idioma del header desktop, al estilo del de litsalt.com
 * (Juan 2026-09-10): un item más de la cápsula de navegación, con la misma
 * viñeta que los demás, que abre un menú en vez de enseñar los dos idiomas a
 * la vez.
 *
 * Por qué no el `LangToggle` de dos botones: dentro de la cápsula, "ES EN"
 * competía visualmente con Suscripción y Cuenta, y con solo dos idiomas medio
 * control siempre estaba apagado. La web ya resolvió esto con "▾ ES", así que
 * se copia el patrón en vez de inventar otro.
 *
 * `LangToggle` sigue existiendo y en uso: es el que va en el cuerpo de Cuenta
 * en móvil, donde no hay cápsula ni sitio en la barra superior.
 */
export function LangMenu() {
  const lang = useLangValue();
  const setLang = useLangSetter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Cerrar al pulsar fuera y con Escape. Sin esto el menú se queda abierto al
  // navegar con el teclado o al tocar en cualquier otro sitio, que es el fallo
  // clásico de un desplegable hecho a mano.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={lang === "es" ? "Idioma" : "Language"}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-lit-grey)]/55 transition-colors hover:text-[color:var(--color-lit-grey)]"
      >
        <span
          aria-hidden
          className={`text-[9px] leading-none transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        >
          ▾
        </span>
        {lang}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 min-w-[104px] overflow-hidden rounded-[14px] border border-[color:var(--color-lit-grey)]/12 bg-[color:var(--color-sharp-white)] py-1 shadow-[0_14px_34px_-16px_rgba(40,34,20,0.34)]"
        >
          {(["es", "en"] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="menuitem"
              onClick={() => {
                setLang(l);
                setOpen(false);
              }}
              className={`flex w-full cursor-pointer items-center gap-2 px-3.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.16em] transition-colors ${
                lang === l
                  ? "text-[color:var(--color-lit-grey)]"
                  : "text-[color:var(--color-lit-grey)]/55 hover:bg-[color:var(--color-brisky-cream)] hover:text-[color:var(--color-lit-grey)]"
              }`}
            >
              <span
                aria-hidden
                className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${
                  lang === l ? "bg-current" : "border border-current opacity-70"
                }`}
              />
              {l === "es" ? "Español" : "English"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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

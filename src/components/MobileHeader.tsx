"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import logo from "@/assets/lit-logo-grey.webp";
import { useSubscriptionSwitch } from "@/components/SubscriptionGate";
import { useSwitchAccount } from "@/components/SwitchAccount";
import { T, useLang, useLangSetter, useLangValue, type Lang } from "@/lib/i18n";
import { activeRoute, COLLECTION_ENABLED, portalHref, type PortalRoute } from "@/lib/portal-link";

/**
 * Cabecera MÓVIL del portal (Juan 2026-10-14: «estéticamente debe quedar como el
 * menú mobile de la web normal»):
 *
 *   - izquierda, el menú: círculo lima con dos rayas que abre el panel de
 *     litsalt.com (crema, a 10 px de los bordes, radio 20, velo detrás) con
 *     Suscripción, Cuenta y el idioma (▾ ES ▾ EN);
 *   - centro, el logo, que lleva a la tienda como antes;
 *   - derecha, las iniciales del cliente: al pulsarlas, «Cerrar sesión» (y
 *     «Cambiar de suscripción» a quien tiene varias, que antes era una píldora
 *     de la cabecera).
 *
 * Sustituye a la cabecera móvil de cada página y a la barra fija de abajo, que
 * se quita: sus pestañas viven ahora en el menú. Medidas sacadas de la web:
 * botones de 44 px, enlaces en Barlow 18/500 con 0,06em y separadores al 14 %.
 *
 * El panel va en un portal a <body>: la cabecera lleva `backdrop-filter`, y eso
 * convierte a cualquier hijo `fixed` en relativo a la cabecera, no a la pantalla.
 */

const ITEMS: Array<{ route: PortalRoute; en: string; es: string }> = [
  { route: "home", en: "Subscription", es: "Suscripción" },
  { route: "account", en: "Account", es: "Cuenta" },
  { route: "collection", en: "Collection", es: "Colección" },
];

function initialsOf(name: string | null | undefined): string {
  return (
    (name ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join("") || ""
  );
}

export function MobileHeader({
  name,
  extra,
}: {
  /** Nombre del cliente, para las iniciales. Sin él (aún cargando), el círculo va vacío. */
  name?: string | null;
  /** Algo más dentro del menú, debajo del idioma (la píldora del Círculo Interior). */
  extra?: ReactNode;
}) {
  const t = useLang();
  const lang = useLangValue();
  const setLang = useLangSetter();
  const pathname = usePathname();
  const current = activeRoute(pathname);
  const { canSwitch, openChooser, accountOnly, hasSubscription } = useSubscriptionSwitch();
  const signOut = useSwitchAccount();

  const [menuOpen, setMenuOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    burgerRef.current?.focus();
  }, []);

  // Con el menú abierto: la página no hace scroll por detrás, Esc lo cierra y
  // el foco empieza en el botón de cerrar.
  useEffect(() => {
    if (!menuOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, closeMenu]);

  // El menú de las iniciales se cierra pulsando fuera o con Esc.
  useEffect(() => {
    if (!userOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!userRef.current?.contains(e.target as Node)) setUserOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUserOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [userOpen]);

  // El mayorista solo tiene Cuenta; la Colección, mientras no exista, no sale.
  const items = ITEMS.filter((it) => {
    if (it.route === "collection") return COLLECTION_ENABLED && !accountOnly;
    if (it.route === "home") return !accountOnly;
    return true;
  });
  const initials = initialsOf(name);

  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-[#2F343D]/8 bg-[color:var(--background)]/90 backdrop-blur-md md:hidden">
      <div className="grid grid-cols-[44px_1fr_44px] items-center px-[22px] pt-[calc(12px+var(--safe-top))] pb-3">
        <button
          ref={burgerRef}
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label={t({ en: "Open menu", es: "Abrir menú" })}
          aria-expanded={menuOpen}
          aria-controls="portal-menu"
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-[color:var(--color-bold-yellow)] text-[#323743] transition-transform duration-150 active:scale-95"
        >
          <svg aria-hidden width="18" height="12" viewBox="0 0 18 12" fill="none">
            <path d="M1 1.5h16M1 10.5h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        <a href="https://litsalt.com/" aria-label="LIT — Ir a la tienda" className="justify-self-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo.src} alt="LIT" width={56} height={43} className="h-auto w-[56px]" />
        </a>

        <div ref={userRef} className="relative">
          <button
            type="button"
            onClick={() => setUserOpen((v) => !v)}
            aria-label={t({ en: "Your account", es: "Tu cuenta" })}
            aria-expanded={userOpen}
            aria-haspopup="menu"
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-[#2F343D]/12 bg-white/85 font-display text-[13px] font-semibold tracking-[0.04em] text-[#2F343D] shadow-[0_2px_8px_-4px_rgba(40,34,20,0.3)] transition-transform duration-150 active:scale-95"
          >
            {initials || (
              <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
              </svg>
            )}
          </button>

          {userOpen && (
            <div
              role="menu"
              className="lp2-menu-in absolute top-[52px] right-0 w-[220px] overflow-hidden rounded-[16px] border border-[#2F343D]/8 bg-white text-[#2F343D] shadow-[0_18px_40px_-16px_rgba(20,22,28,0.35)]"
            >
              {name && (
                <p className="m-0 truncate border-b border-[#2F343D]/8 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8C8E87]">
                  {name}
                </p>
              )}
              {canSwitch && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserOpen(false);
                    openChooser();
                  }}
                  className="block w-full cursor-pointer border-b border-[#2F343D]/8 px-4 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.12em]"
                >
                  <T en="Switch subscription" es="Cambiar de suscripción" />
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={signOut.go}
                disabled={signOut.busy}
                className="block w-full cursor-pointer px-4 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.12em] disabled:opacity-50"
              >
                {signOut.busy ? <T en="Signing out…" es="Cerrando sesión…" /> : <T en="Sign out" es="Cerrar sesión" />}
              </button>
            </div>
          )}
        </div>
      </div>

      {menuOpen &&
        createPortal(
          <>
            <div aria-hidden className="lp2-fade-in fixed inset-0 z-[60] bg-[#323743]/45 md:hidden" onClick={closeMenu} />
            <div
              id="portal-menu"
              role="dialog"
              aria-modal="true"
              aria-label={t({ en: "Menu", es: "Menú" })}
              className="lp2-menu-in fixed inset-x-2.5 top-[calc(10px+var(--safe-top))] z-[61] rounded-[20px] bg-[#F4F2EA] px-5 pt-6 pb-9 text-[#323743] shadow-[0_24px_60px_rgba(20,22,28,0.28)] md:hidden"
            >
              <div className="relative flex h-12 items-center justify-center">
                <button
                  ref={closeRef}
                  type="button"
                  onClick={closeMenu}
                  aria-label={t({ en: "Close menu", es: "Cerrar menú" })}
                  className="absolute top-1/2 left-0 flex h-10 w-10 -translate-y-1/2 cursor-pointer items-center justify-center"
                >
                  <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M1.5 1.5l11 11M12.5 1.5l-11 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logo.src} alt="LIT" width={62} height={48} className="h-auto w-[62px]" />
              </div>

              <nav aria-label={t({ en: "Portal", es: "Portal" })} className="mt-10">
                {items.map((it) => {
                  const label = t({ en: it.en, es: it.es });
                  const row =
                    "flex items-center justify-between border-b border-[#323743]/14 px-0.5 py-4 text-[18px] leading-[1.3] font-medium uppercase tracking-[0.06em]";
                  // Suscripción apagada para quien no tiene ninguna (misma regla
                  // que tenía la barra de abajo): gris y sin pulsar.
                  if (it.route === "home" && !hasSubscription) {
                    return (
                      <span key={it.route} aria-disabled className={`${row} cursor-not-allowed opacity-35`}>
                        {label}
                      </span>
                    );
                  }
                  const active = current === it.route;
                  return (
                    <Link
                      key={it.route}
                      href={portalHref(lang, it.route)}
                      onClick={() => setMenuOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={row}
                    >
                      {label}
                      {active && (
                        <span
                          aria-hidden
                          className="h-2 w-2 flex-none rounded-full bg-[color:var(--color-bold-yellow)] shadow-[0_0_0_1.5px_#323743]"
                        />
                      )}
                    </Link>
                  );
                })}
              </nav>

              {/* El idioma como en la web: «▾ ES  ▾ EN», el actual en oscuro. */}
              <div className="mt-5 flex items-center" role="group" aria-label={t({ en: "Language", es: "Idioma" })}>
                {(["es", "en"] as Lang[]).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLang(l)}
                    aria-pressed={lang === l}
                    aria-label={l === "es" ? "Español" : "English"}
                    className={`flex cursor-pointer items-center gap-1.5 py-1.5 pr-2.5 text-[15px] font-medium uppercase tracking-[0.06em] transition-opacity ${
                      lang === l ? "" : "opacity-45"
                    }`}
                  >
                    <svg aria-hidden width="8" height="5" viewBox="0 0 8 5">
                      <path d="M0 0h8L4 5z" fill="currentColor" />
                    </svg>
                    {l}
                  </button>
                ))}
              </div>

              {extra && <div className="mt-5">{extra}</div>}
            </div>
          </>,
          document.body,
        )}
    </header>
  );
}

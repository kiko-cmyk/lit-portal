"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { useSubscriptionSwitch } from "@/components/SubscriptionGate";
import { SignOutPill } from "@/components/SwitchAccount";
import { LangMenu, LangToggle, useLang, useLangValue } from "@/lib/i18n";
import { COLLECTION_ENABLED } from "@/lib/portal-link";
import { activeRoute, portalHref, type PortalRoute } from "@/lib/portal-link";

/**
 * Navegación del portal. En ESCRITORIO, la cápsula de la cabecera (TopNav). En
 * móvil ya no hay barra fija abajo (Juan 2026-10-14): las mismas pestañas van en
 * el menú de `MobileHeader`, como en litsalt.com.
 *
 * La Colección va oculta mientras la función no exista (COLLECTION_ENABLED).
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


/**
 * Top nav for desktop — shown only on md+. Logo on left, nav links horizontal.
 */
export function TopNav() {
  const pathname = usePathname();
  const lang = useLangValue();
  const t = useLang();
  const current = activeRoute(pathname);
  const { canSwitch, openChooser, accountOnly, hasSubscription } =
    useSubscriptionSwitch();
  return (
    <nav
      className="fixed top-0 left-0 right-0 z-40 hidden border-b border-[color:var(--color-lit-grey)]/10 bg-[color:var(--background)]/90 backdrop-blur-md md:block"
      aria-label="Primary"
    >
      {/* Header tema web PRE: logo a la IZQUIERDA del todo; a la DERECHA
          CAMBIAR (a la izquierda del resto) + la cápsula de nav (viñeta ○/●
          por item, activo en pastilla amarilla). */}
      {/* Fondo y ancho siguen a la página: el crema de la zona (`--background`)
          y los 1440 px con 24 px de margen del rediseño lp2 de Suscripción y
          Cuenta (Juan 2026-10-13: «el ancho de página que sea más»). */}
      <div className="mx-auto flex w-full max-w-[1440px] items-center justify-between px-8 py-4">
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
            // Ver BottomNav: misma regla, misma ausencia de "PRONTO".
            const locked = it.route === "home" && !hasSubscription;
            if (it.inactive || locked) {
              return (
                <span
                  key={it.route}
                  aria-disabled
                  title={
                    it.inactive
                      ? t({ en: "Coming soon", es: "Próximamente" })
                      : t({
                          en: "Subscribe to unlock",
                          es: "Suscríbete para activarlo",
                        })
                  }
                  className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-lit-grey)]/35"
                >
                  <span aria-hidden className="inline-block h-[6px] w-[6px] rounded-full border border-current opacity-70" />
                  {label}
                  {it.inactive && (
                    <span className="ml-0.5 text-[8px] font-extrabold tracking-[0.2em] text-[color:var(--color-warm-gray)]/80">
                      {t({ en: "SOON", es: "PRONTO" })}
                    </span>
                  )}
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
          {/* Idioma DENTRO de la cápsula, como en litsalt.com (Juan
              2026-09-10): "○ ABOUT  ○ LOG IN  ▾ ES" es una sola pieza, no una
              cápsula más una píldora aparte. Corrige la primera versión, que lo
              dejaba fuera con su propio borde: se leía como un segundo control
              al nivel de "Cambiar" cuando pertenece al mismo grupo que las
              pestañas.

              Va al final y con el chevron en vez de una viñeta ○/●: comparte el
              lenguaje del grupo pero se distingue de lo que navega. */}
          <LangMenu />
          </div>
          )}
          {/* Mayorista: no hay cápsula, así que el idioma necesita ir suelto.
              Un partner también lee el portal en su idioma. */}
          {accountOnly && <LangToggle />}
        </div>
      </div>
    </nav>
  );
}

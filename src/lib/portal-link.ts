/**
 * URL helpers for the portal.
 *
 * URLs in the browser look like `/apps/portal/<locale>/<localized-slug>`.
 * Shopify App Proxy strips `/apps/portal/` before forwarding to Vercel, so
 * the Next.js file system uses canonical EN slugs under `src/app/[locale]/`.
 * `src/proxy.ts` translates ES slugs to canonical at request time.
 */

export type Lang = "en" | "es";

// `signedOut` is not a nav destination — it is the dead end you land on after
// logging out. It lives here anyway so the slug pair exists in exactly one
// place (proxy.ts mirrors it for the ES → canonical rewrite) instead of being
// retyped in every component that needs to send someone there.
export type PortalRoute =
  | "home"
  | "collection"
  | "account"
  | "orders"
  | "signedOut";

const SLUGS: Record<Lang, Record<PortalRoute, string>> = {
  en: {
    home: "my-lit",
    collection: "collection",
    account: "account",
    orders: "orders",
    signedOut: "signed-out",
  },
  es: {
    home: "mi-lit",
    collection: "coleccion",
    account: "cuenta",
    orders: "pedidos",
    signedOut: "sesion-cerrada",
  },
};

/**
 * ¿Se muestra la Colección en el portal?
 *
 * `false` desde 2026-08-31 (Juan: "colections aun no esta habilitado, ocultemoslo
 * del portal y listo de momento"). La página es la maqueta hi-fi: las cartas físicas
 * todavía no se envían, `earnedCount` se deriva del número de envíos y las 12 cartas
 * salen bloqueadas, así que no hay nada que el cliente pueda hacer ahí.
 *
 * Oculta las DOS entradas que había: el item del BottomNav y el bloque
 * "Colección" de mi-lit. La ruta y la página siguen existiendo, así que
 * reactivarlo es poner esto a `true` — no hay que reconstruir nada.
 *
 * Es una constante y no una env var a propósito: `lib/flags.ts` se resuelve en
 * servidor y estos dos son componentes de cliente.
 */
export const COLLECTION_ENABLED = false;

const BASE = process.env.NEXT_PUBLIC_PORTAL_BASE_PATH ?? "";

export function portalHref(locale: Lang, route: PortalRoute): string {
  return `${BASE}/${locale}/${SLUGS[locale][route]}`;
}

/**
 * Order detail URL for a specific Shopify order. Pass the raw Shopify
 * order id (numeric or full GID) — we strip the GID prefix and use
 * just the numeric id in the URL to keep it readable.
 */
export function orderDetailHref(locale: Lang, orderId: string): string {
  const numeric = orderId.replace(/^gid:\/\/shopify\/Order\//, "");
  return `${BASE}/${locale}/${SLUGS[locale].orders}/${numeric}`;
}

/**
 * Compute the equivalent URL in the other locale. Used by LangToggle to
 * swap language without losing the page.
 *
 * `currentPathname` from usePathname() reflects the user-visible URL (the
 * slug in whichever locale they're currently on, NOT the canonical EN
 * post-rewrite), so we look up the route in both locales' slug maps.
 */
export function swapLocale(
  currentPathname: string,
  nextLocale: Lang,
  search = "",
): string {
  // Preserve the query string (e.g. `?action=skip` from the renewal-reminder
  // deep-link, or the `?__dev_customer`/`?__dry_run` testing params) so a
  // language toggle keeps you on the same page in the same state instead of
  // dropping everything after the path.
  const q =
    search && search !== "?"
      ? search.startsWith("?")
        ? search
        : `?${search}`
      : "";
  // Scan EVERY segment for the route slug instead of a fixed index — same fix
  // activeRoute already has: in production usePathname can include the App
  // Proxy prefix (/apps/portal/es/cuenta), where parts[2] is the LOCALE, not
  // the slug, so the fixed-index lookup missed and the toggle bounced every
  // non-home page to home (audit 2026-07-06). Trailing segments after the slug
  // (e.g. an order id in /es/pedidos/12345) are still preserved.
  const parts = currentPathname.split("/").filter(Boolean);
  const routes = Object.keys(SLUGS.en) as PortalRoute[];
  let route: PortalRoute | undefined;
  let slugIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const match = routes.find((r) => SLUGS.en[r] === seg || SLUGS.es[r] === seg);
    if (match) {
      route = match;
      slugIdx = i;
      break;
    }
  }
  if (!route) return `${BASE}/${nextLocale}/${SLUGS[nextLocale].home}${q}`;
  const rest = parts.slice(slugIdx + 1).filter(Boolean);
  const base = portalHref(nextLocale, route);
  return (rest.length ? `${base}/${rest.join("/")}` : base) + q;
}

/**
 * Which nav route the current path belongs to. Matches the user-visible slug
 * in EITHER locale (usePathname returns the localized slug — `mi-lit`,
 * `cuenta`, `coleccion` — NOT the canonical EN one, same as swapLocale), so
 * the active nav item highlights correctly for Spanish users too.
 */
export function activeRoute(currentPathname: string | null): PortalRoute | null {
  if (!currentPathname) return null;
  const routes = Object.keys(SLUGS.en) as PortalRoute[];
  // Scan EVERY path segment (not a fixed index) so it works whether the
  // pathname is `/es/mi-lit`, `/en/my-lit`, or includes the App Proxy prefix
  // `/apps/portal/...`. Matches the visible slug in either locale.
  for (const seg of currentPathname.split("/")) {
    if (!seg) continue;
    const r = routes.find((rt) => SLUGS.en[rt] === seg || SLUGS.es[rt] === seg);
    // Order detail lives under the Account tab — highlight "Cuenta" there
    // instead of leaving the nav with nothing active.
    if (r) return r === "orders" ? "account" : r;
  }
  return null;
}

/**
 * URL helpers for the portal.
 *
 * URLs in the browser look like `/apps/portal/<locale>/<localized-slug>`.
 * Shopify App Proxy strips `/apps/portal/` before forwarding to Vercel, so
 * the Next.js file system uses canonical EN slugs under `src/app/[locale]/`.
 * `src/proxy.ts` translates ES slugs to canonical at request time.
 */

export type Lang = "en" | "es";

export type PortalRoute = "home" | "collection" | "account" | "orders";

const SLUGS: Record<Lang, Record<PortalRoute, string>> = {
  en: { home: "my-lit", collection: "collection", account: "account", orders: "orders" },
  es: { home: "mi-lit", collection: "coleccion", account: "cuenta", orders: "pedidos" },
};

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
export function swapLocale(currentPathname: string, nextLocale: Lang): string {
  const parts = currentPathname.split("/");
  const slug = parts[2];
  // Preserve any trailing segments (e.g. an order id in /es/pedidos/12345) so
  // toggling language on a detail page keeps you on that page instead of
  // bouncing to the section root.
  const rest = parts.slice(3).filter(Boolean);
  const routes = Object.keys(SLUGS.en) as PortalRoute[];
  const route = routes.find(
    (r) => SLUGS.en[r] === slug || SLUGS.es[r] === slug,
  );
  if (!route) return `${BASE}/${nextLocale}/${SLUGS[nextLocale].home}`;
  const base = portalHref(nextLocale, route);
  return rest.length ? `${base}/${rest.join("/")}` : base;
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

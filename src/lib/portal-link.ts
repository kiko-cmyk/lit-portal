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
  const [, , slug] = currentPathname.split("/");
  const routes = Object.keys(SLUGS.en) as PortalRoute[];
  const route = routes.find(
    (r) => SLUGS.en[r] === slug || SLUGS.es[r] === slug,
  );
  if (!route) return `${BASE}/${nextLocale}/${SLUGS[nextLocale].home}`;
  return portalHref(nextLocale, route);
}

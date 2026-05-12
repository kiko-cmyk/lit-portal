/**
 * URL helpers for the portal.
 *
 * URLs in the browser look like `/apps/portal/<locale>/<localized-slug>`.
 * Shopify App Proxy strips `/apps/portal/` before forwarding to Vercel, so
 * the Next.js file system uses canonical EN slugs under `src/app/[locale]/`.
 * `src/proxy.ts` translates ES slugs to canonical at request time.
 */

export type Lang = "en" | "es";

export type PortalRoute = "home" | "collection" | "account";

const SLUGS: Record<Lang, Record<PortalRoute, string>> = {
  en: { home: "your-lit", collection: "collection", account: "account" },
  es: { home: "tu-lit", collection: "coleccion", account: "cuenta" },
};

const BASE = process.env.NEXT_PUBLIC_PORTAL_BASE_PATH ?? "";

export function portalHref(locale: Lang, route: PortalRoute): string {
  return `${BASE}/${locale}/${SLUGS[locale][route]}`;
}

/**
 * Compute the equivalent URL in the other locale. Used by LangToggle to
 * swap language without losing the page.
 */
export function swapLocale(currentPathname: string, nextLocale: Lang): string {
  const segments = currentPathname.split("/").filter(Boolean);
  // Find which canonical route this pathname corresponds to
  // (proxy.ts has already rewritten ES slug → EN canonical before usePathname)
  const [, slug] = segments;
  const route = (Object.keys(SLUGS.en) as PortalRoute[]).find(
    (r) => SLUGS.en[r] === slug,
  );
  if (!route) return `${BASE}/${nextLocale}/${SLUGS[nextLocale].home}`;
  return portalHref(nextLocale, route);
}

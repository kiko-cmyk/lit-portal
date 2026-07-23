import { NextResponse, type NextRequest } from "next/server";

/**
 * Locale + slug routing for the portal.
 *
 * Current URLs:
 *   /apps/portal/en/my-lit, /apps/portal/es/mi-lit
 *   /apps/portal/en/collection, /apps/portal/es/coleccion
 *   /apps/portal/en/account, /apps/portal/es/cuenta
 *
 * Legacy URLs still in customer emails (Klaviyo confirmation flows) that we
 * need to keep redirecting:
 *   /apps/portal/en/your-lit  → /apps/portal/en/my-lit
 *   /apps/portal/es/tu-lit    → /apps/portal/es/mi-lit
 *
 * Shopify App Proxy strips `/apps/portal/` before forwarding to Vercel, so
 * what this proxy sees is `/es/mi-lit`, `/en/my-lit`, etc.
 *
 * Responsibilities:
 * - Redirect bare paths (no locale) to the default locale, with translated slug.
 *   Redirects use a root-relative `Location` header that includes the App Proxy
 *   prefix (`/apps/portal/...`) so the browser stays on litsalt.com instead of
 *   following the Location straight to the Vercel host.
 * - Rewrite translated ES slugs (mi-lit, coleccion, cuenta) to the EN canonical
 *   used in the file system (my-lit, collection, account). The browser URL
 *   doesn't change because rewrites are internal.
 * - Redirect legacy slugs to the new ones so old email links keep working.
 * - Skip /api/*, /_next/*, and static assets.
 */
const LOCALES = ["en", "es"] as const;
const DEFAULT_LOCALE = "es";
const BROWSER_BASE = process.env.NEXT_PUBLIC_PORTAL_BASE_PATH ?? "";

// ES slug → canonical EN slug (the file system uses EN names)
const ES_TO_CANONICAL: Record<string, string> = {
  "mi-lit": "my-lit",
  coleccion: "collection",
  cuenta: "account",
  pedidos: "orders",
};

// Bare canonical slug (no locale) → translated slug for the default locale
const CANONICAL_TO_DEFAULT_LOCALE_SLUG: Record<string, string> = {
  "my-lit": "mi-lit",
  collection: "coleccion",
  account: "cuenta",
  orders: "pedidos",
};

// Legacy → current slug, applied with a 308 so old links in emails still land.
// Keyed by `<locale>/<slug>` to avoid cross-locale ambiguity.
const LEGACY_REDIRECTS: Record<string, string> = {
  "en/your-lit": "en/my-lit",
  "es/tu-lit": "es/mi-lit",
  // Bare (no locale) — handled by the bare-path branch but listed here for
  // intent. The bare-path branch translates the slug into the default locale.
  "your-lit": "my-lit",
  "tu-lit": "mi-lit",
};

function isLocale(s: string): s is (typeof LOCALES)[number] {
  return (LOCALES as readonly string[]).includes(s);
}

function browserRelativeRedirect(pathname: string, req: NextRequest): NextResponse {
  // Use x-forwarded-host so the redirect host matches litsalt.com (the URL
  // bar host) instead of the Vercel host. Otherwise the absolute URL in the
  // Location header would expose lit-portal-drab.vercel.app and the browser
  // would skip App Proxy on the follow-up request.
  const forwardedHost = req.headers.get("x-forwarded-host") ?? req.nextUrl.host;
  const forwardedProto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const target = new URL(`${forwardedProto}://${forwardedHost}${pathname}`);
  return NextResponse.redirect(target, 308);
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Skip API, Next internals, and anything with a file extension
  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    /\.[a-z0-9]+$/i.test(pathname)
  ) {
    return;
  }

  // Direct Vercel access (e.g. install/OAuth flow, dev browsing): when the
  // App Proxy hasn't stripped its prefix, the path arrives with `/apps/portal/`
  // intact. Strip it so the locale logic below sees the same shape regardless
  // of entry point. Otherwise the redirect loop prepends the prefix on every
  // hop until the URL exceeds the browser limit.
  let workPath = pathname;
  if (workPath.startsWith("/apps/portal/")) {
    workPath = workPath.slice("/apps/portal".length) || "/";
  } else if (workPath === "/apps/portal") {
    workPath = "/";
  }

  const segments = workPath.split("/").filter(Boolean);
  const [first, second, ...rest] = segments;

  // Already locale-prefixed
  if (first && isLocale(first)) {
    // Legacy slug (e.g. your-lit / tu-lit) → 308 to current slug.
    if (second) {
      const legacyKey = `${first}/${second}`;
      const replacement = LEGACY_REDIRECTS[legacyKey];
      if (replacement) {
        const tail = rest.length ? "/" + rest.join("/") : "";
        return browserRelativeRedirect(
          `${BROWSER_BASE}/${replacement}${tail}`,
          req,
        );
      }
    }
    // Propagate the real locale to the app so the root layout can set
    // <html lang> correctly. A hardcoded lang="en" on Spanish /es/* pages is
    // what invited browser auto-translation (which crashes React); see
    // src/app/layout.tsx.
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-portal-locale", first);

    // ES translated slug → rewrite to canonical EN slug (browser URL unchanged)
    if (first === "es" && second && ES_TO_CANONICAL[second]) {
      const url = req.nextUrl.clone();
      url.pathname = `/es/${ES_TO_CANONICAL[second]}${rest.length ? "/" + rest.join("/") : ""}`;
      return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // No locale prefix → redirect to the default locale.
  // Resolve legacy first (your-lit / tu-lit are still valid landings); then
  // translate canonical → default-locale slug.
  const resolvedFirst =
    (first && LEGACY_REDIRECTS[first]) || first;
  const translatedFirst =
    resolvedFirst && CANONICAL_TO_DEFAULT_LOCALE_SLUG[resolvedFirst]
      ? CANONICAL_TO_DEFAULT_LOCALE_SLUG[resolvedFirst]
      : resolvedFirst ?? CANONICAL_TO_DEFAULT_LOCALE_SLUG["my-lit"];
  const tail = second ? "/" + [second, ...rest].join("/") : "";
  return browserRelativeRedirect(
    `${BROWSER_BASE}/${DEFAULT_LOCALE}/${translatedFirst}${tail}`,
    req,
  );
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico).*)"],
};

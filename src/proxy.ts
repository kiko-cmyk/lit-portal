import { NextResponse, type NextRequest } from "next/server";

/**
 * Locale + slug routing for the portal.
 *
 * URLs in the wild:
 *   /apps/portal/en/your-lit, /apps/portal/es/tu-lit
 *   /apps/portal/en/collection, /apps/portal/es/coleccion
 *   /apps/portal/en/account, /apps/portal/es/cuenta
 *
 * Shopify App Proxy strips `/apps/portal/` before forwarding to Vercel, so
 * what this proxy sees is `/es/tu-lit`, `/en/your-lit`, etc.
 *
 * Responsibilities:
 * - Redirect bare paths (no locale) to the default locale, with translated slug.
 *   Redirects use a root-relative `Location` header that includes the App Proxy
 *   prefix (`/apps/portal/...`) so the browser stays on litsalt.com instead of
 *   following the Location straight to the Vercel host.
 * - Rewrite translated ES slugs (tu-lit, coleccion, cuenta) to the EN canonical
 *   used in the file system (your-lit, collection, account). The browser URL
 *   doesn't change because rewrites are internal.
 * - Skip /api/*, /_next/*, and static assets.
 */
const LOCALES = ["en", "es"] as const;
const DEFAULT_LOCALE = "es";
const BROWSER_BASE = process.env.NEXT_PUBLIC_PORTAL_BASE_PATH ?? "";

// ES slug → canonical EN slug (the file system uses EN names)
const ES_TO_CANONICAL: Record<string, string> = {
  "tu-lit": "your-lit",
  coleccion: "collection",
  cuenta: "account",
};

// Bare canonical slug (no locale) → translated slug for the default locale
const CANONICAL_TO_DEFAULT_LOCALE_SLUG: Record<string, string> = {
  "your-lit": "tu-lit",
  collection: "coleccion",
  account: "cuenta",
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

  const segments = pathname.split("/").filter(Boolean);
  const [first, second, ...rest] = segments;

  // Already locale-prefixed
  if (first && isLocale(first)) {
    // ES translated slug → rewrite to canonical EN slug (browser URL unchanged)
    if (first === "es" && second && ES_TO_CANONICAL[second]) {
      const url = req.nextUrl.clone();
      url.pathname = `/es/${ES_TO_CANONICAL[second]}${rest.length ? "/" + rest.join("/") : ""}`;
      return NextResponse.rewrite(url);
    }
    return;
  }

  // No locale prefix → redirect to the default locale
  const translatedFirst =
    first && CANONICAL_TO_DEFAULT_LOCALE_SLUG[first]
      ? CANONICAL_TO_DEFAULT_LOCALE_SLUG[first]
      : first ?? CANONICAL_TO_DEFAULT_LOCALE_SLUG["your-lit"];
  const tail = second ? "/" + [second, ...rest].join("/") : "";
  return browserRelativeRedirect(
    `${BROWSER_BASE}/${DEFAULT_LOCALE}/${translatedFirst}${tail}`,
    req,
  );
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico).*)"],
};

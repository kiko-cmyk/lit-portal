/**
 * Prefix internal portal hrefs with the App Proxy base path
 * (e.g. `/apps/portal`). The browser URL is always under that base,
 * but Next.js routes internally without the prefix because Shopify's
 * App Proxy strips it before forwarding to Vercel. So Links need
 * the prefix to navigate via the proxy, while route definitions stay
 * unprefixed.
 */
export const PORTAL_BASE = process.env.NEXT_PUBLIC_PORTAL_BASE_PATH ?? "";

export function portalHref(path: string): string {
  return `${PORTAL_BASE}${path}`;
}

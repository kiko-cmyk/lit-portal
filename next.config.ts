import type { NextConfig } from "next";

/**
 * App Proxy gotcha: Shopify forwards `/apps/portal/*` to Vercel, but NOT
 * `/_next/static/*`. By default Next.js generates relative URLs for assets,
 * so when the page loads at `litsalt.com/apps/portal/your-lit`, the JS/CSS
 * tries to load from `litsalt.com/_next/static/...` → 404.
 *
 * Fix: set `assetPrefix` to the Vercel production URL so static assets load
 * from Vercel directly. Only HTML + /api/* go through the App Proxy.
 *
 * Set ASSET_PREFIX_URL env var in Vercel if the deploy URL changes (e.g.,
 * custom domain). Default falls back to the production vercel.app URL.
 */
const ASSET_PREFIX =
  process.env.ASSET_PREFIX_URL || "https://lit-portal-drab.vercel.app";

/**
 * Security headers.
 *
 * The non-CSP headers below are enforced immediately — they don't affect
 * rendering. The CSP ships as **Report-Only** first: it collects violation
 * reports without blocking anything, so we can confirm the allowlist is
 * complete on real traffic before enforcing.
 *
 * IMPORTANT before flipping CSP to enforce (rename the header to
 * `Content-Security-Policy`): this Report-Only policy intentionally allows
 * `'unsafe-inline'` for script-src, because Next injects inline bootstrap /
 * RSC scripts. Enforcing a strict script-src WITHOUT `'unsafe-inline'`
 * requires a per-request nonce wired through the middleware (`src/proxy.ts`)
 * and Next's nonce support. Do that as a dedicated step. Until then this
 * policy is for OBSERVATION (it validates the external-origin allowlist:
 * Vercel assets, Fontshare, Shopify CDN), not for removing inline scripts.
 *
 * Reporting: violations are sent to /api/csp-report on the Vercel origin
 * directly (not via the App Proxy), so they arrive even cross-origin. We send
 * BOTH `report-uri` (legacy, but the only one Safari/iOS honors — most LIT
 * customers are on iPhone) and `report-to` (modern Reporting-API, paired with
 * the `Reporting-Endpoints` header below). Without this, Report-Only reports
 * only reach each visitor's console and we'd be flying blind before enforcing.
 */
const CSP_REPORT_URI = `${ASSET_PREFIX}/api/csp-report`;

const csp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline' ${ASSET_PREFIX}`,
  `style-src 'self' 'unsafe-inline' https://api.fontshare.com`,
  `font-src 'self' https://cdn.fontshare.com data:`,
  `img-src 'self' https://litsalt.com https://cdn.shopify.com data:`,
  `connect-src 'self' ${ASSET_PREFIX}`,
  `frame-ancestors 'self' https://litsalt.com`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `report-uri ${CSP_REPORT_URI}`,
  `report-to csp-endpoint`,
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  // Reporting-API group referenced by `report-to` above.
  { key: "Reporting-Endpoints", value: `csp-endpoint="${CSP_REPORT_URI}"` },
  // Report-Only for now — see the comment above before enforcing.
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig: NextConfig = {
  // Only set in production. Locally (npm run dev) we want relative paths.
  ...(process.env.NODE_ENV === "production" ? { assetPrefix: ASSET_PREFIX } : {}),
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

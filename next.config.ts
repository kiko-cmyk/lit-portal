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

const nextConfig: NextConfig = {
  // Only set in production. Locally (npm run dev) we want relative paths.
  ...(process.env.NODE_ENV === "production" ? { assetPrefix: ASSET_PREFIX } : {}),
};

export default nextConfig;

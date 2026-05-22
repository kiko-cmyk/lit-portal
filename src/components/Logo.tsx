/**
 * LIT brand logo. Renders the script logo PNG from Shopify CDN —
 * source of truth so updates in Shopify propagate automatically.
 * Default size matches the previous text-2xl placeholder.
 */
export function Logo({ className = "h-7 w-auto" }: { className?: string }) {
  return (
    <a href="https://litsalt.com/" aria-label="LIT — Ir a la tienda" className="inline-flex">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="https://litsalt.com/cdn/shop/t/31/assets/lit-logo-dark-indigo.png"
        alt="LIT"
        className={className}
      />
    </a>
  );
}

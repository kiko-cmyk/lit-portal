"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Bottom navigation — Phase 1 MVP has 3 slots: Hub / Collection / Account.
 *
 * Collection is shown BLURRED in Phase 1 (cards locked, no real progression yet
 * — physical cards not in production). Drops + The World are NOT in Phase 1
 * navigation but their code is preserved for Phase 2 reactivation.
 *
 * Per locked decision 2026-05-06.
 */
const ITEMS = [
  { href: "/your-lit", label: "Your LIT" },
  { href: "/collection", label: "Collection" },
  { href: "/account", label: "Account" },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      className="sticky bottom-0 left-0 right-0 z-40 grid grid-cols-3 border-t border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-brisky-cream)]"
      aria-label="Primary"
    >
      {ITEMS.map((it) => {
        const active = pathname === it.href || pathname?.startsWith(it.href + "/");
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-bold uppercase tracking-[0.15em] ${
              active
                ? "text-[color:var(--color-lit-grey)]"
                : "text-[color:var(--color-lit-grey)]/45"
            }`}
          >
            <span>{it.label}</span>
            <span
              className={`h-[2px] w-6 ${active ? "bg-[color:var(--color-bold-yellow)]" : "bg-transparent"}`}
            />
          </Link>
        );
      })}
    </nav>
  );
}

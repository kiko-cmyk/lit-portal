"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Bottom navigation — 4 slots in MVP (Hub / Drops / World / Account).
 * Collection deferred to Phase 2 per locked decision 2026-04-27.
 */
const ITEMS = [
  { href: "/your-lit", label: "Your LIT" },
  { href: "/drops", label: "Drops" },
  { href: "/the-world", label: "World" },
  { href: "/account", label: "Account" },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      className="sticky bottom-0 left-0 right-0 z-40 grid grid-cols-4 border-t border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-brisky-cream)]"
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

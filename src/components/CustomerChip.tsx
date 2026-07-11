"use client";

import Link from "next/link";
import { useLangValue } from "@/lib/i18n";
import { portalHref } from "@/lib/portal-link";

interface CustomerChipProps {
  name: string;
}

/**
 * Header chip with the customer's initials in a yellow disc + first name
 * in caps. Pill-shaped, links to Account. Per Juan 2026-05-18 round 4 —
 * borrowed from the v2 nav rail.
 */
export function CustomerChip({ name }: CustomerChipProps) {
  const lang = useLangValue();
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join("") || "L";
  const firstName = name.split(/\s+/)[0] ?? name;

  return (
    // min-w-0 + the truncating name span let the chip shrink gracefully in
    // tight mobile headers (multi-sub: pill + toggle + chip + TierPill on
    // ≤390px) instead of pushing the row past the viewport (audit 2026-07-08).
    <Link
      href={portalHref(lang, "account")}
      className="inline-flex min-w-0 items-center gap-2 rounded-full border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] py-[5px] pl-[5px] pr-3 text-[color:var(--color-lit-grey)] transition-transform duration-150 ease-out hover:-translate-y-[1px] hover:border-[color:var(--color-lit-grey)]/35"
      aria-label={`${name} — account`}
    >
      <span
        className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full border border-[color:var(--color-lit-grey)]/10 font-bold text-[color:var(--color-lit-grey)]"
        style={{
          background: "var(--color-sharp-white)",
          boxShadow: "0 2px 6px -3px rgba(40, 34, 20, 0.28)",
          fontFamily: "var(--font-display)",
          fontSize: 11,
        }}
      >
        {initials}
      </span>
      <span
        className="min-w-0 truncate font-bold uppercase tracking-[0.16em]"
        style={{ fontFamily: "var(--font-body)", fontSize: 11 }}
      >
        {firstName}
      </span>
    </Link>
  );
}

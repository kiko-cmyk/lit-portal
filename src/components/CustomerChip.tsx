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
    <Link
      href={portalHref(lang, "account")}
      className="inline-flex items-center gap-2 rounded-full border border-[color:var(--color-lit-grey)]/22 bg-[color:var(--color-sharp-white)] py-[5px] pl-[5px] pr-3 text-[color:var(--color-lit-grey)] transition-transform duration-150 ease-out hover:-translate-y-[1px] hover:border-[color:var(--color-lit-grey)]/50"
      aria-label={`${name} — account`}
    >
      <span
        className="flex h-[26px] w-[26px] items-center justify-center rounded-full font-bold text-[color:var(--color-lit-grey)]"
        style={{
          background:
            "linear-gradient(135deg, var(--color-bold-yellow) 0%, var(--color-retro-ochre) 100%)",
          boxShadow:
            "0 0 0 2px var(--color-sharp-white), 0 0 0 3px rgba(50, 55, 67, 0.18)",
          fontFamily: "var(--font-display)",
          fontSize: 11,
        }}
      >
        {initials}
      </span>
      <span
        className="font-bold uppercase tracking-[0.16em]"
        style={{ fontFamily: "var(--font-body)", fontSize: 11 }}
      >
        {firstName}
      </span>
    </Link>
  );
}

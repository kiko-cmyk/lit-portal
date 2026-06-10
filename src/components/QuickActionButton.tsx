"use client";

import type { ReactNode } from "react";
import { T } from "@/lib/i18n";

interface QuickActionButtonProps {
  icon: ReactNode;
  label: string;
  sub?: string;
  /** Optional eyebrow (kept for backward compat — Hub no longer uses it). */
  eyebrow?: string;
  /** Forced muted-grey with SOON badge, non-clickable. */
  comingSoon?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

/**
 * Quick action tile, second pass post-Juan-feedback-2026-05-18:
 * "less Clash Display, more minimalist". Now:
 *   - Label is Barlow (body) — NOT Clash Display. Less shouty.
 *   - Weight 600 (semibold) instead of 900 (heavy black).
 *   - Title-case, not screaming uppercase.
 *   - Soft border + soft hover lift, no big drop shadow.
 *   - Arrow on hover persists (it was the part that worked).
 */
export function QuickActionButton({
  icon,
  label,
  sub,
  comingSoon,
  onClick,
  disabled,
}: QuickActionButtonProps) {
  const inert = comingSoon || disabled;
  const base =
    "group relative flex h-full min-h-[112px] w-full flex-col justify-between gap-2 overflow-hidden rounded-2xl px-5 pt-5 pb-5 text-left transition-all duration-200 ease-out";
  const active =
    "border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] hover:-translate-y-[2px] hover:border-[color:var(--color-bold-yellow)]/60 hover:shadow-[0_10px_24px_-18px_rgba(50,55,67,0.35)] active:translate-y-0";
  const muted =
    "border border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-lit-grey)]/[0.03] cursor-not-allowed";

  return (
    <button
      type="button"
      onClick={comingSoon ? undefined : onClick}
      disabled={inert}
      aria-disabled={inert}
      className={`${base} ${comingSoon ? muted : active} disabled:cursor-not-allowed disabled:opacity-55`}
    >
      <span
        className={`inline-flex h-5 w-5 transition-transform duration-200 ${
          comingSoon
            ? "text-[color:var(--color-warm-gray)]/50"
            : "text-[color:var(--color-lit-grey)] group-hover:scale-110"
        }`}
      >
        {icon}
      </span>

      {comingSoon && (
        <span
          className="absolute right-3 top-3 rounded-sm bg-[color:var(--color-lit-grey)]/10 px-1.5 py-0.5 font-semibold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 9 }}
        >
          <T en="Soon" es="Pronto" />
        </span>
      )}

      <div className="flex flex-col gap-1">
        <span
          className="text-[14px] font-semibold leading-tight tracking-[-0.005em]"
          style={{
            fontFamily: "var(--font-body)",
            color: comingSoon
              ? "var(--color-warm-gray)"
              : "var(--color-lit-grey)",
          }}
        >
          {label}
        </span>
        {sub && (
          <span
            className="text-[12px] leading-[1.4]"
            style={{
              color: comingSoon
                ? "rgba(122, 116, 106, 0.6)"
                : "var(--color-warm-gray)",
            }}
          >
            {sub}
          </span>
        )}
      </div>

      {/* Subtle arrow that only reveals on hover. */}
      {!comingSoon && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-4 right-4 -translate-x-2 text-[15px] font-light text-[color:var(--color-lit-grey)]/55 opacity-0 transition-all duration-200 ease-out group-hover:translate-x-0 group-hover:opacity-100"
        >
          →
        </span>
      )}
    </button>
  );
}

/** Inline SVG icon set — line icons sized 20×20. */
export const QAIcons = {
  // Bolt = "instant / now". Distinct from Skip's skip-forward glyph.
  ChargeNow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  ChangePlan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  ),
  Skip: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </svg>
  ),
  Flavor: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 4v16M4 12h16" />
    </svg>
  ),
  Extras: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3" width="22" height="5" />
      <path d="M21 8v13H3V8" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  ),
  Cancel: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  ),
};

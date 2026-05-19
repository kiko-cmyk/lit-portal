"use client";

import type { ReactNode } from "react";

interface QuickActionButtonProps {
  icon: ReactNode;
  label: string;
  sub?: string;
  /**
   * When true, the tile renders muted-grey, non-interactive, with a SOON
   * badge. `onClick` is ignored so callers don't accidentally fire flows
   * that aren't ready (Phase 1 has Extras + Flavor in this state).
   */
  comingSoon?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

/**
 * Quick action tile from the Hub hi-fi (.qa-btn).
 *
 *   icon (20×20) ─ label uppercase 12px ─ sub 11px warm-gray
 *   hover: border yellow + translateY(-1px) (active state only)
 *   comingSoon: forced grey, not clickable, SOON badge
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
  return (
    <button
      type="button"
      onClick={comingSoon ? undefined : onClick}
      disabled={inert}
      aria-disabled={inert}
      className={
        comingSoon
          ? "relative flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-[10px] border border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-lit-grey)]/[0.04] px-3 py-3.5 text-left cursor-not-allowed"
          : "group relative flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-[10px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-3 py-3.5 text-left transition-all duration-200 ease-out hover:-translate-y-[2px] hover:border-[color:var(--color-bold-yellow)] hover:bg-[color:var(--color-bold-yellow)]/5 hover:shadow-[0_8px_18px_-12px_rgba(50,55,67,0.25)] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:border-[color:var(--color-lit-grey)]/10 disabled:hover:shadow-none"
      }
    >
      {comingSoon && (
        <span className="absolute right-2 top-2 rounded-sm bg-[color:var(--color-lit-grey)]/10 px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]">
          Soon
        </span>
      )}
      <span
        className={`h-5 w-5 transition-transform duration-200 ${comingSoon ? "text-[color:var(--color-warm-gray)]/60" : "text-[color:var(--color-lit-grey)] group-hover:scale-[1.08]"}`}
      >
        {icon}
      </span>
      <span
        className={`text-[12px] font-extrabold uppercase leading-none tracking-[0.06em] ${comingSoon ? "text-[color:var(--color-warm-gray)]" : "text-[color:var(--color-lit-grey)]"}`}
      >
        {label}
      </span>
      {sub && (
        <span
          className={`text-[11px] leading-[1.3] ${comingSoon ? "text-[color:var(--color-warm-gray)]/70" : "text-[color:var(--color-warm-gray)]"}`}
        >
          {sub}
        </span>
      )}
    </button>
  );
}

/**
 * Inline SVG icon set — line icons sized 20×20, matching the hi-fi exactly.
 * Each icon is a self-contained SVG; consumers pass them via `icon` prop.
 */
export const QAIcons = {
  ChangePlan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  ),
  Skip: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </svg>
  ),
  Flavor: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 4v16M4 12h16" />
    </svg>
  ),
  Extras: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3" width="22" height="5" />
      <path d="M21 8v13H3V8" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  ),
};

"use client";

import type { ReactNode } from "react";

interface QuickActionButtonProps {
  icon: ReactNode;
  label: string;
  sub?: string;
  /** Optional editorial eyebrow (e.g. "01"). Rendered top-left in Condensed. */
  eyebrow?: string;
  /** Soft tan/cream when true → muted grey + SOON badge, not clickable. */
  comingSoon?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

/**
 * Quick action tile. Same 4-col grid structure as the MVP but rendered
 * with editorial polish: numbered eyebrow (Barlow Condensed), title in
 * the display face, animated arrow that slides in on hover, taller
 * card so the type can breathe.
 */
export function QuickActionButton({
  icon,
  label,
  sub,
  eyebrow,
  comingSoon,
  onClick,
  disabled,
}: QuickActionButtonProps) {
  const inert = comingSoon || disabled;
  const base =
    "group relative flex h-full w-full flex-col gap-2 overflow-hidden rounded-2xl px-4 pt-3 pb-4 text-left transition-all duration-200 ease-out";
  const active =
    "border border-[color:var(--color-lit-grey)]/12 bg-[color:var(--color-sharp-white)] hover:-translate-y-[3px] hover:border-[color:var(--color-bold-yellow)] hover:bg-[color:var(--color-bold-yellow)]/8 hover:shadow-[0_14px_28px_-18px_rgba(50,55,67,0.35)] active:translate-y-0";
  const muted =
    "border border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-lit-grey)]/[0.04] cursor-not-allowed";

  return (
    <button
      type="button"
      onClick={comingSoon ? undefined : onClick}
      disabled={inert}
      aria-disabled={inert}
      className={`${base} ${comingSoon ? muted : active} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <div className="flex items-center justify-between">
        {eyebrow && (
          <span
            className="font-bold uppercase tracking-[0.22em]"
            style={{
              fontFamily: "var(--font-cond)",
              fontSize: 10,
              color: comingSoon ? "var(--color-warm-gray)" : "var(--color-warm-gray)",
            }}
          >
            {eyebrow}
          </span>
        )}
        <span
          className={`h-5 w-5 transition-transform duration-200 ${
            comingSoon
              ? "text-[color:var(--color-warm-gray)]/55"
              : "text-[color:var(--color-lit-grey)] group-hover:scale-[1.1] group-hover:rotate-[-3deg]"
          }`}
        >
          {icon}
        </span>
      </div>

      {comingSoon && (
        <span
          className="absolute right-3 top-3 rounded-sm bg-[color:var(--color-lit-grey)]/10 px-1.5 py-0.5 font-extrabold uppercase tracking-[0.2em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 8 }}
        >
          Soon
        </span>
      )}

      <span
        className="mt-3 font-bold uppercase leading-[0.95] tracking-[-0.015em]"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(14px, 3.6vw, 17px)",
          color: comingSoon ? "var(--color-warm-gray)" : "var(--color-lit-grey)",
        }}
      >
        {label}
      </span>

      {sub && (
        <span
          className="text-[11px] leading-[1.35]"
          style={{
            color: comingSoon
              ? "rgba(122, 116, 106, 0.65)"
              : "var(--color-warm-gray)",
          }}
        >
          {sub}
        </span>
      )}

      {/* Animated arrow — slides in from the right on hover. Invisible on
          comingSoon tiles since they're not clickable. */}
      {!comingSoon && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-3 right-3 -translate-x-2 text-[16px] font-bold text-[color:var(--color-lit-grey)] opacity-0 transition-all duration-200 ease-out group-hover:translate-x-0 group-hover:opacity-100"
          style={{ fontFamily: "var(--font-display)" }}
        >
          →
        </span>
      )}
    </button>
  );
}

/** Inline SVG icon set — line icons sized 20×20. */
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

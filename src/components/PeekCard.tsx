"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export type PeekVariant = "drops" | "collection" | "world";

interface PeekCardProps {
  variant: PeekVariant;
  lead: string;
  title: string;
  sub: string;
  cta?: string;
  href?: string;
  onClick?: () => void;
  visual?: ReactNode;
  comingSoon?: boolean;
}

/**
 * Peek card pattern from the Hub hi-fi (.peek-card).
 *
 * 72×72 visual on the left, content on the right with lead / title / sub / cta.
 * Three visual variants:
 *   - drops      → ochre→rust gradient w/ puzzle-mini overlay + big number
 *   - collection → zesty-beige w/ 2×2 mini cards grid
 *   - world      → dark indigo SVG nightscene
 */
export function PeekCard({
  variant,
  lead,
  title,
  sub,
  cta,
  href,
  onClick,
  visual,
  comingSoon,
}: PeekCardProps) {
  const inner = (
    <div
      className={`group mx-6 mb-3.5 flex items-center gap-4 overflow-hidden rounded-[14px] border border-[color:var(--color-lit-grey)]/5 bg-[color:var(--color-sharp-white)] px-5 py-5 transition-all duration-200 md:mx-0 ${
        comingSoon
          ? "opacity-80"
          : "hover:-translate-y-0.5 hover:border-[color:var(--color-bold-yellow)]/40 hover:shadow-[0_8px_20px_rgba(100,90,70,0.08)]"
      }`}
    >
      <PeekVisual variant={variant}>{visual}</PeekVisual>
      <div className="min-w-0 flex-1">
        <div className="text-[9px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
          {lead}
        </div>
        <div className="mt-1.5 font-display text-[18px] font-black uppercase leading-none tracking-[-0.01em] text-[color:var(--color-lit-grey)]">
          {title}
        </div>
        <div className="mt-1 text-[12px] leading-[1.4] text-[color:var(--color-warm-gray)]">
          {sub}
        </div>
        {cta && (
          <div className="mt-2.5 text-[10px] font-extrabold uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]">
            {cta} <span aria-hidden>→</span>
          </div>
        )}
      </div>
    </div>
  );

  if (href && !comingSoon) {
    return <Link href={href}>{inner}</Link>;
  }
  if (onClick && !comingSoon) {
    return (
      <button type="button" onClick={onClick} className="block w-full text-left">
        {inner}
      </button>
    );
  }
  return <div className={comingSoon ? "cursor-default" : ""}>{inner}</div>;
}

function PeekVisual({ variant, children }: { variant: PeekVariant; children?: ReactNode }) {
  if (children) {
    return (
      <div className="relative h-[72px] w-[72px] flex-shrink-0 overflow-hidden rounded-[10px]">
        {children}
      </div>
    );
  }
  if (variant === "drops") {
    return (
      <div
        className="relative flex h-[72px] w-[72px] flex-shrink-0 items-center justify-center overflow-hidden rounded-[10px] p-1.5 font-display font-black text-[color:var(--color-cream)]"
        style={{
          background:
            "linear-gradient(135deg, var(--color-retro-ochre), var(--color-retro-rust))",
        }}
      >
        <div className="relative z-[2] text-center">
          <div className="text-[18px] leading-none tracking-[-0.03em]">—</div>
          <div className="mt-0.5 text-[9px] tracking-[0.12em] opacity-70">DROPS</div>
        </div>
      </div>
    );
  }
  if (variant === "collection") {
    return (
      <div className="flex h-[72px] w-[72px] flex-shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-[color:var(--color-zesty-beige)] p-2">
        <div className="grid h-full w-full grid-cols-2 gap-[2px]">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-[2px] bg-[color:var(--color-lit-grey)]/20"
            />
          ))}
        </div>
      </div>
    );
  }
  // world
  return (
    <div className="h-[72px] w-[72px] flex-shrink-0 overflow-hidden rounded-[10px]">
      <svg viewBox="0 0 72 72" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
        <defs>
          <radialGradient id="peek-world-g" cx="50%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#5a4a7a" />
            <stop offset="100%" stopColor="#0f0e1a" />
          </radialGradient>
        </defs>
        <rect width="72" height="72" fill="url(#peek-world-g)" />
        <circle cx="36" cy="22" r="9" fill="#EBEE62" opacity="0.85" />
        <path d="M0 56 L72 56 L72 72 L0 72 Z" fill="#0a0915" />
        <g fill="#0a0915">
          <circle cx="14" cy="52" r="4" />
          <circle cx="26" cy="50" r="5" />
          <circle cx="40" cy="49" r="5" />
          <circle cx="54" cy="51" r="4" />
        </g>
      </svg>
    </div>
  );
}

/**
 * Drops visual with live data: 4×4 puzzle-mini overlay + big number badge.
 */
export function DropsPeekVisual({
  count,
  percentComplete,
}: {
  count: number;
  percentComplete: number;
}) {
  const tiles = 16;
  const placed = Math.round((percentComplete / 100) * tiles);
  return (
    <div
      className="relative flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-[10px] p-1.5 font-display font-black text-[color:var(--color-cream)]"
      style={{
        background:
          "linear-gradient(135deg, var(--color-retro-ochre), var(--color-retro-rust))",
      }}
    >
      <div className="absolute inset-0 grid grid-cols-4 gap-[1.5px] p-1.5 opacity-40">
        {Array.from({ length: tiles }).map((_, i) => (
          <div
            key={i}
            className={`rounded-[1px] ${i < placed ? "bg-transparent" : "bg-[#1a1510]"}`}
          />
        ))}
      </div>
      <div className="relative z-[2] text-center">
        <div className="text-[18px] leading-none tracking-[-0.03em]">{count}</div>
        <div className="mt-0.5 text-[9px] tracking-[0.12em] opacity-70">DROPS</div>
      </div>
    </div>
  );
}

/**
 * Collection visual with live earned/total state.
 */
export function CollectionPeekVisual({ earned }: { earned: number }) {
  const colors = [
    "linear-gradient(135deg, #C89B5F, #8B4A3A)",
    "linear-gradient(135deg, #373554, #1a1830)",
    "linear-gradient(135deg, #E8B473, #C89B5F)",
    "linear-gradient(135deg, #8B7355, #5a3d2a)",
  ];
  return (
    <div className="flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-[10px] bg-[color:var(--color-zesty-beige)] p-2">
      <div className="grid h-full w-full grid-cols-2 gap-[2px]">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-[2px]"
            style={{
              background:
                i < earned ? colors[i] : "rgba(50,55,67,0.2)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

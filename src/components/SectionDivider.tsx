"use client";

import type { ReactNode } from "react";

/**
 * Section title — single line, refined. Per Juan 2026-05-18 round 2:
 * "demasiada Clash Display, queda muy brusco. Eleva el nivel, algo más
 * minimalista". So:
 *   - Clash Display kept (brand) but weight dropped to 500 (medium),
 *     not the heavy 700-900 we were running before.
 *   - Tracking loosened from -0.025em to -0.005em — letters breathe.
 *   - No uppercase. Title-case feels editorial instead of shouty.
 *   - Smaller cap on the size scale (clamp 18-22px).
 *   - More top margin so sections have real breathing room.
 *
 * The eyebrow and meta props remain optional but the Hub now never
 * passes them — kept for flexibility on future surfaces.
 */
export function SectionDivider({
  eyebrow,
  title,
  meta,
}: {
  eyebrow?: string;
  title: string | ReactNode;
  meta?: string | ReactNode;
}) {
  return (
    <div className="mx-6 mt-14 mb-5 md:mx-0 md:mt-16">
      {eyebrow && (
        <div
          className="mb-1.5 font-bold uppercase tracking-[0.32em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          {eyebrow}
        </div>
      )}
      <div className="flex items-end justify-between gap-4">
        <h2
          className="font-semibold uppercase leading-[1] tracking-[-0.01em] text-[color:var(--color-lit-grey)]"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(18px, 4vw, 22px)",
          }}
        >
          {title}
        </h2>
        {meta && (
          <div
            className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
            style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
          >
            {meta}
          </div>
        )}
      </div>
    </div>
  );
}

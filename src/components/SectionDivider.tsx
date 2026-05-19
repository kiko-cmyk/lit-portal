"use client";

import type { ReactNode } from "react";

/**
 * Editorial section divider — Barlow Condensed eyebrow on the left, display
 * title underneath, optional right-aligned meta. Sits between Hub sections
 * to give the page a magazine cadence instead of one card flowing into the
 * next.
 *
 * Sandwiches the section content visually with a thin grey rule.
 */
export function SectionDivider({
  eyebrow,
  title,
  meta,
}: {
  eyebrow: string;
  title: string | ReactNode;
  meta?: string | ReactNode;
}) {
  return (
    <div className="mx-6 mt-10 mb-3 flex items-end justify-between gap-4 border-b border-[color:var(--color-lit-grey)]/15 pb-2 md:mx-0">
      <div>
        <div
          className="font-bold uppercase tracking-[0.32em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          {eyebrow}
        </div>
        <div
          className="mt-1.5 font-bold uppercase leading-[0.92] tracking-[-0.025em] text-[color:var(--color-lit-grey)]"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(20px, 5.5vw, 28px)",
          }}
        >
          {title}
        </div>
      </div>
      {meta && (
        <div
          className="font-extrabold uppercase tracking-[0.28em] text-[color:var(--color-lit-grey)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          {meta}
        </div>
      )}
    </div>
  );
}

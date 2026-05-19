"use client";

import type { ReactNode } from "react";

/**
 * Section title block. Renders the display-face title centred over its
 * section. Per Juan 2026-05-18: NO eyebrow line above the title, NO rule
 * below it, NO right-aligned meta — just the title.
 *
 * The eyebrow/meta props remain in the API so individual callers can
 * opt back in later, but the Hub no longer uses them.
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
    <div className="mx-6 mt-10 mb-4 md:mx-0">
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
          className="font-bold uppercase leading-[0.92] tracking-[-0.025em] text-[color:var(--color-lit-grey)]"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(22px, 6vw, 30px)",
          }}
        >
          {title}
        </h2>
        {meta && (
          <div
            className="font-extrabold uppercase tracking-[0.28em] text-[color:var(--color-lit-grey)]"
            style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
          >
            {meta}
          </div>
        )}
      </div>
    </div>
  );
}

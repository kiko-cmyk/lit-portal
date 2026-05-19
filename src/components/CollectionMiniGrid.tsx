"use client";

import { T } from "@/lib/i18n";

interface CollectionMiniGridProps {
  /** How many of the 12 are earned. */
  earned: number;
  /** Kept for forward-compat; ignored in Phase 1 (Collection is SOON). */
  href?: string;
}

/**
 * Replaces the previous Collection PeekCard on the Hub with a glance of
 * all 12 slots laid out in a single row. Earned cards render in the
 * ochre/rust gradient (vintage retro per LIT brand), locked cards stay
 * muted with a dashed outline. Per Juan 2026-05-18 round 4: he liked the
 * v2 mockup that showed every card upfront — kept that exact treatment.
 *
 * On narrow mobile widths, the row wraps onto two lines (6 + 6); on
 * desktop they all fit in a single row inside the max-w-5xl container.
 */
export function CollectionMiniGrid({ earned }: CollectionMiniGridProps) {
  return (
    <section
      className="relative mx-6 overflow-hidden rounded-[22px] px-6 py-7 md:mx-0 md:px-8 md:py-8"
      style={{
        background:
          "linear-gradient(135deg, var(--color-zesty-beige) 0%, var(--color-cream) 70%)",
      }}
    >
      {/* Subtle ochre corner glow so the banner feels rich, not flat. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(at 85% 110%, rgba(200, 155, 95, 0.32) 0%, transparent 55%), radial-gradient(at 5% -20%, rgba(245, 240, 221, 0.6) 0%, transparent 50%)",
        }}
      />

      <div className="relative mb-5 flex items-center justify-between">
        <span
          className="font-semibold uppercase tracking-[0.32em] text-[color:var(--color-retro-rust)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          <T en="Edition 01" es="Edición 01" />
        </span>
        {/* Phase 1: Collection is not yet clickable — physical cards aren't
            shipping, so the destination page is a teaser. SOON pill replaces
            the previous "Ver las 12" link. */}
        <span
          className="inline-flex items-center rounded-full bg-[color:var(--color-lit-grey)]/10 px-2.5 py-1 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-retro-rust)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          Soon
        </span>
      </div>

      <div className="relative grid grid-cols-6 gap-2 sm:grid-cols-12 sm:gap-2.5">
        {Array.from({ length: 12 }).map((_, i) => {
          const num = i + 1;
          const isEarned = i < earned;
          return (
            <div
              key={i}
              className={`relative aspect-[5/7] overflow-hidden rounded-xl transition-transform duration-200 ease-out hover:-translate-y-0.5 ${
                isEarned
                  ? "shadow-[0_10px_20px_-12px_rgba(50,40,30,0.4)]"
                  : "border border-dashed border-[color:var(--color-lit-grey)]/22 bg-[color:var(--color-sharp-white)]/40"
              }`}
              style={
                isEarned
                  ? {
                      background:
                        "linear-gradient(135deg, var(--color-retro-ochre) 0%, var(--color-retro-rust) 100%)",
                    }
                  : undefined
              }
            >
              <span
                className={`absolute inset-0 flex items-center justify-center font-bold ${
                  isEarned
                    ? "text-[color:var(--color-cream)]"
                    : "text-[color:var(--color-lit-grey)]/30"
                }`}
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "clamp(14px, 3vw, 18px)",
                  letterSpacing: "-0.015em",
                }}
              >
                {String(num).padStart(2, "0")}
              </span>
            </div>
          );
        })}
      </div>

      <div className="relative mt-5 flex items-baseline justify-between">
        <span
          className="font-semibold uppercase tracking-[0.32em] text-[color:var(--color-retro-rust)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          <T en="Progress" es="Progreso" />
        </span>
        <span
          className="font-semibold tracking-[-0.005em] text-[color:var(--color-lit-grey)]"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 20,
          }}
        >
          {String(earned).padStart(2, "0")} / 12
        </span>
      </div>
    </section>
  );
}

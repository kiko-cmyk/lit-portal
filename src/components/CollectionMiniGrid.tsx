"use client";

import Link from "next/link";
import { T, useLang } from "@/lib/i18n";

interface CollectionMiniGridProps {
  /** How many of the 12 are earned. */
  earned: number;
  /** Where the "Ver las 12" link points (collection page). */
  href: string;
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
export function CollectionMiniGrid({ earned, href }: CollectionMiniGridProps) {
  const t = useLang();
  return (
    <div className="mx-6 md:mx-0">
      <div className="mb-3 flex items-center justify-between">
        <span
          className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          <T en="Edition 01" es="Edición 01" />
        </span>
        <Link
          href={href}
          className="flex items-center gap-1 border-b border-[color:var(--color-lit-grey)] pb-0.5 font-semibold uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] transition-opacity hover:opacity-70"
          style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
        >
          {t({ en: "See all 12", es: "Ver las 12" })}{" "}
          <span aria-hidden>↗</span>
        </Link>
      </div>

      <div className="grid grid-cols-6 gap-2 sm:grid-cols-12 sm:gap-2.5">
        {Array.from({ length: 12 }).map((_, i) => {
          const num = i + 1;
          const isEarned = i < earned;
          return (
            <div
              key={i}
              className={`relative aspect-[5/7] overflow-hidden rounded-xl transition-transform duration-200 ease-out hover:-translate-y-0.5 ${
                isEarned
                  ? "shadow-[0_8px_18px_-12px_rgba(50,40,30,0.35)]"
                  : "border border-dashed border-[color:var(--color-lit-grey)]/25"
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

      <div className="mt-4 flex items-baseline justify-between">
        <span
          className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          <T en="Progress" es="Progreso" />
        </span>
        <span
          className="font-semibold tracking-[-0.005em] text-[color:var(--color-lit-grey)]"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 18,
          }}
        >
          {String(earned).padStart(2, "0")} / 12
        </span>
      </div>
    </div>
  );
}

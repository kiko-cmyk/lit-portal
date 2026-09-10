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
 *   - (El margen superior se igualó al del resto del Hub el 2026-09-10;
 *     ver la nota de espaciado más abajo.)
 *
 * The eyebrow and meta props remain optional but the Hub now never
 * passes them — kept for flexibility on future surfaces.
 *
 * ── Espaciado (Juan 2026-09-10) ──
 *
 * `mt-10 / md:mt-12`. Todas las secciones del Hub se separan por este hueco, y
 * la referencia es el que hay entre el calendario y el banner del formulario,
 * que sale del `mt-10 md:mt-12` de ProfileSurveyBanner. Antes esto era
 * `mt-14 md:mt-16` (56/64px): cada título respiraba más que ese banner y el
 * ritmo de la página iba a saltos.
 *
 * Si se cambia aquí hay que cambiarlo también en ProfileSurveyBanner, que no
 * lleva divisor y se separa por su cuenta.
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
    <div className="mx-6 mt-10 mb-5 md:mx-0 md:mt-12">
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

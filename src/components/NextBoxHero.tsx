"use client";

import { T, useLang, useLangValue } from "@/lib/i18n";
import { frequencyLabel } from "@/lib/frequency-label";
import { WaxSeal } from "@/components/WaxSeal";
import type { Frequency } from "@/lib/types";

export type NextBoxHeroVariant = "default" | "skipped" | "locked" | "new";

interface NextBoxHeroProps {
  shipDate: Date | null;
  flavor: string;
  variant: NextBoxHeroVariant;
  cutoffEndsAt?: Date | null;
  onUndoSkip?: () => void;
  boxCount: number;
  frequency: Frequency;
}

/**
 * Hero card — round 6 redesign (Juan 2026-05-18). Everything in normal
 * document flow so nothing is cropped and nothing is uncentered:
 *
 *   [tape pill — horizontal, inside the card]
 *   ┌────────────────────────────────────┐
 *   │ JUN              [STAY LIT seal]   │  ← date column + seal column
 *   │ 30                                 │
 *   │ ──                                 │
 *   │ Martes · Llega en 30 días          │
 *   │ ─────────────────────────────────  │
 *   │ Sabor       Tu plan                │
 *   │ Salty Lemon 4 cajas · 45 días      │
 *   └────────────────────────────────────┘
 *
 * No `position: absolute` for the seal — it lives in a flex/grid track on
 * the right so the date and the seal never collide. Seal is hidden under
 * 480 px; below that the hero is type-only.
 */
export function NextBoxHero({
  shipDate,
  flavor,
  variant,
  cutoffEndsAt,
  onUndoSkip,
  boxCount,
  frequency,
}: NextBoxHeroProps) {
  const t = useLang();
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  const skipped = variant === "skipped";
  const locked = variant === "locked";

  const month = shipDate
    ? shipDate
        .toLocaleDateString(dateLocale, { month: "short" })
        .replace(".", "")
        .toUpperCase()
    : "—";
  const day = shipDate ? shipDate.getDate().toString() : "—";
  const weekday = shipDate
    ? shipDate.toLocaleDateString(dateLocale, { weekday: "long" })
    : "";

  const arrivalCopy = arrivalDescriptor(shipDate, locked, lang);
  const planLabel = `${boxCount} ${
    boxCount === 1 ? t({ en: "BOX", es: "CAJA" }) : t({ en: "BOXES", es: "CAJAS" })
  } · ${frequencyLabel(frequency, lang, { format: "short" }).toUpperCase()}`;

  const tapeLabel = locked
    ? t({ en: "Locked", es: "Cerrada" })
    : skipped
      ? t({ en: "Skipped", es: "Saltada" })
      : t({ en: "Next delivery", es: "Próxima entrega" });

  return (
    <section
      className="cover-rise relative mx-6 mt-2 overflow-hidden rounded-[24px] bg-[color:var(--color-cream)] px-6 pt-6 pb-7 md:mx-0 md:rounded-[28px] md:px-10 md:pt-8 md:pb-10"
      style={{
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.6) inset, 0 24px 50px -20px rgba(50,40,30,0.22), 0 8px 16px -10px rgba(50,40,30,0.16)",
        isolation: "isolate",
      }}
    >
      {/* Interior mesh */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-[10%] -z-10"
        style={{
          background:
            "radial-gradient(at 80% 10%, rgba(235, 238, 98, 0.55) 0%, transparent 45%), radial-gradient(at 10% 90%, rgba(200, 155, 95, 0.32) 0%, transparent 50%), radial-gradient(at 50% 50%, rgba(55, 53, 84, 0.10) 0%, transparent 60%)",
          filter: "blur(20px)",
        }}
      />

      {/* Top row: tape pill on the left, arrival countdown on the right.
          Both fully inside the card, no rotation overflow. */}
      <div className="mb-5 flex items-center justify-between gap-3 md:mb-7">
        <span
          className="inline-flex items-center rounded-full bg-[color:var(--color-bold-yellow)] px-3 py-1.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)]"
          style={{
            fontFamily: "var(--font-cond)",
            fontSize: 10,
            boxShadow: "0 4px 10px rgba(0,0,0,0.08)",
          }}
        >
          {tapeLabel}
        </span>
        <span
          className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          {arrivalCopy ?? <T en="Loading" es="Cargando" />}
        </span>
      </div>

      {/* Main row: date column + seal column (seal hidden on small).
          Round 7 (2026-05-19): mes + día en la misma línea → el hero
          ocupa menos alto. El día queda hueco (outline) como antes para
          mantener el contraste editorial. */}
      <div className="grid grid-cols-[1fr_auto] items-center gap-4 md:gap-6">
        {/* Date column */}
        <div className="min-w-0">
          <div className="flex items-baseline gap-3 md:gap-4">
            <span
              className="char-rise font-display font-semibold leading-[0.85] tracking-[-0.04em] text-[color:var(--color-lit-grey)]"
              style={{
                fontSize: "clamp(2.8rem, 10vw, 4.6rem)",
                color: skipped ? "var(--color-warm-gray-lt)" : undefined,
              }}
            >
              {month}
            </span>
            <span
              className="char-rise font-display font-semibold leading-[0.85] tracking-[-0.04em]"
              style={{
                fontSize: "clamp(2.8rem, 10vw, 4.6rem)",
                color: "transparent",
                WebkitTextStroke: "2px var(--color-lit-grey)",
                animationDelay: "0.15s",
              }}
            >
              {day}
            </span>
          </div>

          <div
            className="mt-3 font-semibold uppercase tracking-[0.28em] text-[color:var(--color-warm-gray)]"
            style={{
              fontFamily: "var(--font-cond)",
              fontSize: 11,
            }}
          >
            {weekday}
            {skipped && (
              <>
                <span> · </span>
                <T en="skipped" es="saltada" />
              </>
            )}
          </div>
        </div>

        {/* Seal column — hidden below 480px, 96px sm, 132px md.
            Bajado un poco para acompañar al hero más estrecho. */}
        <div className="hidden flex-shrink-0 [@media(min-width:480px)]:block">
          <WaxSeal size={96} className="md:hidden" />
          <WaxSeal size={132} className="hidden md:block" />
        </div>
      </div>

      {/* Meta row: Sabor | Tu plan, full-width grid below the divider */}
      <div className="mt-7 grid grid-cols-2 gap-4 border-t border-[color:var(--color-lit-grey)]/15 pt-5 md:mt-10 md:pt-6">
        <MetaCell
          label={t({ en: "Flavor", es: "Sabor" })}
          value={flavor.toUpperCase()}
          align="left"
        />
        <MetaCell
          label={t({ en: "My plan", es: "Mi plan" })}
          value={planLabel}
          align="right"
        />
      </div>

      {skipped && (
        <div className="mt-4 flex items-center justify-between border-l-[3px] border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/20 px-4 py-2.5">
          <span className="text-[12px] text-[color:var(--color-lit-grey)]">
            <T
              en="You skipped this one. Next box moves out one cycle."
              es="Saltaste esta. La próxima caja pasa un ciclo."
            />
          </span>
          {onUndoSkip && (
            <button
              type="button"
              onClick={onUndoSkip}
              className="text-[10px] font-extrabold uppercase tracking-[0.15em] underline"
            >
              <T en="Undo" es="Deshacer" />
            </button>
          )}
        </div>
      )}

      {locked && cutoffEndsAt && (
        <div className="mt-4 bg-[color:var(--color-lit-grey)]/[0.06] px-3 py-2 text-center text-[11px] text-[color:var(--color-warm-gray)]">
          <strong className="font-extrabold text-[color:var(--color-lit-grey)]">
            <T
              en={`Locked in ${formatHM(cutoffEndsAt)}`}
              es={`Bloqueado en ${formatHM(cutoffEndsAt)}`}
            />
          </strong>
          <span>
            <T
              en=" · Changes apply to the box after."
              es=" · Los cambios aplican a la siguiente."
            />
          </span>
        </div>
      )}
    </section>
  );
}

function MetaCell({
  label,
  value,
  align,
}: {
  label: string;
  value: string;
  align: "left" | "right";
}) {
  return (
    <div className={align === "right" ? "text-right" : "text-left"}>
      <div
        className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
        style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
      >
        {label}
      </div>
      <div
        className="mt-2 font-semibold uppercase leading-[0.95] tracking-[-0.015em] text-[color:var(--color-lit-grey)]"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(18px, 4.5vw, 24px)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function arrivalDescriptor(
  shipDate: Date | null,
  locked: boolean,
  lang: "en" | "es",
): string | null {
  if (!shipDate) return null;
  const ms = shipDate.getTime() - Date.now();
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
  const hours = Math.max(0, Math.ceil(ms / (1000 * 60 * 60)));

  if (locked) {
    return lang === "es" ? `Cierra en ${hours}h` : `Locks in ${hours}h`;
  }
  if (ms <= 0) {
    return lang === "es" ? "Llega hoy" : "Arrives today";
  }
  if (days <= 1 && hours < 48) {
    return lang === "es" ? `Llega en ${hours}h` : `Arrives in ${hours}h`;
  }
  return lang === "es" ? `Llega en ${days} días` : `Arrives in ${days} days`;
}

function formatHM(date: Date): string {
  const ms = Math.max(0, date.getTime() - Date.now());
  const totalMin = Math.floor(ms / (1000 * 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

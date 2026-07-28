"use client";

import { T, useLang, useLangValue } from "@/lib/i18n";
import { frequencyLabel } from "@/lib/frequency-label";
import { WaxSeal } from "@/components/WaxSeal";
import { HERO_PHOTO_DATA_URI } from "@/lib/hero-photo";
import { shortLabel } from "@/lib/mix";
import type { FlavorKey } from "@/lib/seal-plans";
import type { Frequency } from "@/lib/types";

export type NextBoxHeroVariant = "default" | "skipped" | "locked" | "new";

interface NextBoxHeroProps {
  shipDate: Date | null;
  flavor: string;
  /** Boxes per flavor. When it has 2+ entries the Flavor cell stacks one line per
   *  flavor instead of showing a single label. */
  composition?: Array<{ flavor: string; boxes: number }>;
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
  composition,
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

  // Después de un skip, la fecha que se muestra ES la PRÓXIMA real
  // (el calendario ya saltó un ciclo). Por eso la pill arriba se
  // mantiene siempre como "Próxima entrega" salvo que estemos en
  // ventana de cutoff (Cerrada). El estado "Saltada" sólo se refleja
  // en el banner inferior, no en la cabecera del hero. (Juan 2026-05-19)
  const tapeLabel = locked
    ? t({ en: "Locked", es: "Cerrada" })
    : t({ en: "Next order", es: "Próximo pedido" });

  return (
    <section
      className="cover-rise relative mx-6 mt-2 overflow-hidden rounded-[24px] bg-[#16130C] px-6 pt-6 pb-7 md:mx-0 md:rounded-[28px] md:px-10 md:pt-8 md:pb-10"
      style={{
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.06) inset, 0 26px 54px -22px rgba(30,24,12,0.5), 0 8px 16px -10px rgba(30,24,12,0.3)",
        isolation: "isolate",
      }}
    >
      {/* Cinematic photo backdrop (PRE) — brand photo veiled to dark warm */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-cover"
        style={{
          backgroundImage: `url(${HERO_PHOTO_DATA_URI})`,
          backgroundPosition: "center 28%",
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "linear-gradient(180deg, rgba(18,15,9,0.42) 0%, rgba(18,15,9,0.74) 52%, #16130C 98%)",
        }}
      />
      {/* Faint yellow glow keeps the brand heartbeat on the dark hero */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-[10%] -z-10"
        style={{
          background:
            "radial-gradient(at 82% 6%, rgba(235, 238, 98, 0.18) 0%, transparent 45%)",
          filter: "blur(24px)",
        }}
      />

      {/* Top row: tape pill on the left, arrival countdown on the right.
          Both fully inside the card, no rotation overflow.
          Round 7b (Juan 2026-05-19): bumped 10→12px so labels son legibles
          a primera vista. */}
      <div className="mb-5 flex items-center justify-between gap-3 md:mb-7">
        <span
          className="inline-flex items-center rounded-full bg-[color:var(--color-bold-yellow)] px-3.5 py-1.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)]"
          style={{
            fontFamily: "var(--font-cond)",
            fontSize: 12,
            boxShadow: "0 4px 10px rgba(0,0,0,0.08)",
          }}
        >
          {tapeLabel}
        </span>
        <span
          className="font-semibold uppercase tracking-[0.22em] text-[#F2EEE1]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 12 }}
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
          <div className="flex items-baseline gap-4 md:gap-6">
            <span
              className="char-rise font-display font-semibold leading-[0.85] tracking-[-0.04em] text-[#F2EEE1]"
              style={{
                fontSize: "clamp(3.6rem, 13vw, 5.8rem)",
              }}
            >
              {month}
            </span>
            <span
              className="char-rise font-display font-semibold leading-[0.85] tracking-[-0.04em]"
              style={{
                fontSize: "clamp(3.6rem, 13vw, 5.8rem)",
                color: "transparent",
                WebkitTextStroke: "2.5px #F2EEE1",
                animationDelay: "0.15s",
              }}
            >
              {day}
            </span>
          </div>

          <div
            className="mt-3 font-semibold uppercase tracking-[0.28em] text-[#b3ab98]"
            style={{
              fontFamily: "var(--font-cond)",
              fontSize: 12,
            }}
          >
            {weekday}
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
      <div className="mt-7 grid grid-cols-2 gap-4 border-t border-white/15 pt-5 md:mt-10 md:pt-6">
        <MetaCell
          label={t({
            en: (composition?.length ?? 0) > 1 ? "Flavors" : "Flavor",
            es: (composition?.length ?? 0) > 1 ? "Sabores" : "Sabor",
          })}
          value={flavor.toUpperCase()}
          values={
            (composition?.length ?? 0) > 1
              ? composition!.map((c) => `${c.boxes} ${shortLabel(c.flavor as FlavorKey).toUpperCase()}`)
              : undefined
          }
          align="left"
        />
        <MetaCell
          label={t({ en: "My plan", es: "Mi plan" })}
          value={planLabel}
          align="right"
        />
      </div>

      {skipped && (
        <div className="mt-4 flex items-center justify-between border-l-[3px] border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/15 px-4 py-2.5">
          <span className="text-[12px] text-[#F2EEE1]">
            <T
              en="You skipped the previous order. This is your next one."
              es="Saltaste el pedido anterior. Este es el próximo."
            />
          </span>
          {onUndoSkip && (
            <button
              type="button"
              onClick={onUndoSkip}
              className="text-[10px] font-extrabold uppercase tracking-[0.15em] underline text-[color:var(--color-bold-yellow)]"
            >
              <T en="Undo" es="Deshacer" />
            </button>
          )}
        </div>
      )}

      {locked && cutoffEndsAt && (
        <div className="mt-4 rounded-md bg-white/[0.08] px-3 py-2 text-center text-[11px] text-[#b3ab98]">
          <strong className="font-extrabold text-[#F2EEE1]">
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
  values,
  align,
}: {
  label: string;
  value: string;
  /** Several lines, stacked. A flavor mix ("2 LEMON" / "1 WATERMELON") would
   *  truncate as one line in a half-width cell on a 390px phone. When stacking, the
   *  type steps down so the hero keeps its height. */
  values?: string[];
  align: "left" | "right";
}) {
  const lines = values?.length ? values : [value];
  const stacked = lines.length > 1;
  return (
    <div className={align === "right" ? "text-right" : "text-left"}>
      <div
        className="font-semibold uppercase tracking-[0.22em] text-[#b3ab98]"
        style={{ fontFamily: "var(--font-cond)", fontSize: 12 }}
      >
        {label}
      </div>
      <div
        className="mt-2 font-semibold uppercase leading-[0.95] tracking-[-0.015em] text-[#F2EEE1]"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: stacked ? "clamp(15px, 3.8vw, 19px)" : "clamp(20px, 5vw, 26px)",
        }}
      >
        {lines.map((l) => (
          <div key={l}>{l}</div>
        ))}
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
    return lang === "es" ? "Sale hoy" : "Ships today";
  }
  if (days <= 1 && hours < 48) {
    return lang === "es" ? `Sale en ${hours}h` : `Ships in ${hours}h`;
  }
  return lang === "es" ? `Sale en ${days} días` : `Ships in ${days} days`;
}

function formatHM(date: Date): string {
  const ms = Math.max(0, date.getTime() - Date.now());
  const totalMin = Math.floor(ms / (1000 * 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

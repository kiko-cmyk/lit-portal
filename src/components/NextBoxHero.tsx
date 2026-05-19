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
 * Hero card — "My next box".
 *
 * Same content/structure as the MVP (eyebrow → date → weekday + arrival
 * descriptor → 2-col meta row Flavor | Plan + skip/lock banners), now with
 * editorial polish:
 *   - cream cover with interior mesh + faint grain
 *   - diagonal yellow tape pill anchoring the top-left corner
 *   - issue strip (Barlow Condensed) above the date with edition + status
 *   - mega date in Clash Display (clamp 4.5–7.5rem) — DAY rendered as
 *     stroke-outline overlay sliding into place after MONTH
 *   - cover-rise + char-rise entrance animations on mount
 *   - hover lift on the whole surface
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
      className="cover-rise relative mx-6 mt-2 overflow-hidden rounded-[24px] bg-[color:var(--color-cream)] px-6 pt-10 pb-7 md:mx-0 md:rounded-[28px] md:px-8 md:pt-12 md:pb-9"
      style={{
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.6) inset, 0 24px 50px -20px rgba(50,40,30,0.22), 0 8px 16px -10px rgba(50,40,30,0.16)",
        isolation: "isolate",
      }}
    >
      {/* Interior mesh — three radials drifting slowly */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-[10%] -z-10"
        style={{
          background:
            "radial-gradient(at 80% 10%, rgba(235, 238, 98, 0.55) 0%, transparent 45%), radial-gradient(at 10% 90%, rgba(200, 155, 95, 0.32) 0%, transparent 50%), radial-gradient(at 50% 50%, rgba(55, 53, 84, 0.10) 0%, transparent 60%)",
          filter: "blur(20px)",
          animation: "cover-mesh-drift 14s ease-in-out infinite alternate",
        }}
      />

      {/* Tape pill — diagonal yellow strip in top-left */}
      <span
        className="absolute top-3.5 -left-9 z-[3] inline-block rotate-[-22deg] bg-[color:var(--color-bold-yellow)] px-10 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)]"
        style={{
          boxShadow: "0 4px 10px rgba(0,0,0,0.12)",
          fontFamily: "var(--font-display)",
        }}
      >
        {tapeLabel}
      </span>

      {/* Wax-seal brand badge — rotating rim, static "STAY LIT" centre.
          Sits middle-right of the hero, fully inside the card so it never
          covers the issue strip nor the meta row. Hidden on tight mobile
          (<420px) where there's no room. */}
      <div className="pointer-events-none absolute right-5 top-1/2 z-[2] hidden -translate-y-1/2 [@media(min-width:420px)]:block md:right-10">
        <WaxSeal size={130} className="md:hidden" />
        <WaxSeal size={190} className="hidden md:block" />
      </div>

      {/* Issue strip — arrival countdown only (Juan: drop "Mi LIT" here). */}
      <div className="mb-4 flex items-baseline justify-end md:mb-5">
        <span
          className="eyebrow-cond"
          style={{ color: "var(--color-lit-grey)" }}
        >
          {arrivalCopy ?? <T en="Loading" es="Cargando" />}
        </span>
      </div>

      {/* Mega date — month + day, with the day painted as stroked outline */}
      <div className="relative">
        <span
          className="char-rise block font-display font-bold leading-[0.82] tracking-[-0.045em] text-[color:var(--color-lit-grey)]"
          style={{ fontSize: "var(--display-mega)" }}
        >
          {month}
        </span>
        <span
          className="char-rise block font-display font-bold leading-[0.82] tracking-[-0.045em]"
          style={{
            fontSize: "var(--display-mega)",
            marginTop: "-0.05em",
            color: "transparent",
            WebkitTextStroke: "2px var(--color-lit-grey)",
            animationDelay: "0.18s",
          }}
        >
          {day}
        </span>
      </div>

      <div className="mt-3 font-[var(--font-cond)] text-[12px] font-bold uppercase tracking-[0.32em] text-[color:var(--color-warm-gray)]">
        {weekday || ""}
        {skipped && (
          <>
            <span> · </span>
            <T en="skipped" es="saltada" />
          </>
        )}
      </div>

      {/* Meta row — Flavor + Plan, 2-col with editorial spacing */}
      <div className="mt-6 grid grid-cols-2 gap-4 border-t border-[color:var(--color-lit-grey)]/15 pt-5">
        <MetaCell
          label={t({ en: "Flavor", es: "Sabor" })}
          value={flavor.toUpperCase()}
          align="left"
        />
        <MetaCell
          label={t({ en: "Your plan", es: "Tu plan" })}
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
          fontSize: "clamp(20px, 5vw, 28px)",
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

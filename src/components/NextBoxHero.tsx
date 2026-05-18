"use client";

import { T, useLang, useLangValue } from "@/lib/i18n";
import { frequencyLabel } from "@/lib/frequency-label";
import type { Frequency } from "@/lib/types";

export type NextBoxHeroVariant = "default" | "skipped" | "locked" | "new";

interface NextBoxHeroProps {
  shipDate: Date | null;
  flavor: string;
  variant: NextBoxHeroVariant;
  cutoffEndsAt?: Date | null;
  onUndoSkip?: () => void;
  /** Customer's current plan, used in the meta-row. */
  boxCount: number;
  frequency: Frequency;
}

/**
 * Hero card for "Your next box".
 *
 * Hierarchy (post user-feedback 2026-05-18):
 *   - eyebrow "TU PRÓXIMA CAJA"
 *   - 58px Clash Display date
 *   - day-of-week · "LLEGA EN X DÍAS" inline so the countdown reads as context
 *     for the big date, not as a competing number
 *   - 2-col meta row: SABOR | TU PLAN (boxes · frequency)
 *
 * Previously this card had a yellow countdown pill in the middle and a
 * BOX #N cell on the right. Removed because the date already communicates
 * "when" (no need for a second number) and the box index didn't help the
 * customer.
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

  const monthDay = shipDate
    ? shipDate
        .toLocaleDateString(dateLocale, { month: "short", day: "numeric" })
        .toUpperCase()
    : "—";

  const weekday = shipDate
    ? shipDate.toLocaleDateString(dateLocale, { weekday: "long" })
    : "";

  const arrivalCopy = arrivalDescriptor(shipDate, locked, lang);
  const planLabel = `${boxCount} ${
    boxCount === 1
      ? t({ en: "box", es: "caja" })
      : t({ en: "boxes", es: "cajas" })
  } · ${frequencyLabel(frequency, lang, { format: "short" })}`;

  return (
    <section
      className={
        "relative mx-6 mt-2 overflow-hidden rounded-2xl bg-[color:var(--color-sharp-white)] px-6 pt-7 pb-6 shadow-[0_8px_24px_rgba(100,90,70,0.08)] ring-1 ring-[color:var(--color-lit-grey)]/5 md:mx-0 md:px-8 md:pt-9"
      }
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-52 w-52 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(235, 238, 98, 0.28) 0%, transparent 70%)",
        }}
      />

      <div className="relative">
        <div className="lead-label">
          <T en="Your next box" es="Tu próxima caja" />
        </div>

        <div
          className={`mt-2 font-display text-[58px] font-black leading-[0.86] tracking-[-0.04em] ${
            skipped
              ? "text-[color:var(--color-warm-gray-lt)]"
              : "text-[color:var(--color-lit-grey)]"
          }`}
        >
          {monthDay}
        </div>

        <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
          {weekday}
          {arrivalCopy && (
            <>
              <span> · </span>
              <span className="text-[color:var(--color-lit-grey)]">{arrivalCopy}</span>
            </>
          )}
          {skipped && (
            <>
              <span> · </span>
              <T en="skipped" es="saltada" />
            </>
          )}
        </div>

        <div className="relative mt-5 grid grid-cols-2 items-center gap-4 border-t border-[color:var(--color-lit-grey)]/10 pt-4">
          <MetaCell
            label={t({ en: "Flavor", es: "Sabor" })}
            value={flavor.toUpperCase()}
            align="left"
          />
          <MetaCell
            label={t({ en: "Your plan", es: "Tu plan" })}
            value={planLabel.toUpperCase()}
            align="right"
          />
        </div>

        {skipped && (
          <div className="mt-3.5 flex items-center justify-between border-l-[3px] border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/20 px-3.5 py-2.5">
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
          <div className="mt-3.5 bg-[color:var(--color-lit-grey)]/[0.06] px-3 py-2 text-center text-[11px] text-[color:var(--color-warm-gray)]">
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
      </div>
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
      <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-[color:var(--color-warm-gray)]">
        {label}
      </div>
      <div className="mt-0.5 font-display text-[16px] font-black uppercase leading-tight tracking-[-0.01em] text-[color:var(--color-lit-grey)]">
        {value}
      </div>
    </div>
  );
}

/**
 * "LLEGA EN 15 DÍAS" / "LLEGA HOY" / "LLEGA EN 14H" — copy that contextualises
 * the big date, replacing the old yellow countdown pill.
 */
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
    return lang === "es"
      ? `cierra en ${hours}h`
      : `locks in ${hours}h`;
  }
  if (ms <= 0) {
    return lang === "es" ? "llega hoy" : "arrives today";
  }
  if (days <= 1 && hours < 48) {
    return lang === "es" ? `llega en ${hours}h` : `arrives in ${hours}h`;
  }
  const unit =
    days === 1
      ? lang === "es"
        ? "día"
        : "day"
      : lang === "es"
        ? "días"
        : "days";
  return lang === "es" ? `llega en ${days} ${unit}` : `arrives in ${days} ${unit}`;
}

function formatHM(date: Date): string {
  const ms = Math.max(0, date.getTime() - Date.now());
  const totalMin = Math.floor(ms / (1000 * 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

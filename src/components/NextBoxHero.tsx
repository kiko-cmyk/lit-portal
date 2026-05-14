"use client";

import { T, useLang, useLangValue } from "@/lib/i18n";

export type NextBoxHeroVariant = "default" | "skipped" | "locked" | "new";

interface NextBoxHeroProps {
  shipDate: Date | null;
  flavor: string;
  boxNumber: number | null;
  variant: NextBoxHeroVariant;
  cutoffEndsAt?: Date | null;
  onUndoSkip?: () => void;
}

/**
 * Hi-fi next-box hero card.
 *
 * Layout mirrors `designs/mobile/lit-hub-hifi/index.html` (.next-box):
 *   - eyebrow "YOUR NEXT BOX"
 *   - 58px Clash Display date
 *   - day caps with wide tracking
 *   - 3-col meta row: flavor | yellow countdown pill | box #
 *   - variant adds .skipped (greyed date + undo banner) or .locked (lock-note)
 */
export function NextBoxHero({
  shipDate,
  flavor,
  boxNumber,
  variant,
  cutoffEndsAt,
  onUndoSkip,
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

  const { num, unit } = countdown({ shipDate, locked, lang });

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
          {skipped && (
            <>
              <span> · </span>
              <T en="skipped" es="saltada" />
            </>
          )}
        </div>

        <div className="relative mt-5 grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-t border-[color:var(--color-lit-grey)]/10 pt-4">
          <MetaCell
            label={t({ en: "Flavor", es: "Sabor" })}
            value={flavor}
            align="left"
          />

          <div className="rounded-lg bg-[color:var(--color-bold-yellow)] px-3 py-2.5 text-center font-display font-black text-[color:var(--color-lit-grey)] min-w-[64px]">
            <div className="text-xl leading-none tracking-[-0.02em]">{num}</div>
            <div className="mt-1 text-[9px] font-black uppercase tracking-[0.2em] opacity-75">
              {unit}
            </div>
          </div>

          <MetaCell
            label={t({ en: "Box", es: "Caja" })}
            value={boxNumber ? `#${boxNumber}` : "—"}
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
                en={`Locked in ${formatHM(cutoffEndsAt, "en")}`}
                es={`Bloqueado en ${formatHM(cutoffEndsAt, "es")}`}
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
      <div className="mt-0.5 font-display text-[18px] font-black uppercase tracking-[-0.01em] text-[color:var(--color-lit-grey)]">
        {value}
      </div>
    </div>
  );
}

function countdown({
  shipDate,
  locked,
  lang,
}: {
  shipDate: Date | null;
  locked: boolean;
  lang: "en" | "es";
}): { num: string; unit: string } {
  if (!shipDate) return { num: "—", unit: lang === "es" ? "días" : "days" };

  const ms = shipDate.getTime() - Date.now();
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
  const hours = Math.max(0, Math.ceil(ms / (1000 * 60 * 60)));

  if (locked) {
    return {
      num: `${hours}h`,
      unit: lang === "es" ? "al cierre" : "to lock",
    };
  }
  if (days <= 1 && hours < 48) {
    return {
      num: `${hours}h`,
      unit: lang === "es" ? "restan" : "left",
    };
  }
  return {
    num: String(Math.max(0, days)),
    unit:
      days === 1
        ? lang === "es"
          ? "día"
          : "day"
        : lang === "es"
          ? "días"
          : "days",
  };
}

function formatHM(date: Date, lang: "en" | "es"): string {
  const ms = Math.max(0, date.getTime() - Date.now());
  const totalMin = Math.floor(ms / (1000 * 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return lang === "es" ? `${h}h ${m}m` : `${h}h ${m}m`;
}

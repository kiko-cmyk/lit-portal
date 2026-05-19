"use client";

import { T, useLang, useLangValue } from "@/lib/i18n";
import { useCounterUp, useReveal } from "@/lib/use-reveal";

interface ImpactStatsProps {
  /** Number of boxes the customer has received so far. */
  boxesReceived: number;
  /** ISO date when the customer became a LIT subscriber. */
  memberSince: string;
}

/**
 * Editorial "Tu impacto" banner — three counter-up stats sourced from data
 * we already have (boxes received + member-since). No extra API calls.
 *
 * Visible even for brand-new subs (boxes = 0) so the customer sees their
 * journey starting; counters animate from 0 in any case, the zero-state
 * just reads "empieza desde aquí".
 */
export function ImpactStats({ boxesReceived, memberSince }: ImpactStatsProps) {
  const t = useLang();
  const lang = useLangValue();
  const ref = useReveal<HTMLElement>();

  const sachetsConsumed = boxesReceived * 30;
  const monthsAsMember = Math.max(
    0,
    Math.floor(
      (Date.now() - new Date(memberSince).getTime()) /
        (1000 * 60 * 60 * 24 * 30),
    ),
  );
  const isZero = boxesReceived === 0;

  const dateLocale = lang === "es" ? "es-ES" : "en-US";
  const memberSinceLabel = new Date(memberSince).toLocaleDateString(
    dateLocale,
    { month: "long", year: "numeric" },
  );

  return (
    <section
      ref={ref}
      className="reveal relative mx-6 mt-10 overflow-hidden rounded-[24px] bg-[color:var(--color-lit-grey)] px-6 pt-10 pb-9 text-[color:var(--color-brisky-cream)] md:mx-0 md:rounded-[28px] md:px-10 md:pt-12 md:pb-10"
    >
      {/* Indigo + ochre radial accents — same DNA as the v2 proposal */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(at 90% 0%, rgba(235, 238, 98, 0.2) 0%, transparent 40%), radial-gradient(at 10% 100%, rgba(207, 191, 173, 0.15) 0%, transparent 50%)",
        }}
      />

      <div className="relative mb-6 flex items-baseline justify-between gap-3">
        <span
          className="font-bold uppercase tracking-[0.32em] text-[color:var(--color-bold-yellow)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          <T en="Your impact" es="Tu impacto" />
        </span>
        <span
          className="font-bold uppercase tracking-[0.28em] text-[color:var(--color-warm-gray-lt)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          <T
            en={`Since ${memberSinceLabel}`}
            es={`Desde ${memberSinceLabel}`}
          />
        </span>
      </div>

      <h2
        className="relative mb-8 font-bold uppercase leading-[0.9] tracking-[-0.025em] text-[color:var(--color-brisky-cream)]"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "var(--display-xl)",
        }}
      >
        {isZero ? (
          lang === "es" ? (
            <>
              Tu historia{" "}
              <em className="not-italic text-[color:var(--color-bold-yellow)]">
                empieza aquí.
              </em>
            </>
          ) : (
            <>
              Your story{" "}
              <em className="not-italic text-[color:var(--color-bold-yellow)]">
                starts here.
              </em>
            </>
          )
        ) : lang === "es" ? (
          <>
            Hidratación{" "}
            <em className="not-italic text-[color:var(--color-bold-yellow)]">
              con historia.
            </em>
          </>
        ) : (
          <>
            Hydration{" "}
            <em className="not-italic text-[color:var(--color-bold-yellow)]">
              has history.
            </em>
          </>
        )}
      </h2>

      <div className="relative grid grid-cols-1 gap-7 md:grid-cols-3 md:gap-10">
        <Stat
          value={boxesReceived}
          unit={t({
            en: boxesReceived === 1 ? "Box delivered" : "Boxes delivered",
            es: boxesReceived === 1 ? "Caja entregada" : "Cajas entregadas",
          })}
          caption={t({
            en: isZero ? "Your first box ships soon." : "Each one a routine reset.",
            es: isZero ? "Tu primera caja sale pronto." : "Cada una, una rutina renovada.",
          })}
        />
        <Stat
          value={sachetsConsumed}
          unit={t({ en: "Sachets stacked", es: "Sobres acumulados" })}
          caption={t({
            en: "1,000mg electrolytes each. Counting still.",
            es: "1.000mg de electrolitos cada uno. Y subiendo.",
          })}
        />
        <Stat
          value={monthsAsMember}
          unit={t({
            en: monthsAsMember === 1 ? "Month inside" : "Months inside",
            es: monthsAsMember === 1 ? "Mes dentro" : "Meses dentro",
          })}
          caption={t({
            en: isZero ? "Just landed. Welcome." : "Routine over willpower.",
            es: isZero ? "Recién llegada. Bienvenida." : "Rutina sobre fuerza de voluntad.",
          })}
        />
      </div>
    </section>
  );
}

function Stat({
  value,
  unit,
  caption,
}: {
  value: number;
  unit: string;
  caption: string;
}) {
  const counterRef = useCounterUp(value);
  return (
    <div className="grid gap-2 border-t border-[color:var(--color-bold-yellow)]/25 pt-4">
      <span
        ref={counterRef}
        className="block font-bold leading-[0.85] tracking-[-0.04em] tabular-nums text-[color:var(--color-brisky-cream)]"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(3.5rem, 14vw, 6rem)",
        }}
      >
        {value}
      </span>
      <span
        className="font-bold uppercase tracking-[0.28em] text-[color:var(--color-bold-yellow)]"
        style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
      >
        {unit}
      </span>
      <span className="max-w-[22ch] text-[13px] leading-[1.45] text-[color:var(--color-warm-gray-lt)]">
        {caption}
      </span>
    </div>
  );
}

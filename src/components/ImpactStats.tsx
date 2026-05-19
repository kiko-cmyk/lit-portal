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
 * Editorial-style "Tu impacto" banner — three counter-up stats sourced
 * from data we already have (boxes shipped + member-since). No new
 * functionality: just visualises what we already know about the customer.
 *
 * Animates in once when scrolled into view (IntersectionObserver via
 * useReveal). The numbers count up independently via useCounterUp.
 */
export function ImpactStats({ boxesReceived, memberSince }: ImpactStatsProps) {
  const t = useLang();
  const lang = useLangValue();
  const ref = useReveal<HTMLElement>();

  const sachetsConsumed = boxesReceived * 30;
  const monthsAsMember = Math.max(
    1,
    Math.floor(
      (Date.now() - new Date(memberSince).getTime()) /
        (1000 * 60 * 60 * 24 * 30),
    ),
  );

  const dateLocale = lang === "es" ? "es-ES" : "en-US";
  const memberSinceLabel = new Date(memberSince).toLocaleDateString(
    dateLocale,
    { month: "long", year: "numeric" },
  );

  return (
    <section
      ref={ref}
      className="reveal mx-6 mt-6 overflow-hidden rounded-2xl bg-[color:var(--color-lit-grey)] px-6 py-7 text-[color:var(--color-brisky-cream)] md:mx-0 md:px-8"
    >
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-[color:var(--color-bold-yellow)]">
          <T en="Your impact" es="Tu impacto" />
        </span>
        <span className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-warm-gray-lt)]">
          <T
            en={`Since ${memberSinceLabel}`}
            es={`Desde ${memberSinceLabel}`}
          />
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 md:gap-6">
        <Stat
          value={boxesReceived}
          label={t({
            en: boxesReceived === 1 ? "Box received" : "Boxes received",
            es: boxesReceived === 1 ? "Caja recibida" : "Cajas recibidas",
          })}
        />
        <Stat
          value={sachetsConsumed}
          label={t({ en: "Sachets in", es: "Sobres dentro" })}
        />
        <Stat
          value={monthsAsMember}
          label={t({
            en: monthsAsMember === 1 ? "Month strong" : "Months strong",
            es: monthsAsMember === 1 ? "Mes fuerte" : "Meses fuerte",
          })}
        />
      </div>
    </section>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  const counterRef = useCounterUp(value);
  return (
    <div>
      <span
        ref={counterRef}
        className="block font-display text-[42px] font-black leading-none tracking-[-0.04em] tabular-nums text-[color:var(--color-bold-yellow)] md:text-[56px]"
      >
        {value}
      </span>
      <span className="mt-2 block text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray-lt)]">
        {label}
      </span>
    </div>
  );
}

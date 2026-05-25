"use client";

import { T, useLang, useLangValue } from "@/lib/i18n";
import type { TimelineEntry } from "@/lib/types";

interface TimelineProps {
  past: TimelineEntry[];
  nextShipDate: Date | null;
  nextBoxNumber: number | null;
  nextFlavor: string;
}

/**
 * Horizontal strip of timeline cards — last N delivered + next upcoming.
 * Matches `.timeline` in the Hub hi-fi: 140px wide cards, status pill,
 * 18px date, flavor sub. The "next" card is yellow-bordered.
 */
export function Timeline({
  past,
  nextShipDate,
  nextBoxNumber,
  nextFlavor,
}: TimelineProps) {
  const t = useLang();
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  const cards: Array<{
    key: string;
    status: "delivered" | "next" | "shipped";
    date: string;
    flavor: string;
  }> = past.map((entry) => {
    const d = entry.deliveredAt
      ? new Date(entry.deliveredAt)
      : entry.shippedAt
        ? new Date(entry.shippedAt)
        : null;
    return {
      key: entry.shipmentId,
      status: entry.status === "delivered" ? "delivered" : "shipped",
      date: d
        ? d.toLocaleDateString(dateLocale, { month: "short", day: "numeric" }).toUpperCase()
        : "—",
      flavor: `${nextFlavor} · #${entry.boxNumber}`,
    };
  });

  if (nextShipDate) {
    cards.push({
      key: "next",
      status: "next",
      date: nextShipDate.toLocaleDateString(dateLocale, { month: "short", day: "numeric" }).toUpperCase(),
      flavor: `${nextFlavor} · #${nextBoxNumber ?? "—"}`,
    });
  }

  if (cards.length === 0) return null;

  return (
    <section className="mt-2">
      <div className="section-label mx-6 mb-2.5 flex items-center justify-between md:mx-0">
        <span>
          <T en="Timeline" es="Historial" />
        </span>
        <span className="text-[color:var(--color-lit-grey)] font-extrabold">
          <T en="Last + next" es="Últimos + próximo" />
        </span>
      </div>

      <div className="flex gap-3 overflow-x-auto px-6 pb-2 [scrollbar-width:none] md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden">
        {cards.map((c) => (
          <div
            key={c.key}
            className={`flex-shrink-0 basis-[140px] rounded-[10px] border p-3.5 ${
              c.status === "next"
                ? "border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/[0.08]"
                : c.status === "delivered"
                  ? "border-[color:var(--color-lit-grey)]/6 bg-[color:var(--color-sharp-white)] opacity-70"
                  : "border-[color:var(--color-lit-grey)]/6 bg-[color:var(--color-sharp-white)]"
            }`}
          >
            <span
              className={`mb-1.5 inline-block rounded-[2px] px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-[0.2em] ${
                c.status === "next"
                  ? "bg-[color:var(--color-bold-yellow)] text-[color:var(--color-lit-grey)]"
                  : c.status === "delivered"
                    ? "bg-[color:var(--color-success)] text-[color:var(--color-cream)]"
                    : "bg-[color:var(--color-lit-grey)]/15 text-[color:var(--color-lit-grey)]"
              }`}
            >
              {c.status === "next" ? (
                t({ en: "Next", es: "Próxima" })
              ) : c.status === "delivered" ? (
                t({ en: "Delivered", es: "Entregada" })
              ) : (
                t({ en: "Shipped", es: "Enviada" })
              )}
            </span>
            <div className="font-display text-[18px] font-black leading-none tracking-[-0.01em] text-[color:var(--color-lit-grey)]">
              {c.date}
            </div>
            <div className="mt-1 text-[11px] text-[color:var(--color-warm-gray)]">
              {c.flavor}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

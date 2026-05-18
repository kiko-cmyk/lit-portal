"use client";

import { T, useLang, useLangValue } from "@/lib/i18n";
import type { UpcomingShipment } from "@/lib/types";

interface DeliveryCalendarProps {
  /**
   * Next shipment Seal has scheduled. Rendered as the first row, highlighted
   * yellow. Comes straight from `subscription.nextShipDate` so it lines up
   * with the hero card above.
   */
  nextShipDate: Date | null;
  nextBoxNumber: number | null;
  /** All upcoming shipments AFTER the next one (Seal's pre-scheduled queue). */
  upcoming: UpcomingShipment[];
}

/**
 * Vertical list of upcoming shipments. Seal typically pre-schedules 5–6 so
 * the customer sees the next ~6 months of deliveries laid out clearly.
 *
 * The first row (next ship) is highlighted yellow with a "PRÓXIMA" pill;
 * the rest are plain.
 */
export function DeliveryCalendar({
  nextShipDate,
  nextBoxNumber,
  upcoming,
}: DeliveryCalendarProps) {
  const t = useLang();
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  const rows: Array<{
    key: string;
    date: Date;
    boxNumber: number;
    isNext: boolean;
  }> = [];
  if (nextShipDate) {
    rows.push({
      key: "next",
      date: nextShipDate,
      boxNumber: nextBoxNumber ?? 1,
      isNext: true,
    });
  }
  upcoming.forEach((u) => {
    rows.push({
      key: u.date,
      date: new Date(u.date),
      boxNumber: u.boxNumber,
      isNext: false,
    });
  });

  if (rows.length === 0) return null;

  return (
    <section className="mx-6 mt-5 md:mx-0">
      <div className="section-label mb-3 flex items-center justify-between">
        <span>
          <T en="Upcoming deliveries" es="Próximas entregas" />
        </span>
        <span className="font-extrabold text-[color:var(--color-lit-grey)]">
          {rows.length}{" "}
          {rows.length === 1
            ? t({ en: "scheduled", es: "programada" })
            : t({ en: "scheduled", es: "programadas" })}
        </span>
      </div>
      <ol className="overflow-hidden rounded-2xl border border-[color:var(--color-lit-grey)]/5 bg-[color:var(--color-sharp-white)]">
        {rows.map((r) => {
          const day = r.date
            .toLocaleDateString(dateLocale, { day: "numeric" })
            .toUpperCase();
          const monthShort = r.date
            .toLocaleDateString(dateLocale, { month: "short" })
            .toUpperCase()
            .replace(".", "");
          const weekday = r.date.toLocaleDateString(dateLocale, {
            weekday: "long",
          });
          return (
            <li
              key={r.key}
              className={`flex items-center gap-4 border-b border-[color:var(--color-lit-grey)]/5 px-5 py-3.5 last:border-b-0 ${
                r.isNext ? "bg-[color:var(--color-bold-yellow)]/15" : ""
              }`}
            >
              <div
                className={`flex h-[52px] w-[52px] flex-shrink-0 flex-col items-center justify-center rounded-lg text-center ${
                  r.isNext
                    ? "bg-[color:var(--color-bold-yellow)] text-[color:var(--color-lit-grey)]"
                    : "bg-[color:var(--color-brisky-cream)]/60 text-[color:var(--color-lit-grey)]"
                }`}
              >
                <span className="font-display text-[20px] font-black leading-none tracking-[-0.02em]">
                  {day}
                </span>
                <span className="mt-0.5 text-[8px] font-bold uppercase tracking-[0.2em] opacity-80">
                  {monthShort}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold capitalize text-[color:var(--color-lit-grey)]">
                  {weekday}
                </div>
                <div className="text-[11px] text-[color:var(--color-warm-gray)]">
                  <T en={`Box #${r.boxNumber}`} es={`Caja #${r.boxNumber}`} />
                </div>
              </div>
              {r.isNext && (
                <span className="rounded-[2px] bg-[color:var(--color-lit-grey)] px-2 py-1 text-[9px] font-extrabold uppercase tracking-[0.18em] text-[color:var(--color-bold-yellow)]">
                  <T en="Next" es="Próxima" />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

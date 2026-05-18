"use client";

import { T, useLangValue } from "@/lib/i18n";
import type { UpcomingShipment } from "@/lib/types";

interface DeliveryCalendarProps {
  /**
   * Next shipment Seal has scheduled. Rendered as the first tile, highlighted
   * yellow with a "PRÓXIMA" tag. Comes from `subscription.nextShipDate`.
   */
  nextShipDate: Date | null;
  /**
   * All upcoming shipments AFTER the next one (Seal's pre-scheduled queue).
   * Sorted ascending by date.
   */
  upcoming: UpcomingShipment[];
}

/**
 * Visual calendar strip of upcoming deliveries. Horizontal scroll-snap so a
 * customer with 6+ shipments can sweep through them without the section
 * dominating the page.
 *
 * Each tile shows only what matters: month, day, weekday. No "Caja #N" — the
 * subscriber doesn't think in box counters; they think "when does the next
 * one arrive". The first tile gets a yellow card and a "PRÓXIMA" tag; the
 * rest stay neutral.
 */
export function DeliveryCalendar({
  nextShipDate,
  upcoming,
}: DeliveryCalendarProps) {
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  const tiles: Array<{ key: string; date: Date; isNext: boolean }> = [];
  if (nextShipDate) {
    tiles.push({ key: "next", date: nextShipDate, isNext: true });
  }
  upcoming.forEach((u) => {
    tiles.push({ key: u.date, date: new Date(u.date), isNext: false });
  });

  if (tiles.length === 0) return null;

  return (
    <section className="mt-6">
      <div className="section-label mx-6 mb-3 md:mx-0">
        <T en="Upcoming deliveries" es="Próximas entregas" />
      </div>

      <div className="flex gap-2.5 overflow-x-auto px-6 pb-2 [scroll-snap-type:x_mandatory] [scrollbar-width:none] md:px-0 [&::-webkit-scrollbar]:hidden">
        {tiles.map((tile) => (
          <DateTile
            key={tile.key}
            date={tile.date}
            dateLocale={dateLocale}
            isNext={tile.isNext}
          />
        ))}
      </div>
    </section>
  );
}

function DateTile({
  date,
  dateLocale,
  isNext,
}: {
  date: Date;
  dateLocale: string;
  isNext: boolean;
}) {
  const day = date.toLocaleDateString(dateLocale, { day: "numeric" });
  const monthShort = date
    .toLocaleDateString(dateLocale, { month: "short" })
    .toUpperCase()
    .replace(".", "");
  const weekdayShort = date
    .toLocaleDateString(dateLocale, { weekday: "short" })
    .toUpperCase()
    .replace(".", "");

  return (
    <div
      className={`flex h-[124px] w-[88px] flex-shrink-0 flex-col items-center justify-between rounded-xl border px-2 py-3 [scroll-snap-align:start] ${
        isNext
          ? "border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/30"
          : "border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-sharp-white)]"
      }`}
    >
      <div className="text-[9px] font-extrabold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
        {monthShort}
      </div>
      <div className="font-display text-[40px] font-black leading-none tracking-[-0.04em] text-[color:var(--color-lit-grey)]">
        {day}
      </div>
      {isNext ? (
        <span className="rounded-[2px] bg-[color:var(--color-lit-grey)] px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)]">
          <T en="Next" es="Próxima" />
        </span>
      ) : (
        <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-[color:var(--color-warm-gray)]">
          {weekdayShort}
        </div>
      )}
    </div>
  );
}

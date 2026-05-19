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
 * Visual calendar of upcoming deliveries. Per Juan 2026-05-18: full width
 * inside the section container, more visual punch than the v1 strip.
 *
 * Layout: horizontal scroll-snap on mobile so it fills the screen and
 * scrolls naturally; equal-column grid (max 6 tiles) on md+ so the whole
 * year-or-so of upcoming ships is visible at once without scrolling.
 *
 * Each tile is taller and the day number renders in Clash Display
 * clamp(2.4–3.6rem) so the date is the centre of gravity.
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

  // Cap visible-at-once on desktop to keep tile width readable.
  // 6 tiles in a single row at md+; mobile scrolls horizontally.
  const desktopCols = Math.min(6, tiles.length) || 1;

  return (
    <section className="mx-6 md:mx-0">
      {/* Mobile: horizontal scroll-snap. Hidden on md+. */}
      <div className="flex gap-2.5 overflow-x-auto pb-1 [scroll-snap-type:x_mandatory] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">
        {tiles.map((tile) => (
          <div key={tile.key} className="w-[110px] flex-shrink-0">
            <DateTile date={tile.date} dateLocale={dateLocale} isNext={tile.isNext} />
          </div>
        ))}
      </div>
      {/* Desktop: full-width grid. Up to 6 tiles in one row. */}
      <div
        className="hidden gap-3 md:grid"
        style={{ gridTemplateColumns: `repeat(${desktopCols}, minmax(0, 1fr))` }}
      >
        {tiles.slice(0, 6).map((tile) => (
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
  // Redesign 2026-05-18 round 4: drop the mega day number — too brusque.
  // Show a tear-off receipt feel instead: weekday eyebrow on top,
  // "1 jun" in a medium display weight (no shouting), year muted below.
  const day = date.toLocaleDateString(dateLocale, { day: "numeric" });
  const monthShort = date
    .toLocaleDateString(dateLocale, { month: "short" })
    .replace(".", "");
  const weekdayLong = date
    .toLocaleDateString(dateLocale, { weekday: "long" });
  const year = date.getFullYear();

  return (
    <div
      className={`relative flex h-[124px] min-w-[96px] flex-col items-stretch justify-between rounded-2xl px-4 py-4 transition-all duration-200 ease-out hover:-translate-y-1 [scroll-snap-align:start] ${
        isNext
          ? "bg-[color:var(--color-bold-yellow)] text-[color:var(--color-lit-grey)] hover:shadow-[0_18px_30px_-14px_rgba(235,238,98,0.7)]"
          : "border border-[color:var(--color-lit-grey)]/12 bg-[color:var(--color-sharp-white)] text-[color:var(--color-lit-grey)] hover:border-[color:var(--color-bold-yellow)]/45 hover:shadow-[0_12px_24px_-14px_rgba(50,55,67,0.3)]"
      }`}
    >
      {/* Top: weekday OR "Próxima" tag for the next tile */}
      {isNext ? (
        <span
          className="self-start rounded-full bg-[color:var(--color-lit-grey)] px-2 py-0.5 font-semibold uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 9 }}
        >
          <T en="Next" es="Próxima" />
        </span>
      ) : (
        <span
          className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          {weekdayLong}
        </span>
      )}

      {/* Middle: day + month, medium display weight (no shouty mega) */}
      <div className="leading-none">
        <span
          className="font-semibold tracking-[-0.015em]"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
          }}
        >
          {day}
        </span>
        <span
          className="ml-1.5 font-semibold uppercase"
          style={{
            fontFamily: "var(--font-cond)",
            fontSize: 12,
            letterSpacing: "0.18em",
            color: isNext
              ? "var(--color-lit-grey)"
              : "var(--color-warm-gray)",
          }}
        >
          {monthShort}
        </span>
      </div>

      {/* Bottom: muted year + weekday short on the next tile */}
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="font-semibold uppercase tracking-[0.2em]"
          style={{
            fontFamily: "var(--font-cond)",
            fontSize: 9,
            color: isNext
              ? "rgba(50, 55, 67, 0.7)"
              : "rgba(122, 116, 106, 0.7)",
          }}
        >
          {year}
        </span>
        {isNext && (
          <span
            className="font-semibold uppercase tracking-[0.2em]"
            style={{
              fontFamily: "var(--font-cond)",
              fontSize: 9,
              color: "rgba(50, 55, 67, 0.7)",
            }}
          >
            {weekdayLong}
          </span>
        )}
      </div>
    </div>
  );
}

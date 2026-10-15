"use client";

import { CardTitle, Lp2Card } from "@/components/Lp2";
import { frequencyLabel } from "@/lib/frequency-label";
import { useLang, useLangValue } from "@/lib/i18n";
import type { Frequency, UpcomingShipment } from "@/lib/types";

interface DeliveryCalendarProps {
  /**
   * Next shipment Seal has scheduled. Rendered first and highlighted in yellow.
   * Comes from `subscription.nextShipDate`.
   */
  nextShipDate: Date | null;
  /**
   * All upcoming shipments AFTER the next one (Seal's pre-scheduled queue).
   * Sorted ascending by date.
   */
  upcoming: UpcomingShipment[];
  /** Para la etiqueta «Cada 5 meses» de la cabecera. */
  frequency?: Frequency;
}

/** Fechas que se enseñan, como hasta ahora: la próxima y cinco más. */
const MAX_DATES = 6;

/**
 * «Próximos envíos», rediseño lp2 (Juan 2026-10-13).
 *
 * Móvil: una agenda, una fila por envío con el día grande y el mes al lado; la
 * primera en lima. Escritorio: seis fichas de fecha en fila (tres por fila entre
 * md y lg), la primera también en lima. Antes fue una línea de tiempo fina y
 * Juan la vio «sosa»; luego llevó una píldora «Tu próximo LIT» en la ficha lima
 * y la quitó: el color ya dice cuál es la próxima (el mismo criterio que el
 * 2026-05-18).
 *
 * Las fechas NO son pulsables: solo se puede saltar o adelantar la próxima, y
 * eso vive en «Gestiona tu plan».
 */
export function DeliveryCalendar({ nextShipDate, upcoming, frequency }: DeliveryCalendarProps) {
  const lang = useLangValue();
  const t = useLang();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  const dates: Array<{ key: string; date: Date; isNext: boolean }> = [];
  if (nextShipDate) dates.push({ key: "next", date: nextShipDate, isNext: true });
  upcoming.forEach((u) => dates.push({ key: u.date, date: new Date(u.date), isNext: false }));
  const shown = dates.slice(0, MAX_DATES);
  if (shown.length === 0) return null;

  return (
    <div className="mx-6 md:mx-0">
      <Lp2Card>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <CardTitle thin={t({ en: "Upcoming", es: "Próximos" })} bold={t({ en: "deliveries", es: "envíos" })} />
          {frequency && (
            <p className="m-0 text-[9.5px] font-bold uppercase tracking-[0.18em] text-[#8C8E87] md:text-[10.5px]">
              {frequencyLabel(frequency, lang, { format: "long" })}
            </p>
          )}
        </div>

        {/* Móvil: agenda. */}
        <ol className="m-0 mt-[18px] list-none p-0 md:hidden">
          {shown.map((d, i) => (
            <li
              key={d.key}
              className={`flex items-center gap-3.5 px-3.5 ${
                d.isNext
                  ? "rounded-[16px] bg-[color:var(--color-bold-yellow)] py-[13px]"
                  : `py-3 ${i < shown.length - 1 ? "border-b border-[#2F343D]/12" : ""}`
              }`}
            >
              <span className="flex w-[84px] flex-none items-baseline gap-[5px]">
                <span className={`font-display font-semibold leading-none ${d.isNext ? "text-[30px]" : "text-[26px]"}`}>
                  {d.date.getDate()}
                </span>
                <span className={`font-display font-light uppercase tracking-[0.04em] ${d.isNext ? "text-[16px]" : "text-[15px]"}`}>
                  {monthShort(d.date, dateLocale)}
                </span>
              </span>
              <span
                className={`text-[9.5px] font-bold uppercase tracking-[0.18em] ${
                  d.isNext ? "text-[#2F343D]/75" : "text-[#8C8E87]"
                }`}
              >
                {d.date.toLocaleDateString(dateLocale, { weekday: "long" })} · {d.date.getFullYear()}
              </span>
            </li>
          ))}
        </ol>

        {/* Escritorio: fichas. */}
        <ol className="m-0 mt-[22px] hidden list-none grid-cols-3 gap-3 p-0 md:grid lg:grid-cols-6">
          {shown.map((d) => (
            <li
              key={d.key}
              className={`flex flex-col rounded-[20px] px-[18px] pt-[18px] pb-5 ${
                d.isNext
                  ? "bg-[color:var(--color-bold-yellow)] shadow-[0_14px_28px_-18px_rgba(120,122,20,0.55)]"
                  : "border border-[#2F343D]/[0.07] bg-white shadow-[0_12px_26px_-18px_rgba(40,34,20,0.35)]"
              }`}
            >
              <span
                className={`text-[9.5px] font-bold uppercase tracking-[0.18em] ${
                  d.isNext ? "text-[#2F343D]/75" : "text-[#8C8E87]"
                }`}
              >
                {d.date.toLocaleDateString(dateLocale, { weekday: "long" })}
              </span>
              <span className="mt-3.5 flex items-baseline gap-1.5">
                <span className={`font-display font-semibold leading-none ${d.isNext ? "text-[44px]" : "text-[40px]"}`}>
                  {d.date.getDate()}
                </span>
                <span
                  className={`font-display uppercase tracking-[0.04em] ${
                    d.isNext ? "text-[20px] font-medium" : "text-[19px] font-light"
                  }`}
                >
                  {monthShort(d.date, dateLocale)}
                </span>
              </span>
              <span
                className={`mt-2 text-[9.5px] font-bold tracking-[0.18em] ${
                  d.isNext ? "text-[#2F343D]/75" : "text-[#8C8E87]"
                }`}
              >
                {d.date.getFullYear()}
              </span>
            </li>
          ))}
        </ol>
      </Lp2Card>
    </div>
  );
}

function monthShort(d: Date, locale: string): string {
  return d.toLocaleDateString(locale, { month: "short" }).replace(".", "");
}

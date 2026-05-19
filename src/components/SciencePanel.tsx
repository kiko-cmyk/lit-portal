"use client";

import { T } from "@/lib/i18n";
import { useReveal } from "@/lib/use-reveal";

/**
 * Static brand-education banner — three claims about what's in a LIT
 * sachet. Pure messaging, no data fetching, no new functionality. Lives
 * near the bottom of the Hub so the reader closes the page with the
 * brand story reinforced.
 *
 * Values match the confirmation email + Klaviyo templates so we stay
 * consistent across surfaces.
 */
export function SciencePanel() {
  const ref = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      className="reveal mx-6 mt-6 overflow-hidden rounded-2xl border border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-sharp-white)] px-6 py-6 md:mx-0 md:px-8"
    >
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-[color:var(--color-warm-gray)]">
          <T en="In every sachet" es="En cada sobre" />
        </span>
        <span className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]">
          <T en="The formula" es="La fórmula" />
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 md:gap-6">
        <Claim
          number="1000"
          unit="MG"
          labelEn="Electrolytes"
          labelEs="Electrolitos"
        />
        <Claim
          number="0"
          unit="G"
          labelEn="Sugar. Ever."
          labelEs="Azúcar. Nunca."
        />
        <Claim
          number="72"
          unit={null}
          unitLabelEn="Trace"
          unitLabelEs="Trazas"
          labelEn="Minerals from sea salt"
          labelEs="Minerales de sal marina"
        />
      </div>
    </section>
  );
}

function Claim({
  number,
  unit,
  unitLabelEn,
  unitLabelEs,
  labelEn,
  labelEs,
}: {
  number: string;
  unit: string | null;
  unitLabelEn?: string;
  unitLabelEs?: string;
  labelEn: string;
  labelEs: string;
}) {
  return (
    <div>
      <div className="font-display text-[34px] font-black leading-none tracking-[-0.04em] text-[color:var(--color-lit-grey)] md:text-[44px]">
        {number}
      </div>
      <div className="mt-1 text-[10px] font-extrabold uppercase tracking-[0.2em] text-[color:var(--color-warm-gray)]">
        {unit ? unit : <T en={unitLabelEn ?? ""} es={unitLabelEs ?? ""} />}
      </div>
      <div className="mt-3 text-[11px] leading-[1.35] text-[color:var(--color-warm-gray)]">
        <T en={labelEn} es={labelEs} />
      </div>
    </div>
  );
}

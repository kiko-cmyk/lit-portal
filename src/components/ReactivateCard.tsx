"use client";

import { T } from "@/lib/i18n";

interface ReactivateCardProps {
  dropsHeld?: number;
  dropsHeldDays?: number;
  cardsKept?: number;
  onReactivate: () => void;
  /** Disables the CTA and swaps the label while reactivation is in flight. */
  busy?: boolean;
}

/**
 * Post-cancel state: replaces NextBoxHero when subscription.status is
 * post_cancel or expired. Dark gradient card with reactivation CTA.
 *
 * Mirrors `.reactivate-card` in the Hub hi-fi.
 */
export function ReactivateCard({
  dropsHeld,
  dropsHeldDays,
  cardsKept,
  onReactivate,
  busy,
}: ReactivateCardProps) {
  return (
    <section
      className="relative mx-6 mt-2 overflow-hidden rounded-2xl px-6 py-7 text-center text-[color:var(--color-cream)] md:mx-0"
      style={{
        background:
          "linear-gradient(135deg, var(--color-lit-grey), var(--color-dark-indigo))",
      }}
    >
      <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-[color:var(--color-bold-yellow)]">
        <T en="Come back any time" es="Vuelve cuando quieras" />
      </div>
      <h2 className="mt-2.5 font-display text-[32px] font-black leading-[0.92] tracking-[-0.02em] uppercase">
        <T en="Your drops" es="Tus drops" />
        <br />
        <T en="are waiting." es="te esperan." />
      </h2>
      {(dropsHeld !== undefined || cardsKept !== undefined) && (
        <p className="mt-2.5 text-[13px] leading-[1.5] text-[color:var(--color-warm-gray-lt)]">
          {dropsHeld !== undefined && dropsHeldDays !== undefined && (
            <>
              <T
                en={`${dropsHeld} drops held ${dropsHeldDays} more days. `}
                es={`${dropsHeld} drops guardados ${dropsHeldDays} días más. `}
              />
            </>
          )}
          {cardsKept !== undefined && (
            <T
              en={`${cardsKept} cards still yours.`}
              es={`${cardsKept} cartas aún tuyas.`}
            />
          )}
        </p>
      )}
      <button
        type="button"
        onClick={onReactivate}
        disabled={busy}
        className="mt-5 rounded-[2px] bg-[color:var(--color-bold-yellow)] px-7 py-3.5 text-[11px] font-black uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] disabled:opacity-60"
      >
        {busy ? (
          <T en="Reactivating…" es="Reactivando…" />
        ) : (
          <T en="Reactivate" es="Reactivar" />
        )}
      </button>
    </section>
  );
}

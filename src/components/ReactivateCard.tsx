"use client";

import { T } from "@/lib/i18n";

interface ReactivateCardProps {
  /**
   * `cancelled` (default) is the post-cancel state with the 90-day Drops hold.
   * `paused` is the resume state: no hold, no Drops countdown, different copy.
   * Pauses only ever came from Seal's own portal, so a paused customer has no
   * idea our portal exists — the copy has to make the way back obvious.
   */
  variant?: "cancelled" | "paused";
  dropsHeld?: number;
  dropsHeldDays?: number;
  cardsKept?: number;
  onReactivate: () => void;
  /** Disables the CTA and swaps the label while reactivation is in flight. */
  busy?: boolean;
  /**
   * Inline error from a failed reactivation attempt. Rendered inside the
   * card so a transient failure never replaces the whole Hub with the
   * full-page error state — the customer keeps the button to retry.
   */
  error?: string | null;
}

/**
 * Terminal-ish states: replaces NextBoxHero when the subscription isn't running.
 * Dark gradient card with a single CTA.
 *
 *   - `cancelled` (post_cancel / expired) → reactivate, with the Drops hold.
 *   - `paused` → resume. Added 2026-07-28.
 *
 * Mirrors `.reactivate-card` in the Hub hi-fi.
 */
export function ReactivateCard({
  variant = "cancelled",
  dropsHeld,
  dropsHeldDays,
  cardsKept,
  onReactivate,
  busy,
  error,
}: ReactivateCardProps) {
  const paused = variant === "paused";
  return (
    <section
      className="relative mx-6 mt-2 overflow-hidden rounded-[24px] px-6 py-7 text-center text-[#F2EEE1] md:mx-0"
      style={{
        background:
          "linear-gradient(135deg, var(--color-lit-grey), var(--color-dark-indigo))",
        boxShadow:
          "0 26px 54px -22px rgba(30,24,12,0.5), 0 8px 16px -10px rgba(30,24,12,0.3)",
      }}
    >
      <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-[color:var(--color-bold-yellow)]">
        {paused ? (
          <T en="Paused" es="En pausa" />
        ) : (
          <T en="Come back any time" es="Vuelve cuando quieras" />
        )}
      </div>
      <h2 className="mt-2.5 font-display text-[32px] font-black leading-[0.92] tracking-[-0.02em] uppercase">
        {paused ? (
          <>
            <T en="Pick it up" es="Reanúdala" />
            <br />
            <T en="whenever." es="cuando quieras." />
          </>
        ) : (
          <>
            <T en="Your drops" es="Tus drops" />
            <br />
            <T en="are waiting." es="te esperan." />
          </>
        )}
      </h2>
      {paused && (
        <p className="mt-2.5 text-[13px] leading-[1.5] text-[#b3ab98]">
          <T
            en="Your subscription is paused, so we are not billing you. Resume it and your next box is scheduled from today."
            es="Tu suscripción está en pausa, así que no te estamos cobrando. Reanúdala y tu próxima caja se programa desde hoy."
          />
        </p>
      )}
      {!paused && (dropsHeld !== undefined || cardsKept !== undefined) && (
        <p className="mt-2.5 text-[13px] leading-[1.5] text-[#b3ab98]">
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
      {error && (
        <div className="mx-auto mt-4 max-w-xs rounded-[14px] border border-[color:var(--color-danger)]/40 bg-red-50/10 px-4 py-3 text-xs text-[#ff9b9b]">
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={onReactivate}
        disabled={busy}
        className="mt-5 rounded-full bg-[color:var(--color-bold-yellow)] px-7 py-3.5 text-[11px] font-black uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] disabled:opacity-60"
      >
        {busy ? (
          paused ? (
            <T en="Resuming…" es="Reanudando…" />
          ) : (
            <T en="Reactivating…" es="Reactivando…" />
          )
        ) : paused ? (
          <T en="Resume" es="Reanudar" />
        ) : (
          <T en="Reactivate" es="Reactivar" />
        )}
      </button>
    </section>
  );
}

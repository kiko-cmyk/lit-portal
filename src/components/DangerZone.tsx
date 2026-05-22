"use client";

import { useLangValue } from "@/lib/i18n";

interface DangerZoneProps {
  onCancel: () => void;
  /** Legacy prop, no longer used. Kept so callers don't break. */
  signoutUrl?: string;
}

/**
 * Dark "Zona oscura" footer block. Single CTA: cancel subscription.
 *
 * Sign-out removed 2026-05-22 (Juan): for a personal post-purchase
 * portal, an explicit logout button is friction with no real benefit
 * — customers either stay logged in on their own device or close the
 * tab. Implementing the proper OIDC end_session flow (which would
 * require refresh_token + offline_access scope) wasn't worth it for a
 * feature nobody clicks. The /api/auth/logout endpoint still exists
 * because the cancel done-state uses it to land the customer back on
 * litsalt.com after they've cancelled.
 */
export function DangerZone({ onCancel }: DangerZoneProps) {
  const lang = useLangValue();

  return (
    <section
      className="relative mx-6 mt-14 overflow-hidden rounded-[22px] bg-[color:var(--color-lit-grey)] px-7 pt-8 pb-7 text-[color:var(--color-brisky-cream)] md:mx-0 md:px-10 md:pt-10 md:pb-9"
    >
      {/* Soft yellow corner glow */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(at 90% 100%, rgba(235, 238, 98, 0.22) 0%, transparent 50%)",
        }}
      />

      <h2
        className="relative mb-7 font-semibold uppercase leading-[0.95] tracking-[-0.025em] text-[color:var(--color-brisky-cream)]"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(28px, 7.2vw, 44px)",
        }}
      >
        {lang === "es" ? (
          <>
            ¿Quieres{" "}
            <em className="not-italic text-[color:var(--color-bold-yellow)]">
              salir del círculo
            </em>
            ?
          </>
        ) : (
          <>
            Want to{" "}
            <em className="not-italic text-[color:var(--color-bold-yellow)]">
              leave the circle
            </em>
            ?
          </>
        )}
      </h2>

      <div className="relative">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center rounded-full border border-[color:var(--color-bold-yellow)]/40 px-6 py-3.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-bold-yellow)] transition-colors duration-150 hover:border-[color:var(--color-danger)] hover:text-[#ff9b9b]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
        >
          {lang === "es" ? "Cancelar suscripción" : "Cancel subscription"}
        </button>
      </div>
    </section>
  );
}

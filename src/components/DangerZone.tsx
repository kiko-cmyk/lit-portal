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
      className="relative mx-6 mt-14 overflow-hidden rounded-[20px] border border-[rgba(155,61,61,0.3)] bg-[color:var(--color-sharp-white)] px-7 pt-8 pb-7 text-[color:var(--color-lit-grey)] md:mx-0 md:px-10 md:pt-10 md:pb-9"
      style={{ boxShadow: "0 10px 30px -14px rgba(40,34,20,0.22)" }}
    >
      {/* Soft danger corner glow */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(at 90% 100%, rgba(155, 61, 61, 0.10) 0%, transparent 55%)",
        }}
      />

      <h2
        className="relative mb-7 font-semibold uppercase leading-[0.95] tracking-[-0.025em] text-[color:var(--color-lit-grey)]"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(28px, 7.2vw, 44px)",
        }}
      >
        {lang === "es" ? (
          <>
            ¿Quieres{" "}
            <em className="not-italic text-[color:var(--color-danger)]">
              salir del círculo
            </em>
            ?
          </>
        ) : (
          <>
            Want to{" "}
            <em className="not-italic text-[color:var(--color-danger)]">
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
          className="inline-flex items-center font-semibold uppercase tracking-[0.22em] text-[color:var(--color-danger)] underline decoration-[color:var(--color-danger)]/40 underline-offset-4 transition-colors duration-150 hover:decoration-[color:var(--color-danger)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
        >
          {lang === "es" ? "Cancelar suscripción" : "Cancel subscription"}
        </button>
      </div>
    </section>
  );
}

"use client";

import { useLangValue } from "@/lib/i18n";

interface DangerZoneProps {
  onCancel: () => void;
  /**
   * Optional signout URL (Shopify customer accounts). When provided, a
   * "Cerrar sesión" pill renders linking out. We don't manage portal
   * session ourselves so we delegate to Shopify's logout endpoint.
   */
  signoutUrl?: string;
}

/**
 * Dark "Zona oscura" footer block per the v2 Account proposal. Reserves
 * the cancellation flow as the visual climax of the page: high-contrast
 * dark surface, oversized two-tone headline, pill-shaped action buttons.
 *
 * Only renders actions that are actually wired:
 *   - "Cerrar sesión" (yellow filled) when signoutUrl is passed.
 *   - "Cancelar suscripción" (outline) always, hooked to the existing
 *     CancelTakeover via the onCancel prop.
 * "Pausar suscripción" from the v2 mock is intentionally absent — we
 * don't have a portal pause flow yet, and shipping a button that does
 * nothing is worse than not shipping it.
 */
export function DangerZone({ onCancel, signoutUrl }: DangerZoneProps) {
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

      {/* Eyebrow "Zona oscura" eliminado a petición de Juan 2026-05-19:
          el banner debe entrar directo con el headline, sin etiqueta
          interna duplicada. */}

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

      <div className="relative flex flex-wrap gap-2.5">
        {signoutUrl && (
          <a
            href={signoutUrl}
            className="inline-flex items-center rounded-full bg-[color:var(--color-bold-yellow)] px-6 py-3.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)] transition-transform duration-200 ease-out hover:-translate-y-[2px]"
            style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
          >
            {lang === "es" ? "Cerrar sesión" : "Sign out"}
          </a>
        )}
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

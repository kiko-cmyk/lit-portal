"use client";

import { useLangValue } from "@/lib/i18n";

interface DangerZoneProps {
  onCancel: () => void;
}

/**
 * Dark "Zona oscura" footer block. Single CTA: cancel subscription.
 *
 * Sign-out was removed from here on 2026-05-22 on the reasoning that nobody
 * clicks logout on a personal post-purchase portal. That held for the
 * shared-device case and missed the one that actually happens: customers
 * stuck in the WRONG Shopify account, 25 of them in the two months that
 * followed. It came back on 2026-07-29 as <SwitchAccountRow/> under "Mis
 * datos", as "cerrar sesión o entrar con otro email", and deliberately NOT
 * here: leaving an account is not in the same family as
 * cancelling a subscription, and this block is styled to make you hesitate.
 *
 * The note from 2026-05-22 about needing `refresh_token + offline_access` was
 * also wrong on the facts. Shopify's refresh grant never returns a new
 * id_token and `offline_access` does not exist on this platform; the real
 * mechanism is a `prompt=none` round trip. See docs/AUTH_LOGOUT.md.
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

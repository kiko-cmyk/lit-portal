"use client";

import { T } from "@/lib/i18n";

/**
 * Flavor switch overlay — Phase 1 "coming soon" state.
 *
 * Shown when the customer taps the Flavor quick action on Hub or Account.
 * In Phase 1 there's only one flavor (Lemon Drop). New flavors land June 2026.
 * This overlay teases the upcoming options and explains the wait.
 */

const COMING = [
  { name: "Salty Peach", note: "First drop, June" },
  { name: "Raw", note: "July" },
  { name: "Coming", note: "TBA" },
];

export function FlavorOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-[#0F0E1A]/70 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="zone-cream relative mx-auto w-full max-w-md rounded-t-3xl bg-[color:var(--color-brisky-cream)] px-6 pt-9 pb-8 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-2xl opacity-60"
        >
          ×
        </button>

        <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
          <T en="Flavor" es="Sabor" />
        </div>
        <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none">
          <T en="New flavors" es="Sabores nuevos" />
          <br />
          <T en="land in June" es="llegan en junio" />
          <span className="text-[color:var(--color-bold-yellow)]">.</span>
        </h1>
        <p className="mt-3 text-sm opacity-70">
          <T
            en="Right now everyone's on Lemon Drop. We'll send you a heads-up when each new flavor lands so you can swap."
            es="Ahora mismo todos llevamos Lemon Drop. Te avisaremos cuando llegue cada sabor nuevo para que puedas cambiar."
          />
        </p>

        <ul className="mt-6 space-y-2">
          {COMING.map((f, i) => (
            <li
              key={i}
              className="flex items-center justify-between rounded-2xl bg-[color:var(--color-zesty-beige)] px-5 py-4 opacity-90"
            >
              <span className="font-display text-lg font-black uppercase">{f.name}</span>
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-60">
                {f.note}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-6 text-center text-[10px] uppercase tracking-[0.25em] opacity-50">
          <T en="Stay LIT." es="Stay LIT." />
        </div>
      </div>
    </div>
  );
}

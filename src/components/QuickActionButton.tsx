"use client";

import type { ReactNode } from "react";
import { T } from "@/lib/i18n";

interface QuickActionButtonProps {
  icon: ReactNode;
  label: string;
  sub?: string;
  /**
   * Lo que cambia la acción, en la franja de abajo de la tarjeta (rediseño lp2,
   * Juan 2026-10-13): «20 ENE → HOY» al adelantar, «20 ENE → 20 JUN» al saltar,
   * «4 CAJAS · CADA 5 MESES» en el plan y las cajas en el sabor. Así la tarjeta
   * dice qué va a pasar antes de pulsarla, que es lo que la hacía «sosa».
   */
  state?: ReactNode;
  /** Optional eyebrow (kept for backward compat — Hub no longer uses it). */
  eyebrow?: string;
  /** Forced muted-grey with SOON badge, non-clickable. */
  comingSoon?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

/**
 * Tarjeta de acción del Hub, rediseño lp2: blanca y en relieve sobre la tarjeta
 * crema de «Gestiona tu plan», con el icono en círculo oscuro y trazo lima.
 * En móvil el título va en dos líneas («ADELANTAR / ENVÍO») y en escritorio en
 * una; la flecha en círculo solo aparece en escritorio.
 */
export function QuickActionButton({
  icon,
  label,
  sub,
  state,
  comingSoon,
  onClick,
  disabled,
}: QuickActionButtonProps) {
  const inert = comingSoon || disabled;
  const trimmedLabel = label.trim();
  const spaceIdx = trimmedLabel.indexOf(" ");
  const labelLine1 = spaceIdx === -1 ? trimmedLabel : trimmedLabel.slice(0, spaceIdx);
  const labelLine2 = spaceIdx === -1 ? "" : trimmedLabel.slice(spaceIdx + 1);

  return (
    <button
      type="button"
      onClick={comingSoon ? undefined : onClick}
      disabled={inert}
      aria-disabled={inert}
      className="group relative flex h-full min-h-[196px] w-full cursor-pointer flex-col gap-[9px] rounded-[18px] border border-[#2F343D]/[0.07] bg-white p-3.5 text-left text-[#2F343D] shadow-[0_12px_24px_-18px_rgba(40,34,20,0.35)] transition-all duration-200 ease-out hover:-translate-y-[2px] hover:shadow-[0_16px_30px_-18px_rgba(40,34,20,0.45)] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 md:min-h-[186px] md:gap-2.5 md:rounded-[20px] md:p-[18px]"
    >
      <span className="flex w-full items-center justify-between">
        <span className="flex h-[38px] w-[38px] items-center justify-center rounded-full bg-[#2F343D] text-[color:var(--color-bold-yellow)] md:h-[42px] md:w-[42px]">
          <span className="inline-flex h-[17px] w-[17px] md:h-[18px] md:w-[18px]">{icon}</span>
        </span>
        <span
          aria-hidden
          className="hidden h-[30px] w-[30px] items-center justify-center rounded-full border border-[#2F343D]/15 transition-colors duration-200 group-hover:border-[#2F343D]/40 md:flex"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" />
            <path d="M13 6l6 6-6 6" />
          </svg>
        </span>
      </span>

      {comingSoon && (
        <span
          className="absolute right-3 top-3 rounded-full bg-[#2F343D]/10 px-2 py-0.5 font-semibold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 9 }}
        >
          <T en="Soon" es="Pronto" />
        </span>
      )}

      <span className="mt-0.5 font-display text-[15px] font-semibold uppercase leading-[1.05] tracking-[0.01em] md:mt-1 md:text-[17px]">
        <span className="block md:inline">{labelLine1}</span>
        {labelLine2 && (
          <>
            <span className="hidden md:inline"> </span>
            <span className="block md:inline">{labelLine2}</span>
          </>
        )}
      </span>
      {sub && <span className="text-[12px] leading-[1.4] text-[#5E6168] md:text-[13px] md:leading-[1.45]">{sub}</span>}

      {state && (
        <span className="mt-auto flex w-full flex-wrap items-center gap-[5px] border-t border-dashed border-[#2F343D]/16 pt-2.5 font-display text-[11px] font-semibold uppercase tracking-[0.02em] md:gap-[7px] md:pt-3 md:text-[13px]">
          {state}
        </span>
      )}
    </button>
  );
}

/**
 * «20 ENE → HOY»: de qué fecha a cuál mueve la acción el próximo envío. La
 * flecha va en SVG porque ni Clash ni Barlow traen el glifo «→».
 */
export function DateChange({ from, to }: { from: string; to: string }) {
  return (
    <>
      <span className="text-[#8C8E87]">{from}</span>
      <svg aria-hidden className="h-3 w-3 md:h-3.5 md:w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" />
        <path d="M13 6l6 6-6 6" />
      </svg>
      <span>{to}</span>
    </>
  );
}

export const QAIcons = {
  // Bolt = "instant / now". Distinct from Skip's skip-forward glyph.
  ChargeNow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  ChangePlan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  ),
  Skip: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </svg>
  ),
  Flavor: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 4v16M4 12h16" />
    </svg>
  ),
  Extras: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3" width="22" height="5" />
      <path d="M21 8v13H3V8" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  ),
  Cancel: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  ),
};

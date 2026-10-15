"use client";

import type { ReactNode, Ref } from "react";
import { useLang } from "@/lib/i18n";

/**
 * Contenedor común de los popups del rediseño lp2 (Juan 2026-10-13: «rediseñar
 * los popups de las quick actions, formulario de perfilado y cancelación para
 * que todo tenga un sentido de diseño»).
 *
 * Hoja crema (#EFEEE5, el fondo de las páginas) que sube desde abajo en móvil,
 * con su asa, y que en escritorio flota centrada. El cierre es un botón redondo
 * como el resto de iconos del portal. Mientras hay una petición en curso
 * (`busy`) no se cierra ni pulsando fuera ni con el botón, igual que antes.
 *
 * Las piezas de dentro van con las clases `lp2-*` de globals.css (antetítulo,
 * texto, tarjeta, botón principal con flecha lima, enlace, opciones, campos y
 * avisos).
 */
export function Lp2Sheet({
  onClose,
  busy = false,
  size = "md",
  children,
  className = "",
  /** Contenido pegado arriba a la izquierda (p. ej. la etiqueta «Simulación»). */
  corner,
  /** La hoja es lo que hace scroll: los formularios por pasos la suben al cambiar de paso. */
  panelRef,
}: {
  onClose: () => void;
  busy?: boolean;
  size?: "md" | "lg";
  children: ReactNode;
  className?: string;
  corner?: ReactNode;
  panelRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[#1A1C22]/55 backdrop-blur-[3px] sm:items-center sm:p-6"
      onClick={busy ? undefined : onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={`zone-lp2 relative max-h-[92vh] w-full overflow-y-auto rounded-t-[28px] bg-[#EFEEE5] px-5 pt-10 pb-[max(1.75rem,env(safe-area-inset-bottom,0px))] text-[#2F343D] shadow-[0_-24px_60px_-24px_rgba(26,28,34,0.5)] sm:rounded-[32px] sm:px-8 sm:pt-11 sm:pb-8 ${
          size === "lg" ? "sm:max-w-lg" : "sm:max-w-md"
        } ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span
          aria-hidden
          className="absolute left-1/2 top-2.5 h-1 w-10 -translate-x-1/2 rounded-full bg-[#2F343D]/15 sm:hidden"
        />
        {corner && <div className="absolute left-5 top-4 sm:left-8">{corner}</div>}
        <SheetClose onClose={onClose} disabled={busy} />
        {children}
      </div>
    </div>
  );
}

/** Botón de cierre redondo (también lo usa la cancelación, en oscuro). */
export function SheetClose({
  onClose,
  disabled,
  dark = false,
  className = "absolute right-4 top-4",
}: {
  onClose: () => void;
  disabled?: boolean;
  dark?: boolean;
  className?: string;
}) {
  const t = useLang();
  return (
    <button
      type="button"
      onClick={onClose}
      disabled={disabled}
      aria-label={t({ en: "Close", es: "Cerrar" })}
      className={`${className} z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border transition-colors disabled:opacity-30 ${
        dark
          ? "border-[#F2F1EA]/25 text-[#F2F1EA] hover:border-[#F2F1EA]/60"
          : "border-[#2F343D]/15 bg-white/60 text-[#2F343D] hover:border-[#2F343D]/40"
      }`}
    >
      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M6 6l12 12" />
        <path d="M18 6L6 18" />
      </svg>
    </button>
  );
}

/**
 * Título de popup: dos pesos en una línea, como los de las páginas (Light 300 +
 * Semibold 600), algo más grande porque es lo único que manda en la hoja. Si no
 * cabe, la parte en negrita baja entera.
 */
export function SheetTitle({
  thin,
  bold,
  text,
  className = "mt-2",
  size = "md",
}: {
  thin?: string;
  bold?: string;
  /**
   * Título entero, para los que llegan hechos (copys dinámicos): se parte solo,
   * las dos últimas palabras en negrita y el resto fino («¿SEGURO QUE / QUIERES
   * SALTAR?»). Con `thin`/`bold` se elige el corte a mano.
   */
  text?: string;
  className?: string;
  /** `sm` para títulos-frase largos; `lg` para las pantallas grandes de la cancelación. */
  size?: "sm" | "md" | "lg";
}) {
  if (text !== undefined) {
    const words = text.trim().split(/\s+/);
    if (words.length <= 2) {
      thin = undefined;
      bold = text.trim();
    } else {
      thin = words.slice(0, -2).join(" ");
      bold = words.slice(-2).join(" ");
    }
  }
  return (
    <h1
      className={`font-display uppercase leading-[0.98] tracking-[0.005em] ${
        size === "lg"
          ? "text-[34px] md:text-[56px]"
          : size === "sm"
            ? "text-[24px] sm:text-[28px]"
            : "text-[30px] sm:text-[36px]"
      } ${className}`}
    >
      {thin && (
        <>
          <span className="font-light">{thin}</span>{" "}
        </>
      )}
      <span className="whitespace-nowrap font-semibold">{bold ?? ""}</span>
    </h1>
  );
}

/** Marca de «hecho»: círculo lima con un check, arriba de las pantallas finales. */
export function SheetDoneMark({ dark = false }: { dark?: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--color-bold-yellow)] ${
        dark ? "text-[#1A1C22]" : "text-[#2F343D]"
      }`}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    </span>
  );
}

/** Flecha para los «de → a» (fechas, precios). Ni Clash ni Barlow traen «→». */
export function SheetArrow({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

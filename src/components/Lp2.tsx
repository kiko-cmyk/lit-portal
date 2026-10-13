import type { ReactNode } from "react";

/**
 * Piezas comunes del rediseño lp2 de Suscripción y Cuenta (Juan 2026-10-13,
 * aprobado en el lienzo PRE). El lenguaje sale de la landing «No es cansancio»:
 * tarjetas claras sobre crema, títulos en Clash a dos pesos y en UNA línea.
 */

/** Tarjeta base: #F8F9F2 sobre el crema de `.zone-lp2`, radio 24/28. */
export function Lp2Card({
  children,
  className = "",
  as: Tag = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "article" | "div";
}) {
  return (
    <Tag
      className={`rounded-[24px] border border-[#2F343D]/[0.06] bg-[color:var(--color-sharp-white)] px-5 pt-[22px] pb-5 text-[#2F343D] shadow-[0_22px_44px_-24px_rgba(40,34,20,0.38)] md:rounded-[28px] md:p-[30px] ${className}`}
    >
      {children}
    </Tag>
  );
}

/**
 * Título de tarjeta: dos pesos en UNA sola línea («TU PLAN», «MIS PEDIDOS»).
 * Juan pidió la línea única y un tamaño algo menor que el de la landing, que es
 * más elegante dentro de una tarjeta. Si el texto no cabe (títulos largos en
 * móvil), parte por el espacio entre los dos pesos.
 */
export function CardTitle({
  thin,
  bold,
  as: Tag = "h2",
  className = "",
}: {
  thin: string;
  bold: string;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <Tag
      className={`m-0 font-display text-[28px] uppercase leading-[0.98] tracking-[0.005em] md:text-[38px] ${className}`}
    >
      <span className="font-extralight">{thin}</span>{" "}
      {/* La parte en negrita no se parte: si no cabe, baja entera («¿QUIERES
          SALIR / DEL CÍRCULO?» y no «… DEL / CÍRCULO?»). */}
      <span className="whitespace-nowrap font-semibold">{bold}</span>
    </Tag>
  );
}

/** Etiqueta pequeña en versalitas (los «Cajas por envío», «Miércoles · 2027»…). */
export const capsLabel =
  "font-semibold uppercase tracking-[0.16em] text-[9.5px] text-[#8C8E87]";

/**
 * Cifra con su etiqueta, como en la landing («4 / Cajas por envío»). Las cuatro
 * celdas de «Tu plan» y del hero usan esto.
 */
export function Figure({
  value,
  label,
  className = "",
  size = "md",
}: {
  value: ReactNode;
  label: ReactNode;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={className}>
      <p
        className={`m-0 font-display font-semibold uppercase leading-none ${
          size === "sm" ? "text-[26px]" : "text-[30px] md:text-[34px]"
        }`}
      >
        {value}
      </p>
      <p className={`mt-2 ${capsLabel}`}>{label}</p>
    </div>
  );
}

/**
 * Banda de cierre «POUR IT. MIX IT. GET LIT.» con la fila de sabores calada,
 * como la de la landing. Sustituye a la cinta en movimiento en estas dos
 * pantallas. `compact` recorta el hueco de arriba y abajo cuando detrás viene la
 * invitación a suscribirse (mismo criterio que tenía la cinta).
 */
export function BrandBand({ compact = false }: { compact?: boolean }) {
  return (
    <section
      aria-hidden
      // Los márgenes SE SUMAN al hueco de la columna (16/24 px): 36+16 = 52 en
      // móvil y 64+24 = 88 en escritorio, como en el lienzo aprobado.
      className={`overflow-hidden whitespace-nowrap border-y border-[#2F343D]/12 py-6 md:py-8 ${
        compact ? "mt-4" : "mt-9 md:mt-16"
      }`}
    >
      <div className="pl-5 font-display text-[46px] font-semibold uppercase leading-none tracking-[0.005em] text-[#2F343D] md:pl-12 md:text-[84px]">
        Pour it. Mix it.{" "}
        <span className="rounded-[8px] bg-[color:var(--color-bold-yellow)] px-2.5 md:rounded-[14px] md:px-4">
          Get LIT.
        </span>{" "}
        Pour it. Mix it.
      </div>
      <div
        className="mt-2.5 pl-5 font-display text-[46px] font-light uppercase leading-none tracking-[0.005em] text-transparent md:mt-3 md:pl-12 md:text-[84px]"
        style={{ WebkitTextStroke: "1px rgba(47,52,61,0.5)" }}
      >
        Salty Lemon · Salty Watermelon · Salty Peach
      </div>
    </section>
  );
}

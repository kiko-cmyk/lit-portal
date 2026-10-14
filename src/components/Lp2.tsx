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
 * La parte fina en Light (300), no en Extralight: Juan la quiso «un pelín más
 * gruesa» (2026-10-13), que tan fina no se usa en LIT.
 * Juan pidió la línea única y un tamaño algo menor que el de la landing, que es
 * más elegante dentro de una tarjeta. Si el texto no cabe (títulos largos en
 * móvil), parte por el espacio entre los dos pesos.
 */
export function CardTitle({
  thin,
  bold,
  boldFirst = false,
  as: Tag = "h2",
  className = "",
}: {
  thin: string;
  bold: string;
  /**
   * La negrita delante («PLAN de suscripción», «DATOS personales»: Juan
   * 2026-10-14). Por idioma: en inglés el orden natural cambia («Subscription
   * PLAN»), así que lo decide quien llama.
   */
  boldFirst?: boolean;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  // La parte en negrita no se parte: si no cabe, baja entera («¿QUIERES SALIR /
  // DEL CÍRCULO?» y no «… DEL / CÍRCULO?»).
  const strong = <span className="whitespace-nowrap font-semibold">{bold}</span>;
  const light = <span className="font-light">{thin}</span>;
  return (
    // En móvil, como mucho 28 px y si no, el 6,6 % del ancho: así los títulos
    // largos de Cuenta («HISTORIAL DE PEDIDOS», 312 px a 28) caben en UNA línea
    // también en un móvil de 360 (Juan 2026-10-13: «los titles en 1 fila»).
    <Tag
      className={`m-0 font-display text-[min(28px,6.6vw)] uppercase leading-[0.98] tracking-[0.005em] md:text-[38px] ${className}`}
    >
      {boldFirst ? (
        <>
          {strong} {light}
        </>
      ) : (
        <>
          {light} {strong}
        </>
      )}
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
 * como la «banda cinética» de la landing: de borde a borde y MOVIÉNDOSE (Juan
 * 2026-10-13: «esto se debe mover, ¿no?»). La fila de arriba va hacia la
 * izquierda y la calada hacia la derecha.
 *
 * En la landing la banda se mueve con el scroll (GSAP, `xPercent` 0 → -24),
 * pero allí va a media página. Aquí cierra la página: al final casi no queda
 * recorrido de scroll y apenas se movía, así que va en bucle continuo, como la
 * cinta que sustituye (clases `.lp2-band-row` en globals.css, quieta con
 * «reducir movimiento»). Cada fila lleva el texto cuatro veces y se desplaza
 * media fila por vuelta, para que el empalme no se vea en ninguna pantalla.
 *
 * `compact` recorta el hueco de arriba cuando detrás viene la invitación a
 * suscribirse (mismo criterio que la cinta). Ocupa el ancho de la ventana
 * aunque viva dentro de la columna de la página (`w-screen` + margen
 * negativo); la página corta el desborde con `overflow-x-clip`.
 */
export function BrandBand({ compact = false }: { compact?: boolean }) {
  const row =
    "lp2-band-row flex w-max items-center whitespace-nowrap font-display text-[46px] uppercase leading-none tracking-[0.005em] md:text-[84px]";
  const copies = [0, 1, 2, 3];
  const dot = (
    <span
      aria-hidden
      className="mx-[0.32em] inline-block h-[0.18em] w-[0.18em] flex-none rounded-full bg-[color:var(--color-bold-yellow)] shadow-[0_0_0_1px_rgba(50,55,67,0.25)]"
    />
  );

  return (
    <section
      aria-hidden
      // Los márgenes SE SUMAN al hueco de la columna (16/24 px): 32+16 y 24+24,
      // 48 px en los dos casos, lo mismo que queda DEBAJO de la banda (hasta el
      // final de Suscripción y hasta la baja en Cuenta). Juan 2026-10-13:
      // «mismo espacio arriba que abajo».
      className={`ml-[calc(50%-50vw)] w-screen overflow-hidden border-y border-[#2F343D]/12 py-6 md:py-8 ${
        compact ? "mt-4" : "mt-8 md:mt-6"
      }`}
    >
      <div className={`${row} font-semibold text-[#2F343D]`}>
        {copies.map((i) => (
          <span key={i} className="flex items-center gap-[0.32em] pr-[0.32em]">
            <span>Pour it.</span>
            <span>Mix it.</span>
            <span className="rounded-[8px] bg-[color:var(--color-bold-yellow)] px-2.5 md:rounded-[14px] md:px-4">
              Get LIT.
            </span>
          </span>
        ))}
      </div>
      <div
        className={`${row} lp2-band-row--rev mt-2.5 font-light text-transparent md:mt-3`}
        style={{ WebkitTextStroke: "1px rgba(47,52,61,0.5)" }}
      >
        {copies.map((i) => (
          <span key={i} className="flex items-center">
            <span>Salty Lemon</span>
            {dot}
            <span>Salty Watermelon</span>
            {dot}
            <span>Salty Peach</span>
            {dot}
          </span>
        ))}
      </div>
    </section>
  );
}

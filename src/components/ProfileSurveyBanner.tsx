"use client";

import { T } from "@/lib/i18n";

interface ProfileSurveyBannerProps {
  onStart: () => void;
}

/**
 * Llamada al formulario de perfilado. Vive bajo "Próximos pedidos" en el Hub.
 *
 * ── Por qué NO es una quick action más (Juan, 2026-09-10) ──
 *
 * Nació como una quinta `QuickActionButton` y se veía mal por dos razones. La
 * de forma: cuatro tarjetas llenan la fila en desktop (`md:grid-cols-4`), así
 * que la quinta caía sola en una segunda fila, huérfana y alineada a la
 * izquierda. Y la de fondo, que es la que importa: las otras cuatro
 * ADMINISTRAN la suscripción (adelantar, plan, saltar, sabor) y ésta pide un
 * favor al cliente. Vestirla igual promete lo mismo que las demás y no lo es.
 *
 * Así que se separa del grid y hereda el lenguaje de `ReactivateCard`:
 * gradiente oscuro a ancho completo y un único CTA. En una pantalla de tarjetas
 * claras, la banda oscura dice "esto es otra cosa" sin necesidad de explicarlo.
 * No es un patrón nuevo: es el que el portal ya usa cuando algo no es una
 * acción de rutina.
 *
 * ── Sin mención a los drops (Juan, 2026-09-10) ──
 *
 * El primer borrador encabezaba con "+50 drops" de eyebrow. Fuera: los drops y
 * la Colección no están todavía visibles ni funcionales para el cliente, así
 * que prometer una recompensa que no puede ver ni gastar es una deuda, no un
 * incentivo. El formulario SÍ los paga (`DROPS_AMOUNTS.profile_survey`), y se
 * los encuentra al terminar; simplemente no se anuncian aquí.
 *
 * Cuando los drops se enciendan de cara al cliente, este es el sitio obvio para
 * recuperar ese eyebrow.
 *
 * El copy nombra el beneficio para el CLIENTE (ajustar su suscripción a lo que
 * consume), nunca el nuestro (datos).
 *
 * `mt-10/12` porque no lleva SectionDivider propio, y ese componente es el que
 * pone el aire entre secciones (`mt-14/16`). Sin este margen la banda quedaba
 * pegada al calendario de arriba, como si fuera parte de él.
 *
 * Sin guiones largos en el copy, por la guía de LIT.
 */
export function ProfileSurveyBanner({ onStart }: ProfileSurveyBannerProps) {
  return (
    <section
      className="relative mx-6 mt-10 overflow-hidden rounded-[24px] px-6 py-6 text-[#F2EEE1] md:mx-0 md:mt-12 md:px-8 md:py-7"
      style={{
        background:
          "linear-gradient(135deg, var(--color-lit-grey), var(--color-dark-indigo))",
        boxShadow:
          "0 26px 54px -22px rgba(30,24,12,0.5), 0 8px 16px -10px rgba(30,24,12,0.3)",
      }}
    >
      {/* Halo amarillo muy tenue en la esquina. Mismo recurso que la hero del
          Hub: da profundidad a la banda sin meter una imagen que cargar. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full opacity-[0.13] blur-3xl"
        style={{ background: "var(--color-bold-yellow)" }}
      />

      <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between md:gap-8">
        <div className="min-w-0">
          {/* Mismo tamaño y peso que SectionDivider ("Gestionar mi suscripción",
              "Próximos pedidos"…): clamp 18-22px, Clash Display 600, uppercase,
              tracking -0.01em. Antes iba a 30px y se leía como un titular de
              campaña, más alto en la jerarquía que las secciones que lo rodean.
              Aquí el fondo oscuro ya da todo el contraste que necesita. */}
          <h2
            className="font-semibold uppercase leading-[1] tracking-[-0.01em]"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(18px, 4vw, 22px)",
            }}
          >
            <T en="Tell us about you" es="Cuéntanos sobre ti" />
          </h2>

          {/* El "para qué" en la voz del cliente. Sin esto el banner pide nueve
              respuestas sin decir para qué sirven, que es la forma más rápida de
              que nadie las conteste. */}
          <p className="mt-2.5 max-w-md text-[13px] leading-[1.5] text-[#b3ab98]">
            <T
              en="Nine questions, one minute. We use them to fit your subscription to what you actually drink, so no more boxes piling up."
              es="Nueve preguntas, un minuto. Nos sirven para ajustar tu suscripción a lo que de verdad consumes, y que no se te acumulen las cajas."
            />
          </p>
        </div>

        {/* shrink-0 para que el botón no se comprima cuando el titular es largo
            (el inglés ocupa más), y w-full en móvil para que sea un objetivo
            táctil de ancho completo en vez de un botón perdido a la izquierda. */}
        <button
          type="button"
          onClick={onStart}
          className="w-full shrink-0 rounded-full bg-[color:var(--color-bold-yellow)] px-7 py-3.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] transition-transform duration-200 ease-out hover:-translate-y-[1px] active:translate-y-0 md:w-auto"
        >
          <T en="Start" es="Empezar" />
        </button>
      </div>
    </section>
  );
}

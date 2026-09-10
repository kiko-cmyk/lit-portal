"use client";

import { T } from "@/lib/i18n";

interface ProfileSurveyBannerProps {
  onStart: () => void;
}

/**
 * Los drops que paga el formulario. Va a mano porque `DROPS_AMOUNTS` vive en
 * `lib/drops.ts`, que importa `supabaseAdmin` y por tanto no se puede traer a
 * un componente de cliente. Mismo criterio que `ProfileSurveyOverlay`, que ya
 * escribe la cifra en su CTA.
 *
 * Si algún día cambia el importe hay que tocar los dos sitios. La fuente de
 * verdad para lo que se PAGA sigue siendo `DROPS_AMOUNTS.profile_survey`: esto
 * es solo la promesa en pantalla.
 */
const SURVEY_DROPS = 50;

/**
 * Llamada al formulario de perfilado, bajo las quick actions del Hub.
 *
 * ── Por qué NO es una quick action más (Juan, 2026-09-10) ──
 *
 * Nació como una quinta `QuickActionButton` y se veía mal por dos razones. La
 * de forma: cuatro tarjetas llenan la fila en desktop (`md:grid-cols-4`), así
 * que la quinta caía sola en una segunda fila, huérfana y alineada a la
 * izquierda. Y la de fondo, que es la que importa: las otras cuatro
 * ADMINISTRAN la suscripción (adelantar, plan, saltar, sabor) y ésta pide un
 * favor al cliente a cambio de drops. Vestirla igual promete lo mismo que las
 * demás y no lo es.
 *
 * Así que se separa del grid y hereda el lenguaje de `ReactivateCard`:
 * gradiente oscuro a ancho completo, eyebrow amarillo y un único CTA. En una
 * pantalla de tarjetas claras, la banda oscura dice "esto es otra cosa" sin
 * necesidad de explicarlo. No es un patrón nuevo: es el que el portal ya usa
 * cuando algo no es una acción de rutina.
 *
 * El copy nombra el beneficio para el CLIENTE (ajustar sus envíos), no el
 * nuestro (datos). Los drops van de eyebrow, no de titular: pagan la molestia,
 * no son el motivo, y encabezar con la recompensa se lee como promoción.
 *
 * `mt-3` da aire con las quick actions: pegado a ellas, el salto de tarjeta
 * clara a banda oscura se lee como un borde del propio grid.
 *
 * Sin guiones largos en el copy, por la guía de LIT.
 */
export function ProfileSurveyBanner({ onStart }: ProfileSurveyBannerProps) {
  return (
    <section
      className="relative mx-6 mt-3 overflow-hidden rounded-[24px] px-6 py-6 text-[#F2EEE1] md:mx-0 md:px-8 md:py-7"
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
          <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-[color:var(--color-bold-yellow)]">
            <T en={`+${SURVEY_DROPS} drops`} es={`+${SURVEY_DROPS} drops`} />
          </div>

          <h2 className="mt-2 font-display text-[26px] font-black uppercase leading-[0.95] tracking-[-0.02em] md:text-[30px]">
            <T en="Tell us about you" es="Cuéntanos sobre ti" />
          </h2>

          {/* El "para qué" en la voz del cliente. Sin esto el banner pide nueve
              respuestas sin decir qué gana, y los drops solos suenan a cebo. */}
          <p className="mt-2.5 max-w-md text-[13px] leading-[1.5] text-[#b3ab98]">
            <T
              en="Nine questions, one minute. We use them to fit your deliveries to what you actually drink, so no more boxes piling up."
              es="Nueve preguntas, un minuto. Nos sirven para ajustar tus envíos a lo que de verdad bebes, y que no se te acumulen las cajas."
            />
          </p>
        </div>

        {/* shrink-0 para que el botón no se comprima cuando el titular es largo
            (el inglés ocupa más), y w-full en móvil para que sea un objetivo
            táctil de ancho completo en vez de un botón perdido a la izquierda. */}
        <button
          type="button"
          onClick={onStart}
          className="w-full shrink-0 rounded-full bg-[color:var(--color-bold-yellow)] px-7 py-3.5 text-[11px] font-black uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] transition-transform duration-200 ease-out hover:-translate-y-[1px] active:translate-y-0 md:w-auto"
        >
          <T en="Start" es="Empezar" />
        </button>
      </div>
    </section>
  );
}

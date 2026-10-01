"use client";

import { T } from "@/lib/i18n";
import { MEMBER_PHOTO_DATA_URI } from "@/lib/member-photo";

interface ProfileSurveyBannerProps {
  onStart: () => void;
}

/**
 * Llamada al formulario de perfilado. Vive en CUENTA, bajo las acciones
 * rápidas (Juan 2026-09-15). Estuvo en el Hub hasta esa fecha: se movió porque
 * allí lo alimentaba /api/hub/dashboard, que 404ea sin suscripción viva, así
 * que los pausados y los cancelados no lo veían nunca. Ahora el estado viaja en
 * /api/customer.
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
 * Así que se separa del grid: banda oscura a ancho completo y un único CTA. En
 * una pantalla de tarjetas claras eso dice "esto es otra cosa" sin necesidad de
 * explicarlo. No es un patrón nuevo: es el que el portal ya usa cuando algo no
 * es una acción de rutina.
 *
 * El fondo es el de la antigua tarjeta de socio (negro + foto de marca velada),
 * heredado el 2026-09-15 al pasar el nombre a texto: era la superficie buena y
 * se quedaba sin usar.
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
 * `mb-3` y nada más, igual que cada `Section` de Cuenta: en esa pantalla TODAS
 * las secciones se separan por ese hueco de 12px y el banner es una más. Traía
 * un `mt-10 md:mt-12` de cuando vivía en el Hub, donde el ritmo es otro
 * (`SectionDivider`, 40-48px), y aquí se veía como un agujero encima de la
 * banda. El margen va abajo y no arriba por la misma razón que en `Section`:
 * así el último elemento de la página no arrastra un hueco sobrante.
 *
 * El CTA va en blanco (`sharp-white`) y no en amarillo: sobre la banda oscura el
 * amarillo gritaba más que el propio titular, y este banner pide un favor, no
 * vende nada.
 *
 * Sin guiones largos en el copy, por la guía de LIT.
 */
export function ProfileSurveyBanner({ onStart }: ProfileSurveyBannerProps) {
  return (
    <section
      className="relative isolate mx-6 mb-3 overflow-hidden rounded-[24px] bg-[#16130C] px-6 py-6 text-[#F2EEE1] md:mx-0 md:px-8 md:py-7"
      style={{
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.06) inset, 0 26px 54px -22px rgba(30,24,12,0.5), 0 8px 16px -10px rgba(30,24,12,0.3)",
        isolation: "isolate",
      }}
    >
      {/* Foto de marca velada: el fondo que llevaba la tarjeta de socio hasta
          hoy (Juan 2026-09-15). Al pasar el nombre a texto, esa superficie se
          quedaba sin usar y era la buena; el gradiente índigo que tenía este
          banner era el sustituto, no el original.

          El degradado cierra mucho más que en el hero viejo (.92 → .78 → .55,
          antes .95 → .6 → .35): aquí hay un párrafo de dos líneas por encima, y
          con la foto tan abierta a la derecha aparecía la mancha gris que
          descuadraba la banda. Así la foto se intuye y el texto se lee. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-cover"
        style={{
          backgroundImage: `url(${MEMBER_PHOTO_DATA_URI})`,
          backgroundPosition: "center 32%",
          filter: "grayscale(1)",
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "linear-gradient(100deg, rgba(13,10,6,.92) 30%, rgba(13,10,6,.78) 68%, rgba(13,10,6,.55))",
        }}
      />

      <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between md:gap-8">
        <div className="min-w-0">
          {/* Mismo tamaño y peso que los títulos de Cuenta ("Mis datos", "Mis
              pedidos"…): clamp 16-19px, Clash Display 600, uppercase, tracking
              -0.01em. Venía del Hub con la escala de SectionDivider (18-22px),
              que aquí lo colocaba por encima de las secciones que lo rodean.
              El fondo oscuro ya da todo el contraste que necesita. */}
          <h2
            className="font-semibold uppercase leading-[1] tracking-[-0.01em]"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(16px, 3.6vw, 19px)",
            }}
          >
            <T en="Tell us about you" es="Cuéntanos sobre ti" />
          </h2>

          {/* El "para qué" en la voz del cliente. Sin esto el banner pide nueve
              respuestas sin decir para qué sirven, que es la forma más rápida de
              que nadie las conteste. */}
          <p className="mt-2.5 max-w-md text-[13px] leading-[1.5] text-[#b3ab98]">
            <T
              en="Ten questions, one minute. We use them to fit your subscription to what you actually drink, so no more boxes piling up."
              es="Diez preguntas, un minuto. Nos sirven para ajustar tu suscripción a lo que de verdad consumes, y que no se te acumulen las cajas."
            />
          </p>
        </div>

        {/* shrink-0 para que el botón no se comprima cuando el titular es largo
            (el inglés ocupa más), y w-full en móvil para que sea un objetivo
            táctil de ancho completo en vez de un botón perdido a la izquierda. */}
        <button
          type="button"
          onClick={onStart}
          className="w-full shrink-0 rounded-full bg-[color:var(--color-sharp-white)] px-7 py-3.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] transition-transform duration-200 ease-out hover:-translate-y-[1px] active:translate-y-0 md:w-auto"
        >
          <T en="Start" es="Empezar" />
        </button>
      </div>
    </section>
  );
}

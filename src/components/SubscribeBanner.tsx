"use client";

import { T } from "@/lib/i18n";
import { MEMBER_PHOTO_DATA_URI } from "@/lib/member-photo";
import { SUBSCRIBE_URL } from "@/lib/storefront-links";

/**
 * Invitación a suscribirse, en CUENTA y para quien no tiene suscripción
 * (Juan 2026-09-22).
 *
 * Existe porque la pantalla que hacía este trabajo ya no se visita. Hasta hoy,
 * el cliente de one-shot que entraba por el enlace de la tienda aterrizaba en
 * Mi LIT y se encontraba el "BIENVENIDO A LIT" con su botón de activar. Ese
 * enlace ahora rebota a Cuenta, que es donde está lo suyo, así que la oferta se
 * quedaba sin ningún sitio donde aparecer: el portal dejaba de proponer la
 * suscripción justo a la única gente que no la tiene.
 *
 * Se viste como ProfileSurveyBanner (banda oscura a ancho completo, foto de
 * marca velada) porque en una pantalla de tarjetas claras esa forma ya
 * significa "esto es otra cosa", y el portal no necesita un lenguaje nuevo para
 * decirlo.
 *
 * ── Dónde se diferencia de ese banner ──
 *
 * El CTA va en AMARILLO y no en blanco. En el del formulario el blanco está
 * razonado: pide un favor y no vende nada, así que no debe gritar más que su
 * propio titular. Aquí es al revés, esto es lo único de la pantalla que propone
 * comprar, y el amarillo es el color con el que LIT llama a comprar. Nunca
 * coinciden en pantalla: el del formulario solo sale con la encuesta pendiente
 * y éste solo sin suscripción.
 *
 * El descuento va en el cuerpo y no de eyebrow: "desde el 25%" es el argumento,
 * pero el titular tiene que decir qué es antes de decir cuánto ahorra.
 *
 * Sin guiones largos, por la guía de copy de LIT.
 */

export function SubscribeBanner() {
  return (
    <section
      className="relative isolate mx-6 mb-3 overflow-hidden rounded-[24px] bg-[#16130C] px-6 py-6 text-[#F2EEE1] md:mx-0 md:px-8 md:py-7"
      style={{
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.06) inset, 0 26px 54px -22px rgba(30,24,12,0.5), 0 8px 16px -10px rgba(30,24,12,0.3)",
        isolation: "isolate",
      }}
    >
      {/* Mismo fondo y mismo degradado cerrado que ProfileSurveyBanner: con la
          foto más abierta salía una mancha gris por la derecha que descuadraba
          la banda. */}
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
          <h2
            className="font-semibold uppercase leading-[1] tracking-[-0.01em]"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(16px, 3.6vw, 19px)",
            }}
          >
            <T en="Never run out" es="No te quedes sin LIT" />
          </h2>

          <p className="mt-2.5 max-w-md text-[13px] leading-[1.5] text-[#b3ab98]">
            <T
              en="Get LIT delivered automatically, with 25% off or more, and manage plans, flavours and dates from here. Change or cancel whenever you want."
              es="Recibe LIT automáticamente, con un descuento desde el 25%, y gestiona plan, sabores y fechas desde aquí. Lo cambias o lo cancelas cuando quieras."
            />
          </p>
        </div>

        <a
          href={SUBSCRIBE_URL}
          className="inline-flex w-full shrink-0 items-center justify-center rounded-full bg-[color:var(--color-bold-yellow)] px-7 py-3.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] transition-transform duration-200 ease-out hover:-translate-y-[1px] active:translate-y-0 md:w-auto"
        >
          <T en="Subscribe" es="Suscribirme" />
        </a>
      </div>
    </section>
  );
}

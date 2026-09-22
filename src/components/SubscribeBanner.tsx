"use client";

import { T, useLangValue } from "@/lib/i18n";
import { MEMBER_PHOTO_DATA_URI } from "@/lib/member-photo";
import { SUBSCRIBE_URL } from "@/lib/storefront-links";

/**
 * Invitación a suscribirse, al final de CUENTA y para quien no tiene ninguna
 * (Juan 2026-09-22).
 *
 * Existe porque la pantalla que hacía este trabajo ya no se visita. El cliente
 * de one-shot entraba por el enlace de la tienda, aterrizaba en Mi LIT y se
 * encontraba el "BIENVENIDO A LIT". Ese enlace ahora rebota a Cuenta, así que
 * la oferta se quedaba sin ningún sitio donde aparecer.
 *
 * ── Forma: la banda oscura, y pequeña (Juan, 2026-09-22) ──
 *
 * Dos intentos antes de éste. El primero copiaba entero el banner del
 * formulario y se leían como lo mismo. El segundo se fue al extremo contrario,
 * tarjeta clara con titular a 2,9rem y lista de tres beneficios: con forma
 * propia, sí, pero ocupaba media pantalla para decir una cosa, y colocada donde
 * estaba partía el cierre de la página.
 *
 * Lo que queda: el fondo oscuro de la encuesta, que es lo que le da el canteo,
 * en una pieza baja de una sola línea de argumento. Va DESPUÉS del marquee
 * LIT · PERFORM · REPEAT, así que el cierre de marca sigue cerrando y esto
 * remata sin interrumpir.
 *
 * Comparte fondo con ProfileSurveyBanner a propósito, pero no se confunden:
 * aquel es alto, con párrafo y CTA blanco de "Empezar"; éste es una banda baja
 * con el 25% y un CTA amarillo. Y casi nunca coinciden, porque el de la
 * encuesta sale con la encuesta pendiente y éste solo sin suscripción.
 *
 * ── Qué promete ──
 *
 * El 25% porque es el argumento, y "desde" porque la escalera llega al 45% a
 * partir de 5 cajas (ver [[reference_lit_pricing_ladder]]).
 *
 * Un solo beneficio además del precio, el que más pesa para quien no se ha
 * suscrito nunca: que no hay permanencia. Los otros (saltar, adelantar, cambiar
 * plan y sabor) se cayeron con la lista: son buenos, pero de los que convencen
 * DESPUÉS de entrar, y aquí lo que hay que quitar es el miedo a atarse.
 *
 * Sin envío gratis: en la PDP es un badge sin condiciones a la vista y no
 * cuelga de la suscripción, así que prometerlo aquí sería deuda.
 *
 * Sin guiones largos, por la guía de copy de LIT.
 */
export function SubscribeBanner() {
  // El titular lleva el 25% en amarillo, o sea markup, y <T> solo admite
  // strings. Se resuelve con el idioma en la mano, como el resto del portal.
  const lang = useLangValue();
  return (
    <section
      className="relative isolate mx-6 mb-3 overflow-hidden rounded-[20px] bg-[#16130C] px-5 py-5 text-[#F2EEE1] md:mx-0 md:px-7 md:py-5"
      style={{ isolation: "isolate" }}
    >
      {/* Mismo fondo que ProfileSurveyBanner: foto de marca en gris con el
          degradado cerrado por la izquierda, que es donde va el texto. */}
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

      <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
        <div className="min-w-0">
          {/* Una línea, con el 25% en el peso fuerte: es lo único que tiene que
              quedarse de un vistazo. */}
          <p className="font-display text-[17px] font-semibold uppercase leading-[1.15] tracking-[-0.01em] md:text-[19px]">
            {lang === "es" ? (
              <>
                Ahorra{" "}
                <span className="text-[color:var(--color-bold-yellow)]">
                  desde el 25%
                </span>{" "}
                en cada caja
              </>
            ) : (
              <>
                Save{" "}
                <span className="text-[color:var(--color-bold-yellow)]">
                  25% or more
                </span>{" "}
                on every box
              </>
            )}
          </p>
          <p className="mt-1.5 text-[12px] leading-[1.45] text-[#b3ab98]">
            <T
              en="LIT delivered automatically. No commitment, cancel from here whenever you want."
              es="LIT en tu casa automáticamente. Sin permanencia, cancelas desde aquí cuando quieras."
            />
          </p>
        </div>

        <a
          href={SUBSCRIBE_URL}
          className="inline-flex w-full shrink-0 items-center justify-center rounded-full bg-[color:var(--color-bold-yellow)] px-6 py-3 font-semibold uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)] transition-transform duration-200 ease-out hover:-translate-y-[1px] active:translate-y-0 md:w-auto"
          style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
        >
          <T en="Subscribe" es="Suscribirme" />
        </a>
      </div>
    </section>
  );
}

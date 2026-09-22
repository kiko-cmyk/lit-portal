"use client";

import { T, useLangValue } from "@/lib/i18n";
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
 * ── Por qué NO se viste como ProfileSurveyBanner (Juan, 2026-09-22) ──
 *
 * El primer intento reusaba su banda oscura con la foto velada. Fuera: los dos
 * banners viven en la misma pantalla y con la misma ropa se leen como lo mismo,
 * cuando no lo son. Aquel pide un favor y no vende nada, y de hecho su CTA va
 * en blanco justo para no gritar. Éste vende. Copiarle la forma le quitaba a
 * cada uno lo que lo distingue.
 *
 * Así que aquí la forma es la de la pantalla que sustituye: fondo claro, el
 * titular grande de LIT y el descuento como protagonista. No es un patrón
 * nuevo, es el que el cliente de one-shot ya se encontraba antes.
 *
 * ── Qué promete ──
 *
 * El 25% en grande porque es el argumento, y "desde" porque la escalera llega
 * al 45% a partir de 5 cajas (ver [[reference_lit_pricing_ladder]]: el
 * descuento vive en el precio de la variante, 25 / 40 / 45).
 *
 * Los tres beneficios de debajo son los que el portal cumple de verdad y que
 * este cliente ya tiene delante: saltar, adelantar, cambiar plan y sabor, y
 * cancelar cuando quiera. Deliberadamente NO se menciona el envío gratis: en la
 * PDP es un badge sin condiciones a la vista y no cuelga de la suscripción, así
 * que prometerlo aquí sería deuda.
 *
 * Sin guiones largos, por la guía de copy de LIT.
 */

function Check() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-[3px] shrink-0 text-[color:var(--color-lit-grey)]"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function SubscribeBanner() {
  const lang = useLangValue();
  const benefits =
    lang === "es"
      ? [
          "Salta, adelanta o cambia la fecha de tu próxima caja",
          "Cambia de plan y de sabor cuando te apetezca",
          "Sin permanencia, cancelas desde aquí en dos toques",
        ]
      : [
          "Skip, bring forward or move your next box",
          "Change plan and flavour whenever you feel like it",
          "No commitment, cancel from here in two taps",
        ];

  return (
    <section className="mx-6 mb-3 overflow-hidden rounded-[24px] border border-[color:var(--color-lit-grey)]/12 bg-[color:var(--color-sharp-white)] px-6 py-7 md:mx-0 md:px-8 md:py-8">
      {/* `items-start` y no `items-center`: centrado contra la columna de texto
          (titular + párrafo + tres beneficios), el botón se quedaba flotando a
          media altura con un vacío debajo. Arriba queda a la altura del titular,
          que es lo que el ojo lee primero. */}
      <div className="md:flex md:items-start md:justify-between md:gap-10">
        <div className="min-w-0">
          <span
            className="font-semibold uppercase tracking-[0.32em] text-[color:var(--color-warm-gray)]"
            style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
          >
            <T en="Subscription" es="Suscripción" />
          </span>

          {/* El titular de la pantalla que esto sustituye: Clash Display, negro,
              en caja alta y a dos líneas. El "25%" es lo que se ve primero. */}
          <h2
            className="mt-3 font-display font-medium uppercase leading-[0.9] tracking-[-0.03em] text-[color:var(--color-lit-grey)]"
            style={{ fontSize: "clamp(2rem, 7vw, 2.9rem)" }}
          >
            {lang === "es" ? (
              <>
                Ahorra desde
                <br />
                el 25% en cada caja
              </>
            ) : (
              <>
                Save 25% or more
                <br />
                on every box
              </>
            )}
          </h2>

          <p className="mt-4 max-w-md text-[14px] leading-[1.55] text-[color:var(--color-warm-gray)]">
            <T
              en="Get LIT automatically, without having to remember to order. The more boxes on your plan, the bigger the discount."
              es="Recibe LIT automáticamente, sin tener que acordarte de pedirlo. Cuantas más cajas lleve tu plan, mayor es el descuento."
            />
          </p>

          <ul className="mt-5 flex flex-col gap-2.5">
            {benefits.map((b) => (
              <li
                key={b}
                className="flex items-start gap-2.5 text-[13px] leading-[1.45] text-[color:var(--color-lit-grey)]"
              >
                <Check />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* En desktop el CTA se va a la derecha, centrado con el bloque. En
            móvil cae debajo a ancho completo, que es donde cae el pulgar. */}
        <a
          href={SUBSCRIBE_URL}
          className="mt-7 inline-flex w-full shrink-0 items-center justify-center rounded-full bg-[color:var(--color-lit-grey)] px-7 py-4 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-bold-yellow)] transition-transform duration-200 ease-out hover:-translate-y-[2px] active:translate-y-0 md:mt-6 md:w-auto"
          style={{ fontFamily: "var(--font-cond)", fontSize: 12 }}
        >
          <T en="Start my subscription" es="Activar mi suscripción" />
        </a>
      </div>
    </section>
  );
}

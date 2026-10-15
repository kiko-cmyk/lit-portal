"use client";

import { CardTitle, Lp2Card } from "@/components/Lp2";
import { T, useLang } from "@/lib/i18n";

interface ProfileSurveyBannerProps {
  onStart: () => void;
}

/**
 * Llamada al formulario de perfilado. Vive en CUENTA, justo debajo del saludo
 * (Juan 2026-09-15 la trajo del Hub; desde el rediseño lp2 del 2026-10-13 va
 * arriba del todo, donde antes estaban las acciones rápidas). Se movió del Hub
 * porque allí lo alimentaba /api/hub/dashboard, que 404ea sin suscripción viva,
 * así que los pausados y los cancelados no lo veían nunca. Ahora el estado viaja
 * en /api/customer.
 *
 * ── Por qué NO es una acción más (Juan, 2026-09-10) ──
 * Las acciones ADMINISTRAN la suscripción y esta pide un favor al cliente.
 * Vestirla igual promete lo mismo que las demás y no lo es.
 *
 * ── Aspecto (rediseño lp2, Juan 2026-10-13) ──
 * Tarjeta clara como las de la página, con un círculo lima y el icono de
 * formulario, y un único botón oscuro. Antes era una banda oscura con foto; en
 * el rediseño la única superficie oscura de Cuenta es el banner de referidos.
 * Juan probó también dos sobres dentro del círculo y no le gustaron ahí.
 *
 * ── Sin mención a los drops (Juan, 2026-09-10) ──
 * Los drops no están visibles para el cliente, así que prometer una recompensa
 * que no puede ver ni gastar es una deuda, no un incentivo. El formulario SÍ los
 * paga (`DROPS_AMOUNTS.profile_survey`); simplemente no se anuncian aquí.
 *
 * El copy nombra el beneficio para el CLIENTE (ajustar su suscripción a lo que
 * consume), nunca el nuestro (datos). Sin guiones largos, por la guía de LIT.
 */
export function ProfileSurveyBanner({ onStart }: ProfileSurveyBannerProps) {
  const t = useLang();
  return (
    <div className="mx-6 md:mx-0">
      <Lp2Card className="md:flex md:items-center md:gap-7 md:py-6 md:px-[30px]">
        {/* Sin icono (Juan 2026-10-14): el título solo, como el resto de
            tarjetas. */}
        <div className="min-w-0 md:flex-1">
          <CardTitle
            thin={t({ en: "Tell us", es: "Cuéntanos" })}
            bold={t({ en: "about you", es: "sobre ti" })}
          />
          {/* El «para qué» en la voz del cliente. Sin esto el banner pide diez
              respuestas sin decir para qué sirven, que es la forma más rápida
              de que nadie las conteste. */}
          <p className="mt-3.5 mb-0 max-w-[560px] text-[14px] leading-[1.5] text-[#5E6168] md:mt-2.5 md:text-[14.5px]">
            <T
              en="Ten questions, one minute. We use them to fit your subscription to what you actually drink, so no more boxes piling up."
              es="Diez preguntas, un minuto. Nos sirven para ajustar tu suscripción a lo que de verdad consumes, y que no se te acumulen las cajas."
            />
          </p>
        </div>
        <button
          type="button"
          onClick={onStart}
          className="mt-4 flex w-full flex-none cursor-pointer items-center justify-center gap-2.5 rounded-full bg-[#2F343D] px-6 py-[15px] text-[11px] font-bold uppercase tracking-[0.16em] text-[#F2F1EA] transition-transform duration-200 ease-out hover:-translate-y-[1px] active:translate-y-0 md:mt-0 md:w-auto"
        >
          <T en="Start" es="Empezar" />
          <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EBEE62" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" />
            <path d="M13 6l6 6-6 6" />
          </svg>
        </button>
      </Lp2Card>
    </div>
  );
}

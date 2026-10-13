"use client";

import type { ReactNode } from "react";
import { CardTitle, Lp2Card } from "@/components/Lp2";
import { useLang } from "@/lib/i18n";

interface DangerZoneProps {
  onCancel: () => void;
  /** Abre el salto del próximo envío (SkipOverlay). Sin él, no sale el botón. */
  onSkip?: () => void;
  /** Abre el cambio de plan (PlanOverlay), donde se cambia la frecuencia. */
  onChangeFrequency?: () => void;
  /** Dentro de la ventana de cierre las dos alternativas no se pueden usar. */
  alternativesDisabled?: boolean;
}

/**
 * Bloque de baja, rediseño lp2 (Juan 2026-10-13: «el banner de cancelación debe
 * mejorarse»).
 *
 * Antes era una tarjeta con borde rojo y un solo enlace. Ahora es una tarjeta
 * como las demás: título a dos pesos, una frase que recuerda que se puede parar
 * sin irse, las dos alternativas que ya existen en el portal (saltar un envío y
 * cambiar la frecuencia) y, debajo, «Cancelar suscripción» en un rojo apagado.
 * Cancelar sigue a un clic y abre el mismo asistente de siempre; las
 * alternativas solo están al lado.
 *
 * En escritorio el enlace va alineado a la derecha con el TEXTO del último botón,
 * no con su borde (Juan): de ahí el margen igual al relleno del botón + 1 px de
 * borde.
 *
 * Sign-out vive en «Tus datos» como «Cerrar sesión o entrar con otro email»
 * (2026-07-29), no aquí: salir de una cuenta no es de la misma familia que
 * cancelar una suscripción. Ver docs/AUTH_LOGOUT.md.
 */
export function DangerZone({ onCancel, onSkip, onChangeFrequency, alternativesDisabled }: DangerZoneProps) {
  const t = useLang();
  const hasAlternatives = Boolean(onSkip || onChangeFrequency);

  return (
    <div className="mx-6 md:mx-0">
      <Lp2Card className="md:flex md:flex-wrap md:items-center md:justify-between md:gap-x-12 md:gap-y-6">
        <div className="min-w-0 md:flex-[1_1_460px]">
          <CardTitle
            thin={t({ en: "Want to leave", es: "¿Quieres salir" })}
            bold={t({ en: "the circle?", es: "del círculo?" })}
          />
          {hasAlternatives && (
            <p className="mt-3 mb-0 max-w-[520px] text-[14px] leading-[1.5] text-[#5E6168] md:text-[14.5px] md:leading-[1.55]">
              {t({
                en: "If you just need a break, you can skip a delivery or get your boxes less often. Free, whenever you like.",
                es: "Si solo necesitas un respiro, puedes saltar un envío o recibir tus cajas menos a menudo. Sin coste y cuando quieras.",
              })}
            </p>
          )}
        </div>

        <div className="md:flex md:flex-none md:flex-col md:items-end md:gap-4">
          {hasAlternatives && (
            <div className="mt-[18px] grid grid-cols-2 gap-2 md:mt-0 md:flex md:gap-2.5">
              {onSkip && (
                <Alternative
                  onClick={onSkip}
                  disabled={alternativesDisabled}
                  label={t({ en: "Skip a delivery", es: "Saltar un envío" })}
                  icon={
                    <>
                      <path d="M6 5l9 7-9 7V5z" />
                      <path d="M18 5v14" />
                    </>
                  }
                />
              )}
              {onChangeFrequency && (
                <Alternative
                  onClick={onChangeFrequency}
                  disabled={alternativesDisabled}
                  label={t({ en: "Change frequency", es: "Cambiar frecuencia" })}
                  icon={
                    <>
                      <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" />
                      <path d="M4 4v4h4" />
                      <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" />
                      <path d="M20 20v-4h-4" />
                    </>
                  }
                />
              )}
            </div>
          )}
          <button
            type="button"
            onClick={onCancel}
            className={`block w-full cursor-pointer text-center text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#A0412F] underline decoration-[#A0412F]/45 underline-offset-4 transition-colors hover:decoration-[#A0412F] md:w-auto md:text-right ${
              hasAlternatives ? "mt-[18px] md:mt-0 md:mr-[19px]" : "mt-4 md:mt-0"
            }`}
          >
            {t({ en: "Cancel subscription", es: "Cancelar suscripción" })}
          </button>
        </div>
      </Lp2Card>
    </div>
  );
}

function Alternative({
  onClick,
  disabled,
  label,
  icon,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex cursor-pointer flex-col items-center gap-1.5 rounded-[16px] border border-[#2F343D]/12 px-1 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[#2F343D] transition-colors hover:border-[#2F343D]/35 disabled:cursor-not-allowed disabled:opacity-50 md:flex-row md:gap-2 md:rounded-full md:border-[#2F343D]/18 md:px-[18px] md:py-[13px] md:text-[11px]"
    >
      <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2F343D" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {icon}
      </svg>
      {label}
    </button>
  );
}

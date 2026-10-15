"use client";

import logo from "@/assets/lit-logo-grey.webp";
import { T } from "@/lib/i18n";

/**
 * Pantalla de carga del portal (Juan 2026-10-13: «rediseña la página de
 * CARGANDO mientras carga el portal»).
 *
 * La MISMA para la entrada (SubscriptionGate) y para Suscripción y Cuenta
 * mientras piden sus datos. Antes eran dos pantallas distintas, el logo
 * latiendo y después un «Cargando…» suelto, y al pasar de una a otra se veía
 * el salto. Ahora el cliente ve una sola espera.
 *
 * El logo en gris LIT sobre el crema lp2 (import estático de 7 KB: sale del
 * origen de Vercel como las cajas, que el App Proxy no sirve /public) y tres
 * puntos con los colores de los sabores que se encienden por turnos
 * (`.lp2-loader-dot` en globals.css). Los colores son los tonos fuertes de los
 * paneles de sabor, con un aro fino: los suaves no se veían sobre el crema.
 */
const DOTS = ["#E1E46A", "#F4A096", "#F7B77D"];

export function Lp2Loader({ fullScreen = false }: { fullScreen?: boolean }) {
  return (
    <main
      role="status"
      aria-live="polite"
      className={`zone-lp2 flex flex-col items-center justify-center bg-[#EFEEE5] text-[#2F343D] ${
        fullScreen ? "min-h-screen" : "flex-1"
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo.src} alt="LIT" width={64} height={49} className="h-auto w-16" />
      <div aria-hidden className="mt-7 flex items-center gap-2">
        {DOTS.map((c, i) => (
          <span
            key={c}
            className="lp2-loader-dot h-2.5 w-2.5 rounded-full shadow-[0_0_0_1px_rgba(47,52,61,0.18)]"
            style={{ background: c, animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </div>
      <p className="mt-4 text-[9.5px] font-semibold uppercase tracking-[0.2em] text-[#8C8E87]">
        <T en="Loading" es="Cargando" />
      </p>
    </main>
  );
}

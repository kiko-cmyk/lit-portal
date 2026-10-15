"use client";

import logo from "@/assets/lit-logo-grey.webp";
import { capsLabel } from "@/components/Lp2";
import { SheetArrow } from "@/components/Lp2Sheet";
import { FlavorThumb } from "@/components/MixBuilder";
import { frequencyLabel } from "@/lib/frequency-label";
import { T, useLang, useLangValue } from "@/lib/i18n";
import { compositionLabel } from "@/lib/mix";
import { FLAVORS } from "@/lib/seal-plans";
import type { Subscription } from "@/lib/types";

/**
 * First-screen subscription chooser. Shown by SubscriptionGate BEFORE the portal
 * when a customer has more than one subscription and hasn't picked yet. Picking
 * one persists the choice (localStorage, via the parent) and enters the full
 * portal scoped to that subscription (api-client injects ?seal_subscription_id
 * on every call). Single-sub customers never see this.
 *
 * Rediseño lp2 (Juan 2026-10-13): crema de la landing, título a dos pesos y una
 * tarjeta por suscripción con sus cajas, para que se reconozca cada una de un
 * vistazo (sabor y cajas primero, los datos debajo).
 */
export function SubscriptionChooser({
  subs,
  onPick,
}: {
  subs: Subscription[];
  onPick: (sealSubscriptionId: string) => void;
}) {
  const t = useLang();
  const lang = useLangValue();
  const fmtDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(lang === "es" ? "es-ES" : "en-US", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null;

  return (
    <div className="zone-lp2 min-h-screen bg-[#EFEEE5] px-5 pt-10 pb-14 text-[#2F343D] sm:flex sm:items-center sm:justify-center sm:px-6 sm:py-16">
      <div className="mx-auto w-full max-w-xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo.src} alt="LIT" width={52} height={40} className="h-auto w-[52px]" />

        <h1 className="mt-10 font-display text-[34px] font-normal uppercase leading-[0.98] tracking-[0.005em] md:mt-12 md:text-[48px]">
          <span className="font-light">{t({ en: "Choose a", es: "Elige una" })}</span>{" "}
          <span className="whitespace-nowrap font-semibold">
            {t({ en: "subscription", es: "suscripción" })}
          </span>
        </h1>
        <p className="lp2-text mt-4 max-w-md">
          <T
            en="You have more than one active subscription. Pick the one you want to manage."
            es="Tienes más de una suscripción activa. Elige la que quieres gestionar."
          />
        </p>

        <div className="mt-8 space-y-3 md:mt-10 md:space-y-4">
          {subs.map((s) => {
            const next = fmtDate(s.nextShipDate);
            // Un sabor que el portal aún no tenga en su catálogo (p. ej. Raw) no
            // puede pasar por compositionLabel, que lo busca en FLAVORS.
            const known =
              !!s.composition?.length &&
              s.composition.every((c) => Object.prototype.hasOwnProperty.call(FLAVORS, c.flavor));
            const title = known ? compositionLabel(s.composition) : s.flavorSummary || s.flavor;
            const thumbs = s.composition?.length
              ? s.composition.map((c) => c.flavor)
              : [];
            return (
              <button
                key={s.sealSubscriptionId}
                type="button"
                onClick={() => onPick(s.sealSubscriptionId)}
                // Rejilla: en móvil, las cajas y la flecha arriba y el texto
                // debajo a todo el ancho (en fila, el nombre de una mezcla se
                // partía en tres líneas); en escritorio, todo en una fila.
                className="group grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 rounded-[24px] border border-[#2F343D]/[0.06] bg-[color:var(--color-sharp-white)] px-5 py-4 text-left shadow-[0_22px_44px_-24px_rgba(40,34,20,0.38)] transition duration-200 hover:-translate-y-0.5 hover:border-[#2F343D]/20 md:grid-cols-[auto_1fr_auto] md:gap-x-5 md:rounded-[28px] md:px-6 md:py-5"
              >
                {/* Las cajas de la suscripción, solapadas si es una mezcla. */}
                {thumbs.length > 0 && (
                  <span aria-hidden className="col-start-1 row-start-1 flex">
                    {thumbs.slice(0, 3).map((f, i) => (
                      // `flex`: FlavorThumb es un <span> con alto y ancho, que
                      // dentro de otro <span> en línea se quedaba a cero.
                      <span key={f} className={`flex ${i > 0 ? "-ml-6" : ""}`}>
                        <FlavorThumb flavor={f} />
                      </span>
                    ))}
                  </span>
                )}
                <span className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:col-start-2 md:row-start-1">
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="font-display text-[19px] font-semibold uppercase leading-tight md:text-[22px]">
                      {title}
                    </span>
                    {s.status === "paused" && (
                      <span className="rounded-full bg-[#2F343D]/8 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.16em] text-[#5E6168]">
                        <T en="Paused" es="En pausa" />
                      </span>
                    )}
                  </span>
                  <span className={`mt-2 block ${capsLabel}`}>
                    {s.boxCount}{" "}
                    {s.boxCount === 1 ? t({ en: "box", es: "caja" }) : t({ en: "boxes", es: "cajas" })}
                    {" · "}
                    {frequencyLabel(s.frequency, lang)}
                    {s.shippingAddress?.city ? ` · ${s.shippingAddress.city}` : ""}
                  </span>
                  {next && (
                    <span className="mt-1.5 block text-[13px] leading-snug text-[#5E6168]">
                      {t({ en: "Next shipment", es: "Próximo envío" })}: {next}
                    </span>
                  )}
                </span>
                <span className="col-start-2 row-start-1 flex h-11 w-11 items-center justify-center rounded-full bg-[#2F343D] text-[color:var(--color-bold-yellow)] transition-transform duration-200 group-hover:translate-x-0.5 md:col-start-3">
                  <SheetArrow className="h-[18px] w-[18px]" />
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

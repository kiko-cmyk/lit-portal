"use client";

import { frequencyLabel } from "@/lib/frequency-label";
import { T, useLang, useLangValue } from "@/lib/i18n";
import type { Subscription } from "@/lib/types";

/**
 * First-screen subscription chooser. Shown by SubscriptionGate BEFORE the portal
 * when a customer has more than one subscription and hasn't picked yet. Picking
 * one persists the choice (localStorage, via the parent) and enters the full
 * portal scoped to that subscription (api-client injects ?seal_subscription_id
 * on every call). Single-sub customers never see this.
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
    <div className="zone-cream min-h-screen bg-[color:var(--color-brisky-cream)] px-6 py-16 sm:flex sm:items-center sm:justify-center">
      <div className="mx-auto w-full max-w-lg">
        <h1 className="font-display text-5xl font-semibold uppercase leading-[0.95] text-[color:var(--color-lit-grey)]">
          <T en="Choose a subscription" es="Elige una suscripción" />
        </h1>
        <p className="mt-4 text-base text-[color:var(--color-warm-gray)]">
          <T
            en="You have more than one active subscription. Pick the one you want to manage."
            es="Tienes más de una suscripción activa. Elige la que quieres gestionar."
          />
        </p>

        <div className="mt-10 space-y-4">
          {subs.map((s) => {
            const next = fmtDate(s.nextShipDate);
            return (
              <button
                key={s.sealSubscriptionId}
                type="button"
                onClick={() => onPick(s.sealSubscriptionId)}
                className="zone-cream group flex w-full items-center justify-between rounded-[20px] md:rounded-[22px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-6 py-5 text-left shadow-[0_10px_30px_-14px_rgba(40,34,20,0.22)] transition hover:-translate-y-0.5 hover:border-[color:var(--color-bold-yellow)] hover:shadow-[0_16px_36px_-14px_rgba(40,34,20,0.28)]"
              >
                <span>
                  <span className="block font-display text-xl font-semibold uppercase leading-tight text-[color:var(--color-lit-grey)]">
                    {s.flavor}
                  </span>
                  <span className="mt-1 block text-sm text-[color:var(--color-warm-gray)]">
                    {s.boxCount}
                    {" "}
                    {s.boxCount === 1 ? t({ en: "box", es: "caja" }) : t({ en: "boxes", es: "cajas" })}
                    {" · "}
                    {frequencyLabel(s.frequency, lang)}
                    {s.shippingAddress?.city ? ` · ${s.shippingAddress.city}` : ""}
                    {next ? ` · ${t({ en: "next", es: "próx." })} ${next}` : ""}
                  </span>
                </span>
                <span className="ml-4 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-bold-yellow)] text-xl leading-none text-[color:var(--color-lit-grey)] transition group-hover:scale-105">→</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

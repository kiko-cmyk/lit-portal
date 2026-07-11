"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang } from "@/lib/i18n";
import type { ChargeNowResponse, Subscription } from "@/lib/types";

/**
 * Charge-now overlay — "Adelantar mi pedido".
 *
 * Calls POST /api/subscription/charge-now which:
 *   - Enforces the 24h cutoff (can't bring forward an order already shipping)
 *   - Fires Seal /subscription-create-charge-now with reset_schedule → charges
 *     the card on file NOW and re-anchors the cadence on today
 *   - Fires Klaviyo subscription_charge_now event
 *
 * Mirror of SkipOverlay, but the copy makes the immediate charge explicit:
 * the customer must understand they're paying now.
 */
export function ChargeNowOverlay({
  subscription,
  onClose,
  onCharged,
}: {
  subscription: Subscription;
  onClose: () => void;
  onCharged: (newDate: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `locked` = a charge is already in flight for this subscription (Seal
  // returned `charge_already_scheduled`). We disable the confirm button so the
  // customer can't fire a duplicate attempt, which is what generated the
  // repeated P0 alerts on /charge-now.
  const [locked, setLocked] = useState(false);
  const [done, setDone] = useState<ChargeNowResponse | null>(null);
  const t = useLang();

  const currentShip = subscription.nextShipDate
    ? new Date(subscription.nextShipDate)
    : null;

  const handleCharge = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<ChargeNowResponse>("/api/subscription/charge-now", {
        method: "POST",
        // Fast-path: lets the backend skip the 33-page Seal scan (same
        // optimisation as skip/plan).
        body: JSON.stringify({ sealSubscriptionId: subscription.sealSubscriptionId }),
      });
      setDone(res);
      onCharged(res.newNextShipDate);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "charge_already_scheduled") {
        // A charge is already being processed for this subscription. Lock the
        // button and show a calm, truthful message so the customer waits
        // instead of re-tapping (which is what fired the duplicate alerts).
        setLocked(true);
        setError(
          t({
            en: "We're already processing an order for you. Give it a few minutes. No need to try again.",
            es: "Ya estamos procesando un pedido tuyo. Espera unos minutos; no hace falta que vuelvas a intentarlo.",
          }),
        );
      } else {
        setError(
          code === "cutoff_passed"
            ? t({
                en: "Your next order is already on its way.",
                es: "Tu próximo pedido ya está en camino.",
              })
            : t({
                en: "Couldn't process the payment. Check your payment method or try again later.",
                es: "No se pudo procesar el pago. Revisa tu método de pago o inténtalo más tarde.",
              }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-[#0F0E1A]/70 backdrop-blur-sm sm:items-center"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="zone-cream relative mx-auto w-full max-w-md rounded-t-[24px] bg-[color:var(--color-brisky-cream)] px-6 pt-9 pb-8 sm:rounded-[28px]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="absolute right-4 top-4 text-2xl text-[color:var(--color-warm-gray)] opacity-70 disabled:opacity-30"
        >
          ×
        </button>

        {!done ? (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
              <T en="Bring order forward" es="Adelantar pedido" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none text-[color:var(--color-lit-grey)]">
              <T en="Get it now" es="¿Recibirlo ya" />?
            </h1>
            <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">
              <T
                en="We'll charge your next order now and it'll arrive within 48-72h. Your calendar will reset from today based on your plan."
                es="Cobraremos tu próximo pedido ahora y te llegará en las próximas 48-72h. Tu calendario se reajustará desde hoy en función de tu plan contratado."
              />
            </p>

            {currentShip && (
              <div className="mt-6 rounded-[20px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] p-5 shadow-[0_10px_30px_-14px_rgba(40,34,20,0.22)] md:rounded-[22px]">
                <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
                  <T en="Scheduled order date" es="Fecha de pedido programada" />
                </div>
                <div className="mt-1 flex items-center gap-3">
                  <span className="font-display text-xl font-black uppercase line-through text-[#9a9284]">
                    {currentShip.toLocaleDateString(t({ en: "en-US", es: "es-ES" }), {
                      day: "numeric",
                      month: "long",
                    })}
                  </span>
                  <span aria-hidden className="text-lg text-[color:var(--color-warm-gray)]">
                    →
                  </span>
                  <span className="font-display text-2xl font-black uppercase text-[color:var(--color-lit-grey)]">
                    <T en="Today" es="Hoy" />
                  </span>
                </div>
              </div>
            )}

            {error && (
              <div
                className={
                  locked
                    ? "mt-4 rounded-[14px] bg-[color:var(--color-bold-yellow)]/15 px-4 py-3 text-xs text-[color:var(--color-lit-grey)]"
                    : "mt-4 rounded-[14px] bg-[color:var(--color-danger)]/10 px-4 py-3 text-xs text-[color:var(--color-danger)]"
                }
              >
                {error}
              </div>
            )}

            <button
              type="button"
              disabled={busy || locked}
              onClick={handleCharge}
              className="mt-7 w-full rounded-full bg-[color:var(--color-lit-grey)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)] disabled:opacity-50"
            >
              {busy ? (
                <T en="Processing…" es="Procesando…" />
              ) : (
                <T en="Yes, order now" es="Sí, pedir ahora" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 w-full text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)] underline"
            >
              <T en="Never mind" es="Mejor no" />
            </button>
          </>
        ) : (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
              <T en="Done" es="Listo" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none text-[color:var(--color-lit-grey)]">
              <T en="On its way" es="En camino" />!
            </h1>
            <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">
              <T
                en="We're processing your order. Your new delivery calendar will recalculate in a few moments."
                es="Vamos a procesar tu pedido. Tu nuevo calendario de envíos se recalculará en unos instantes."
              />
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-7 w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
            >
              <T en="Back to LIT" es="Volver a LIT" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

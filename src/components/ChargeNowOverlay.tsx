"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { Lp2Sheet, SheetArrow, SheetDoneMark, SheetTitle } from "@/components/Lp2Sheet";
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
      } else if (
        code === "charge_unconfirmed" ||
        code === "gateway_timeout" ||
        (e as { status?: number }).status === 504
      ) {
        // No sabemos si se ha cobrado (14-oct-2026). Volver a pulsar podría cobrar otra caja:
        // se bloquea el botón y se le dice dónde lo verá.
        setLocked(true);
        setError(
          t({
            en: "We couldn't confirm whether your order was charged. Please don't try again: in a few minutes you'll see it in My orders or get the confirmation email. If it doesn't appear, write to us.",
            es: "No hemos podido confirmar si tu pedido se ha cobrado. No lo repitas: en unos minutos lo verás en Mis pedidos o te llegará el email de confirmación. Si no aparece, escríbenos.",
          }),
        );
      } else if (code === "change_applying") {
        setLocked(true);
        setError(
          t({
            en: "Your plan change is still being applied. You'll be able to bring your order forward in a few minutes.",
            es: "Tu cambio de plan se está terminando de aplicar. Podrás adelantar el envío en unos minutos.",
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
    <Lp2Sheet onClose={onClose} busy={busy}>
      {!done ? (
        <>
          <p className="lp2-eyebrow">
            <T en="Bring forward" es="Adelantar envío" />
          </p>
          <SheetTitle thin={t({ en: "Get it", es: "¿Recibirlo" })} bold={t({ en: "now?", es: "ya?" })} />
          <p className="lp2-text mt-3">
            <T
              en="We'll charge your next order now and it'll arrive within 48-72h. Your calendar will reset from today based on your plan."
              es="Cobraremos tu próximo pedido ahora y te llegará en las próximas 48-72h. Tu calendario se reajustará desde hoy en función de tu plan contratado."
            />
          </p>

          {currentShip && (
            <div className="lp2-card mt-6">
              <span className="lp2-label">
                <T en="Scheduled order date" es="Fecha de pedido programada" />
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <span className="lp2-figure text-[22px] text-[#8C8E87] line-through decoration-2">
                  {currentShip.toLocaleDateString(t({ en: "en-US", es: "es-ES" }), {
                    day: "numeric",
                    month: "long",
                  })}
                </span>
                <SheetArrow className="h-5 w-5 text-[#8C8E87]" />
                <span className="lp2-figure text-[30px]">
                  <T en="Today" es="Hoy" />
                </span>
              </div>
            </div>
          )}

          {error && <div className={`lp2-notice mt-4 ${locked ? "" : "lp2-notice--error"}`}>{error}</div>}

          <button type="button" disabled={busy || locked} onClick={handleCharge} className="lp2-cta mt-7">
            {busy ? <T en="Processing…" es="Procesando…" /> : <T en="Yes, order now" es="Sí, pedir ahora" />}
          </button>
          <button type="button" onClick={onClose} className="lp2-link mt-4">
            <T en="Never mind" es="Mejor no" />
          </button>
        </>
      ) : (
        <>
          <SheetDoneMark />
          <p className="lp2-eyebrow mt-5">
            <T en="Done" es="Listo" />
          </p>
          <SheetTitle thin={t({ en: "Order", es: "Pedido" })} bold={t({ en: "on its way", es: "en camino" })} />
          <p className="lp2-text mt-3">
            <T
              en="We're processing your order. Your new delivery calendar will recalculate in a few moments."
              es="Vamos a procesar tu pedido. Tu nuevo calendario de envíos se recalculará en unos instantes."
            />
          </p>
          <button type="button" onClick={onClose} className="lp2-cta lp2-cta--still mt-7">
            <T en="Back to LIT" es="Volver a LIT" />
          </button>
        </>
      )}
    </Lp2Sheet>
  );
}

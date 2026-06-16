"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang } from "@/lib/i18n";
import type { SkipResponse, Subscription } from "@/lib/types";

/**
 * Skip overlay — confirms skipping the next box.
 *
 * Calls POST /api/subscription/skip which:
 *   - Fires Seal billing-attempt skip (no 24h cutoff — allowed until the
 *     charge actually fires; Seal rejects with `already_charged` past that)
 *   - Fires Klaviyo subscription_skip event
 */
// Nueva fecha de envío tras saltar: la actual + un ciclo de la frecuencia
// (1mo, 15d, 3mo…). En una cadencia regular coincide con el siguiente billing
// attempt ya programado, que es lo que pasa a ser el próximo envío al saltar.
function addCycle(date: Date, frequency: string): Date {
  const d = new Date(date);
  const n = parseInt(frequency, 10);
  if (frequency.endsWith("mo")) d.setMonth(d.getMonth() + n);
  else if (frequency.endsWith("d")) d.setDate(d.getDate() + n);
  return d;
}

export function SkipOverlay({
  subscription,
  onClose,
  onSkipped,
}: {
  subscription: Subscription;
  onClose: () => void;
  onSkipped: (newDate: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SkipResponse | null>(null);
  const t = useLang();

  const currentShip = subscription.nextShipDate
    ? new Date(subscription.nextShipDate)
    : null;
  const newShip = currentShip
    ? addCycle(currentShip, subscription.frequency)
    : null;

  const handleSkip = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<SkipResponse>("/api/subscription/skip", {
        method: "POST",
        // Fast-path: lets the backend skip the 33-page Seal scan that
        // bumped into proxy timeouts on cold starts (Juan 2026-05-21
        // reported first-click skip from Cuenta failing, second click ok).
        body: JSON.stringify({ sealSubscriptionId: subscription.sealSubscriptionId }),
      });
      setDone(res);
      onSkipped(res.newNextShipDate);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code === "already_charged" || code === "no_pending_attempt"
          ? t({
              en: "This order is already being processed and can't be skipped.",
              es: "Este pedido ya se está procesando y no se puede saltar.",
            })
          : t({
              en: "Couldn't skip. Try again or contact us.",
              es: "No se pudo saltar. Inténtalo de nuevo o escríbenos.",
            }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-[#0F0E1A]/70 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="zone-cream relative mx-auto w-full max-w-md rounded-t-3xl bg-[color:var(--color-brisky-cream)] px-6 pt-9 pb-8 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-2xl opacity-60"
        >
          ×
        </button>

        {!done ? (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
              <T en="Skip next order" es="Saltar próximo pedido" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none text-[color:var(--color-lit-grey)]">
              <T en="Need a break?" es="¿Necesitas una pausa?" />
            </h1>
            <p className="mt-3 text-sm opacity-70">
              <T
                en="Your subscription will skip one cycle and we'll resume from there."
                es="Tu suscripción se saltará un ciclo y retomaremos desde ahí."
              />
            </p>

            {currentShip && (
              <div className="mt-6 rounded-2xl bg-[color:var(--color-sharp-white)] p-5">
                <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
                  <T en="Current ship date" es="Fecha de envío actual" />
                </div>
                <div className="mt-1 font-display text-2xl font-black uppercase opacity-60">
                  {currentShip.toLocaleDateString(t({ en: "en-US", es: "es-ES" }), {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  })}
                </div>
                {newShip && (
                  <>
                    <div className="my-4 border-t border-[color:var(--color-lit-grey)]/10" />
                    <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)]">
                      <T en="New ship date" es="Nueva fecha de envío" />
                    </div>
                    <div className="mt-1 font-display text-2xl font-black uppercase">
                      {newShip.toLocaleDateString(t({ en: "en-US", es: "es-ES" }), {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-sm bg-red-50 px-4 py-3 text-xs text-red-700">
                {error}
              </div>
            )}

            <button
              type="button"
              disabled={busy}
              onClick={handleSkip}
              className="mt-7 w-full rounded-sm bg-[color:var(--color-lit-grey)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-brisky-cream)] disabled:opacity-50"
            >
              {busy ? (
                <T en="Skipping…" es="Saltando…" />
              ) : (
                <T en="Confirm skip" es="Confirmar saltar" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 w-full text-[11px] uppercase tracking-[0.18em] opacity-50 underline"
            >
              <T en="Never mind" es="Mejor no" />
            </button>
          </>
        ) : (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
              <T en="Done" es="Listo" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none">
              <T en="Skipped" es="Saltado" />
            </h1>
            <p className="mt-3 text-sm opacity-70">
              <T
                en="Your next box now ships on"
                es="Tu próxima caja sale el"
              />{" "}
              <strong>
                {new Date(done.newNextShipDate).toLocaleDateString(
                  t({ en: "en-US", es: "es-ES" }),
                  { weekday: "long", day: "numeric", month: "long" },
                )}
              </strong>
              .
            </p>
            <p className="mt-3 text-xs opacity-50">
              <T
                en="You can undo this until your new ship date approaches."
                es="Puedes deshacer hasta que se acerque la nueva fecha."
              />
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-7 w-full rounded-sm bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
            >
              <T en="Back to LIT" es="Volver a LIT" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

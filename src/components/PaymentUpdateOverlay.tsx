"use client";

import { useEffect, useRef, useState } from "react";
import { T, useLang } from "@/lib/i18n";

interface PaymentUpdateOverlayProps {
  /**
   * Single-use Shopify-hosted URL where the customer enters new card / PayPal
   * details. Comes from `customerPaymentMethodGetUpdateUrl` (cards) or from
   * the email-send fallback for non-card instruments.
   */
  url: string;
  onClose: () => void;
  /** Called once the customer hits "Done" — host should refetch payment method. */
  onCompleted?: () => void;
}

/**
 * Embeds the Shopify-hosted payment update form in a modal so the customer
 * never sees the `tracking.litsalt.com` URL bar — visually they stay in our
 * portal. If Shopify serves X-Frame-Options:DENY (which we have to detect
 * via a load timeout because cross-origin iframe inspection is blocked),
 * we fall back to opening the URL in a centred popup and showing a tracking
 * note so the customer knows what's happening.
 *
 * Width capped at 540px to match the form's natural breakpoint.
 */
export function PaymentUpdateOverlay({
  url,
  onClose,
  onCompleted,
}: PaymentUpdateOverlayProps) {
  const t = useLang();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [iframeBlocked, setIframeBlocked] = useState(false);

  // Best-effort blocked-iframe detection: if onLoad never fires within 4 s,
  // assume X-Frame-Options blocked us and offer the popup fallback.
  useEffect(() => {
    const id = setTimeout(() => {
      if (!loaded) setIframeBlocked(true);
    }, 4_000);
    return () => clearTimeout(id);
  }, [loaded]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-[#0F0E1A]/70 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="zone-cream relative mx-auto flex h-[92vh] w-full max-w-[540px] flex-col overflow-hidden rounded-t-3xl bg-[color:var(--color-brisky-cream)] sm:h-[80vh] sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[color:var(--color-lit-grey)]/10 px-5 py-3">
          <h2 className="font-display text-[17px] font-black uppercase tracking-[-0.005em] text-[color:var(--color-lit-grey)]">
            <T en="Update payment method" es="Cambiar método de pago" />
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t({ en: "Close", es: "Cerrar" })}
            className="text-[20px] text-[color:var(--color-warm-gray)] hover:text-[color:var(--color-lit-grey)]"
          >
            ×
          </button>
        </header>

        {iframeBlocked ? (
          <FallbackPanel url={url} onCompleted={onCompleted} />
        ) : (
          <>
            {!loaded && (
              <div className="absolute inset-x-0 top-[49px] flex h-12 items-center justify-center text-[11px] uppercase tracking-[0.2em] text-[color:var(--color-warm-gray)]">
                <T en="Loading secure form…" es="Cargando formulario seguro…" />
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={url}
              title="Update payment method"
              className="flex-1 w-full border-0 bg-[color:var(--color-brisky-cream)]"
              onLoad={() => setLoaded(true)}
            />
            <footer className="border-t border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-5 py-3 flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]">
                <T
                  en="Secure form hosted by Shopify"
                  es="Formulario seguro de Shopify"
                />
              </p>
              <button
                type="button"
                onClick={() => {
                  onCompleted?.();
                  onClose();
                }}
                className="rounded-sm bg-[color:var(--color-lit-grey)] px-4 py-2 text-[10px] font-extrabold uppercase tracking-[0.18em] text-[color:var(--color-bold-yellow)]"
              >
                <T en="Done" es="Hecho" />
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Fallback when Shopify refuses to be iframed. Opens the URL in a centred
 * popup window and shows the customer what's happening. They click "Hecho"
 * when they finish updating in the popup.
 */
function FallbackPanel({
  url,
  onCompleted,
}: {
  url: string;
  onCompleted?: () => void;
}) {
  useEffect(() => {
    const w = window.open(
      url,
      "lit-payment-update",
      "width=520,height=720,centerscreen=yes,scrollbars=yes",
    );
    if (!w) {
      // Popup blocked — fall further back to a normal new-tab open.
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, [url]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="lead-label mb-3">
        <T en="Window opened" es="Ventana abierta" />
      </div>
      <h3 className="font-display text-[28px] font-black uppercase leading-[0.95] tracking-[-0.02em] text-[color:var(--color-lit-grey)]">
        <T
          en="Finish updating your payment method in the secure window."
          es="Termina de actualizar tu método de pago en la ventana segura."
        />
      </h3>
      <p className="mt-3 text-[13px] leading-[1.55] text-[color:var(--color-warm-gray)]">
        <T
          en="When you're done, come back here and tap Done so we can refresh your account."
          es="Cuando termines, vuelve aquí y toca Hecho para refrescar tu cuenta."
        />
      </p>
      <button
        type="button"
        onClick={onCompleted}
        className="mt-8 rounded-sm bg-[color:var(--color-lit-grey)] px-8 py-3.5 text-[11px] font-extrabold uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)]"
      >
        <T en="Done" es="Hecho" />
      </button>
    </div>
  );
}

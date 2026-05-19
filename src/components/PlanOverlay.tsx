"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang } from "@/lib/i18n";
import type { Frequency, PricingResponse, Subscription } from "@/lib/types";

const FREQUENCIES: { value: Frequency; en: string; es: string }[] = [
  { value: "15d", en: "Every 15 days", es: "Cada 15 días" },
  { value: "1mo", en: "Every 1 month", es: "Cada 1 mes" },
  { value: "45d", en: "Every 45 days", es: "Cada 45 días" },
  { value: "2mo", en: "Every 2 months", es: "Cada 2 meses" },
  { value: "3mo", en: "Every 3 months", es: "Cada 3 meses" },
  { value: "4mo", en: "Every 4 months", es: "Cada 4 meses" },
  { value: "5mo", en: "Every 5 months", es: "Cada 5 meses" },
  { value: "6mo", en: "Every 6 months", es: "Cada 6 meses" },
];

const BOX_OPTIONS = [1, 2, 3, 4, 5, 6] as const;

interface PricingWithCompare extends PricingResponse {
  compareAtPerBox?: (number | null)[];
}

/**
 * Plan overlay — change box count + frequency.
 *
 * Swaps variant_id (if box count changed) and selling_plan_id (if frequency
 * changed) via PATCH /api/subscription/plan. Pricing read dynamically from
 * Shopify so discount tiers (-25% / -40% / -45%) are reflected live.
 */
export function PlanOverlay({
  subscription,
  onClose,
  onUpdated,
}: {
  subscription: Subscription;
  onClose: () => void;
  onUpdated: (updated: Subscription) => void;
}) {
  const [boxCount, setBoxCount] = useState<number>(subscription.boxCount);
  const [frequency, setFrequency] = useState<Frequency>(subscription.frequency);
  const [pricing, setPricing] = useState<PricingWithCompare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const t = useLang();

  useEffect(() => {
    api<PricingWithCompare>("/api/pricing")
      .then(setPricing)
      .catch(() => null);
  }, []);

  const newPrice = pricing ? pricing.perBox[boxCount - 1] : null;
  const newCompare =
    pricing && pricing.compareAtPerBox ? pricing.compareAtPerBox[boxCount - 1] : null;
  const currentPrice = pricing ? pricing.perBox[subscription.boxCount - 1] : null;

  const hasChange =
    boxCount !== subscription.boxCount || frequency !== subscription.frequency;

  const handleConfirm = async () => {
    if (!hasChange) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Subscription>("/api/subscription/plan", {
        method: "PATCH",
        body: JSON.stringify({ boxCount, frequency }),
      });
      onUpdated(updated);
      setDone(true);
    } catch (e) {
      const err = e as { code?: string; message?: string; status?: number };
      console.error("[plan] PATCH /api/subscription/plan failed", err);
      if (err.code === "cutoff_passed") {
        setError(
          t({
            en: "Too late, your next box ships within 72h.",
            es: "Demasiado tarde, tu próxima caja se envía en 72h.",
          }),
        );
      } else if (err.code === "gateway_timeout" || err.status === 504 || err.status === 502) {
        // Vercel timed out / Shopify storefront fallback. Don't dump HTML
        // on the customer — friendly retry message instead.
        setError(
          t({
            en: "The service is taking longer than usual. Wait a moment and try again.",
            es: "El servicio está tardando más de lo normal. Espera un momento e inténtalo de nuevo.",
          }),
        );
      } else {
        setError(
          t({
            en: "Couldn't update your plan. Try again or contact us.",
            es: "No se pudo cambiar el plan. Inténtalo de nuevo o escríbenos.",
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
      onClick={onClose}
    >
      <div
        className="zone-cream relative mx-auto w-full max-w-lg rounded-t-3xl bg-[color:var(--color-brisky-cream)] px-6 pt-9 pb-8 sm:rounded-3xl"
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

        {done ? (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
              <T en="Plan updated" es="Plan actualizado" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none">
              <T en="All set" es="Listo" />
              <span className="text-[color:var(--color-bold-yellow)]">.</span>
            </h1>
            <p className="mt-3 text-sm opacity-70">
              <T
                en={`Your new plan: ${boxCount} ${boxCount === 1 ? "box" : "boxes"}, every ${FREQUENCIES.find((f) => f.value === frequency)?.en.replace("Every ", "").toLowerCase()}.`}
                es={`Tu plan nuevo: ${boxCount} ${boxCount === 1 ? "caja" : "cajas"}, ${FREQUENCIES.find((f) => f.value === frequency)?.es.toLowerCase()}.`}
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
        ) : (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
              <T en="Change subscription" es="Cambiar suscripción" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none text-[color:var(--color-lit-grey)]">
              <T en="My plan" es="Mi plan" />.
            </h1>

            {/* Box count picker */}
            <div className="mt-6">
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60 mb-3">
                <T en="Boxes per shipment" es="Cajas por envío" />
              </div>
              <div className="grid grid-cols-6 gap-2">
                {BOX_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setBoxCount(n)}
                    className={`rounded-sm py-3 text-sm font-black ${
                      boxCount === n
                        ? "bg-[color:var(--color-lit-grey)] text-[color:var(--color-bold-yellow)]"
                        : "bg-[color:var(--color-sharp-white)] opacity-70"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Frequency picker */}
            <div className="mt-5">
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60 mb-3">
                <T en="Frequency" es="Frecuencia" />
              </div>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as Frequency)}
                className="w-full rounded-sm bg-[color:var(--color-sharp-white)] px-4 py-3 text-sm font-bold uppercase tracking-[0.15em]"
              >
                {FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {t({ en: f.en, es: f.es })}
                  </option>
                ))}
              </select>
            </div>

            {/* Price preview */}
            {pricing && newPrice !== null && (
              <div className="mt-5 rounded-2xl bg-[color:var(--color-sharp-white)] p-5">
                <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
                  <T en="Per shipment" es="Por envío" />
                </div>
                <div className="mt-1 flex items-baseline gap-3">
                  <span className="font-display text-4xl font-black">
                    €{newPrice.toFixed(2)}
                  </span>
                  {newCompare && newCompare > newPrice && (
                    <span className="text-sm line-through opacity-50">
                      €{newCompare.toFixed(2)}
                    </span>
                  )}
                </div>
                {currentPrice !== null && newPrice !== currentPrice && (
                  <div className="mt-1 text-[11px] uppercase tracking-[0.15em] opacity-60">
                    <T en="Was" es="Antes" /> €{currentPrice.toFixed(2)} {" "}
                    {newPrice > currentPrice ? "↑" : "↓"} €
                    {Math.abs(newPrice - currentPrice).toFixed(2)}
                  </div>
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
              onClick={handleConfirm}
              disabled={!hasChange || busy}
              className="mt-6 w-full rounded-sm bg-[color:var(--color-lit-grey)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? (
                <T en="Saving…" es="Guardando…" />
              ) : (
                <T en="Save plan" es="Guardar plan" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 w-full text-[11px] uppercase tracking-[0.18em] opacity-50 underline"
            >
              <T en="Cancel" es="Cancelar" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

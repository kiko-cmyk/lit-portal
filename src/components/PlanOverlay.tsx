"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang } from "@/lib/i18n";
import { compositionLabel, resplitOnBoxChange } from "@/lib/mix";
import { BOX_OPTIONS, FREQUENCIES } from "@/lib/plan-options";
import { DEFAULT_FLAVOR, flavorKeyForVariant } from "@/lib/seal-plans";
import type { Frequency, PricingResponse, Subscription } from "@/lib/types";

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
  initialFrequency,
}: {
  subscription: Subscription;
  onClose: () => void;
  onUpdated: (updated: Subscription) => void;
  /**
   * Cadencia preseleccionada al abrir. La usa el deep link
   * `?action=plan&frequency=` que emite el formulario de perfilado como salida
   * secundaria ("prefiero verlo yo"), para que el cliente aterrice con la
   * propuesta ya marcada en vez de tener que buscarla.
   *
   * Solo cambia el valor INICIAL: a partir de ahí manda el cliente. Y como
   * `hasChange` compara contra la suscripción, abrir así deja el botón de
   * guardar activo desde el primer render, que es el comportamiento que se
   * quiere aquí.
   */
  initialFrequency?: Frequency;
}) {
  const [boxCount, setBoxCount] = useState<number>(subscription.boxCount);
  const [frequency, setFrequency] = useState<Frequency>(
    initialFrequency ?? subscription.frequency,
  );
  const [pricing, setPricing] = useState<PricingWithCompare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const t = useLang();

  useEffect(() => {
    // Price the customer's current flavor (identical across flavors today, but
    // correct if a flavor is ever priced independently).
    const flavorKey = flavorKeyForVariant(subscription.currentVariantId) ?? DEFAULT_FLAVOR;
    api<PricingWithCompare>(`/api/pricing?flavor=${flavorKey}`)
      .then(setPricing)
      .catch(() => null);
  }, [subscription.currentVariantId]);

  const newPrice = pricing ? pricing.perBox[boxCount - 1] : null;
  const newCompare =
    pricing && pricing.compareAtPerBox ? pricing.compareAtPerBox[boxCount - 1] : null;
  // Lo que el cliente paga HOY sale del CONTRATO (chargeTotalCents), nunca del
  // catálogo: un trimestral legacy paga 67,93 y el catálogo ya dice 85,05
  // (escalera web 2026-08-22) — usar el catálogo como "precio actual" falseaba
  // el delta en las dos direcciones y el badge de caja gratis tapaba una subida
  // real de 17,12 €/ciclo (aviso de Kiko, 23-ago-2026).
  const realCurrent = subscription.chargeTotalCents
    ? subscription.chargeTotalCents / 100
    : null;
  const currentPrice =
    realCurrent ?? (pricing ? pricing.perBox[subscription.boxCount - 1] : null);

  const hasChange =
    boxCount !== subscription.boxCount || frequency !== subscription.frequency;

  // Mixed subscription + a box-count change: the split has to be recomputed, and the
  // customer must SEE the result before confirming. The server refuses to guess
  // (409 mix_needs_recomposition territory) precisely so a mix is never silently
  // rebalanced, so the projection is computed here with the same shared function the
  // server would use and sent explicitly.
  const currentMix = subscription.composition ?? [];
  const isMixed = currentMix.length > 1;
  const boxesChanged = boxCount !== subscription.boxCount;
  const projectedMix = isMixed && boxesChanged ? resplitOnBoxChange(currentMix, boxCount) : null;
  const mixCollapses = !!projectedMix && projectedMix.length < currentMix.length;

  // Sin cambio de cajas, el número grande es lo que el cliente PAGA; al mover
  // cajas, el precio de catálogo del destino. El tachado, el badge del pack y la
  // nota 5-6 solo aplican cuando lo mostrado ES el precio de catálogo (un legacy
  // a 90,57 con 4 cajas no tiene el pack y no debe ver "1 caja gratis").
  const displayPrice = !boxesChanged && realCurrent !== null ? realCurrent : newPrice;
  const atCatalog =
    displayPrice !== null && newPrice !== null && Math.abs(displayPrice - newPrice) < 0.005;

  const handleConfirm = async () => {
    if (!hasChange) return;
    setBusy(true);
    setError(null);
    try {
      // Pass the IDs we already have so the backend can skip the
      // expensive Seal pagination scan (Juan 2026-05-19 — cut ~5 s off
      // the route's wall-clock budget). The backend falls back to the
      // slow path if any of these are missing.
      const updated = await api<Subscription>("/api/subscription/plan", {
        method: "PATCH",
        body: JSON.stringify({
          boxCount,
          frequency,
          // Mixed sub changing box count: send the split we SHOWED the customer, so
          // the server applies exactly that instead of inferring one.
          ...(projectedMix ? { mix: projectedMix } : {}),
          sealSubscriptionId: subscription.sealSubscriptionId,
          mainItemId: subscription.mainItemId,
          currentVariantId: subscription.currentVariantId,
          currentFrequency: subscription.frequency,
          expectedLineIds: subscription.lines?.map((l) => l.itemId) ?? undefined,
          // Preserve the customer's current next-ship date. Seal regenerates
          // billing_attempts on any plan change and re-anchors the next charge
          // to "today + interval", which would silently undo a prior skip
          // (e.g. 27-Sep snaps back to ~27-Jul). The backend re-anchors the
          // regenerated attempt back to this date so earlier steps are never
          // reverted. (Juan 2026-06-12.)
          preserveNextShipDate: subscription.nextShipDate,
        }),
      });
      onUpdated(updated);
      setDone(true);
    } catch (e) {
      const err = e as { code?: string; message?: string; status?: number };
      console.error("[plan] PATCH /api/subscription/plan failed", err);
      if (err.code === "cutoff_passed") {
        setError(
          t({
            en: "Too late, your next box ships within 24h.",
            es: "Demasiado tarde, tu próxima caja se envía en 24h.",
          }),
        );
      } else if (err.code === "frequency_change_failed_partial") {
        // The variant DID change (boxes updated) but the cadence didn't.
        // Tell the customer specifically so they don't think everything
        // worked. Suggest the precise retry: pulsar Guardar otra vez.
        setError(
          t({
            en: "Boxes updated, but the frequency couldn't be changed. Press Save again to retry the frequency.",
            es: "Las cajas se actualizaron pero la frecuencia no pudo cambiarse. Pulsa Guardar otra vez para reintentar la frecuencia.",
          }),
        );
      } else if (err.code === "frequency_change_failed") {
        setError(
          t({
            en: "Couldn't change the frequency. Try again in a moment.",
            es: "No se pudo cambiar la frecuencia. Inténtalo de nuevo en un momento.",
          }),
        );
      } else if (err.code === "subscription_changed" || err.code === "mix_requires_explicit_intent") {
        setError(
          t({
            en: "Your subscription changed since this page loaded. Reload and try again.",
            es: "Tu suscripción cambió desde que se cargó esta página. Recárgala y vuelve a intentarlo.",
          }),
        );
      } else if (err.code === "mix_price_mismatch") {
        setError(
          t({
            en: "We couldn't apply your plan at the right price. Nothing was charged differently. Try again.",
            es: "No pudimos aplicar tu plan al precio correcto. No se ha cobrado nada distinto, inténtalo de nuevo.",
          }),
        );
      } else if (err.code === "mix_line_not_recurring") {
        setError(
          t({
            en: "We couldn't apply your plan. Contact us and we'll do it for you.",
            es: "No pudimos aplicar tu plan. Escríbenos y lo hacemos por ti.",
          }),
        );
      } else if (err.code === "variant_change_failed" || err.code === "seal_edit_items_failed") {
        setError(
          t({
            en: "Couldn't change the number of boxes. Try again in a moment.",
            es: "No se pudo cambiar la cantidad de cajas. Inténtalo de nuevo en un momento.",
          }),
        );
      } else if (err.code === "seal_inconsistent_state") {
        // Both items present — Seal got into a state we couldn't safely
        // roll back. Customer needs human help.
        setError(
          t({
            en: "Something went wrong updating your plan. Please contact support so we can fix it.",
            es: "Algo no fue bien actualizando tu plan. Por favor contáctanos y lo arreglamos.",
          }),
        );
      } else if (err.code === "gateway_timeout" || err.status === 504) {
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
      onClick={busy ? undefined : onClose}
    >
      <div
        className="zone-cream relative mx-auto w-full max-w-lg rounded-t-3xl bg-[color:var(--color-brisky-cream)] px-6 pt-9 pb-8 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="absolute right-4 top-4 text-2xl opacity-60 disabled:opacity-30"
        >
          ×
        </button>

        {done ? (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
              <T en="Plan updated" es="Plan actualizado" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none text-[color:var(--color-lit-grey)]">
              <T en="All set" es="Listo" />
            </h1>
            <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">
              <T
                en={`Your new plan: ${boxCount} ${boxCount === 1 ? "box" : "boxes"}, every ${FREQUENCIES.find((f) => f.value === frequency)?.en.replace("Every ", "").toLowerCase()}.`}
                es={`Tu plan nuevo: ${boxCount} ${boxCount === 1 ? "caja" : "cajas"}, ${FREQUENCIES.find((f) => f.value === frequency)?.es.toLowerCase()}.`}
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
        ) : (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
              <T en="Change subscription" es="Cambiar suscripción" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none text-[color:var(--color-lit-grey)]">
              <T en="My plan" es="Mi plan" />
            </h1>

            {/* Box count picker */}
            <div className="mt-6">
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] mb-3">
                <T en="Boxes per shipment" es="Cajas por envío" />
              </div>
              <div className="grid grid-cols-6 gap-2">
                {BOX_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setBoxCount(n)}
                    className={`rounded-[14px] py-3 text-sm font-black ${
                      boxCount === n
                        ? "bg-[color:var(--color-lit-grey)] text-[color:var(--color-bold-yellow)]"
                        : "border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] text-[color:var(--color-warm-gray)]"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Upsell del pack 3+1: con 3 cajas, la 4ª es gratis (escalera web
                2026-08-22). El importe sale SIEMPRE de pricing (nunca hardcodeado);
                mientras pricing es null se muestra la variante sin cifra.
                NO se enseña a un legacy en reposo que paga menos que el catálogo
                (trimestral a 67,93): para él pasar a 4 NO es gratis, es +17,12. */}
            {boxCount === 3 && (boxesChanged || atCatalog) && (
              <div className="mt-4 rounded-[20px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-bold-yellow)]/25 px-5 py-4">
                <p className="text-xs font-bold text-[color:var(--color-lit-grey)]">
                  {pricing ? (
                    <T
                      en={`Add 1 more box and it's FREE: 4 boxes for €${pricing.perBox[3].toFixed(2)} (the price of 3).`}
                      es={`Añade 1 caja más y te sale GRATIS: 4 cajas por €${pricing.perBox[3].toFixed(2)} (el precio de 3).`}
                    />
                  ) : (
                    <T
                      en="Add 1 more box and it's free: 4 boxes for the price of 3."
                      es="Añade 1 caja más y te sale gratis: 4 cajas al precio de 3."
                    />
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => setBoxCount(4)}
                  className="mt-2 rounded-full border border-[color:var(--color-lit-grey)] px-4 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
                >
                  <T en="Take 4" es="Llevarme 4" />
                </button>
              </div>
            )}

            {/* Mixed sub + box change: show the resulting split BEFORE confirming.
                The server never rebalances a mix on its own, so what's shown here is
                literally what gets sent. */}
            {projectedMix && (
              <div className="mt-5 rounded-[20px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-5 py-4">
                <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
                  <T en="Your mix" es="Tu mezcla" />
                </div>
                <div className="mt-1 font-display text-lg font-black uppercase leading-tight text-[color:var(--color-lit-grey)]">
                  {compositionLabel(projectedMix)}
                </div>
                <p className="mt-2 text-[11px] opacity-60">
                  {mixCollapses ? (
                    <T
                      en={`With ${boxCount} box${boxCount > 1 ? "es" : ""} we'll keep ${compositionLabel(projectedMix)}.`}
                      es={`Con ${boxCount} caja${boxCount > 1 ? "s" : ""} mantendremos ${compositionLabel(projectedMix)}.`}
                    />
                  ) : (
                    <T
                      en="We split your boxes to match your new plan. You can adjust it after saving."
                      es="Repartimos tus cajas según el plan nuevo. Puedes ajustarlo después de guardar."
                    />
                  )}
                </p>
              </div>
            )}

            {/* Frequency picker */}
            <div className="mt-5">
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] mb-3">
                <T en="Frequency" es="Frecuencia" />
              </div>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as Frequency)}
                className="w-full rounded-[14px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-4 py-3 text-sm font-bold uppercase tracking-[0.15em] text-[color:var(--color-lit-grey)]"
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
              <div className="mt-5 rounded-[20px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] p-5 shadow-[0_10px_30px_-14px_rgba(40,34,20,0.22)] md:rounded-[22px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
                    <T en="Per shipment" es="Por envío" />
                  </div>
                  {boxCount === 4 && atCatalog && (
                    <span className="rounded-full bg-[color:var(--color-bold-yellow)] px-3 py-1 text-[9px] font-black uppercase tracking-[0.15em] text-[color:var(--color-lit-grey)]">
                      <T en="PACK 3+1 · 1 FREE BOX" es="PACK 3+1 · 1 CAJA GRATIS" />
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-baseline gap-3">
                  <span className="font-display text-4xl font-black text-[color:var(--color-lit-grey)]">
                    €{(displayPrice ?? newPrice).toFixed(2)}
                  </span>
                  {newCompare && atCatalog && displayPrice !== null && newCompare > displayPrice && (
                    <span className="text-sm line-through text-[color:var(--color-warm-gray)]">
                      €{newCompare.toFixed(2)}
                    </span>
                  )}
                </div>
                {boxCount === 4 && atCatalog && (
                  <p className="mt-1 text-[11px] text-[color:var(--color-warm-gray)]">
                    <T
                      en="You pay for 3 boxes and the fourth ships free."
                      es="Pagas 3 cajas y la cuarta te la enviamos gratis."
                    />
                  </p>
                )}
                {boxesChanged &&
                  currentPrice !== null &&
                  newPrice !== null &&
                  Math.abs(newPrice - currentPrice) > 0.004 && (
                  <div className="mt-1 text-[11px] uppercase tracking-[0.15em] text-[color:var(--color-warm-gray)]">
                    <T en="Now you pay" es="Ahora pagas" /> €{currentPrice.toFixed(2)} {" "}
                    {newPrice > currentPrice ? "↑" : "↓"} €
                    {Math.abs(newPrice - currentPrice).toFixed(2)}
                  </div>
                )}
                {boxCount >= 5 && atCatalog && (
                  <p className="mt-1 text-[11px] text-[color:var(--color-warm-gray)]">
                    <T
                      en="Includes the 3+1 pack (1 free box in every shipment)."
                      es="Incluye el pack 3+1 (1 caja gratis en cada envío)."
                    />
                  </p>
                )}
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-[14px] bg-red-50 px-4 py-3 text-xs text-red-700">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleConfirm}
              disabled={!hasChange || busy}
              className="mt-6 w-full rounded-full bg-[color:var(--color-lit-grey)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)] disabled:cursor-not-allowed disabled:opacity-40"
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
              className="mt-2 w-full text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)] underline"
            >
              <T en="Cancel" es="Cancelar" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

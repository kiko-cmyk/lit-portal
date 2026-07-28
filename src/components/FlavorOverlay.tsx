"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang } from "@/lib/i18n";
import {
  ALL_FLAVORS,
  DEFAULT_FLAVOR,
  type FlavorKey,
  flavorKeyForVariant,
} from "@/lib/seal-plans";
import type { Subscription } from "@/lib/types";

/**
 * Flavor overlay — switch the subscription to another flavor (product).
 *
 * A flavor change is a variant swap to another product's variant for the SAME
 * box count, so it goes through PATCH /api/subscription/plan with `flavor`
 * (reusing all its safety: ownership, retention-discount carry-over,
 * verification, rollback). Plan, frequency, price and next-ship date stay put —
 * only the product on the next (and future) boxes changes.
 */
export function FlavorOverlay({
  subscription,
  onClose,
  onUpdated,
}: {
  subscription: Subscription;
  onClose: () => void;
  onUpdated: (updated: Subscription) => void;
}) {
  const currentFlavor: FlavorKey =
    flavorKeyForVariant(subscription.currentVariantId) ?? DEFAULT_FLAVOR;
  const [selected, setSelected] = useState<FlavorKey>(currentFlavor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const t = useLang();

  const hasChange = selected !== currentFlavor;
  const selectedLabel = ALL_FLAVORS.find((f) => f.key === selected)?.label ?? "";

  const handleConfirm = async () => {
    if (!hasChange) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Subscription>("/api/subscription/plan", {
        method: "PATCH",
        body: JSON.stringify({
          flavor: selected,
          // Deliberately DO NOT send boxCount. The backend derives the current
          // box count from the variant map so the swap lands on the same box
          // count, and correctly refuses (409 box_count_unknown) for a legacy
          // sub whose variant isn't mapped — instead of silently downgrading it
          // to 1 box. (The fast-path key is sealSubscriptionId + mainItemId +
          // currentVariantId + currentFrequency; boxCount was never part of it.)
          sealSubscriptionId: subscription.sealSubscriptionId,
          mainItemId: subscription.mainItemId,
          currentVariantId: subscription.currentVariantId,
          currentFrequency: subscription.frequency,
          // A flavor-only swap doesn't regenerate billing_attempts, but we send
          // the date anyway so any combined path keeps the current ship date.
          preserveNextShipDate: subscription.nextShipDate,
        }),
      });
      onUpdated(updated);
      setDone(true);
    } catch (e) {
      const err = e as { code?: string; message?: string; status?: number };
      console.error("[flavor] PATCH /api/subscription/plan failed", err);
      if (err.code === "cutoff_passed") {
        setError(
          t({
            en: "Too late, your next box ships within 24h. You can switch flavor for the box after that.",
            es: "Demasiado tarde, tu próxima caja se envía en 24h. Puedes cambiar el sabor para la caja siguiente.",
          }),
        );
      } else if (err.code === "box_count_unknown") {
        // Legacy/manual sub on an unmapped variant — the backend refuses rather
        // than guess a box count. Route the customer to support.
        setError(
          t({
            en: "We couldn't switch this subscription's flavor automatically. Please contact us and we'll do it for you.",
            es: "No pudimos cambiar el sabor de esta suscripción automáticamente. Escríbenos y lo hacemos por ti.",
          }),
        );
      } else if (err.code === "subscription_changed" || err.code === "mix_requires_explicit_intent") {
        // The subscription changed since this screen loaded (another tab, support), so
        // applying what's on screen would overwrite a state the customer never saw.
        setError(
          t({
            en: "Your subscription changed since this page loaded. Reload and try again.",
            es: "Tu suscripción cambió desde que se cargó esta página. Recárgala y vuelve a intentarlo.",
          }),
        );
      } else if (err.code === "mix_price_mismatch") {
        setError(
          t({
            en: "We couldn't apply your flavors at the right price. Nothing was charged differently. Try again.",
            es: "No pudimos aplicar tus sabores al precio correcto. No se ha cobrado nada distinto, inténtalo de nuevo.",
          }),
        );
      } else if (err.code === "mix_line_not_recurring") {
        setError(
          t({
            en: "We couldn't apply your flavors. Contact us and we'll do it for you.",
            es: "No pudimos aplicar tus sabores. Escríbenos y lo hacemos por ti.",
          }),
        );
      } else if (err.code === "variant_change_failed" || err.code === "seal_add_items_failed" || err.code === "seal_edit_items_failed") {
        setError(
          t({
            en: "Couldn't change your flavor. Try again in a moment.",
            es: "No se pudo cambiar el sabor. Inténtalo de nuevo en un momento.",
          }),
        );
      } else if (err.code === "seal_inconsistent_state") {
        // A repair intent is written and the cron converges it, so promise the
        // customer they won't be double charged instead of just sending them away.
        setError(
          t({
            en: "We're still finishing your change. You won't be charged twice, we'll sort it within the next few minutes.",
            es: "Estamos terminando de aplicar tu cambio. No se te cobrará dos veces, lo dejamos resuelto en unos minutos.",
          }),
        );
      } else if (err.code === "gateway_timeout" || err.status === 504) {
        setError(
          t({
            en: "The service is taking longer than usual. Wait a moment and try again.",
            es: "El servicio está tardando más de lo normal. Espera un momento e inténtalo de nuevo.",
          }),
        );
      } else {
        setError(
          t({
            en: "Couldn't change your flavor. Try again or contact us.",
            es: "No se pudo cambiar el sabor. Inténtalo de nuevo o escríbenos.",
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
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
              <T en="Flavor updated" es="Sabor actualizado" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none">
              <T en="All set" es="Listo" />
            </h1>
            <p className="mt-3 text-sm opacity-70">
              <T
                en={`Your next box will be ${selectedLabel}.`}
                es={`Tu próxima caja será ${selectedLabel}.`}
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
              <T en="My flavor" es="Mi sabor" />
            </h1>
            <p className="mt-3 text-sm opacity-70">
              <T
                en="Choose the flavor for your next boxes. Your plan, frequency, price and ship date stay the same."
                es="Elige el sabor de tus próximas cajas. Tu plan, frecuencia, precio y fecha de envío no cambian."
              />
            </p>

            {/* Flavor picker */}
            <div className="mt-6 space-y-2.5">
              {ALL_FLAVORS.map((f) => {
                const isSelected = selected === f.key;
                const isCurrent = currentFlavor === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setSelected(f.key)}
                    aria-pressed={isSelected}
                    className={`flex w-full items-center justify-between rounded-2xl border px-5 py-4 text-left transition ${
                      isSelected
                        ? "border-[color:var(--color-lit-grey)] bg-[color:var(--color-lit-grey)] text-[color:var(--color-bold-yellow)]"
                        : "border-[color:var(--color-lit-grey)]/12 bg-[color:var(--color-sharp-white)] hover:border-[color:var(--color-lit-grey)]/40"
                    }`}
                  >
                    <span className="font-display text-lg font-black uppercase leading-tight">
                      {f.label}
                    </span>
                    {isCurrent && (
                      <span
                        className={`rounded-sm px-1.5 py-0.5 font-semibold uppercase tracking-[0.18em] ${
                          isSelected
                            ? "bg-[color:var(--color-bold-yellow)]/25 text-[color:var(--color-bold-yellow)]"
                            : "bg-[color:var(--color-lit-grey)]/10 text-[color:var(--color-warm-gray)]"
                        }`}
                        style={{ fontFamily: "var(--font-cond)", fontSize: 9 }}
                      >
                        <T en="Current" es="Actual" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

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
                <T en="Save flavor" es="Guardar sabor" />
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

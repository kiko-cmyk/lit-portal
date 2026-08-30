"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang } from "@/lib/i18n";
import { compositionLabel, type FlavorComposition, resplitOnBoxChange } from "@/lib/mix";
import {
  ALL_FLAVORS,
  DEFAULT_FLAVOR,
  type FlavorKey,
  flavorKeyForVariant,
} from "@/lib/seal-plans";
import type { Subscription } from "@/lib/types";
import { isMixSavable, MixBuilder } from "./MixBuilder";

/** Seed for a fresh mix: one box to the first flavor, the rest to the second, so the
 *  builder opens on a valid 2-flavor split the customer can nudge. */
function evenStart(boxCount: number): FlavorComposition[] {
  const [a, b] = ALL_FLAVORS;
  if (!b) return [{ flavor: a.key, boxes: boxCount }];
  const first = Math.ceil(boxCount / 2);
  return [
    { flavor: a.key, boxes: first },
    { flavor: b.key, boxes: boxCount - first },
  ];
}

/**
 * Flavor overlay — one flavor, or a MIX of flavors across the plan's boxes.
 *
 * Both go through PATCH /api/subscription/plan (single flavor via `flavor`, a mix via
 * `mix`), reusing all its safety: ownership, optimistic concurrency, the
 * retention-discount guard, the money assertion and the idempotent line diff. The
 * plan, frequency, price and ship date stay put — only what's in the boxes changes.
 */
export function FlavorOverlay({
  subscription,
  onClose,
  onUpdated,
  /** Opens the plan overlay — offered when the customer has 1 box and mixing needs 2. */
  onRequestPlanChange,
}: {
  subscription: Subscription;
  onClose: () => void;
  onUpdated: (updated: Subscription) => void;
  onRequestPlanChange?: () => void;
}) {
  const currentFlavor: FlavorKey =
    flavorKeyForVariant(subscription.currentVariantId) ?? DEFAULT_FLAVOR;
  const boxCount = subscription.boxCount;
  const currentComposition = subscription.composition ?? [];
  const currentlyMixed = currentComposition.length > 1;
  // Mixing needs the flag, 2+ boxes and 2+ flavors in the catalogue. Reading a mix is
  // never gated, so an existing mix still opens in mix mode even if the flag is off.
  const canMix = (subscription.canEditMix || currentlyMixed) && boxCount >= 2 && ALL_FLAVORS.length >= 2;

  const [mode, setMode] = useState<"single" | "mix">(currentlyMixed ? "mix" : "single");
  const [selected, setSelected] = useState<FlavorKey>(currentFlavor);
  const [draft, setDraft] = useState<FlavorComposition[]>(() =>
    currentlyMixed ? currentComposition : resplitOnBoxChange(evenStart(boxCount), boxCount),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const t = useLang();

  const target: FlavorComposition[] =
    mode === "mix" ? draft : [{ flavor: selected, boxes: boxCount }];
  const key = (c: FlavorComposition[]) =>
    [...c].sort((a, b) => a.flavor.localeCompare(b.flavor)).map((x) => `${x.flavor}:${x.boxes}`).join("|");
  const hasChange = key(target) !== key(currentComposition.length ? currentComposition : [{ flavor: currentFlavor, boxes: boxCount }]);
  const valid = mode === "mix" ? isMixSavable(draft, boxCount) : true;
  const resultLabel = compositionLabel(target);

  const handleConfirm = async () => {
    if (!hasChange || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Subscription>("/api/subscription/plan", {
        method: "PATCH",
        body: JSON.stringify({
          // A mix carries its own box count (the sum), so `boxCount` is never sent.
          // For a single flavor the backend derives the current box count from the
          // variant map and correctly refuses (409 box_count_unknown) on a legacy
          // sub whose variant isn't mapped, instead of downgrading it to 1 box.
          ...(mode === "mix" ? { mix: draft } : { flavor: selected }),
          sealSubscriptionId: subscription.sealSubscriptionId,
          mainItemId: subscription.mainItemId,
          currentVariantId: subscription.currentVariantId,
          currentFrequency: subscription.frequency,
          // Optimistic concurrency: refuse if the lines moved since this screen
          // loaded, rather than diffing against a state the customer never saw.
          expectedLineIds: subscription.lines?.map((l) => l.itemId) ?? undefined,
          // Neither path regenerates billing_attempts, but send the date anyway so a
          // combined path keeps the current ship date.
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
      } else if (err.code === "price_would_increase" || err.code === "box_count_out_of_range") {
        // El backend se niega a repreciar un contrato de la escalera vieja por un cambio
        // que no toca el número de cajas. No es culpa del cliente y no queremos que se
        // quede sin poder cambiar de sabor: se le pasa a soporte, que lo hace a mano
        // conservando su precio. (24-ago-2026)
        setError(
          t({
            en: "We can't switch this from here without changing your price, and your price shouldn't change. Write to us and we'll do it for you, keeping what you pay today.",
            es: "No podemos cambiarlo desde aquí sin tocarte el precio, y tu precio no debería cambiar. Escríbenos y lo hacemos nosotros, dejándote lo que pagas hoy.",
          }),
        );
      } else if (err.code === "mix_not_enabled") {
        setError(
          t({
            en: "Mixing flavors isn't available on your account yet.",
            es: "Mezclar sabores todavía no está disponible en tu cuenta.",
          }),
        );
      } else if (err.code === "invalid_mix" || err.code === "mix_box_count_mismatch") {
        setError(
          t({
            en: `Check the split: the boxes have to add up to ${boxCount}.`,
            es: `Revisa el reparto: las cajas tienen que sumar ${boxCount}.`,
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
                en={`Your next boxes: ${resultLabel}.`}
                es={`Tus próximas cajas: ${resultLabel}.`}
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
              {canMix ? (
                <T
                  en={`Choose what goes in your ${boxCount} boxes. Your plan, frequency, price and ship date stay the same.`}
                  es={`Elige qué llevan tus ${boxCount} cajas. Tu plan, frecuencia, precio y fecha de envío no cambian.`}
                />
              ) : (
                <T
                  en="Choose the flavor for your next boxes. Your plan, frequency, price and ship date stay the same."
                  es="Elige el sabor de tus próximas cajas. Tu plan, frecuencia, precio y fecha de envío no cambian."
                />
              )}
            </p>

            {/* One box: mixing is impossible, so offer the way out instead of a dead end. */}
            {boxCount === 1 && ALL_FLAVORS.length >= 2 && onRequestPlanChange && (
              <div className="mt-5 rounded-2xl border border-[color:var(--color-lit-grey)]/12 bg-[color:var(--color-sharp-white)] px-5 py-4">
                <p className="text-xs opacity-70">
                  <T
                    en="With 1 box per shipment you get one flavor. Add a second box to mix them."
                    es="Con 1 caja por envío recibes un solo sabor. Añade una segunda caja para mezclarlos."
                  />
                </p>
                <button
                  type="button"
                  onClick={onRequestPlanChange}
                  className="mt-2 text-[11px] font-bold uppercase tracking-[0.18em] underline"
                >
                  <T en="Change my plan" es="Cambiar mi plan" />
                </button>
              </div>
            )}

            {/* Mode switch. Not rendered when mixing isn't possible, so the flag's
                off-state is pixel-identical to what production shows today. */}
            {canMix && (
              <div className="mt-6 flex rounded-sm bg-[color:var(--color-lit-grey)]/8 p-1">
                {(["single", "mix"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={`flex-1 rounded-sm py-2.5 text-[10px] font-black uppercase tracking-[0.18em] transition ${
                      mode === m
                        ? "bg-[color:var(--color-lit-grey)] text-[color:var(--color-bold-yellow)]"
                        : "text-[color:var(--color-lit-grey)]/60"
                    }`}
                  >
                    {m === "single" ? (
                      <T en="One flavor" es="Un solo sabor" />
                    ) : (
                      <T en="Mix" es="Mezcla" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {mode === "mix" && canMix ? (
              <MixBuilder boxCount={boxCount} value={draft} onChange={setDraft} disabled={busy} />
            ) : (
              <div className="mt-6 space-y-2.5">
                {ALL_FLAVORS.map((f) => {
                  const isSelected = selected === f.key;
                  const isCurrent = !currentlyMixed && currentFlavor === f.key;
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
            )}

            {/* The obvious question a customer has about mixing: does it cost more?
                Con 4+ cajas, además, recordar el pack 3+1 (escalera web 2026-08-22). */}
            {canMix && (
              <p className="mt-4 text-center text-[11px] opacity-55">
                {boxCount === 4 ? (
                  <T
                    en="PACK 3+1: you pay for 3 boxes and 1 is free, whatever mix you choose."
                    es="PACK 3+1: pagas 3 cajas y 1 es gratis, elijas la mezcla que elijas."
                  />
                ) : boxCount >= 5 ? (
                  <T
                    en="Includes the 3+1 pack (1 free box), same price however you mix them."
                    es="Incluye el pack 3+1 (1 caja gratis), el mismo precio los mezcles como quieras."
                  />
                ) : (
                  <T
                    en={`${boxCount} boxes, same price however you mix them.`}
                    es={`${boxCount} cajas, el mismo precio los mezcles como quieras.`}
                  />
                )}
              </p>
            )}

            {error && (
              <div className="mt-4 rounded-sm bg-red-50 px-4 py-3 text-xs text-red-700">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleConfirm}
              disabled={!hasChange || !valid || busy}
              className="mt-6 w-full rounded-sm bg-[color:var(--color-lit-grey)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? (
                <T en="Saving…" es="Guardando…" />
              ) : mode === "mix" ? (
                <T en="Save my mix" es="Guardar mi mezcla" />
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

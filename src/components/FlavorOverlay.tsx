"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Lp2Sheet, SheetDoneMark, SheetTitle } from "@/components/Lp2Sheet";
import { formatEuro } from "@/lib/format-price";
import { T, useLang } from "@/lib/i18n";
import { compositionLabel, type FlavorComposition, resplitOnBoxChange } from "@/lib/mix";
import {
  DEFAULT_FLAVOR,
  type FlavorDef,
  type FlavorKey,
  flavorChoices,
  flavorKeyForVariant,
} from "@/lib/seal-plans";
import type { PricingResponse, Subscription } from "@/lib/types";
import { FlavorThumb, isMixSavable, MixBuilder } from "./MixBuilder";

/** Seed for a fresh mix: one box to the first flavor, the rest to the second, so the
 *  builder opens on a valid 2-flavor split the customer can nudge. */
function evenStart(boxCount: number, flavors: FlavorDef[]): FlavorComposition[] {
  const [a, b] = flavors;
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
  // Los sabores que se ofrecen: los que el servidor da por lanzados hoy, más los que la
  // sub ya lleva (Raw no aparece antes de las 17:00 del 29-oct-2026, aunque se lea bien).
  const choices = flavorChoices(subscription.offerableFlavors, [
    currentFlavor,
    ...currentComposition.map((c) => c.flavor),
  ]);
  // Mixing needs the flag, 2+ boxes and 2+ flavors in the catalogue. Reading a mix is
  // never gated, so an existing mix still opens in mix mode even if the flag is off.
  const canMix = (subscription.canEditMix || currentlyMixed) && boxCount >= 2 && choices.length >= 2;

  const [mode, setMode] = useState<"single" | "mix">(currentlyMixed ? "mix" : "single");
  const [selected, setSelected] = useState<FlavorKey>(currentFlavor);
  const [draft, setDraft] = useState<FlavorComposition[]>(() =>
    currentlyMixed ? currentComposition : resplitOnBoxChange(evenStart(boxCount, choices), boxCount),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pricing, setPricing] = useState<PricingResponse | null>(null);
  const t = useLang();

  // Catalogue price for THIS box count, to tell apart a customer on today's ladder
  // from one carrying an older, cheaper contract. Only used to decide whether to
  // show the banner below, so a failed fetch simply means no banner.
  useEffect(() => {
    api<PricingResponse>(`/api/pricing?flavor=${currentFlavor}`)
      .then(setPricing)
      .catch(() => null);
  }, [currentFlavor]);

  /**
   * The customer pays less than today's catalogue for the boxes they get, so they
   * are on a legacy contract we promise not to touch (decision LIT-372, 2026-09-03:
   * these contracts keep their price for as long as they stay subscribed).
   *
   * 514 subscribers are in this position, nearly all on 3 boxes at 67,93 against a
   * catalogue of 85,05. The page already said "your price does not change" in a
   * dimmed line among plan, frequency and ship date, which is precisely the line
   * that matters most to them and the easiest to miss. Hence the explicit banner.
   */
  const catalogueCents =
    pricing && boxCount >= 1 && boxCount <= pricing.perBox.length
      ? Math.round(pricing.perBox[boxCount - 1] * 100)
      : null;
  const keepsLegacyPrice =
    catalogueCents !== null &&
    subscription.chargeTotalCents > 0 &&
    subscription.chargeTotalCents < catalogueCents;
  const legacyPrice = (subscription.chargeTotalCents / 100).toFixed(2).replace(".", ",");

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
        // Desde el 3-sep-2026 un contrato de la escalera vieja CONSERVA su precio al
        // cambiar de sabor, así que este camino ya no es el caso normal: solo quedan las
        // subs cuyas líneas no admiten el reparto en sitio y las que llevan más cajas de
        // las que la escalera sabe tarificar. Sigue siendo cosa nuestra, no del cliente.
        setError(
          t({
            en: "We can't switch this from here without changing your price, and your price shouldn't change. Write to us and we'll do it for you, keeping what you pay today.",
            es: "No podemos cambiarlo desde aquí sin tocarte el precio, y tu precio no debería cambiar. Escríbenos y lo hacemos nosotros, dejándote lo que pagas hoy.",
          }),
        );
      } else if (err.code === "flavor_not_available_yet") {
        // No debería verse: esta pantalla solo ofrece lo que el servidor ya da por
        // lanzado. Queda por si dos relojes de servidor no coinciden por segundos.
        setError(
          t({
            en: "That flavor isn't available yet. Reload the page in a few minutes.",
            es: "Ese sabor todavía no está disponible. Recarga la página en unos minutos.",
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
      } else if (err.code === "seal_busy") {
        // Rechazado antes de tocar nada (14-oct-2026): Seal seguía con un cambio reciente.
        setError(
          t({
            en: "We're still saving a previous change to your subscription. Try again in a couple of minutes; nothing has been changed.",
            es: "Estamos terminando de guardar un cambio anterior en tu suscripción. Inténtalo en un par de minutos; no hemos cambiado nada.",
          }),
        );
      } else if (err.code === "change_unconfirmed") {
        setError(
          t({
            en: "We couldn't confirm your change. Reload the page in a few minutes to see how your flavors ended up and, if they didn't change, try again.",
            es: "No hemos podido confirmar tu cambio. Recarga la página en unos minutos para ver cómo han quedado tus sabores y, si no han cambiado, vuelve a pedirlo.",
          }),
        );
      } else if (
        err.code === "variant_change_failed" ||
        err.code === "variant_change_failed_after_interval" ||
        err.code === "seal_add_items_failed" ||
        err.code === "seal_edit_items_failed"
      ) {
        setError(
          t({
            en: "Couldn't change your flavor. Try again in a moment.",
            es: "No se pudo cambiar el sabor. Inténtalo de nuevo en un momento.",
          }),
        );
      } else if (err.code === "seal_inconsistent_state") {
        // A repair intent is written and the cron settles it, so promise the customer
        // they won't be overcharged instead of just sending them away. It does NOT promise
        // the change will be applied: the cron completes it or confirms it never landed.
        setError(
          t({
            en: "Your change didn't finish applying cleanly. We'll sort it out within a few minutes and you won't be overcharged. Reload the page then to see how your flavors ended up.",
            es: "Tu cambio no ha terminado de aplicarse bien. En unos minutos lo dejamos en orden y no se te cobrará de más. Recarga la página entonces para ver cómo han quedado tus sabores.",
          }),
        );
      } else if (err.code === "plan_change_in_progress" || err.code === "referral_reward_busy") {
        // Igual que en PlanOverlay: rechazado antes de tocar nada, se reintenta en unos segundos.
        setError(
          t({
            en: "We're finishing another update to your subscription. Wait a moment and try again.",
            es: "Estamos terminando otro cambio en tu suscripción. Espera un momento y vuelve a intentarlo.",
          }),
        );
      } else if (err.code === "change_applying") {
        // ESTE cambio entró a medias y el cron lo termina en minutos (14-oct-2026): no es
        // "tu último cambio", es el que acaba de pedir, y repetirlo no hace falta.
        setError(
          t({
            en: "Your new flavors are still being applied. You'll see them on your subscription within a few minutes and you won't be overcharged. No need to save again.",
            es: "Tus sabores nuevos se están terminando de aplicar. En unos minutos los verás en tu suscripción y no se te cobrará de más. No hace falta que lo vuelvas a guardar.",
          }),
        );
      } else if (err.code === "change_in_progress") {
        setError(
          t({
            en: "We're still finishing your last change. Wait a few minutes, reload the page and try again.",
            es: "Todavía estamos terminando de aplicar tu último cambio. Espera unos minutos, recarga la página y vuelve a intentarlo.",
          }),
        );
      } else if (err.code === "gateway_timeout" || err.status === 504) {
        // Same as PlanOverlay since 2026-09-04: the App Proxy gave up, the server may
        // still be mid-swap, so the outcome is UNKNOWN. "Try again" is how the 12798642
        // re-submitted on top of a half-written subscription on 2026-10-02.
        setError(
          t({
            en: "This is taking longer than usual, and your change may still be going through. Reload the page in a moment to see how your flavors ended up, and don't save again in the meantime.",
            es: "Esto está tardando más de lo normal y puede que tu cambio se haya llegado a aplicar. Recarga la página en un momento para ver cómo han quedado tus sabores, y no vuelvas a guardar mientras tanto.",
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
    <Lp2Sheet onClose={onClose} busy={busy} size="lg">

        {done ? (
          <>
            <SheetDoneMark />
            <div className="lp2-eyebrow mt-5">
              <T en="Flavor updated" es="Sabor actualizado" />
            </div>
            <SheetTitle className="mt-2" text={t({ en: "All set", es: "Listo" })} />
            <p className="lp2-text mt-3">
              <T
                en={`Your next boxes: ${resultLabel}.`}
                es={`Tus próximas cajas: ${resultLabel}.`}
              />
            </p>
            <button
              type="button"
              onClick={onClose}
              className="lp2-cta lp2-cta--still mt-7"
            >
              <T en="Back to LIT" es="Volver a LIT" />
            </button>
          </>
        ) : (
          <>
            <div className="lp2-eyebrow">
              <T en="Change subscription" es="Cambiar suscripción" />
            </div>
            <SheetTitle thin={t({ en: "Your", es: "Tu" })} bold={t({ en: "flavor", es: "sabor" })} />
            <p className="lp2-text mt-3">
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

            {/* Legacy contract: say the price is kept, out loud and with the figure.
                The generic line above already promises it, but these customers are the
                ones for whom it is the whole question. */}
            {keepsLegacyPrice && (
              <div className="lp2-notice mt-4 flex items-start gap-3 px-5 py-4">
                {/* Candado en SVG: en el portal no van emojis. */}
                <svg aria-hidden className="mt-0.5 h-4 w-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
                <p className="m-0">
                  <strong className="font-bold">
                    <T
                      en={`You keep your price: ${formatEuro(subscription.chargeTotalCents, "en")} per shipment.`}
                      es={`Mantienes tu precio: ${legacyPrice}€ por envío.`}
                    />
                  </strong>{" "}
                  <T
                    en="Changing flavor does not raise what you pay, however you mix them."
                    es="Cambiar de sabor no te sube lo que pagas, los mezcles como los mezcles."
                  />
                </p>
              </div>
            )}

            {/* One box: mixing is impossible, so offer the way out instead of a dead end. */}
            {boxCount === 1 && choices.length >= 2 && onRequestPlanChange && (
              <div className="lp2-card mt-5 px-5 py-4">
                <p className="text-[12.5px] leading-[1.5] text-[#5E6168]">
                  <T
                    en="With 1 box per shipment you get one flavor. Add a second box to mix them."
                    es="Con 1 caja por envío recibes un solo sabor. Añade una segunda caja para mezclarlos."
                  />
                </p>
                <button
                  type="button"
                  onClick={onRequestPlanChange}
                  className="mt-2.5 cursor-pointer text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#2F343D] underline underline-offset-4"
                >
                  <T en="Change my plan" es="Cambiar mi plan" />
                </button>
              </div>
            )}

            {/* Mode switch. Not rendered when mixing isn't possible, so the flag's
                off-state is pixel-identical to what production shows today. */}
            {canMix && (
              <div className="mt-6 flex rounded-full border border-[#2F343D]/12 bg-white/70 p-1">
                {(["single", "mix"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={`flex-1 cursor-pointer rounded-full py-2.5 text-[10.5px] font-bold uppercase tracking-[0.16em] transition ${
                      mode === m
                        ? "bg-[#2F343D] text-[color:var(--color-bold-yellow)]"
                        : "text-[#5E6168] hover:text-[#2F343D]"
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
              <MixBuilder
                boxCount={boxCount}
                value={draft}
                onChange={setDraft}
                flavors={choices.map((f) => f.key)}
                disabled={busy}
              />
            ) : (
              <div className="mt-6 space-y-2.5">
                {choices.map((f) => {
                  const isSelected = selected === f.key;
                  const isCurrent = !currentlyMixed && currentFlavor === f.key;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => setSelected(f.key)}
                      aria-pressed={isSelected}
                      className={`lp2-choice py-2.5 pl-3.5 ${isSelected ? "is-on" : ""}`}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <FlavorThumb flavor={f.key} />
                        <span className="font-display text-[17px] font-semibold uppercase leading-tight">
                          {f.label}
                        </span>
                      </span>
                      <span className="flex flex-none items-center gap-2.5">
                        {isCurrent && (
                          <span className="lp2-pill bg-[#2F343D]/8 text-[#5E6168]">
                            <T en="Current" es="Actual" />
                          </span>
                        )}
                        <span
                          aria-hidden
                          className={`h-4 w-4 flex-none rounded-full ${
                            isSelected
                              ? "bg-[color:var(--color-bold-yellow)] shadow-[0_0_0_2px_#2F343D]"
                              : "border-[1.5px] border-[#2F343D]/25"
                          }`}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* The obvious question a customer has about mixing: does it cost more?
                Con 4+ cajas, además, recordar el pack 3+1 (escalera web 2026-08-22). */}
            {canMix && (
              <p className="mt-4 mb-0 text-center text-[12px] text-[#8C8E87]">
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
              <div className="lp2-notice lp2-notice--error mt-4">{error}</div>
            )}

            <button
              type="button"
              onClick={handleConfirm}
              disabled={!hasChange || !valid || busy}
              className="lp2-cta mt-6"
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
              className="lp2-link mt-4"
            >
              <T en="Cancel" es="Cancelar" />
            </button>
          </>
        )}
    </Lp2Sheet>
  );
}

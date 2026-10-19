"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Lp2Sheet, SheetDoneMark, SheetTitle } from "@/components/Lp2Sheet";
import { formatEuro } from "@/lib/format-price";
import { T, useLang, useLangValue } from "@/lib/i18n";
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
  /** The request timed out with the outcome unknown: the change may or may not
   *  have landed. Re-submitting from here is what corrupts subscriptions, so the
   *  save button stays locked until the customer reloads (incident 2026-09-04). */
  const [uncertain, setUncertain] = useState(false);
  const t = useLang();
  const lang = useLangValue();

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
  // Un contrato POR DEBAJO del catálogo (la escalera vieja: 67,93 por 3 cajas) que
  // cambia de nº de cajas pasa a pagar catálogo, y eso es una SUBIDA aunque el destino
  // traiga caja gratis. Sin esto, `atCatalog` es true en cuanto boxesChanged (porque
  // displayPrice pasa a ser newPrice) y el cliente veía "PACK 3+1 · 1 CAJA GRATIS"
  // justo al lado de "↑ €17,13": las dos cosas ciertas, juntas leen como una promoción
  // que tapa la subida. Las chapas de regalo se callan cuando el cliente está dejando
  // atrás un precio mejor. (3-sep-2026)
  const leavingBetterRate =
    realCurrent !== null && newPrice !== null && realCurrent < newPrice - 0.005;
  const showsFreeBoxPerks = atCatalog && !leavingBetterRate;

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
            en: "Your plan has changed since you opened this page. Reload it to see how it is now; if it won't let you change it, write to us.",
            es: "Tu plan ha cambiado desde que abriste esta página. Recárgala para ver cómo está ahora; si no te deja cambiarlo, escríbenos.",
          }),
        );
      } else if (err.code === "mix_price_mismatch") {
        setError(
          t({
            en: "We couldn't apply your plan at the right price. Nothing was charged differently. Try again.",
            es: "No pudimos aplicar tu plan al precio correcto. No se ha cobrado nada distinto, inténtalo de nuevo.",
          }),
        );
      } else if (
        err.code === "price_would_increase" ||
        err.code === "box_count_out_of_range" ||
        err.code === "box_count_unknown"
      ) {
        // Esta pantalla manda `mix` cuando la sub ya es split (projectedMix), así que
        // sí puede disparar los 409 de la contención, y sin esta rama el cliente veía
        // "no se pudo cambiar el plan" en vez del "escríbenos". (Aviso de Kiko, 31-ago)
        setError(
          t({
            en: "We can't apply this from here without changing your price, and your price shouldn't change. Write to us and we'll do it for you, keeping what you pay today.",
            es: "No podemos aplicarlo desde aquí sin tocarte el precio, y tu precio no debería cambiar. Escríbenos y lo hacemos nosotros, dejándote lo que pagas hoy.",
          }),
        );
      } else if (err.code === "mix_line_not_recurring") {
        setError(
          t({
            en: "We couldn't apply your plan. Contact us and we'll do it for you.",
            es: "No pudimos aplicar tu plan. Escríbenos y lo hacemos por ti.",
          }),
        );
      } else if (err.code === "repair_net_unavailable") {
        // Rechazado ANTES de tocar nada (16-oct-2026): no se pudo leer la red de escrituras a
        // medias y, desde hoy, eso también frena los cambios de frecuencia.
        setError(
          t({
            en: "We couldn't check your plan just now, so we haven't changed anything. Try again in a moment.",
            es: "Ahora mismo no hemos podido comprobar tu plan, así que no hemos cambiado nada. Inténtalo de nuevo en un momento.",
          }),
        );
      } else if (err.code === "seal_busy") {
        // Rechazado ANTES de tocar nada (14-oct-2026): Seal seguía procesando un cambio
        // reciente de esta sub, y escribir encima es como se pierden los cambios.
        setError(
          t({
            en: "We're still saving a previous change to your subscription. Try again in a couple of minutes; nothing has been changed.",
            es: "Estamos terminando de guardar un cambio anterior en tu suscripción. Inténtalo en un par de minutos; no hemos cambiado nada.",
          }),
        );
      } else if (err.code === "change_unconfirmed") {
        // Seal aceptó el cambio pero no lo enseña: no sabemos si entrará. Ni "reintenta" ni
        // "listo": que mire en unos minutos (14-oct-2026).
        setUncertain(true);
        setError(
          t({
            en: "We couldn't confirm your change. Reload the page in a few minutes to see how your plan ended up and, if it didn't change, try again.",
            es: "No hemos podido confirmar tu cambio. Recarga la página en unos minutos para ver cómo ha quedado tu plan y, si no ha cambiado, vuelve a pedirlo.",
          }),
        );
      } else if (err.code === "frequency_change_failed") {
        setError(
          t({
            en: "We couldn't change the frequency and nothing was changed. Try again in a few minutes.",
            es: "No hemos podido cambiar la frecuencia y no se ha cambiado nada. Inténtalo de nuevo en unos minutos.",
          }),
        );
      } else if (err.code === "variant_change_failed_after_interval") {
        setError(
          t({
            en: "We changed the frequency, but not the boxes. Reload the page and change the boxes again.",
            es: "Hemos cambiado la frecuencia, pero no las cajas. Recarga la página y vuelve a cambiar las cajas.",
          }),
        );
      } else if (
        err.code === "variant_change_failed" ||
        err.code === "seal_edit_items_failed" ||
        err.code === "seal_add_items_failed"
      ) {
        setError(
          t({
            en: "Couldn't change the number of boxes. Try again in a moment.",
            es: "No se pudo cambiar la cantidad de cajas. Inténtalo de nuevo en un momento.",
          }),
        );
      } else if (err.code === "seal_inconsistent_state") {
        // The change stopped halfway (or we can't tell whether it landed). A repair
        // intent is armed and the cron settles it within minutes, so the honest message
        // is "we're sorting it, reload then", and saving again is exactly what must not
        // happen: it would start from the half-written state (incident 2026-10-02).
        setUncertain(true);
        setError(
          t({
            en: "Your change didn't finish applying cleanly. We'll sort it out within a few minutes and you won't be overcharged. Reload the page then to see how your plan ended up.",
            es: "Tu cambio no ha terminado de aplicarse bien. En unos minutos lo dejamos en orden y no se te cobrará de más. Recarga la página entonces para ver cómo ha quedado tu plan.",
          }),
        );
      } else if (err.code === "plan_change_in_progress" || err.code === "referral_reward_busy") {
        // Rechazado ANTES de tocar nada: otro cambio con el cerrojo tomado (un doble
        // clic, o el cron poniendo los 10 € de un referido), o ese descuento que hay
        // que retirar primero. No hay nada a medias: se reintenta en unos segundos.
        setError(
          t({
            en: "We're finishing another update to your subscription. Wait a moment and try again.",
            es: "Estamos terminando otro cambio en tu suscripción. Espera un momento y vuelve a intentarlo.",
          }),
        );
      } else if (err.code === "change_applying") {
        // ESTE cambio entró a medias y el cron lo termina en minutos (14-oct-2026): se le dice
        // qué plan va a ver y que no lo repita. Con el mensaje de `change_in_progress` ("tu
        // último cambio… vuelve a intentarlo") Juan no supo qué había pasado con el suyo.
        setUncertain(true);
        const freq = FREQUENCIES.find((f) => f.value === frequency);
        setError(
          t({
            en: `Your new plan, ${boxCount} ${boxCount === 1 ? "box" : "boxes"} ${freq?.en.toLowerCase() ?? ""}, is still being applied. You'll see it on your subscription within a few minutes and you won't be overcharged. No need to save it again.`,
            es: `Tu plan nuevo, ${boxCount} ${boxCount === 1 ? "caja" : "cajas"} ${freq?.es.toLowerCase() ?? ""}, se está terminando de aplicar. En unos minutos lo verás en tu suscripción y no se te cobrará de más. No hace falta que lo vuelvas a guardar.`,
          }),
        );
      } else if (err.code === "change_in_progress") {
        setUncertain(true);
        setError(
          t({
            en: "We're still finishing your last change. Wait a few minutes, reload the page and try again.",
            es: "Todavía estamos terminando de aplicar tu último cambio. Espera unos minutos, recarga la página y vuelve a intentarlo.",
          }),
        );
      } else if (err.code === "gateway_timeout" || err.status === 504) {
        // The App Proxy gave up at ~10s; the server may still have been mid-swap
        // when it did. So the outcome here is UNKNOWN, not "failed", and telling
        // the customer to try again is the wrong advice: on 2026-09-04 a retry
        // re-sent the same payload against a subscription the first request had
        // already changed, which is how subscriptions ended up holding both the
        // old and the new lines. Ask them to reload and look, never to re-submit.
        setUncertain(true);
        setError(
          t({
            en: "This is taking longer than usual, and your change may still be going through. Reload the page in a moment to see how your plan ended up, and don't save again in the meantime.",
            es: "Esto está tardando más de lo normal y puede que tu cambio se haya llegado a aplicar. Recarga la página en un momento para ver cómo quedó tu plan, y no vuelvas a guardar mientras tanto.",
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
    <Lp2Sheet onClose={onClose} busy={busy} size="lg">

        {done ? (
          <>
            <SheetDoneMark />
            <p className="lp2-eyebrow mt-5">
              <T en="All set" es="Listo" />
            </p>
            <SheetTitle thin={t({ en: "Plan", es: "Plan" })} bold={t({ en: "updated", es: "actualizado" })} />
            <p className="lp2-text mt-3">
              <T
                en={`Your new plan: ${boxCount} ${boxCount === 1 ? "box" : "boxes"}, every ${FREQUENCIES.find((f) => f.value === frequency)?.en.replace("Every ", "").toLowerCase()}.`}
                es={`Tu plan nuevo: ${boxCount} ${boxCount === 1 ? "caja" : "cajas"}, ${FREQUENCIES.find((f) => f.value === frequency)?.es.toLowerCase()}.`}
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
            <p className="lp2-eyebrow">
              <T en="Change subscription" es="Cambiar suscripción" />
            </p>
            <SheetTitle thin={t({ en: "Your", es: "Tu" })} bold={t({ en: "plan", es: "plan" })} />

            {/* Box count picker */}
            <div className="mt-6">
              <span className="lp2-label">
                <T en="Boxes per shipment" es="Cajas por envío" />
              </span>
              <div className="grid grid-cols-6 gap-2">
                {BOX_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setBoxCount(n)}
                    aria-pressed={boxCount === n}
                    className={`lp2-option py-3 text-[18px] ${boxCount === n ? "is-on" : ""}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Upsell del pack 3+1: con 3 cajas, la 4ª es gratis (escalera web
                2026-08-22). El importe sale SIEMPRE de pricing (nunca hardcodeado);
                mientras pricing es null se muestra la variante sin cifra.
                NO se enseña a un legacy que paga menos que el catálogo (trimestral a
                67,93): para él pasar a 4 NO es gratis, es +17,12. Ojo, `boxesChanged`
                por sí solo NO bastaba para respetarlo: en cuanto el legacy movía el
                selector, `atCatalog` se volvía true (displayPrice pasa a ser newPrice)
                y volvía a ver "la 4ª GRATIS" sobre una subida real. (3-sep-2026) */}
            {boxCount === 3 && (boxesChanged || atCatalog) && !leavingBetterRate && (
              <div className="lp2-notice mt-4 px-5 py-4">
                <p className="m-0 font-semibold">
                  {pricing ? (
                    <T
                      en={`Add 1 more box and it's FREE: 4 boxes for ${formatEuro(Math.round(pricing.perBox[3] * 100), "en")} (the price of 3).`}
                      es={`Añade 1 caja más y te sale GRATIS: 4 cajas por ${formatEuro(Math.round(pricing.perBox[3] * 100), "es")} (el precio de 3).`}
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
                  className="mt-3 cursor-pointer rounded-full bg-[#2F343D] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-bold-yellow)]"
                >
                  <T en="Take 4" es="Llevarme 4" />
                </button>
              </div>
            )}

            {/* Mixed sub + box change: show the resulting split BEFORE confirming.
                The server never rebalances a mix on its own, so what's shown here is
                literally what gets sent. */}
            {projectedMix && (
              <div className="lp2-card mt-5 px-5 py-4">
                <span className="lp2-label">
                  <T en="Your mix" es="Tu mezcla" />
                </span>
                <div className="lp2-figure text-[20px] leading-tight">
                  {compositionLabel(projectedMix)}
                </div>
                <p className="mt-2 mb-0 text-[12px] leading-[1.45] text-[#5E6168]">
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
              <span className="lp2-label">
                <T en="Frequency" es="Frecuencia" />
              </span>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as Frequency)}
                className="lp2-field font-semibold"
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
              <div className="lp2-card mt-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="lp2-label mb-0">
                    <T en="Per shipment" es="Por envío" />
                  </span>
                  {boxCount === 4 && showsFreeBoxPerks && (
                    <span className="lp2-pill">
                      <T en="PACK 3+1 · 1 FREE BOX" es="PACK 3+1 · 1 CAJA GRATIS" />
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-baseline gap-3">
                  <span className="lp2-figure text-[38px]">
                    {formatEuro(Math.round((displayPrice ?? newPrice) * 100), lang)}
                  </span>
                  {newCompare && showsFreeBoxPerks && displayPrice !== null && newCompare > displayPrice && (
                    <span className="text-[15px] text-[#8C8E87] line-through">
                      {formatEuro(Math.round(newCompare * 100), lang)}
                    </span>
                  )}
                </div>
                {boxCount === 4 && showsFreeBoxPerks && (
                  <p className="mt-1.5 mb-0 text-[12px] text-[#5E6168]">
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
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#8C8E87]">
                    <T en="Now you pay" es="Ahora pagas" /> {formatEuro(Math.round(currentPrice * 100), lang)}
                    <span aria-hidden>·</span>
                    <span className={newPrice > currentPrice ? "text-[#2F343D]" : "text-[#547862]"}>
                      {newPrice > currentPrice ? "+" : "−"}
                      {formatEuro(Math.round(Math.abs(newPrice - currentPrice) * 100), lang)}
                    </span>
                  </div>
                )}

                {/* BAJAR SIN AHORRAR (4-sep-2026). La escalera cobra lo mismo por 3 que
                    por 4 cajas (85,05 las dos: la 4ª es la gratis del pack), así que
                    bajar de 4 a 3 quita una caja y no baja el recibo ni un céntimo. El
                    bloque del delta de arriba solo se pinta cuando el delta NO es cero,
                    o sea que se callaba justo en el caso en que el cliente sale
                    perdiendo. Cinco clientes ya están pagando 85,05 por 3 cajas. */}
                {boxesChanged &&
                  currentPrice !== null &&
                  newPrice !== null &&
                  boxCount < subscription.boxCount &&
                  Math.abs(newPrice - currentPrice) <= 0.004 && (
                  <div className="lp2-notice mt-3">
                    <T
                      en={`Heads up: ${boxCount} boxes costs the same as ${subscription.boxCount}, ${formatEuro(Math.round(newPrice * 100), "en")}. You would get one box less for the same price, so going back up to ${subscription.boxCount} is the better deal.`}
                      es={`Ojo: ${boxCount} cajas cuestan lo mismo que ${subscription.boxCount}, ${formatEuro(Math.round(newPrice * 100), "es")}. Recibirías una caja menos por el mismo precio, así que te sale mejor quedarte en ${subscription.boxCount}.`}
                    />
                  </div>
                )}
                {boxCount >= 5 && showsFreeBoxPerks && (
                  <p className="mt-1.5 mb-0 text-[12px] text-[#5E6168]">
                    <T
                      en="Includes the 3+1 pack (1 free box in every shipment)."
                      es="Incluye el pack 3+1 (1 caja gratis en cada envío)."
                    />
                  </p>
                )}
              </div>
            )}

            {error && (
              <div className="lp2-notice lp2-notice--error mt-4">{error}</div>
            )}

            <button
              type="button"
              onClick={handleConfirm}
              disabled={!hasChange || busy || uncertain}
              className="lp2-cta mt-6"
            >
              {busy ? (
                <T en="Saving…" es="Guardando…" />
              ) : uncertain ? (
                <T en="Reload to see your plan" es="Recarga para ver tu plan" />
              ) : (
                <T en="Save plan" es="Guardar plan" />
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

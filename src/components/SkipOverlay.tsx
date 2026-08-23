"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { addCycle, subCycle } from "@/lib/cadence";
import { T, useLang } from "@/lib/i18n";
import { BOX_OPTIONS, FREQUENCIES, longerFrequencies } from "@/lib/plan-options";
import type {
  Frequency,
  PricingResponse,
  SkipReason,
  SkipResponse,
  Subscription,
} from "@/lib/types";

/**
 * Skip overlay — now a small retention wizard (bottom-sheet, cream). Per Juan
 * 2026-06-19: instead of a one-tap skip, intercept with up to three steps so a
 * customer about to skip is nudged toward spacing out their cadence (or taking
 * fewer boxes) instead of losing a shipment.
 *
 *   reason  → why are you skipping? (chips, captured for Klaviyo + offer routing)
 *   offer   → "what if you space it out?" frequency / box change with a live
 *             preview of the new next-order date. Spacing uses the plan route in
 *             reanchorMode="natural" so the next order lands on
 *             (last charge + new interval) — it really moves later.
 *   confirm → the original skip confirmation (escape hatch, still one tap)
 *
 * All three entry points (Hub button, Account button, the renewal email's
 * ?action=skip deep-link) open this same overlay, so they inherit the flow.
 *
 * Mutations:
 *   - Spacing  → PATCH /api/subscription/plan (reanchorMode: "natural")
 *   - Skip     → POST  /api/subscription/skip (no 24h cutoff; Seal rejects with
 *                `already_charged` once the charge fires)
 * Analytics: skip_flow_started (open) + skip_retained (saved) via /skip/track,
 * and subscription_skip (carries the reason) from the skip route.
 */

type Step = "reason" | "offer" | "confirm" | "done-skip" | "done-adjust";

const REASONS: { value: SkipReason; en: string; es: string }[] = [
  { value: "not_using_enough", en: "I'm not using it enough", es: "No lo uso lo suficiente" },
  { value: "taking_a_break", en: "Taking a break", es: "Me tomo un descanso" },
  { value: "traveling_or_break", en: "I'm away for a while", es: "Me voy de viaje un tiempo" },
  { value: "budget", en: "It's too expensive", es: "Me parece caro" },
  { value: "other", en: "Other", es: "Otro" },
];

const DATE_OPTS = { weekday: "long", day: "numeric", month: "long" } as const;

interface PricingWithCompare extends PricingResponse {
  compareAtPerBox?: (number | null)[];
}

export function SkipOverlay({
  subscription,
  onClose,
  onSkipped,
  onAdjusted,
}: {
  subscription: Subscription;
  onClose: () => void;
  onSkipped: (newDate: string) => void;
  /** Called when the customer adjusts their plan instead of skipping. */
  onAdjusted: (updated: Subscription) => void;
}) {
  const t = useLang();
  const locale = t({ en: "en-US", es: "es-ES" });

  const longer = longerFrequencies(subscription.frequency);
  // Within 24h of the next charge a plan change is blocked (cutoff_passed), so
  // the spacing offer can't move the imminent order — only skipping is possible.
  const offerAvailable = !subscription.withinCutoff;

  const [step, setStep] = useState<Step>("reason");
  const [reason, setReason] = useState<SkipReason | null>(null);
  const [freeText, setFreeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneSkip, setDoneSkip] = useState<SkipResponse | null>(null);
  const [adjustedDate, setAdjustedDate] = useState<string | null>(null);

  // Offer state. Frequency pre-selects the next longer option so the customer
  // immediately sees the "spaced out" alternative; box count starts unchanged.
  const [offerFreq, setOfferFreq] = useState<Frequency>(longer[0] ?? subscription.frequency);
  const [offerBoxes, setOfferBoxes] = useState<number>(subscription.boxCount);
  const [pricing, setPricing] = useState<PricingWithCompare | null>(null);

  const dryRun =
    typeof window !== "undefined" &&
    !!new URLSearchParams(window.location.search).get("__dry_run");

  // Fire the funnel "started" event once on open, and load pricing for the
  // box-count preview. Both fire-and-forget.
  useEffect(() => {
    api("/api/subscription/skip/track", {
      method: "POST",
      body: JSON.stringify({
        event: "skip_flow_started",
        properties: {
          sealSubscriptionId: subscription.sealSubscriptionId,
          currentFrequency: subscription.frequency,
          currentBoxCount: subscription.boxCount,
        },
      }),
    }).catch(() => undefined);
    api<PricingWithCompare>("/api/pricing").then(setPricing).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentShip = subscription.nextShipDate ? new Date(subscription.nextShipDate) : null;
  // Skip moves the next order forward one cycle of the CURRENT cadence.
  const skipShip = currentShip ? addCycle(currentShip, subscription.frequency) : null;
  // Spacing anchors on the last charge (≈ current next ship − current interval)
  // and adds the NEW interval — matching Seal's natural regeneration. This is
  // a preview; the done screen shows the date the backend returns.
  const anchor = currentShip ? subCycle(currentShip, subscription.frequency) : null;
  const offerNewShip = anchor ? addCycle(anchor, offerFreq) : null;

  const freqChanged = offerFreq !== subscription.frequency;
  const boxesChanged = offerBoxes !== subscription.boxCount;
  const hasOfferChange = freqChanged || boxesChanged;

  const freqOptions: Frequency[] = [subscription.frequency, ...longer];
  const newPrice = pricing ? pricing.perBox[offerBoxes - 1] ?? null : null;
  // Lo que paga HOY sale del CONTRATO, no del catálogo: un trimestral legacy paga
  // 67,93 y el catálogo ya dice 85,05 (escalera web) — el delta se falseaba en las
  // dos direcciones (aviso de Kiko, 23-ago-2026).
  const realCurrent = subscription.chargeTotalCents
    ? subscription.chargeTotalCents / 100
    : null;
  const currentPrice =
    realCurrent ?? (pricing ? pricing.perBox[subscription.boxCount - 1] ?? null : null);
  const displayPrice = !boxesChanged && realCurrent !== null ? realCurrent : newPrice;
  const atCatalog =
    displayPrice !== null && newPrice !== null && Math.abs(displayPrice - newPrice) < 0.005;

  const freqLabel = (f: Frequency) =>
    (FREQUENCIES.find((x) => x.value === f)?.[t({ en: "en", es: "es" }) as "en" | "es"] ?? f)
      .replace(/^Every /, "")
      .toLowerCase();

  const fmt = (d: Date) => d.toLocaleDateString(locale, DATE_OPTS);

  // Offer copy tailored to the reason the customer gave.
  const offerCopy = (() => {
    switch (reason) {
      case "too_much_product":
        return {
          en: "You've got too much. Space it out or take fewer boxes.",
          es: "Te sobra producto. Espácialo o llévate menos cajas.",
        };
      case "not_using_enough":
        return {
          en: "Still going through it? Let's stretch the gap between boxes.",
          es: "¿Aún te queda? Estiremos el tiempo entre cajas.",
        };
      case "taking_a_break":
        return {
          en: "Taking a break? Space it out instead of skipping just one.",
          es: "¿Un descanso? Espácialo en vez de saltar solo uno.",
        };
      case "traveling_or_break":
        return {
          en: "Want a longer breather? Space your cadence instead of skipping one.",
          es: "¿Quieres un respiro más largo? Espacia tu cadencia en vez de saltar una.",
        };
      case "budget":
        return {
          en: "Lighten the cost: fewer boxes or a longer gap between orders.",
          es: "Aligera el gasto: menos cajas o más tiempo entre pedidos.",
        };
      default:
        return {
          en: "What if you adjusted your plan instead of skipping?",
          es: "¿Y si ajustas tu plan en vez de saltar?",
        };
    }
  })();

  const handleContinueFromReason = () => {
    if (!reason || (reason === "other" && !freeText.trim())) return;
    // Within cutoff the spacing offer can't apply — go straight to confirm.
    setStep(offerAvailable ? "offer" : "confirm");
  };

  const handleAdjust = async () => {
    if (!hasOfferChange) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Subscription>("/api/subscription/plan", {
        method: "PATCH",
        body: JSON.stringify({
          boxCount: offerBoxes,
          frequency: offerFreq,
          sealSubscriptionId: subscription.sealSubscriptionId,
          mainItemId: subscription.mainItemId,
          currentVariantId: subscription.currentVariantId,
          currentFrequency: subscription.frequency,
          expectedLineIds: subscription.lines?.map((l) => l.itemId),
          // Skip retention: move the next order to (last charge + new interval)
          // so spacing actually pushes the imminent order later, rather than
          // preserving the current date the way a normal plan change does.
          reanchorMode: "natural",
        }),
      });
      onAdjusted(updated);
      setAdjustedDate(updated.nextShipDate ?? offerNewShip?.toISOString() ?? null);
      setStep("done-adjust");
      // Funnel "saved" event — fire and forget.
      api("/api/subscription/skip/track", {
        method: "POST",
        body: JSON.stringify({
          event: "skip_retained",
          properties: {
            sealSubscriptionId: subscription.sealSubscriptionId,
            reason,
            fromFrequency: subscription.frequency,
            toFrequency: offerFreq,
            fromBoxCount: subscription.boxCount,
            toBoxCount: offerBoxes,
            newNextShipDate: updated.nextShipDate,
          },
        }),
      }).catch(() => undefined);
    } catch (e) {
      const code = (e as { code?: string; status?: number }).code;
      const status = (e as { status?: number }).status;
      setError(
        code === "cutoff_passed"
          ? t({
              en: "Too late, your next box ships within 24h.",
              es: "Demasiado tarde, tu próxima caja se envía en 24h.",
            })
          : code === "gateway_timeout" || status === 504
            ? t({
                en: "The service is taking longer than usual. Wait a moment and try again.",
                es: "El servicio está tardando más de lo normal. Espera un momento e inténtalo de nuevo.",
              })
            : t({
                en: "Couldn't update your plan. Try again or contact us.",
                es: "No se pudo cambiar el plan. Inténtalo de nuevo o escríbenos.",
              }),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSkip = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<SkipResponse>("/api/subscription/skip", {
        method: "POST",
        body: JSON.stringify({
          sealSubscriptionId: subscription.sealSubscriptionId,
          reason,
          freeText: freeText || undefined,
        }),
      });
      setDoneSkip(res);
      onSkipped(res.newNextShipDate);
      setStep("done-skip");
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
      onClick={busy ? undefined : onClose}
    >
      <div
        className="zone-cream relative mx-auto max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-[28px] bg-[color:var(--color-brisky-cream)] px-7 pt-10 pb-8 sm:rounded-[28px]"
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
        {dryRun && (
          <div className="absolute left-4 top-4 rounded-full bg-[color:var(--color-lit-grey)] px-2.5 py-0.5 text-[9px] font-black uppercase tracking-[0.18em] text-[color:var(--color-bold-yellow)]">
            <T en="Simulation" es="Simulación" />
          </div>
        )}

        {/* ───────── Step: reason ───────── */}
        {step === "reason" && (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
              <T en="Skip next order" es="Saltar próximo pedido" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-[1.1] text-[color:var(--color-lit-grey)]">
              <T en="Sure you want to skip?" es="¿Seguro que quieres saltar?" />
            </h1>
            <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">
              <T
                en="Tell us why, and we'll suggest something better than losing a shipment."
                es="Cuéntanos por qué y te proponemos algo mejor que perder un envío."
              />
            </p>

            <ul className="mt-6 space-y-2">
              {REASONS.map((r) => (
                <li key={r.value}>
                  <button
                    type="button"
                    onClick={() => setReason(r.value)}
                    className={`flex w-full items-center justify-between rounded-[14px] border px-4 py-3 text-left text-sm ${
                      reason === r.value
                        ? "border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/15"
                        : "border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)]"
                    }`}
                  >
                    <span>{t({ en: r.en, es: r.es })}</span>
                    {reason === r.value && (
                      <span className="text-[color:var(--color-bold-yellow)]">●</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {reason === "other" && (
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder={t({ en: "Tell us what happened", es: "Cuéntanos qué ha pasado" })}
                rows={2}
                className="mt-3 w-full rounded-[14px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] p-3 text-sm placeholder:opacity-40"
              />
            )}

            <button
              type="button"
              disabled={!reason || (reason === "other" && !freeText.trim())}
              onClick={handleContinueFromReason}
              className="mt-7 w-full rounded-full bg-[color:var(--color-lit-grey)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)] disabled:opacity-40"
            >
              <T en="Continue" es="Continuar" />
            </button>
            <button
              type="button"
              onClick={() => setStep("confirm")}
              className="mt-2 w-full text-[11px] uppercase tracking-[0.18em] opacity-50 underline"
            >
              <T en="Skip anyway" es="Saltar igualmente" />
            </button>
          </>
        )}

        {/* ───────── Step: offer ───────── */}
        {step === "offer" && (
          <>
            <h1 className="font-display text-3xl font-black uppercase leading-[1.1] text-[color:var(--color-lit-grey)]">
              {t(offerCopy)}
            </h1>
            <p className="mt-3 text-xs uppercase tracking-[0.15em] text-[color:var(--color-warm-gray)]">
              <T en="Now" es="Ahora" />:{" "}
              {t({
                en: `${subscription.boxCount} ${subscription.boxCount === 1 ? "box" : "boxes"}, every ${freqLabel(subscription.frequency)}`,
                es: `${subscription.boxCount} ${subscription.boxCount === 1 ? "caja" : "cajas"}, cada ${freqLabel(subscription.frequency)}`,
              })}
            </p>

            {freqOptions.length > 1 && (
              <div className="mt-5">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
                  <T en="New frequency" es="Nueva frecuencia" />
                </div>
                <select
                  value={offerFreq}
                  onChange={(e) => setOfferFreq(e.target.value as Frequency)}
                  className="w-full rounded-[14px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-4 py-3 text-sm font-bold uppercase tracking-[0.15em]"
                >
                  {freqOptions.map((f) => (
                    <option key={f} value={f}>
                      {t({
                        en: FREQUENCIES.find((x) => x.value === f)?.en ?? f,
                        es: FREQUENCIES.find((x) => x.value === f)?.es ?? f,
                      })}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Preview of the next order date */}
            {currentShip && (
              <div className="mt-4 rounded-[20px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] p-5 shadow-[0_10px_30px_-14px_rgba(40,34,20,0.22)]">
                {freqChanged && offerNewShip ? (
                  <>
                    <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
                      <T en="Your next order moves to" es="Tu próximo pedido pasa al" />
                    </div>
                    <div className="mt-1 font-display text-xl font-black uppercase">
                      {fmt(offerNewShip)}
                    </div>
                    <div className="mt-1 text-[11px] uppercase tracking-[0.12em] opacity-50 line-through">
                      {fmt(currentShip)}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
                      <T en="Next order date" es="Fecha de próximo pedido" />
                    </div>
                    <div className="mt-1 font-display text-xl font-black uppercase">
                      {fmt(currentShip)}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Box count */}
            <div className="mt-5">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
                <T en="Boxes per shipment" es="Cajas por envío" />
              </div>
              <div className="grid grid-cols-6 gap-2">
                {BOX_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setOfferBoxes(n)}
                    className={`rounded-[14px] py-3 text-sm font-black ${
                      offerBoxes === n
                        ? "bg-[color:var(--color-lit-grey)] text-[color:var(--color-bold-yellow)]"
                        : "border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] text-[color:var(--color-warm-gray)]"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              {pricing && displayPrice !== null && (
                <div className="mt-2 text-[11px] uppercase tracking-[0.12em] opacity-60">
                  €{displayPrice.toFixed(2)} <T en="per shipment" es="por envío" />
                  {boxesChanged &&
                    currentPrice !== null &&
                    newPrice !== null &&
                    Math.abs(newPrice - currentPrice) > 0.004 && (
                    <>
                      {" "}
                      ({newPrice > currentPrice ? "↑" : "↓"} €
                      {Math.abs(newPrice - currentPrice).toFixed(2)})
                    </>
                  )}
                </div>
              )}
              {/* Pack 3+1 (escalera web): recordatorio compacto — esto es retención,
                  una línea basta. Solo cuando lo mostrado es precio de catálogo:
                  a un legacy que paga menos no se le promete "gratis". */}
              {offerBoxes === 3 && (boxesChanged || atCatalog) && (
                <div className="mt-1 text-[11px] opacity-60">
                  <T
                    en="Add 1 more box and it's free: 4 boxes for the price of 3."
                    es="Añade 1 caja más y te sale gratis: 4 cajas al precio de 3."
                  />
                </div>
              )}
              {offerBoxes === 4 && atCatalog && (
                <div className="mt-1 text-[11px] opacity-60">
                  <T en="PACK 3+1 · 1 free box." es="PACK 3+1 · 1 caja gratis." />
                </div>
              )}
              {offerBoxes >= 5 && atCatalog && (
                <div className="mt-1 text-[11px] opacity-60">
                  <T
                    en="Includes the 3+1 pack (1 free box)."
                    es="Incluye el pack 3+1 (1 caja gratis)."
                  />
                </div>
              )}
            </div>

            {error && (
              <div className="mt-4 rounded-[14px] bg-[color:var(--color-danger)]/10 px-4 py-3 text-xs text-[color:var(--color-danger)]">{error}</div>
            )}

            <button
              type="button"
              disabled={!hasOfferChange || busy}
              onClick={handleAdjust}
              className="mt-6 w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-40"
            >
              {busy ? (
                <T en="Saving…" es="Guardando…" />
              ) : (
                <T en="Update my plan" es="Ajustar mi plan" />
              )}
            </button>
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep("reason")}
                className="text-[11px] uppercase tracking-[0.18em] opacity-50"
              >
                ← <T en="Back" es="Atrás" />
              </button>
              <button
                type="button"
                onClick={() => setStep("confirm")}
                className="text-[11px] uppercase tracking-[0.18em] opacity-50 underline"
              >
                <T en="Skip anyway" es="Saltar igualmente" />
              </button>
            </div>
          </>
        )}

        {/* ───────── Step: confirm skip ───────── */}
        {step === "confirm" && (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
              <T en="Skip next order" es="Saltar próximo pedido" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-[1.1] text-[color:var(--color-lit-grey)]">
              <T en="Need a break?" es="¿Necesitas una pausa?" />
            </h1>
            <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">
              <T
                en="Your subscription will skip one cycle and we'll resume from there."
                es="Tu suscripción se saltará un ciclo y retomaremos desde ahí."
              />
            </p>

            {currentShip && (
              <div className="mt-6 rounded-[20px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] p-5 shadow-[0_10px_30px_-14px_rgba(40,34,20,0.22)]">
                <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
                  <T en="Next order date" es="Fecha de próximo pedido" />
                </div>
                <div className="mt-1 font-display text-xl font-black uppercase opacity-60">
                  {fmt(currentShip)}
                </div>
                {skipShip && (
                  <>
                    <div className="my-4 border-t border-[color:var(--color-lit-grey)]/10" />
                    <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)]">
                      <T en="New next order date" es="Nueva fecha del próximo pedido" />
                    </div>
                    <div className="mt-1 font-display text-xl font-black uppercase">
                      {fmt(skipShip)}
                    </div>
                  </>
                )}
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-[14px] bg-[color:var(--color-danger)]/10 px-4 py-3 text-xs text-[color:var(--color-danger)]">{error}</div>
            )}

            <button
              type="button"
              disabled={busy}
              onClick={handleSkip}
              className="mt-7 w-full rounded-full bg-[color:var(--color-lit-grey)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-brisky-cream)] disabled:opacity-50"
            >
              {busy ? <T en="Skipping…" es="Saltando…" /> : <T en="Confirm skip" es="Confirmar saltar" />}
            </button>
            <button
              type="button"
              onClick={() => setStep(offerAvailable ? "offer" : "reason")}
              className="mt-2 w-full text-[11px] uppercase tracking-[0.18em] opacity-50 underline"
            >
              {offerAvailable ? (
                <T en="See the alternative" es="Ver la alternativa" />
              ) : (
                <T en="Never mind" es="Mejor no" />
              )}
            </button>
          </>
        )}

        {/* ───────── Done: skipped ───────── */}
        {step === "done-skip" && doneSkip && (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
              <T en="Done" es="Listo" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-[1.1]">
              <T en="Skipped" es="Saltado" />
            </h1>
            <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">
              <T en="Your next box now ships on" es="Tu próxima caja sale el" />{" "}
              <strong>{fmt(new Date(doneSkip.newNextShipDate))}</strong>.
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
              className="mt-7 w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
            >
              <T en="Back to LIT" es="Volver a LIT" />
            </button>
          </>
        )}

        {/* ───────── Done: adjusted ───────── */}
        {step === "done-adjust" && (
          <>
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[color:var(--color-warm-gray)]">
              <T en="Plan updated" es="Plan actualizado" />
            </div>
            <h1 className="mt-2 font-display text-4xl font-black uppercase leading-[1.1]">
              <T en="All set" es="Listo" />
            </h1>
            <p className="mt-3 text-sm text-[color:var(--color-warm-gray)]">
              {freqChanged && adjustedDate ? (
                <>
                  <T
                    en="No skip needed. Your next order now lands on"
                    es="Sin saltar nada. Tu próximo pedido llega ahora el"
                  />{" "}
                  <strong>{fmt(new Date(adjustedDate))}</strong>.
                </>
              ) : (
                <T
                  en="Your plan is updated. Nothing skipped."
                  es="Tu plan está actualizado. Sin saltar nada."
                />
              )}
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

"use client";

import { skipErrorMessage } from "@/lib/skip-messages";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { addCycle, spacedFromNext } from "@/lib/cadence";
import { Lp2Sheet, SheetDoneMark, SheetTitle } from "@/components/Lp2Sheet";
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
 *             reanchorMode="fromNext" so the next order lands on
 *             (current next − current interval + new interval), the same date
 *             the preview shows — it really moves later.
 *   confirm → the original skip confirmation (escape hatch, still one tap)
 *
 * All three entry points (Hub button, Account button, the renewal email's
 * ?action=skip deep-link) open this same overlay, so they inherit the flow.
 *
 * Mutations:
 *   - Spacing  → PATCH /api/subscription/plan (reanchorMode: "fromNext")
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
  // Spacing: current next − current interval + new interval. `spacedFromNext` is
  // the SAME function the backend writes the re-anchor intent with, so this
  // preview can't drift from what gets saved. The done screen shows the date the
  // backend returns.
  const offerNewShip = currentShip ? spacedFromNext(currentShip, subscription.frequency, offerFreq) : null;

  const freqChanged = offerFreq !== subscription.frequency;
  const boxesChanged = offerBoxes !== subscription.boxCount;
  const hasOfferChange = freqChanged || boxesChanged;

  const freqOptions: Frequency[] = [subscription.frequency, ...longer];
  // Solo tramos que NO suban de cajas. Esta pantalla es retención: se entra a saltar un
  // envío (y se llega sin pulsar nada desde el deep-link ?action=skip del email de 48 h),
  // así que ofrecer 6 cajas a quien tiene 2 es ofrecer una subida de importe donde el
  // cliente venía a frenar. Misma corrección que ya se hizo en la oferta de "menos cajas"
  // de CancelTakeover en el audit de 2026-07-08. (24-ago-2026)
  // Y tampoco tramos que quiten cajas SIN bajar el importe (4-sep-2026). La escalera
  // cobra lo mismo por 3 que por 4 (85,05: la 4ª es la gratis del pack), así que
  // ofrecerle 3 a quien tiene 4 en una pantalla que promete aligerar el gasto es
  // ofrecerle perder una caja a cambio de nada. Sin precios cargados todavía no se
  // filtra: mejor enseñar el tramo que esconderlo por una carrera de carga.
  const boxOptions = BOX_OPTIONS.filter((n) => {
    if (n > subscription.boxCount) return false;
    if (n === subscription.boxCount || !pricing) return true;
    const p = pricing.perBox[n - 1];
    const actual = pricing.perBox[subscription.boxCount - 1];
    if (p === undefined || actual === undefined) return true;
    return p < actual - 0.004;
  });
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
          // Skip retention: move the next order to (current next − current
          // interval + new interval), the date the preview above shows, so
          // spacing actually pushes the imminent order later, rather than
          // preserving the current date the way a normal plan change does.
          // (Was "natural" = last charge + new interval until 2026-10-02, which
          // for anyone who had skipped did NOT match this preview.)
          reanchorMode: "fromNext",
        }),
      });
      onAdjusted(updated);
      // Solo la fecha que el servidor deja sujeta (16-oct-2026). Si no viene, es que no pudo
      // guardar la intención que la sostiene: prometer aquí la vista previa sería prometer algo
      // que nadie va a cumplir. Sin fecha, la pantalla dice «Tu plan está actualizado».
      setAdjustedDate(updated.nextShipDate ?? null);
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
            : code === "plan_change_in_progress" || code === "referral_reward_busy"
              ? t({
                  en: "We're finishing another update to your subscription. Wait a moment and try again.",
                  es: "Estamos terminando otro cambio en tu suscripción. Espera un momento y vuelve a intentarlo.",
                })
            : code === "subscription_changed"
              ? t({
                  en: "Your subscription changed since this page loaded. Reload and try again.",
                  es: "Tu suscripción ha cambiado desde que abriste esta página. Recárgala y vuelve a intentarlo.",
                })
            : code === "no_pending_attempt"
              ? t({
                  en: "We're still rescheduling your next deliveries. Try again in a couple of minutes; nothing has been changed.",
                  es: "Estamos terminando de reorganizar tus próximos envíos. Inténtalo en un par de minutos; no hemos cambiado nada.",
                })
            : code === "repair_net_unavailable"
              ? t({
                  en: "We couldn't check your subscription just now, so we haven't changed anything. Try again in a moment.",
                  es: "Ahora mismo no hemos podido comprobar tu suscripción, así que no hemos cambiado nada. Inténtalo de nuevo en un momento.",
                })
            : code === "seal_busy"
              ? t({
                  en: "We're still saving a previous change to your subscription. Try again in a couple of minutes; nothing has been changed.",
                  es: "Estamos terminando de guardar un cambio anterior en tu suscripción. Inténtalo en un par de minutos; no hemos cambiado nada.",
                })
            : code === "change_unconfirmed"
              ? t({
                  en: "We couldn't confirm your change. Reload the page in a few minutes to see how your plan ended up and, if it didn't change, try again.",
                  es: "No hemos podido confirmar tu cambio. Recarga la página en unos minutos para ver cómo ha quedado tu plan y, si no ha cambiado, vuelve a pedirlo.",
                })
            : code === "frequency_change_failed"
              ? t({
                  en: "We couldn't change the frequency and nothing was changed. Try again in a few minutes.",
                  es: "No hemos podido cambiar la frecuencia y no se ha cambiado nada. Inténtalo de nuevo en unos minutos.",
                })
            : code === "change_applying"
              ? t({
                  en: "Your change is still being applied. You'll see it on your subscription within a few minutes and you won't be overcharged. No need to do it again.",
                  es: "Tu cambio se está terminando de aplicar. En unos minutos lo verás en tu suscripción y no se te cobrará de más. No hace falta que lo repitas.",
                })
            : code === "change_in_progress"
              ? t({
                  en: "We're still finishing your last change. Wait a few minutes, reload the page and try again.",
                  es: "Todavía estamos terminando de aplicar tu último cambio. Espera unos minutos, recarga la página y vuelve a intentarlo.",
                })
            : code === "seal_inconsistent_state"
              ? t({
                  en: "Your change didn't finish applying cleanly. We'll sort it out within a few minutes and you won't be overcharged. Reload the page then to see how your plan ended up.",
                  es: "Tu cambio no ha terminado de aplicarse bien. En unos minutos lo dejamos en orden y no se te cobrará de más. Recarga la página entonces para ver cómo ha quedado tu plan.",
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
          // El envío que se le enseñó (14-oct-2026): el servidor salta ESE y, si ya estaba
          // saltado (un intento anterior que entró sin respuesta), no salta otro.
          expectedNextShipDate: subscription.nextShipDate,
        }),
      });
      setDoneSkip(res);
      onSkipped(res.newNextShipDate);
      setStep("done-skip");
    } catch (e) {
      const code = (e as { code?: string }).code;
      const status = (e as { status?: number }).status;
      setError(skipErrorMessage(code, status, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Lp2Sheet
      onClose={onClose}
      busy={busy}
      size="lg"
      corner={
        dryRun ? (
          <span className="lp2-pill bg-[#2F343D] text-[color:var(--color-bold-yellow)]">
            <T en="Simulation" es="Simulación" />
          </span>
        ) : undefined
      }
    >

        {/* ───────── Step: reason ───────── */}
        {step === "reason" && (
          <>
            <div className="lp2-eyebrow">
              <T en="Skip next order" es="Saltar próximo pedido" />
            </div>
            <SheetTitle className="mt-2" text={t({ en: "Sure you want to skip?", es: "¿Seguro que quieres saltar?" })} />
            <p className="lp2-text mt-3">
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
                    className={`lp2-choice ${reason === r.value ? "is-on" : ""}`}
                  >
                    <span>{t({ en: r.en, es: r.es })}</span>
                    {/* La marca se ve también vacía, como en la encuesta y la
                        cancelación: se sabe de entrada que se elige una. */}
                    <span
                      aria-hidden
                      className={`h-4 w-4 flex-none rounded-full ${
                        reason === r.value
                          ? "bg-[color:var(--color-bold-yellow)] shadow-[0_0_0_2px_#2F343D]"
                          : "border-[1.5px] border-[#2F343D]/25"
                      }`}
                    />
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
                className="lp2-field mt-3"
              />
            )}

            <button
              type="button"
              disabled={!reason || (reason === "other" && !freeText.trim())}
              onClick={handleContinueFromReason}
              className="lp2-cta mt-7"
            >
              <T en="Continue" es="Continuar" />
            </button>
            <button
              type="button"
              onClick={() => setStep("confirm")}
              className="lp2-link mt-4"
            >
              <T en="Skip anyway" es="Saltar igualmente" />
            </button>
          </>
        )}

        {/* ───────── Step: offer ───────── */}
        {step === "offer" && (
          <>
            <SheetTitle size="sm" className="" text={t(offerCopy)} />
            <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.14em] text-[#8C8E87]">
              <T en="Now" es="Ahora" />:{" "}
              {t({
                en: `${subscription.boxCount} ${subscription.boxCount === 1 ? "box" : "boxes"}, every ${freqLabel(subscription.frequency)}`,
                es: `${subscription.boxCount} ${subscription.boxCount === 1 ? "caja" : "cajas"}, cada ${freqLabel(subscription.frequency)}`,
              })}
            </p>

            {freqOptions.length > 1 && (
              <div className="mt-5">
                <div className="lp2-eyebrow mb-2">
                  <T en="New frequency" es="Nueva frecuencia" />
                </div>
                <select
                  value={offerFreq}
                  onChange={(e) => setOfferFreq(e.target.value as Frequency)}
                  className="lp2-field"
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
              <div className="lp2-card mt-4">
                {freqChanged && offerNewShip ? (
                  <>
                    <div className="lp2-eyebrow">
                      <T en="Your next order moves to" es="Tu próximo pedido pasa al" />
                    </div>
                    <div className="lp2-figure mt-1 text-[22px]">
                      {fmt(offerNewShip)}
                    </div>
                    <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#8C8E87] line-through">
                      {fmt(currentShip)}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="lp2-eyebrow">
                      <T en="Next order date" es="Fecha de próximo pedido" />
                    </div>
                    <div className="lp2-figure mt-1 text-[22px]">
                      {fmt(currentShip)}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Box count. Oculto cuando no hay nada que ofrecer: con 1 caja el único
                tramo posible es el que ya tiene, y un selector de una sola opción
                inerte solo estorba en una pantalla de retención. */}
            {boxOptions.length > 1 && (
            <div className="mt-5">
              <div className="lp2-eyebrow mb-2">
                <T en="Boxes per shipment" es="Cajas por envío" />
              </div>
              <div className="grid grid-cols-6 gap-2">
                {boxOptions.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setOfferBoxes(n)}
                    aria-pressed={offerBoxes === n}
                    className={`lp2-option py-3 text-[18px] ${offerBoxes === n ? "is-on" : ""}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              {pricing && displayPrice !== null && (
                <div className="mt-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[#8C8E87]">
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
                <div className="mt-1 text-[12px] text-[#5E6168]">
                  <T
                    en="Add 1 more box and it's free: 4 boxes for the price of 3."
                    es="Añade 1 caja más y te sale gratis: 4 cajas al precio de 3."
                  />
                </div>
              )}
              {offerBoxes === 4 && atCatalog && (
                <div className="mt-1 text-[12px] text-[#5E6168]">
                  <T en="PACK 3+1 · 1 free box." es="PACK 3+1 · 1 caja gratis." />
                </div>
              )}
              {offerBoxes >= 5 && atCatalog && (
                <div className="mt-1 text-[12px] text-[#5E6168]">
                  <T
                    en="Includes the 3+1 pack (1 free box)."
                    es="Incluye el pack 3+1 (1 caja gratis)."
                  />
                </div>
              )}
            </div>
            )}

            {error && (
              <div className="lp2-notice lp2-notice--error mt-4">{error}</div>
            )}

            <button
              type="button"
              disabled={!hasOfferChange || busy}
              onClick={handleAdjust}
              className="lp2-cta mt-6"
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
                className="cursor-pointer text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#5E6168]"
              >
                ← <T en="Back" es="Atrás" />
              </button>
              <button
                type="button"
                onClick={() => setStep("confirm")}
                className="cursor-pointer text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#5E6168] underline underline-offset-4"
              >
                <T en="Skip anyway" es="Saltar igualmente" />
              </button>
            </div>
          </>
        )}

        {/* ───────── Step: confirm skip ───────── */}
        {step === "confirm" && (
          <>
            <div className="lp2-eyebrow">
              <T en="Skip next order" es="Saltar próximo pedido" />
            </div>
            <SheetTitle className="mt-2" text={t({ en: "Need a break?", es: "¿Necesitas una pausa?" })} />
            <p className="lp2-text mt-3">
              <T
                en="Your subscription will skip one cycle and we'll resume from there."
                es="Tu suscripción se saltará un ciclo y retomaremos desde ahí."
              />
            </p>

            {currentShip && (
              <div className="lp2-card mt-6">
                <div className="lp2-eyebrow">
                  <T en="Next order date" es="Fecha de próximo pedido" />
                </div>
                <div className="lp2-figure mt-1 text-[22px] text-[#8C8E87]">
                  {fmt(currentShip)}
                </div>
                {skipShip && (
                  <>
                    <div className="my-4 border-t border-[#2F343D]/12" />
                    <div className="lp2-eyebrow">
                      <T en="New next order date" es="Nueva fecha del próximo pedido" />
                    </div>
                    <div className="lp2-figure mt-1 text-[22px]">
                      {fmt(skipShip)}
                    </div>
                  </>
                )}
              </div>
            )}

            {error && (
              <div className="lp2-notice lp2-notice--error mt-4">{error}</div>
            )}

            <button
              type="button"
              disabled={busy}
              onClick={handleSkip}
              className="lp2-cta mt-7"
            >
              {busy ? <T en="Skipping…" es="Saltando…" /> : <T en="Confirm skip" es="Confirmar saltar" />}
            </button>
            <button
              type="button"
              onClick={() => setStep(offerAvailable ? "offer" : "reason")}
              className="lp2-link mt-4"
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
            <SheetDoneMark />
            <div className="lp2-eyebrow mt-5">
              <T en="Done" es="Listo" />
            </div>
            <SheetTitle className="mt-2" text={t({ en: "Skipped", es: "Saltado" })} />
            <p className="lp2-text mt-3">
              <T en="Your next box now ships on" es="Tu próxima caja sale el" />{" "}
              <strong>{fmt(new Date(doneSkip.newNextShipDate))}</strong>.
            </p>
            <p className="mt-3 text-[12px] leading-[1.5] text-[#8C8E87]">
              <T
                en="You can undo this until your new ship date approaches."
                es="Puedes deshacer hasta que se acerque la nueva fecha."
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
        )}

        {/* ───────── Done: adjusted ───────── */}
        {step === "done-adjust" && (
          <>
            <SheetDoneMark />
            <div className="lp2-eyebrow mt-5">
              <T en="Plan updated" es="Plan actualizado" />
            </div>
            <SheetTitle className="mt-2" text={t({ en: "All set", es: "Listo" })} />
            <p className="lp2-text mt-3">
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
              className="lp2-cta lp2-cta--still mt-7"
            >
              <T en="Back to LIT" es="Volver a LIT" />
            </button>
          </>
        )}
    </Lp2Sheet>
  );
}

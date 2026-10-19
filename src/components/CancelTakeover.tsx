"use client";

import { skipErrorMessage } from "@/lib/skip-messages";
import { useEffect, useState } from "react";
import { api, clearSelectedSubscription, clearSessionToken } from "@/lib/api-client";
import { addCycle, spacedFromNext } from "@/lib/cadence";
import { T, useLang, useLangValue } from "@/lib/i18n";
import { SheetArrow, SheetClose, SheetDoneMark, SheetTitle } from "@/components/Lp2Sheet";
import { FlavorThumb } from "@/components/MixBuilder";
import { formatEuro } from "@/lib/format-price";
import { frequencyLabel } from "@/lib/frequency-label";
import { compositionLabel } from "@/lib/mix";
import { BOX_OPTIONS, longerFrequencies } from "@/lib/plan-options";
import { portalHref } from "@/lib/portal-link";
import {
  ALL_FLAVORS,
  BOX_COUNT_BY_VARIANT,
  DEFAULT_FLAVOR,
  type FlavorKey,
  flavorKeyForVariant,
} from "@/lib/seal-plans";
import type {
  CancelStep1Response,
  CancelStep4Response,
  CancellationReason,
  CustomerProfile,
  Frequency,
  PricingResponse,
  Subscription,
} from "@/lib/types";

/**
 * Cancel takeover — full-screen Board 3. Retention redesign (2026-07-03),
 * bilingual EN/ES. Since the lp2 redesign (Juan 2026-10-13) it wears the
 * landing's dark (#262A32) instead of the indigo, with the `lp2-*` pieces in
 * their `.lp2-dark` variant: lime CTA, two-weight titles, quiet cards.
 *
 *   logro     → "what you've built" (stats)
 *   motivo    → reason FIRST, so the offer can be tailored
 *   solucion  → tailored, no-discount solution INLINE per reason (same indigo
 *               takeover): "Me parece caro" → fewer boxes (real price);
 *               "No lo uso" → space out (real next-order date); "Me tomo un
 *               descanso" → skip the next. Applied via /plan or /skip directly.
 *   descuento → 15% off the NEXT charge, only if they reject the solution (or
 *               directly for "Otro"). Last resort. Applied via
 *               /api/subscription/retention-discount (next-charge-only).
 *   confirmar → final cancellation.
 *
 * "No me gusta" gets a "try the other flavor" offer in `solucion` (a flavor
 * swap keeps plan/price/date). "Otro" has no plan fix → skips to `descuento`.
 */
type Step = "logro" | "motivo" | "solucion" | "descuento" | "done-stayed" | "confirmar" | "done";
type StayMsg = { en: string; es: string };

const REASONS: { value: CancellationReason; en: string; es: string }[] = [
  { value: "not_using_enough", en: "I'm not using it enough", es: "No lo uso lo suficiente" },
  { value: "taking_a_break", en: "Taking a break", es: "Me tomo un descanso" },
  { value: "dont_like", en: "I don't like it", es: "No me gusta" },
  { value: "too_expensive", en: "Too expensive", es: "Me parece caro" },
  { value: "other", en: "Other", es: "Otro" },
];

/** Tailored no-discount solution per reason (null → straight to the 15%). */
function solutionFor(reason: CancellationReason | null): "plan" | "skip" | "flavor" | null {
  switch (reason) {
    case "not_using_enough":
    case "too_expensive":
      return "plan"; // space out / fewer boxes
    case "taking_a_break":
      return "skip"; // skip the next one
    case "dont_like":
      return "flavor"; // try the other flavor before leaving
    default:
      return null; // other, too_much_product
  }
}

/**
 * Whether the "try another flavor" offer can be shown for "No me gusta": the sub
 * must be on a mapped variant (so we know its box count for the swap) and there
 * must be at least one OTHER flavor to switch to. Legacy/unmapped subs fall
 * through to the 15% instead of being offered a swap the backend would refuse.
 */
function hasFlavorAlternative(sub: Subscription | null): boolean {
  if (!sub?.currentVariantId) return false;
  if (BOX_COUNT_BY_VARIANT[sub.currentVariantId] == null) return false;
  // A mixed subscriber always has an alternative: adjust the mix. Deriving a single
  // "current flavor" from the variant here would report a mix as its dominant flavor
  // and offer "switch to Watermelon", which SILENTLY DESTROYS the mix under a promise
  // of "same plan, same price, same ship date".
  const composition = sub.composition ?? [];
  if (composition.length > 1) return true;
  const current = composition[0]?.flavor ?? flavorKeyForVariant(sub.currentVariantId) ?? DEFAULT_FLAVOR;
  return ALL_FLAVORS.some((f) => f.key !== current);
}

export function CancelTakeover({
  subscription,
  onClose,
}: {
  /** Unused inside the component; optional so the Hub can open the flow even
   *  when the /api/customer profile fetch failed (customer === null). */
  customer?: CustomerProfile | null;
  subscription: Subscription | null;
  onClose: () => void;
  /** Legacy pivot callbacks (solutions are now inline; kept for call-site compat). */
  onPivotToSkip?: () => void;
  onPivotToPlan?: () => void;
}) {
  const [step, setStep] = useState<Step>("logro");
  const [stats, setStats] = useState<CancelStep1Response["data"] | null>(null);
  const [reason, setReason] = useState<CancellationReason | null>(null);
  const [freeText, setFreeText] = useState("");
  const [pricing, setPricing] = useState<PricingResponse | null>(null);
  const [stayedMsg, setStayedMsg] = useState<StayMsg | null>(null);
  const [done, setDone] = useState<CancelStep4Response | null>(null);
  const [exitBusy, setExitBusy] = useState(false);
  const lang = useLangValue();

  useEffect(() => {
    api<CancelStep1Response>("/api/subscription/cancel", {
      method: "POST",
      body: JSON.stringify({ step: 1 }),
    })
      .then((r) => setStats(r.data))
      .catch(() => null);
    api<PricingResponse>("/api/pricing").then(setPricing).catch(() => null);
  }, []);

  // Persist the reason (cancel API step 3), then route to the tailored solution
  // or straight to the 15%.
  const handleReasonContinue = async () => {
    if (!reason || (reason === "other" && !freeText.trim())) return;
    await api("/api/subscription/cancel", {
      method: "POST",
      body: JSON.stringify({ step: 3, primaryReason: reason, freeText }),
    }).catch(() => null);
    // Skip solution screens that have nothing to offer (audit 2026-07-08):
    // "Me parece caro" with a single box has no smaller plan (every option
    // would RAISE the charge), and "No lo uso" at the longest cadence (6mo)
    // has nothing longer — both used to render a dead-end offer with a
    // permanently disabled CTA. Go straight to the 15% instead.
    const sol = solutionFor(reason);
    const noSmallerPlan =
      reason === "too_expensive" && (subscription?.boxCount ?? 1) <= 1;
    const noLongerCadence =
      reason === "not_using_enough" &&
      longerFrequencies(subscription?.frequency ?? "1mo").length === 0;
    // Also skip the flavor offer within the 24h cutoff: the plan route blocks
    // ALL changes then (cutoff_passed), so the offer would be a click-then-fail
    // dead-end AND its "in your next box" copy would be false (the imminent box
    // is locked). Fall through to the 15%, which is still actionable. (The copy
    // is more specific than the sibling offers, so we gate it where they don't.)
    const noFlavorAlt =
      reason === "dont_like" &&
      (!hasFlavorAlternative(subscription) || !!subscription?.withinCutoff);
    setStep(
      sol && !noSmallerPlan && !noLongerCadence && !noFlavorAlt ? "solucion" : "descuento",
    );
  };

  // Exit after a REAL cancel (DoneState button and the × on the done step).
  // Single-sub: the server purged every session, so log out client-side too
  // and hand back to the storefront — staying would only show stale state.
  // Multi-sub with another ACTIVE sub retained: the server kept the sessions
  // on purpose so the customer can manage the remaining sub — do NOT log
  // them out; drop the (now cancelled) selection and reload the Hub, where
  // the gate re-resolves the remaining subscription. (audit 2026-07-08)
  const exitAfterCancel = async () => {
    if (exitBusy) return;
    setExitBusy(true);
    if (done?.retainsActiveSub) {
      clearSelectedSubscription();
      window.location.replace(portalHref(lang, "home"));
      return;
    }
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch (e) {
      console.warn("[cancel-done] logout failed, exiting anyway", e);
    } finally {
      clearSessionToken();
      window.location.replace("https://litsalt.com/");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="lp2-dark fixed inset-0 z-50 overflow-y-auto bg-[#262A32] text-[#F2F1EA]"
      style={{
        backgroundImage:
          "radial-gradient(120% 55% at 50% 0%, rgba(235,238,98,0.07), transparent 55%)",
      }}
    >
      {/* After a REAL cancel the plain onClose would drop the customer back
          on a stale ACTIVE Hub (single-sub: the refetch 401s because the
          server purged the sessions, and the empty catch swallowed it) — the
          × must exit exactly like "Volver a LIT". (audit 2026-07-08) */}
      <SheetClose
        dark
        onClose={step === "done" && done ? exitAfterCancel : onClose}
        className="absolute right-5 top-[calc(1.25rem+var(--safe-top))]"
      />

      <div className="mx-auto max-w-md px-6 pt-20 pb-12 sm:max-w-lg md:max-w-2xl md:pt-28">
        {step === "logro" && (
          <Logro stats={stats} onStay={onClose} onContinue={() => setStep("motivo")} />
        )}
        {step === "motivo" && (
          <Motivo
            reason={reason}
            setReason={setReason}
            freeText={freeText}
            setFreeText={setFreeText}
            onContinue={handleReasonContinue}
            onBack={() => setStep("logro")}
          />
        )}
        {step === "solucion" && (
          <Solucion
            reason={reason}
            subscription={subscription}
            pricing={pricing}
            onStayed={(msg) => {
              setStayedMsg(msg ?? { en: "Your plan is updated.", es: "Tu plan está actualizado." });
              setStep("done-stayed");
            }}
            onDecline={() => setStep("descuento")}
            onBack={() => setStep("motivo")}
          />
        )}
        {step === "descuento" && (
          <Descuento
            subscription={subscription}
            pricing={pricing}
            reason={reason}
            onKept={() => {
              setStayedMsg({
                en: "Your 15% is set for your next order.",
                es: "Tu 15% ya está listo para tu próximo pedido.",
              });
              setStep("done-stayed");
            }}
            onStay={onClose}
            onDecline={() => setStep("confirmar")}
          />
        )}
        {step === "done-stayed" && <DoneStayed msg={stayedMsg} onClose={onClose} />}
        {step === "confirmar" && (
          <Confirmar
            subscription={subscription}
            onConfirm={async () => {
              const res = await api<CancelStep4Response>("/api/subscription/cancel", {
                method: "POST",
                body: JSON.stringify({
                  step: 4,
                  primaryReason: reason,
                  freeText,
                  effectiveAfterNextDelivery: true,
                  sealSubscriptionId: subscription?.sealSubscriptionId,
                }),
              });
              setDone(res);
              setStep("done");
            }}
            onBack={() => setStep("descuento")}
          />
        )}
        {step === "done" && done && (
          <DoneState
            retainsActiveSub={!!done.retainsActiveSub}
            busy={exitBusy}
            onExit={exitAfterCancel}
          />
        )}
      </div>
    </div>
  );
}

function Logro({
  stats,
  onStay,
  onContinue,
}: {
  stats: CancelStep1Response["data"] | null;
  onStay: () => void;
  onContinue: () => void;
}) {
  const t = useLang();
  const loading = stats === null;
  return (
    <>
      <SheetTitle
        size="lg"
        className=""
        thin={t({ en: "This is what", es: "Esto es lo que" })}
        bold={t({ en: "you've built", es: "has construido" })}
      />
      <div className="mt-10 grid grid-cols-2 gap-3 md:gap-4">
        <Stat label={t({ en: "Boxes received", es: "Cajas recibidas" })} value={stats?.boxes ?? 0} loading={loading} />
        <Stat
          label={t({ en: "Months in inner circle", es: "Meses en inner circle" })}
          value={stats?.monthsInCircle ?? 0}
          loading={loading}
        />
      </div>
      <div className="mt-10 space-y-5">
        <button type="button" onClick={onStay} className="lp2-cta">
          <T en="Stay with LIT" es="Seguir con LIT" />
        </button>
        <button type="button" onClick={onContinue} className="lp2-link">
          <T en="I still want to cancel" es="Aún así quiero cancelar" />
        </button>
      </div>
    </>
  );
}

function Motivo({
  reason,
  setReason,
  freeText,
  setFreeText,
  onContinue,
  onBack,
}: {
  reason: CancellationReason | null;
  setReason: (r: CancellationReason) => void;
  freeText: string;
  setFreeText: (s: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const t = useLang();
  return (
    <>
      <div className="lp2-eyebrow">
        <T en="Help us understand" es="Ayúdanos a entender" />
      </div>
      <SheetTitle
        size="lg"
        className="mt-3"
        thin={t({ en: "Why are you", es: "¿Por qué lo" })}
        bold={t({ en: "leaving?", es: "dejas?" })}
      />
      <ul className="mt-8 space-y-2">
        {REASONS.map((r) => (
          <li key={r.value}>
            <button
              type="button"
              onClick={() => setReason(r.value)}
              aria-pressed={reason === r.value}
              className={`lp2-choice ${reason === r.value ? "is-on" : ""}`}
            >
              <span>{t({ en: r.en, es: r.es })}</span>
              <RadioMark on={reason === r.value} />
            </button>
          </li>
        ))}
      </ul>
      {reason === "other" && (
        <textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder={t({ en: "Tell us what happened", es: "Cuéntanos qué ha pasado" })}
          className="lp2-field mt-3"
          rows={3}
        />
      )}
      <div className="mt-10 flex items-center gap-5">
        <BackLink onClick={onBack} />
        <button
          type="button"
          onClick={onContinue}
          disabled={!reason || (reason === "other" && !freeText.trim())}
          className="lp2-cta flex-1 sm:ml-auto sm:w-auto sm:flex-none sm:px-9"
        >
          <T en="Continue" es="Continuar" />
        </button>
      </div>
    </>
  );
}

/**
 * Inline tailored solution (indigo). Reuses the plan/skip engines directly so
 * the customer never leaves the cancel flow (matches the approved deck).
 */
function Solucion({
  reason,
  subscription,
  pricing,
  onStayed,
  onDecline,
  onBack,
}: {
  reason: CancellationReason | null;
  subscription: Subscription | null;
  pricing: PricingResponse | null;
  onStayed: (msg?: StayMsg) => void;
  onDecline: () => void;
  onBack: () => void;
}) {
  const t = useLang();
  const lang = useLangValue();
  const locale = lang === "es" ? "es-ES" : "en-US";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const freq = subscription?.frequency ?? "1mo";
  const boxCount = subscription?.boxCount ?? 1;
  const currentShip = subscription?.nextShipDate ? new Date(subscription.nextShipDate) : null;
  const fmt = (d: Date) => d.toLocaleDateString(locale, { day: "numeric", month: "long" });

  // Espaciar (No lo uso): offer a longer frequency; next order moves to
  // (current next − current interval + new interval), via `spacedFromNext`,
  // the same function the backend saves the date with.
  const longer = longerFrequencies(freq);
  const [offerFreq, setOfferFreq] = useState<Frequency>(longer[0] ?? freq);
  const spacedShip = currentShip ? spacedFromNext(currentShip, freq, offerFreq) : null;

  // Menos cajas (Me parece caro): default to 1 box (biggest saving). Only
  // offer options BELOW the current count — the screen promises "with fewer
  // boxes you pay less per shipment", so letting the customer pick MORE boxes
  // (a price increase) from here was misleading (audit 2026-07-08). Customers
  // already at 1 box never reach this screen (handleReasonContinue skips it).
  // Lo que paga HOY sale del CONTRATO, no del catálogo (un trimestral legacy paga
  // 67,93 y el catálogo dice 85,05 — aviso de Kiko, 23-ago-2026).
  const curPrice = subscription?.chargeTotalCents
    ? subscription.chargeTotalCents / 100
    : pricing ? pricing.perBox[boxCount - 1] ?? null : null;
  // Escalera web: solo se ofrecen tramos que de verdad cuestan menos que lo que
  // el cliente PAGA (a un pack de 4 a 85,05 no se le ofrece bajar a 3 con ahorro
  // 0,00 €; a un legacy SL120 a 90,57 sí, porque 3 cajas a 85,05 le ahorra) —
  // misma promesa de la pantalla ("pagas menos"), medida contra su precio real.
  const fewerBoxOptions = BOX_OPTIONS.filter(
    (n) =>
      n < boxCount &&
      (!pricing || curPrice === null || pricing.perBox[n - 1] < curPrice),
  );
  // ¿Este contrato paga por debajo del catálogo (escalera vieja)? Entonces cambiar el
  // nº de cajas le mueve a la tarifa de hoy y NO puede volver: un trimestral a 67,93
  // que baja a 2 cajas ahorra de verdad, pero si mañana quiere volver a 3 le costarán
  // 85,05, no 67,93. Ofrecerle el ahorro sin decirle eso, y encima en el momento en
  // que se iba a ir, es venderle una puerta de un solo sentido como si fuera un
  // descuento. El aviso se calcula contra el catálogo de SU nº de cajas actual.
  // OJO CON LAS SUBS FUERA DE ESCALERA (9 y 12 cajas, LIT-303): `perBox` solo llega a
  // 6, asi que `perBox[boxCount - 1]` es undefined y con `?? curPrice` la comparacion
  // se caia a false — el aviso no salia justo en las dos subs mas expuestas, que son
  // las que mas pagan (aviso de Kiko, 3-sep-2026). Si no hay precio de catalogo para
  // su nº de cajas, se compara contra el tramo mas alto que conocemos: quien paga por
  // debajo de 6 cajas a catalogo esta por debajo de cualquier tramo posible.
  const catalogueForBoxes =
    pricing !== null
      ? pricing.perBox[boxCount - 1] ?? pricing.perBox[pricing.perBox.length - 1] ?? null
      : null;
  const belowCatalogue =
    curPrice !== null && catalogueForBoxes !== null
      ? curPrice < catalogueForBoxes - 0.005
      : false;
  const [offerBoxes, setOfferBoxes] = useState<number>(1);
  const newPrice = pricing ? pricing.perBox[offerBoxes - 1] ?? null : null;
  const hasPackPrice =
    curPrice !== null && !!pricing && Math.abs(curPrice - (pricing.perBox[3] ?? -1)) < 0.005;

  // Saltar (Me tomo un descanso): next order moves forward one cycle.
  const skipShip = currentShip ? addCycle(currentShip, freq) : null;

  // Cambiar sabor (No me gusta): offer the other flavor(s). A flavor swap keeps
  // plan, price and next-ship date — only the product changes.
  const currentFlavorKey: FlavorKey =
    flavorKeyForVariant(subscription?.currentVariantId) ?? DEFAULT_FLAVOR;
  const flavorAlternatives = ALL_FLAVORS.filter((f) => f.key !== currentFlavorKey);
  const [offerFlavor, setOfferFlavor] = useState<FlavorKey>(
    flavorAlternatives[0]?.key ?? currentFlavorKey,
  );

  const planErr = (e: unknown): string => {
    const code = (e as { code?: string; status?: number }).code;
    const status = (e as { status?: number }).status;
    if (code === "cutoff_passed")
      return t({ en: "Too late, your next box ships within 24h.", es: "Demasiado tarde, tu próxima caja se envía en 24h." });
    if (code === "box_count_unknown")
      return t({ en: "We couldn't switch your flavor automatically. Please contact us.", es: "No pudimos cambiar el sabor automáticamente. Escríbenos." });
    // Retención + contrato de la escalera vieja: la oferta subiría el importe, que es lo
    // último que quieres hacerle a alguien que se está yendo. El backend lo rechaza y aquí
    // se le ofrece la vía humana, que además es la que retiene. (24-ago-2026)
    if (code === "price_would_increase" || code === "box_count_out_of_range")
      return t({
        en: "We can't apply this from here without changing your price, and it shouldn't change. Write to us and we'll set it up keeping what you pay today.",
        es: "No podemos aplicarlo desde aquí sin tocarte el precio, y no debería cambiar. Escríbenos y te lo dejamos con lo que pagas hoy.",
      });
    if (code === "gateway_timeout" || status === 504)
      return t({ en: "The service is taking longer than usual. Try again in a moment.", es: "El servicio está tardando más de lo normal. Inténtalo de nuevo en un momento." });
    // Rechazado ANTES de tocar nada (otro cambio con el cerrojo tomado, o el descuento de
    // un referido que había que retirar primero): se reintenta en unos segundos.
    if (code === "plan_change_in_progress" || code === "referral_reward_busy")
      return t({
        en: "We're finishing another update to your subscription. Wait a moment and try again.",
        es: "Estamos terminando otro cambio en tu suscripción. Espera un momento y vuelve a intentarlo.",
      });
    // Rechazado antes de tocar nada (14-oct-2026): Seal seguía con un cambio reciente.
    // La pantalla iba con una frecuencia o unas líneas que ya no son (16-oct-2026).
    if (code === "subscription_changed")
      return t({ en: "Your plan has changed since you opened this page. Reload it to see how it is now; if it won't let you change it, write to us.", es: "Tu plan ha cambiado desde que abriste esta página. Recárgala para ver cómo está ahora; si no te deja cambiarlo, escríbenos." });
    if (code === "no_pending_attempt")
      return t({ en: "We're still rescheduling your next deliveries. Try again in a couple of minutes; nothing has been changed.", es: "Estamos terminando de reorganizar tus próximos envíos. Inténtalo en un par de minutos; no hemos cambiado nada." });
    if (code === "variant_change_failed_after_interval")
      return t({ en: "We changed the frequency, but not the boxes. Reload the page and change the boxes again.", es: "Hemos cambiado la frecuencia, pero no las cajas. Recarga la página y vuelve a cambiar las cajas." });
    if (code === "repair_net_unavailable")
      return t({ en: "We couldn't check your plan just now, so we haven't changed anything. Try again in a moment.", es: "Ahora mismo no hemos podido comprobar tu plan, así que no hemos cambiado nada. Inténtalo de nuevo en un momento." });
    if (code === "seal_busy")
      return t({
        en: "We're still saving a previous change to your subscription. Try again in a couple of minutes; nothing has been changed.",
        es: "Estamos terminando de guardar un cambio anterior en tu suscripción. Inténtalo en un par de minutos; no hemos cambiado nada.",
      });
    if (code === "change_unconfirmed")
      return t({
        en: "We couldn't confirm your change. Reload the page in a few minutes to see how your plan ended up and, if it didn't change, try again.",
        es: "No hemos podido confirmar tu cambio. Recarga la página en unos minutos para ver cómo ha quedado tu plan y, si no ha cambiado, vuelve a pedirlo.",
      });
    if (code === "frequency_change_failed")
      return t({
        en: "We couldn't change the frequency and nothing was changed. Try again in a few minutes.",
        es: "No hemos podido cambiar la frecuencia y no se ha cambiado nada. Inténtalo de nuevo en unos minutos.",
      });
    // ESTE cambio entró a medias y el cron lo termina en minutos (14-oct-2026).
    if (code === "change_applying")
      return t({
        en: "Your change is still being applied. You'll see it on your subscription within a few minutes and you won't be overcharged. No need to do it again.",
        es: "Tu cambio se está terminando de aplicar. En unos minutos lo verás en tu suscripción y no se te cobrará de más. No hace falta que lo repitas.",
      });
    // Escritura a medias o sin cerrar (2-oct-2026): la ruta no deja tarificar encima y el
    // cron la cierra en minutos. Reintentar en el acto solo devuelve el 409.
    if (code === "change_in_progress")
      return t({
        en: "We're still finishing your last change. Wait a few minutes, reload the page and try again.",
        es: "Todavía estamos terminando de aplicar tu último cambio. Espera unos minutos, recarga la página y vuelve a intentarlo.",
      });
    if (code === "seal_inconsistent_state")
      return t({
        en: "Your change didn't finish applying cleanly. We'll sort it out within a few minutes and you won't be overcharged. Reload the page then to see how your plan ended up.",
        es: "Tu cambio no ha terminado de aplicarse bien. En unos minutos lo dejamos en orden y no se te cobrará de más. Recarga la página entonces para ver cómo ha quedado tu plan.",
      });
    return t({ en: "Couldn't update your plan. Try again or contact us.", es: "No se pudo cambiar el plan. Inténtalo de nuevo o escríbenos." });
  };

  const applyPlan = async (body: Record<string, unknown>, stayedMsg?: StayMsg) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/subscription/plan", {
        method: "PATCH",
        body: JSON.stringify({
          sealSubscriptionId: subscription?.sealSubscriptionId,
          mainItemId: subscription?.mainItemId,
          currentVariantId: subscription?.currentVariantId,
          currentFrequency: freq,
          ...body,
        }),
      });
      onStayed(stayedMsg);
    } catch (e) {
      setError(planErr(e));
    } finally {
      setBusy(false);
    }
  };

  const doSkip = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/subscription/skip", {
        method: "POST",
        body: JSON.stringify({
          sealSubscriptionId: subscription?.sealSubscriptionId,
          reason: "taking_a_break",
          expectedNextShipDate: subscription?.nextShipDate,
        }),
      });
      onStayed();
    } catch (e) {
      const code = (e as { code?: string }).code;
      const status = (e as { status?: number }).status;
      setError(skipErrorMessage(code, status, t));
    } finally {
      setBusy(false);
    }
  };

  const errorBox = error && <div className="lp2-notice lp2-notice--error mt-4">{error}</div>;
  const eyebrow = (
    <div className="lp2-eyebrow">
      <T en="Before you cancel" es="Antes de cancelar" />
    </div>
  );
  const secondary = (
    <>
      <button type="button" onClick={onDecline} className="lp2-link pt-2">
        <T en="Keep cancelling" es="Seguir con la cancelación" />
      </button>
      <div className="pt-4">
        <BackLink onClick={onBack} />
      </div>
    </>
  );
  // Los títulos-pregunta de las ofertas: tamaño medio en móvil (son frases
  // largas) y grandes en escritorio, donde la pantalla es entera.
  const offerTitle = "mt-3 md:text-[46px]";

  // ── No me gusta → probar otro sabor ──
  if (reason === "dont_like") {
    const altLabel = ALL_FLAVORS.find((f) => f.key === offerFlavor)?.label ?? "";
    // With 2+ boxes, "keep the one you like AND try the other" retains better than
    // asking someone to swap their whole subscription to a flavor they've never tried.
    const boxes = subscription?.boxCount ?? 1;
    const halfAndHalf =
      boxes >= 2 && subscription?.canEditMix && currentFlavorKey !== offerFlavor
        ? [
            // ceil + floor SUMA EXACTAMENTE `boxes`, y de eso depende la promesa
            // escrita de abajo ("el mismo precio"): el backend solo conserva el precio
            // del contrato cuando el nº de cajas NO cambia (boxCountUnchanged en
            // /api/subscription/plan). Si alguien cambia este reparto por uno que no
            // sume igual (una caja de regalo, por ejemplo), la promesa se convierte en
            // un reprecio silencioso a catálogo. Cubierto en scripts/test-mix.ts.
            { flavor: currentFlavorKey, boxes: Math.ceil(boxes / 2) },
            { flavor: offerFlavor, boxes: Math.floor(boxes / 2) },
          ]
        : null;
    return (
      <>
        {eyebrow}
        <SheetTitle
          className={offerTitle}
          text={
            halfAndHalf
              ? t({ en: "What if you keep both?", es: "¿Y si te quedas los dos?" })
              : t({ en: "What if you try another flavor?", es: "¿Y si pruebas otro sabor?" })
          }
        />
        <p className="lp2-text mt-5 max-w-md">
          {halfAndHalf ? (
            <T
              en="Same plan, same price, same ship date. Split your boxes and try the other flavor without giving up the one you have."
              es="El mismo plan, el mismo precio y la misma fecha. Reparte tus cajas y prueba el otro sabor sin renunciar al que tienes."
            />
          ) : (
            <T
              en="Same plan, same price, same ship date — just a different flavor in your next box."
              es="El mismo plan, el mismo precio y la misma fecha. Solo cambia el sabor de tu próxima caja."
            />
          )}
        </p>
        <div className="lp2-label mt-7">
          <T en="Try instead" es="Prueba con" />
        </div>
        <div className="space-y-2">
          {flavorAlternatives.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setOfferFlavor(f.key)}
              aria-pressed={offerFlavor === f.key}
              className={`lp2-choice py-2.5 pl-3.5 ${offerFlavor === f.key ? "is-on" : ""}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <FlavorThumb flavor={f.key} />
                <span className="font-display text-[17px] font-semibold uppercase leading-tight">
                  {f.label}
                </span>
              </span>
              <RadioMark on={offerFlavor === f.key} />
            </button>
          ))}
        </div>
        {errorBox}
        <div className="mt-8 space-y-3">
          {halfAndHalf && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                applyPlan(
                  { mix: halfAndHalf, expectedLineIds: subscription?.lines?.map((l) => l.itemId) },
                  { en: "Your mix is set.", es: "Tu mezcla está lista." },
                )
              }
              className="lp2-cta"
            >
              {busy ? (
                <T en="Saving…" es="Guardando…" />
              ) : (
                <T
                  en={`Split them: ${compositionLabel(halfAndHalf)}`}
                  es={`Repártelas: ${compositionLabel(halfAndHalf)}`}
                />
              )}
            </button>
          )}
          <button
            type="button"
            disabled={busy || offerFlavor === currentFlavorKey}
            onClick={() =>
              applyPlan(
                { flavor: offerFlavor, expectedLineIds: subscription?.lines?.map((l) => l.itemId) },
                { en: "Your flavor is updated.", es: "Tu sabor está actualizado." },
              )
            }
            className={halfAndHalf ? "lp2-ghost" : "lp2-cta"}
          >
            {busy ? (
              <T en="Saving…" es="Guardando…" />
            ) : (
              <T en={`Switch all to ${altLabel}`} es={`Cambiar todo a ${altLabel}`} />
            )}
          </button>
          {secondary}
        </div>
      </>
    );
  }

  // ── Me parece caro → menos cajas ──
  if (reason === "too_expensive") {
    return (
      <>
        {eyebrow}
        <SheetTitle
          className={offerTitle}
          text={t({ en: "What if you get fewer boxes?", es: "¿Y si recibes menos cajas?" })}
        />
        <p className="lp2-text mt-5 max-w-md">
          <T
            en="Fewer boxes means a lower charge per shipment, without losing your bulk discount."
            es="Con menos cajas pagas menos por envío, sin perder tu descuento por cantidad."
          />
        </p>
        <div className="lp2-label mt-7">
          <T en="Boxes per shipment" es="Cajas por envío" />
        </div>
        <div className="grid grid-cols-6 gap-2">
          {fewerBoxOptions.map((n) => (
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
        {boxCount === 4 && hasPackPrice && (
          <p className="mt-3 text-[12px] text-[#F2F1EA]/60">
            <T
              en="You already get 1 free box with the 3+1 pack."
              es="Ya tienes 1 caja gratis con el pack 3+1."
            />
          </p>
        )}
        {newPrice !== null && (
          <div className="lp2-card mt-4">
            <div className="lp2-label">
              <T en="New charge per shipment" es="Nuevo importe por envío" />
            </div>
            <div className="flex items-baseline gap-3">
              <span className="lp2-figure text-[38px] text-[color:var(--color-bold-yellow)]">
                {formatEuro(Math.round(newPrice * 100), lang)}
              </span>
              {curPrice !== null && curPrice !== newPrice && (
                <span className="text-[14px] text-[#F2F1EA]/45 line-through">
                  {formatEuro(Math.round(curPrice * 100), lang)}
                </span>
              )}
            </div>
            {belowCatalogue && (
              <p className="mt-3 text-[12px] leading-relaxed text-[#F2F1EA]/70">
                <T
                  en="Heads up: you're on an older price. If you change the number of boxes you move to the current tariff, and going back to your boxes later would cost today's price."
                  es="Ojo: tienes un precio antiguo. Si cambias el número de cajas pasas a la tarifa actual, y volver luego a tus cajas te costaría el precio de hoy."
                />
              </p>
            )}
          </div>
        )}
        {errorBox}
        <div className="mt-8 space-y-3">
          <button
            type="button"
            disabled={busy || offerBoxes === boxCount}
            onClick={() =>
              applyPlan({
                boxCount: offerBoxes,
                frequency: freq,
                expectedLineIds: subscription?.lines?.map((l) => l.itemId),
              })
            }
            className="lp2-cta"
          >
            {busy ? (
              <T en="Saving…" es="Guardando…" />
            ) : (
              <T en={`Change to ${offerBoxes} ${offerBoxes === 1 ? "box" : "boxes"}`} es={`Cambiar a ${offerBoxes} ${offerBoxes === 1 ? "caja" : "cajas"}`} />
            )}
          </button>
          {secondary}
        </div>
      </>
    );
  }

  // ── Me tomo un descanso → saltar la próxima ──
  if (reason === "taking_a_break") {
    return (
      <>
        {eyebrow}
        <SheetTitle
          className={offerTitle}
          text={t({ en: "What if you just skip the next one?", es: "¿Y si solo te saltas la próxima?" })}
        />
        <p className="lp2-text mt-5 max-w-md">
          <T
            en="A breather without cancelling. You resume whenever you want."
            es="Un respiro sin darte de baja. Retomas cuando quieras."
          />
        </p>
        {skipShip && currentShip && (
          <DateMove
            className="mt-6"
            label={<T en="Your next box would ship on" es="Tu próxima caja saldría el" />}
            from={fmt(currentShip)}
            to={fmt(skipShip)}
          />
        )}
        {errorBox}
        <div className="mt-8 space-y-3">
          <button
            type="button"
            disabled={busy}
            onClick={doSkip}
            className="lp2-cta"
          >
            {busy ? <T en="Skipping…" es="Saltando…" /> : <T en="Skip the next one" es="Saltar la próxima" />}
          </button>
          {secondary}
        </div>
      </>
    );
  }

  // ── No lo uso lo suficiente (default plan) → espaciar la frecuencia ──
  return (
    <>
      {eyebrow}
      <SheetTitle
        className={offerTitle}
        text={t({ en: "What if you space it out?", es: "¿Y si lo espacias en vez de dejarlo?" })}
      />
      <p className="lp2-text mt-5 max-w-md">
        <T
          en="Getting more than you use? Receive it less often. No need to cancel."
          es="¿Recibes más de lo que usas? Recíbelo más espaciado. No hace falta cancelar."
        />
      </p>
      {longer.length > 0 && (
        <div className="mt-7">
          <div className="lp2-label">
            <T en="Receive it every" es="Recíbelo cada" />
          </div>
          {/* Botones y no un <select> (lp2, 2026-10-13): son pocas opciones, se
              ven todas de un vistazo, y el desplegable nativo pintaba en
              algunos sistemas el texto claro sobre una lista blanca. Formato
              corto («2 meses») porque la etiqueta ya dice «cada». */}
          <div className="grid grid-cols-3 gap-2">
            {longer.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setOfferFreq(f)}
                aria-pressed={offerFreq === f}
                className={`lp2-option py-3 text-[14px] uppercase ${offerFreq === f ? "is-on" : ""}`}
              >
                {frequencyLabel(f, lang, { format: "short" })}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Guard on longer.length too: at the max cadence spacedShip equals
          currentShip, so the preview showed the SAME date "moved to" and
          struck through. Normally unreachable (handleReasonContinue skips
          this screen at 6mo), kept as defence. (audit 2026-07-08) */}
      {longer.length > 0 && spacedShip && currentShip && (
        <DateMove
          className="mt-4"
          label={<T en="Your next order would move to" es="Tu próximo pedido pasaría al" />}
          from={fmt(currentShip)}
          to={fmt(spacedShip)}
        />
      )}
      {curPrice !== null && (
        <p className="mt-3 text-[12px] leading-relaxed text-[#F2F1EA]/60">
          <T
            en={`You keep paying ${formatEuro(Math.round(curPrice * 100), lang)} per shipment, just fewer times a year.`}
            es={`Sigues pagando ${formatEuro(Math.round(curPrice * 100), lang)} por envío, solo que menos veces al año.`}
          />
        </p>
      )}
      {errorBox}
      <div className="mt-8 space-y-3">
        <button
          type="button"
          disabled={busy || longer.length === 0}
          // Solo la frecuencia, como la encuesta (16-oct-2026). Con el boxCount de la pestaña, si
          // el cliente había bajado de 2 a 1 caja desde otro sitio, espaciar desde aquí le volvía
          // a poner 2: el servidor lo leía como un cambio de composición. (Revisión de Kiko, #150.)
          onClick={() => applyPlan({ frequency: offerFreq, reanchorMode: "fromNext" })}
          className="lp2-cta"
        >
          {busy ? <T en="Saving…" es="Guardando…" /> : <T en="Space out my deliveries" es="Espaciar mis entregas" />}
        </button>
        {secondary}
      </div>
    </>
  );
}

function Descuento({
  subscription,
  pricing,
  reason,
  onKept,
  onStay,
  onDecline,
}: {
  subscription: Subscription | null;
  pricing: PricingResponse | null;
  reason: CancellationReason | null;
  onKept: () => void;
  /** Leave the takeover WITHOUT cancelling (discount unavailable path). */
  onStay: () => void;
  onDecline: () => void;
}) {
  const t = useLang();
  const lang = useLangValue();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The offer is shown to everyone (the FE can't know eligibility up front),
  // so the server may answer 409 already_used / not_first_cancel. That used
  // to silently jump to "Confirmar cancelación" — the exact opposite of what
  // the customer asked for by pressing "Quedarme con el 15%". Now we tell
  // them honestly and let them stay or keep cancelling. (audit 2026-07-08)
  const [unavailable, setUnavailable] = useState(false);

  const boxCount = subscription?.boxCount ?? null;
  // El 15% se calcula sobre lo que el cliente PAGA (chargeTotalCents), nunca sobre el
  // catálogo. a76c07d arregló PlanOverlay, SkipOverlay y la oferta de menos cajas, pero
  // esta pantalla se quedó fuera: a un trimestral de la escalera vieja que paga 67,93 le
  // ofrecía "85,05 → 72,29", o sea 4,36 MÁS de lo que ya paga, como oferta para que no
  // se fuera. Su descuento real es 57,74. (24-ago-2026)
  const current =
    subscription?.chargeTotalCents
      ? subscription.chargeTotalCents / 100
      : pricing && boxCount ? pricing.perBox[boxCount - 1] ?? null : null;
  const discounted = current !== null ? current * 0.85 : null;

  const handleKeep = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/subscription/retention-discount", {
        method: "POST",
        body: JSON.stringify({ sealSubscriptionId: subscription?.sealSubscriptionId, reason }),
      });
      onKept();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "already_used" || code === "not_first_cancel") {
        setUnavailable(true);
        setError(
          t({
            en: "This discount is only available once, on a first cancellation, and it's no longer available on your account. You can keep your subscription as it is, or continue cancelling.",
            es: "Este descuento solo está disponible una vez, en la primera cancelación, y ya no está disponible en tu cuenta. Puedes seguir con tu suscripción tal como está, o continuar con la cancelación.",
          }),
        );
        return;
      }
      if (code === "discount_apply_unconfirmed" || code === "gateway_timeout") {
        // No sabemos si el 15% entró (14-oct-2026): repetirlo podría ponerlo dos veces, y
        // decir "no se pudo" puede ser falso. Se le dice la verdad y no se le deja repetir.
        setUnavailable(true);
        setError(
          t({
            en: "We couldn't confirm whether your discount was applied. We're checking it and we'll write to you; there's no need to try again.",
            es: "No hemos podido confirmar si tu descuento se ha aplicado. Lo estamos comprobando y te escribimos; no hace falta que lo repitas.",
          }),
        );
        return;
      }
      setError(
        t({
          en: "Couldn't apply the discount. Try again or contact us.",
          es: "No se pudo aplicar el descuento. Inténtalo de nuevo o escríbenos.",
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="lp2-eyebrow">
        <T en="Wait" es="Espera" />
      </div>
      <SheetTitle
        className="mt-3 md:text-[46px]"
        text={t({ en: "This one's on us", es: "Esta va por nuestra cuenta" })}
      />
      <p className="lp2-text mt-5 max-w-md">
        <T
          en="15% off your next order, on top of your bulk discount. Just for staying."
          es="Un 15% en tu próximo pedido, además de tu descuento por cantidad. Solo por quedarte."
        />
      </p>

      {discounted !== null && current !== null && (
        <div className="lp2-card mt-7">
          <div className="lp2-label">
            <T en="Your next order" es="Tu próximo pedido" />
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <span className="lp2-figure text-[44px] text-[color:var(--color-bold-yellow)] md:text-[52px]">
              {formatEuro(Math.round(discounted * 100), lang)}
            </span>
            <span className="text-[14px] text-[#F2F1EA]/45 line-through">
              {formatEuro(Math.round(current * 100), lang)}
            </span>
            <span className="lp2-pill self-center">−15%</span>
          </div>
        </div>
      )}

      {error && <div className="lp2-notice lp2-notice--error mt-4">{error}</div>}

      <div className="mt-9 space-y-5">
        {unavailable ? (
          <button type="button" onClick={onStay} className="lp2-cta">
            <T en="Keep my subscription" es="Seguir con mi suscripción" />
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={handleKeep}
            className="lp2-cta"
          >
            {busy ? <T en="Applying…" es="Aplicando…" /> : <T en="Keep my 15%" es="Quedarme con el 15%" />}
          </button>
        )}
        <button type="button" onClick={onDecline} className="lp2-link">
          <T en="Cancel anyway" es="Cancelar de todas formas" />
        </button>
      </div>
    </>
  );
}

function Confirmar({
  subscription,
  onConfirm,
  onBack,
}: {
  subscription: Subscription | null;
  onConfirm: () => Promise<void>;
  onBack: () => void;
}) {
  const t = useLang();
  const lang = useLangValue();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const willShipNext = !!subscription?.withinCutoff && !!subscription?.nextShipDate;
  const dateLocale = lang === "es" ? "es-ES" : "en-US";
  const nextDateLabel =
    willShipNext && subscription?.nextShipDate
      ? new Date(subscription.nextShipDate).toLocaleDateString(dateLocale, {
          weekday: "long",
          day: "numeric",
          month: "long",
        })
      : null;

  return (
    <>
      <SheetTitle
        size="lg"
        className=""
        thin={t({ en: "Confirm", es: "Confirmar" })}
        bold={t({ en: "cancellation", es: "cancelación" })}
      />
      <p className="lp2-text mt-6 max-w-md">
        {willShipNext ? (
          <T
            en="Your next shipment is already within 24h, so it'll go out. After that, no more shipments and no more charges."
            es="Tu próximo envío ya está dentro de las 24h, así que saldrá igualmente. Después, no habrá más envíos ni cobros."
          />
        ) : (
          <T
            en="Cancellation is immediate. No more shipments and no more charges."
            es="La cancelación es inmediata. No habrá más envíos ni cobros."
          />
        )}
      </p>
      <div className="lp2-card mt-8 divide-y divide-[#F2F1EA]/10 py-1.5">
        {willShipNext && nextDateLabel && (
          <Detail label={t({ en: "Last shipment", es: "Último envío" })} value={nextDateLabel} />
        )}
        <Detail
          label={t({ en: "Status", es: "Estado" })}
          value={
            willShipNext
              ? t({ en: "Cancels after last shipment", es: "Cancela tras último envío" })
              : t({ en: "Cancelled on confirm", es: "Cancelada al confirmar" })
          }
        />
        <Detail label={t({ en: "Next billing", es: "Próximo cobro" })} value={t({ en: "None", es: "Ninguno" })} />
      </div>
      {error && <div className="lp2-notice lp2-notice--error mt-4">{error}</div>}
      {/* La baja va en botón de contorno y no en el lima: es la acción que no
          queremos empujar, pero tiene que estar a la vista y sin trucos. */}
      <div className="mt-10 flex items-center gap-5">
        <BackLink onClick={onBack} />
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
            } catch (e) {
              const err = e as { code?: string; status?: number };
              console.error("[cancel-confirm] failed", e);
              if (err.code === "gateway_timeout" || err.status === 504) {
                setError(
                  t({
                    en: "The service is taking longer than usual. Wait a moment and try again.",
                    es: "El servicio está tardando más de lo normal. Espera un momento e inténtalo de nuevo.",
                  }),
                );
              } else {
                setError(
                  t({
                    en: "Couldn't cancel. Try again or contact us.",
                    es: "No se pudo cancelar. Inténtalo de nuevo o escríbenos.",
                  }),
                );
              }
            } finally {
              setBusy(false);
            }
          }}
          className="lp2-ghost flex-1 sm:ml-auto sm:w-auto sm:flex-none sm:px-8"
        >
          {busy ? <T en="Cancelling…" es="Cancelando…" /> : <T en="Cancel subscription" es="Cancelar suscripción" />}
        </button>
      </div>
    </>
  );
}

function DoneStayed({ msg, onClose }: { msg: StayMsg | null; onClose: () => void }) {
  const t = useLang();
  return (
    <>
      <SheetDoneMark dark />
      <SheetTitle
        size="lg"
        className="mt-6"
        thin={t({ en: "Great,", es: "Genial," })}
        bold={t({ en: "you're staying", es: "te quedas" })}
      />
      <p className="lp2-text mt-6">
        {msg ? `${t(msg)} ` : ""}
        <T en="See you soon." es="Nos vemos pronto." />
      </p>
      <button type="button" onClick={onClose} className="lp2-cta lp2-cta--still mt-10">
        <T en="Back to LIT" es="Volver a LIT" />
      </button>
    </>
  );
}

// After a real cancel the exit lives in the parent (`exitAfterCancel`): the
// single-sub path logs out + redirects to the storefront, while a multi-sub
// customer who retains another ACTIVE sub goes back to the Hub with their
// session intact (the server kept it alive on purpose). (audit 2026-07-08)
function DoneState({
  retainsActiveSub,
  busy,
  onExit,
}: {
  retainsActiveSub: boolean;
  busy: boolean;
  onExit: () => void;
}) {
  const t = useLang();
  return (
    <>
      <SheetTitle
        size="lg"
        className=""
        text={t({ en: "Thank you for trusting LIT", es: "Gracias por confiar en LIT" })}
      />
      <p className="lp2-text mt-6">
        {retainsActiveSub ? (
          <T
            en="This subscription is cancelled. Your other subscription stays active and you can keep managing it here."
            es="Esta suscripción está cancelada. Tu otra suscripción sigue activa y puedes seguir gestionándola aquí."
          />
        ) : (
          <T en="Hope to have you back soon." es="Aquí te esperamos cuando quieras volver." />
        )}
      </p>
      <button
        type="button"
        onClick={onExit}
        disabled={busy}
        className="lp2-cta lp2-cta--still mt-10"
      >
        {busy ? (
          <T en="Closing…" es="Cerrando…" />
        ) : retainsActiveSub ? (
          <T en="Back to my subscription" es="Volver a mi suscripción" />
        ) : (
          <T en="Back to LIT" es="Volver a LIT" />
        )}
      </button>
    </>
  );
}

/** Cifra de «lo que has construido», en lima como las de la landing. */
function Stat({ label, value, loading }: { label: string; value: number; loading?: boolean }) {
  return (
    <div className="lp2-card md:p-6">
      <div
        className={`lp2-figure text-[46px] text-[color:var(--color-bold-yellow)] transition-opacity duration-300 md:text-[60px] ${
          loading ? "animate-pulse opacity-40" : "opacity-100"
        }`}
      >
        {value}
      </div>
      <div className="lp2-label mt-2.5 mb-0">{label}</div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#F2F1EA]/55">{label}</span>
      <span className="text-right text-[14px] text-[#F2F1EA]">{value}</span>
    </div>
  );
}

/** «Atrás» con flecha en SVG (ni Clash ni Barlow traen «←»). */
function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-none cursor-pointer items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#F2F1EA]/60 transition-colors hover:text-[#F2F1EA]"
    >
      <SheetArrow className="h-3.5 w-3.5 rotate-180" />
      <T en="Back" es="Atrás" />
    </button>
  );
}

/** Radio de las listas de elección, en su versión oscura. */
function RadioMark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`h-4 w-4 flex-none rounded-full ${
        on ? "bg-[color:var(--color-bold-yellow)]" : "border-[1.5px] border-[#F2F1EA]/30"
      }`}
    />
  );
}

/**
 * La fecha que cambia: la de hoy tachada y la nueva en grande, con la flecha
 * entre las dos (saltar y espaciar).
 */
function DateMove({
  label,
  from,
  to,
  className = "",
}: {
  label: React.ReactNode;
  from: string;
  to: string;
  className?: string;
}) {
  return (
    <div className={`lp2-card ${className}`}>
      <div className="lp2-label">{label}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[#F2F1EA]/45 line-through">
          {from}
        </span>
        <SheetArrow className="h-4 w-4 flex-none text-[color:var(--color-bold-yellow)]" />
        <span className="lp2-figure text-[26px]">{to}</span>
      </div>
    </div>
  );
}

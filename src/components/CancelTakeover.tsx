"use client";

import { useEffect, useState } from "react";
import { api, clearSelectedSubscription, clearSessionToken } from "@/lib/api-client";
import { addCycle, subCycle } from "@/lib/cadence";
import { T, useLang, useLangValue } from "@/lib/i18n";
import { BOX_OPTIONS, FREQUENCIES, longerFrequencies } from "@/lib/plan-options";
import { portalHref } from "@/lib/portal-link";
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
 * Cancel takeover — full-screen Board 3 (dark indigo). Retention redesign
 * (2026-07-03), bilingual EN/ES:
 *
 *   logro     → "what you've built" (stats)
 *   motivo    → reason FIRST, so the offer can be tailored
 *   solucion  → tailored, no-discount solution INLINE per reason (same indigo
 *               takeover): "Me parece caro" → fewer boxes (real price);
 *               "No lo uso" → space out (real next-order date); "Me tomo un
 *               descanso" → skip the next. Applied via /plan or /skip directly.
 *   descuento → 15% off the NEXT charge, only if they reject the solution (or
 *               directly for "No me gusta" / "Otro"). Last resort. Applied via
 *               /api/subscription/retention-discount (next-charge-only).
 *   confirmar → final cancellation.
 *
 * "No me gusta" / "Otro" have no plan fix, so they skip `solucion` → `descuento`.
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
function solutionFor(reason: CancellationReason | null): "plan" | "skip" | null {
  switch (reason) {
    case "not_using_enough":
    case "too_expensive":
      return "plan"; // space out / fewer boxes
    case "taking_a_break":
      return "skip"; // skip the next one
    default:
      return null; // dont_like, other, too_much_product
  }
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
    setStep(sol && !noSmallerPlan && !noLongerCadence ? "solucion" : "descuento");
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
    <div className="zone-indigo fixed inset-0 z-50 overflow-y-auto bg-[#16130C] text-[#F2EEE1]">
      <button
        type="button"
        // After a REAL cancel the plain onClose would drop the customer back
        // on a stale ACTIVE Hub (single-sub: the refetch 401s because the
        // server purged the sessions, and the empty catch swallowed it) — the
        // × must exit exactly like "Volver a LIT". (audit 2026-07-08)
        onClick={step === "done" && done ? exitAfterCancel : onClose}
        className="absolute right-5 top-5 z-10 text-2xl opacity-60"
        aria-label="Close"
      >
        ×
      </button>

      <div className="mx-auto max-w-md px-6 pt-16 pb-10 sm:max-w-lg md:max-w-2xl">
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
            onStayed={() => {
              setStayedMsg({ en: "Your plan is updated.", es: "Tu plan está actualizado." });
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
      <h1 className="font-display text-5xl font-black uppercase leading-none md:text-6xl">
        <T en="This is what" es="Esto es lo que" />
        <br />
        <T en="you've built" es="has construido" />
      </h1>
      <div className="mt-10 grid grid-cols-2 gap-4">
        <Stat label={t({ en: "Boxes received", es: "Cajas recibidas" })} value={stats?.boxes ?? 0} loading={loading} />
        <Stat
          label={t({ en: "Months in inner circle", es: "Meses en inner circle" })}
          value={stats?.monthsInCircle ?? 0}
          loading={loading}
        />
      </div>
      <div className="mt-10 space-y-3">
        <button
          type="button"
          onClick={onStay}
          className="w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
        >
          <T en="Stay with LIT" es="Seguir con LIT" />
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="w-full text-[11px] uppercase tracking-[0.18em] opacity-60 underline"
        >
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
      <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-55">
        <T en="Help us understand" es="Ayúdanos a entender" />
      </div>
      <h1 className="mt-2 font-display text-5xl font-black uppercase leading-none md:text-6xl">
        <T en="Why are you" es="¿Por qué lo" />
        <br />
        <T en="leaving" es="dejas" />
        <span className="text-[color:var(--color-bold-yellow)]">?</span>
      </h1>
      <ul className="mt-8 space-y-2">
        {REASONS.map((r) => (
          <li key={r.value}>
            <button
              type="button"
              onClick={() => setReason(r.value)}
              className={`flex w-full items-center justify-between rounded-[14px] border px-4 py-3 text-left text-sm uppercase tracking-[0.12em] ${
                reason === r.value
                  ? "border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/10"
                  : "border-[#F2EEE1]/10"
              }`}
            >
              <span>{t({ en: r.en, es: r.es })}</span>
              {reason === r.value && <span className="text-[color:var(--color-bold-yellow)]">●</span>}
            </button>
          </li>
        ))}
      </ul>
      {reason === "other" && (
        <textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder={t({ en: "Tell us what happened", es: "Cuéntanos qué ha pasado" })}
          className="mt-3 w-full rounded-[14px] border border-[#F2EEE1]/10 bg-transparent p-3 text-sm placeholder:opacity-40"
          rows={3}
        />
      )}
      <div className="mt-10 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-[11px] uppercase tracking-[0.18em] opacity-60">
          ← <T en="Back" es="Atrás" />
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!reason || (reason === "other" && !freeText.trim())}
          className="rounded-full bg-[color:var(--color-bold-yellow)] px-6 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-30"
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
  onStayed: () => void;
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
  // (last charge + new interval). Preview via cadence.
  const longer = longerFrequencies(freq);
  const [offerFreq, setOfferFreq] = useState<Frequency>(longer[0] ?? freq);
  const anchor = currentShip ? subCycle(currentShip, freq) : null;
  const spacedShip = anchor ? addCycle(anchor, offerFreq) : null;

  // Menos cajas (Me parece caro): default to 1 box (biggest saving). Only
  // offer options BELOW the current count — the screen promises "with fewer
  // boxes you pay less per shipment", so letting the customer pick MORE boxes
  // (a price increase) from here was misleading (audit 2026-07-08). Customers
  // already at 1 box never reach this screen (handleReasonContinue skips it).
  const fewerBoxOptions = BOX_OPTIONS.filter((n) => n < boxCount);
  const [offerBoxes, setOfferBoxes] = useState<number>(1);
  const curPrice = pricing ? pricing.perBox[boxCount - 1] ?? null : null;
  const newPrice = pricing ? pricing.perBox[offerBoxes - 1] ?? null : null;

  // Saltar (Me tomo un descanso): next order moves forward one cycle.
  const skipShip = currentShip ? addCycle(currentShip, freq) : null;

  const planErr = (e: unknown): string => {
    const code = (e as { code?: string; status?: number }).code;
    const status = (e as { status?: number }).status;
    if (code === "cutoff_passed")
      return t({ en: "Too late, your next box ships within 24h.", es: "Demasiado tarde, tu próxima caja se envía en 24h." });
    if (code === "gateway_timeout" || status === 504)
      return t({ en: "The service is taking longer than usual. Try again in a moment.", es: "El servicio está tardando más de lo normal. Inténtalo de nuevo en un momento." });
    return t({ en: "Couldn't update your plan. Try again or contact us.", es: "No se pudo cambiar el plan. Inténtalo de nuevo o escríbenos." });
  };

  const applyPlan = async (body: Record<string, unknown>) => {
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
      onStayed();
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
        body: JSON.stringify({ sealSubscriptionId: subscription?.sealSubscriptionId, reason: "taking_a_break" }),
      });
      onStayed();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code === "already_charged" || code === "no_pending_attempt"
          ? t({ en: "This order is already being processed and can't be skipped.", es: "Este pedido ya se está procesando y no se puede saltar." })
          : t({ en: "Couldn't skip. Try again or contact us.", es: "No se pudo saltar. Inténtalo de nuevo o escríbenos." }),
      );
    } finally {
      setBusy(false);
    }
  };

  const errorBox = error && (
    <div className="mt-4 rounded-[14px] border border-[color:var(--color-danger)]/40 bg-red-50/10 px-4 py-3 text-xs text-[#ff9b9b]">
      {error}
    </div>
  );
  const eyebrow = (
    <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-55">
      <T en="Before you cancel" es="Antes de cancelar" />
    </div>
  );
  const secondary = (
    <>
      <button
        type="button"
        onClick={onDecline}
        className="w-full text-[11px] uppercase tracking-[0.18em] opacity-60 underline"
      >
        <T en="Keep cancelling" es="Seguir con la cancelación" />
      </button>
      <div className="mt-6">
        <button type="button" onClick={onBack} className="text-[11px] uppercase tracking-[0.18em] opacity-50">
          ← <T en="Back" es="Atrás" />
        </button>
      </div>
    </>
  );

  // ── Me parece caro → menos cajas ──
  if (reason === "too_expensive") {
    return (
      <>
        {eyebrow}
        <h1 className="mt-2 font-display text-4xl font-black uppercase leading-[1.05] md:text-5xl">
          <T en="What if you get fewer boxes?" es="¿Y si recibes menos cajas?" />
        </h1>
        <p className="mt-5 max-w-md text-sm opacity-75">
          <T
            en="Fewer boxes means a lower charge per shipment, without losing your bulk discount."
            es="Con menos cajas pagas menos por envío, sin perder tu descuento por cantidad."
          />
        </p>
        <div className="mt-6 text-[10px] font-bold uppercase tracking-[0.2em] opacity-55">
          <T en="Boxes per shipment" es="Cajas por envío" />
        </div>
        <div className="mt-2 grid grid-cols-6 gap-2">
          {fewerBoxOptions.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setOfferBoxes(n)}
              className={`rounded-[14px] py-3 text-sm font-black ${
                offerBoxes === n
                  ? "bg-[color:var(--color-bold-yellow)] text-[color:var(--color-lit-grey)]"
                  : "border border-[#F2EEE1]/10 bg-[#F2EEE1]/[0.06] opacity-60"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        {newPrice !== null && (
          <div className="mt-4 rounded-[20px] border border-[#F2EEE1]/10 bg-[#F2EEE1]/[0.05] p-5 md:rounded-[22px]">
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
              <T en="New charge per shipment" es="Nuevo importe por envío" />
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="font-display text-4xl font-black text-[color:var(--color-bold-yellow)]">
                €{newPrice.toFixed(2)}
              </span>
              {curPrice !== null && curPrice !== newPrice && (
                <span className="text-sm line-through opacity-50">€{curPrice.toFixed(2)}</span>
              )}
            </div>
          </div>
        )}
        {errorBox}
        <div className="mt-8 space-y-3">
          <button
            type="button"
            disabled={busy || offerBoxes === boxCount}
            onClick={() => applyPlan({ boxCount: offerBoxes, frequency: freq })}
            className="w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-40"
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
        <h1 className="mt-2 font-display text-4xl font-black uppercase leading-[1.05] md:text-5xl">
          <T en="What if you just skip the next one?" es="¿Y si solo te saltas la próxima?" />
        </h1>
        <p className="mt-5 max-w-md text-sm opacity-75">
          <T
            en="A breather without cancelling. You resume whenever you want."
            es="Un respiro sin darte de baja. Retomas cuando quieras."
          />
        </p>
        {skipShip && currentShip && (
          <div className="mt-6 rounded-[20px] border border-[#F2EEE1]/10 bg-[#F2EEE1]/[0.05] p-5 md:rounded-[22px]">
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
              <T en="Your next box would ship on" es="Tu próxima caja saldría el" />
            </div>
            <div className="mt-1 font-display text-xl font-black uppercase">{fmt(skipShip)}</div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.12em] opacity-45 line-through">
              {fmt(currentShip)}
            </div>
          </div>
        )}
        {errorBox}
        <div className="mt-8 space-y-3">
          <button
            type="button"
            disabled={busy}
            onClick={doSkip}
            className="w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-40"
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
      <h1 className="mt-2 font-display text-4xl font-black uppercase leading-[1.05] md:text-5xl">
        <T en="What if you space it out?" es="¿Y si lo espacias en vez de dejarlo?" />
      </h1>
      <p className="mt-5 max-w-md text-sm opacity-75">
        <T
          en="Getting more than you use? Receive it less often. No need to cancel."
          es="¿Recibes más de lo que usas? Recíbelo más espaciado. No hace falta cancelar."
        />
      </p>
      {longer.length > 0 && (
        <div className="mt-6">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-55">
            <T en="Receive it every" es="Recíbelo cada" />
          </div>
          <select
            value={offerFreq}
            onChange={(e) => setOfferFreq(e.target.value as Frequency)}
            className="mt-2 w-full rounded-[14px] border border-[#F2EEE1]/10 bg-[#F2EEE1]/[0.06] px-4 py-3 text-sm font-bold uppercase tracking-[0.15em] text-[#F2EEE1]"
          >
            {longer.map((f) => (
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
      {/* Guard on longer.length too: at the max cadence spacedShip equals
          currentShip, so the preview showed the SAME date "moved to" and
          struck through. Normally unreachable (handleReasonContinue skips
          this screen at 6mo), kept as defence. (audit 2026-07-08) */}
      {longer.length > 0 && spacedShip && currentShip && (
        <div className="mt-4 rounded-[20px] border border-[#F2EEE1]/10 bg-[#F2EEE1]/[0.05] p-5 md:rounded-[22px]">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
            <T en="Your next order would move to" es="Tu próximo pedido pasaría al" />
          </div>
          <div className="mt-1 font-display text-xl font-black uppercase">{fmt(spacedShip)}</div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.12em] opacity-45 line-through">
            {fmt(currentShip)}
          </div>
        </div>
      )}
      {curPrice !== null && (
        <p className="mt-3 text-[11px] opacity-60 leading-relaxed">
          <T
            en={`You keep paying €${curPrice.toFixed(2)} per shipment, just fewer times a year.`}
            es={`Sigues pagando €${curPrice.toFixed(2)} por envío, solo que menos veces al año.`}
          />
        </p>
      )}
      {errorBox}
      <div className="mt-8 space-y-3">
        <button
          type="button"
          disabled={busy || longer.length === 0}
          onClick={() => applyPlan({ frequency: offerFreq, boxCount, reanchorMode: "natural" })}
          className="w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-40"
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The offer is shown to everyone (the FE can't know eligibility up front),
  // so the server may answer 409 already_used / not_first_cancel. That used
  // to silently jump to "Confirmar cancelación" — the exact opposite of what
  // the customer asked for by pressing "Quedarme con el 15%". Now we tell
  // them honestly and let them stay or keep cancelling. (audit 2026-07-08)
  const [unavailable, setUnavailable] = useState(false);

  const boxCount = subscription?.boxCount ?? null;
  const current = pricing && boxCount ? pricing.perBox[boxCount - 1] ?? null : null;
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
      <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-55">
        <T en="Wait" es="Espera" />
      </div>
      <h1 className="mt-2 font-display text-4xl font-black uppercase leading-[1.05] md:text-5xl">
        <T en="This one's on us" es="Esta va por nuestra cuenta" />
      </h1>
      <p className="mt-5 max-w-md text-sm opacity-75">
        <T
          en="15% off your next order, on top of your bulk discount. Just for staying."
          es="Un 15% en tu próximo pedido, además de tu descuento por cantidad. Solo por quedarte."
        />
      </p>

      {discounted !== null && current !== null && (
        <div className="mt-7 rounded-[20px] border border-[#F2EEE1]/10 bg-[#F2EEE1]/[0.05] p-5 md:rounded-[22px]">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
            <T en="Your next order" es="Tu próximo pedido" />
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="font-display text-4xl font-black text-[color:var(--color-bold-yellow)]">
              €{discounted.toFixed(2)}
            </span>
            <span className="text-sm line-through opacity-50">€{current.toFixed(2)}</span>
            <span className="rounded-full border border-[color:var(--color-bold-yellow)]/50 px-2 py-0.5 text-[11px] font-bold tracking-[0.1em] text-[color:var(--color-bold-yellow)]">
              −15%
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-[14px] border border-[color:var(--color-danger)]/40 bg-red-50/10 px-4 py-3 text-xs text-[#ff9b9b]">
          {error}
        </div>
      )}

      <div className="mt-9 space-y-3">
        {unavailable ? (
          <button
            type="button"
            onClick={onStay}
            className="w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
          >
            <T en="Keep my subscription" es="Seguir con mi suscripción" />
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={handleKeep}
            className="w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-50"
          >
            {busy ? <T en="Applying…" es="Aplicando…" /> : <T en="Keep my 15%" es="Quedarme con el 15%" />}
          </button>
        )}
        <button
          type="button"
          onClick={onDecline}
          className="w-full text-[11px] uppercase tracking-[0.18em] opacity-60 underline"
        >
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
      <h1 className="font-display text-5xl font-black uppercase leading-none md:text-6xl">
        <T en="Confirm" es="Confirmar" />
        <br />
        <T en="cancellation" es="cancelación" />
      </h1>
      <p className="mt-6 max-w-md text-sm opacity-70">
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
      <div className="mt-8 space-y-3 rounded-[20px] border border-[#F2EEE1]/10 bg-[#F2EEE1]/[0.05] p-5 text-sm md:rounded-[22px]">
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
      {error && (
        <div className="mt-4 rounded-[14px] border border-[color:var(--color-danger)]/40 bg-red-50/10 px-4 py-3 text-xs text-[#ff9b9b]">
          {error}
        </div>
      )}
      <div className="mt-10 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-[11px] uppercase tracking-[0.18em] opacity-60">
          ← <T en="Back" es="Atrás" />
        </button>
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
          className="rounded-full border border-[#F2EEE1]/25 px-6 py-3 text-[11px] font-bold uppercase tracking-[0.2em] disabled:opacity-30"
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
      <h1 className="font-display text-5xl font-black uppercase leading-none text-[color:var(--color-bold-yellow)] md:text-6xl">
        <T en="Great, you're staying" es="Genial, te quedas" />
      </h1>
      <p className="mt-8 text-sm opacity-80">
        {msg ? `${t(msg)} ` : ""}
        <T en="See you soon." es="Nos vemos pronto." />
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-10 w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
      >
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
  return (
    <>
      <h1 className="font-display text-6xl font-black uppercase leading-none text-[color:var(--color-bold-yellow)] md:text-7xl">
        <T en="Thank you for trusting LIT" es="Gracias por confiar en LIT" />
      </h1>
      <p className="mt-8 text-sm opacity-80">
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
        className="mt-10 w-full rounded-full bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-50"
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

function Stat({ label, value, loading }: { label: string; value: number; loading?: boolean }) {
  return (
    <div className="rounded-[20px] border border-[#F2EEE1]/10 bg-[#F2EEE1]/[0.05] p-5 md:rounded-[22px]">
      <div
        className={`font-display text-4xl font-black transition-opacity duration-300 ${
          loading ? "animate-pulse opacity-40" : "opacity-100"
        }`}
      >
        {value}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.18em] opacity-60">{label}</div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] uppercase tracking-[0.15em] opacity-60">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

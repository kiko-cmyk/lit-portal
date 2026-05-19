"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang } from "@/lib/i18n";
import type {
  CancelStep1Response,
  CancelStep4Response,
  CancellationReason,
  CustomerProfile,
  Subscription,
} from "@/lib/types";

type Step = 1 | 2 | 3 | 4 | "done";

/**
 * Cancel takeover — full-screen Board 3 (dark indigo). 4 steps + done state.
 * Per Master Spec § 7. Bilingual EN/ES via lib/i18n.
 */
export function CancelTakeover({
  customer,
  subscription,
  onClose,
}: {
  customer: CustomerProfile;
  subscription: Subscription | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [stats, setStats] = useState<CancelStep1Response["data"] | null>(null);
  const [reason, setReason] = useState<CancellationReason | null>(null);
  const [freeText, setFreeText] = useState("");
  const [done, setDone] = useState<CancelStep4Response | null>(null);

  useEffect(() => {
    api<CancelStep1Response>("/api/subscription/cancel", {
      method: "POST",
      body: JSON.stringify({ step: 1 }),
    })
      .then((r) => setStats(r.data))
      .catch(() => null);
  }, []);

  return (
    <div className="zone-indigo fixed inset-0 z-50 overflow-y-auto bg-[#0F0E1A] text-[color:var(--color-brisky-cream)]">
      <button
        type="button"
        onClick={onClose}
        className="absolute right-5 top-5 z-10 text-2xl opacity-60"
        aria-label="Close"
      >
        ×
      </button>

      <div className="mx-auto max-w-md px-6 pt-16 pb-10 sm:max-w-lg md:max-w-2xl">
        {/* Step 1 monta la estructura inmediatamente; los stats llegan
            cuando la API responde (puede tardar 1-2 s por las llamadas en
            paralelo a Shopify + Seal + Supabase). Antes esperábamos a
            tener stats para renderizar nada → la modal aparecía vacía y
            "tardaba" en cargar. */}
        {step === 1 && (
          <Step1
            customer={customer}
            stats={stats}
            onContinue={() => setStep(2)}
            onKeepGoing={onClose}
          />
        )}
        {step === 2 && (
          <Step2
            onAlternative={onClose}
            onContinue={() => setStep(3)}
            onBack={() => setStep(1)}
          />
        )}
        {step === 3 && (
          <Step3
            reason={reason}
            setReason={setReason}
            freeText={freeText}
            setFreeText={setFreeText}
            onContinue={async () => {
              if (!reason) return;
              await api("/api/subscription/cancel", {
                method: "POST",
                body: JSON.stringify({ step: 3, primaryReason: reason, freeText }),
              });
              setStep(4);
            }}
            onBack={() => setStep(2)}
          />
        )}
        {step === 4 && (
          <Step4
            subscription={subscription}
            stats={stats}
            onConfirm={async () => {
              const res = await api<CancelStep4Response>("/api/subscription/cancel", {
                method: "POST",
                body: JSON.stringify({
                  step: 4,
                  primaryReason: reason,
                  freeText,
                  effectiveAfterNextDelivery: true,
                }),
              });
              setDone(res);
              setStep("done");
            }}
            onBack={() => setStep(3)}
          />
        )}
        {step === "done" && done && <DoneState done={done} onClose={onClose} />}
      </div>
    </div>
  );
}

function Step1({
  stats,
  onContinue,
  onKeepGoing,
}: {
  customer: CustomerProfile;
  stats: CancelStep1Response["data"] | null;
  onContinue: () => void;
  onKeepGoing: () => void;
}) {
  const t = useLang();
  const loading = stats === null;
  return (
    <>
      <h1 className="font-display text-5xl font-black uppercase leading-none md:text-6xl">
        <T en="This is what" es="Esto es lo que" />
        <br />
        <T en="you've built" es="has construido" />
        <span className="text-[color:var(--color-bold-yellow)]">.</span>
      </h1>
      <div className="mt-10 grid grid-cols-2 gap-4">
        <Stat
          label={t({ en: "Boxes received", es: "Cajas recibidas" })}
          value={stats?.boxes ?? 0}
          loading={loading}
        />
        <Stat
          label={t({ en: "Cards collected", es: "Cartas coleccionadas" })}
          value={stats?.cards ?? 0}
          loading={loading}
        />
        <Stat
          label={t({ en: "Drops stacked", es: "Drops acumulados" })}
          value={stats?.drops ?? 0}
          loading={loading}
        />
        <Stat
          label={t({ en: "Months in inner circle", es: "Meses en inner circle" })}
          value={stats?.monthsInCircle ?? 0}
          loading={loading}
        />
      </div>
      <div className="mt-10 space-y-3">
        <button
          type="button"
          onClick={onKeepGoing}
          className="w-full rounded-sm bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
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

function Step2({
  onAlternative,
  onContinue,
  onBack,
}: {
  onAlternative: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <h1 className="font-display text-5xl font-black uppercase leading-none md:text-6xl">
        <T en="We can adjust" es="Podemos ajustar" />
        <br />
        <T en="your subscription" es="tu suscripción" />
        <span className="text-[color:var(--color-bold-yellow)]">.</span>
      </h1>
      <div className="mt-8 space-y-3">
        <Alternative
          labelEn="Skip the next one"
          labelEs="Saltar la próxima"
          subEn="Take a breather. Resume any time."
          subEs="Toma aire. Reanuda cuando quieras."
          onClick={onAlternative}
        />
        <Alternative
          labelEn="Change your plan"
          labelEs="Cambia tu plan"
          subEn="Fewer boxes, longer cadence, your call."
          subEs="Menos cajas, más espaciadas, tú decides."
          onClick={onAlternative}
        />
        <Alternative
          labelEn="New flavors in June"
          labelEs="Sabores nuevos en junio"
          subEn="Hold tight, Salty Peach is coming."
          subEs="Aguanta, Salty Peach está al caer."
          onClick={onAlternative}
        />
      </div>
      <div className="mt-10 flex justify-between">
        <button type="button" onClick={onBack} className="text-[11px] uppercase tracking-[0.18em] opacity-60">
          ← <T en="Back" es="Atrás" />
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="text-[11px] uppercase tracking-[0.18em] underline"
        >
          <T en="None of these. Cancel" es="Ninguna. Cancelar" /> →
        </button>
      </div>
    </>
  );
}

function Alternative({
  labelEn,
  labelEs,
  subEn,
  subEs,
  onClick,
}: {
  labelEn: string;
  labelEs: string;
  subEn: string;
  subEs: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded-2xl border border-[color:var(--color-brisky-cream)]/15 bg-[color:var(--color-darker-indigo)] px-5 py-4 text-left"
    >
      <div className="font-display text-lg font-black uppercase">
        <T en={labelEn} es={labelEs} />
      </div>
      <div className="mt-1 text-xs opacity-60">
        <T en={subEn} es={subEs} />
      </div>
    </button>
  );
}

function Step3({
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
  const REASONS: { value: CancellationReason; en: string; es: string }[] = [
    { value: "too_expensive", en: "Too expensive", es: "Demasiado caro" },
    { value: "too_much_product", en: "Too much product", es: "Demasiado producto" },
    { value: "not_using_enough", en: "Not using enough", es: "No lo uso lo suficiente" },
    { value: "taking_a_break", en: "Taking a break", es: "Me tomo un descanso" },
    { value: "other", en: "Other", es: "Otro" },
  ];

  return (
    <>
      <h1 className="font-display text-5xl font-black uppercase leading-none md:text-6xl">
        <T en="Why are you" es="¿Por qué te" />
        <br />
        <T en="leaving" es="vas" />
        <span className="text-[color:var(--color-bold-yellow)]">?</span>
      </h1>
      <ul className="mt-8 space-y-2">
        {REASONS.map((r) => (
          <li key={r.value}>
            <button
              type="button"
              onClick={() => setReason(r.value)}
              className={`flex w-full items-center justify-between rounded-sm border px-4 py-3 text-left text-sm uppercase tracking-[0.12em] ${
                reason === r.value
                  ? "border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/10"
                  : "border-[color:var(--color-brisky-cream)]/15"
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
          placeholder={t({ en: "Tell us more (optional)", es: "Cuéntanos más (opcional)" })}
          className="mt-3 w-full rounded-sm border border-[color:var(--color-brisky-cream)]/20 bg-transparent p-3 text-sm placeholder:opacity-40"
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
          disabled={!reason}
          className="rounded-sm bg-[color:var(--color-bold-yellow)] px-6 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-30"
        >
          <T en="Continue" es="Continuar" />
        </button>
      </div>
    </>
  );
}

function Step4({
  subscription,
  stats,
  onConfirm,
  onBack,
}: {
  subscription: Subscription | null;
  stats: CancelStep1Response["data"] | null;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const t = useLang();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h1 className="font-display text-5xl font-black uppercase leading-none md:text-6xl">
        <T en="Your last box" es="Tu última caja" />
        <br />
        <T en="still ships" es="aún se envía" />
        <span className="text-[color:var(--color-bold-yellow)]">.</span>
      </h1>
      <div className="mt-8 space-y-3 rounded-2xl border border-[color:var(--color-brisky-cream)]/15 p-5 text-sm">
        <Detail
          label={t({ en: "Current box ships", es: "Sale la caja actual" })}
          value={
            subscription?.nextShipDate
              ? new Date(subscription.nextShipDate).toLocaleDateString("en", {
                  month: "short",
                  day: "numeric",
                })
              : "—"
          }
        />
        <Detail label={t({ en: "Next billing", es: "Próximo cobro" })} value={t({ en: "None", es: "Ninguno" })} />
        <Detail label={t({ en: "Drops held 90 days", es: "Drops retenidos 90 días" })} value={stats?.drops ?? 0} />
        <Detail label={t({ en: "Cards (yours to keep)", es: "Cartas (son tuyas)" })} value={stats?.cards ?? 0} />
      </div>
      <div className="mt-10 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-[11px] uppercase tracking-[0.18em] opacity-60">
          ← <T en="Back" es="Atrás" />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-sm border border-[color:var(--color-brisky-cream)]/40 px-6 py-3 text-[11px] font-bold uppercase tracking-[0.2em] disabled:opacity-30"
        >
          {busy ? (
            <T en="Cancelling…" es="Cancelando…" />
          ) : (
            <T en="Cancel subscription" es="Cancelar suscripción" />
          )}
        </button>
      </div>
    </>
  );
}

function DoneState({ done, onClose }: { done: CancelStep4Response; onClose: () => void }) {
  const heldUntil = done.dropsHeldUntil ? new Date(done.dropsHeldUntil) : null;
  return (
    <>
      <h1 className="font-display text-6xl font-black uppercase leading-none text-[color:var(--color-bold-yellow)] md:text-7xl">
        <T en="Your last box" es="Tu última caja" />
        <br />
        <T en="is on the way" es="va en camino" />
        <span className="text-[color:var(--color-brisky-cream)]">.</span>
      </h1>
      <p className="mt-8 text-sm opacity-80">
        {heldUntil ? (
          <T
            en={`Your ${done.cardsKept} cards are yours. Drops held 90 days. The door's still open.`}
            es={`Tus ${done.cardsKept} cartas son tuyas. Drops retenidos 90 días. La puerta sigue abierta.`}
          />
        ) : (
          <T
            en={`Your Drops were reset. ${done.cardsKept} cards are yours.`}
            es={`Tus Drops se resetearon. ${done.cardsKept} cartas son tuyas.`}
          />
        )}
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-10 w-full rounded-sm bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
      >
        <T en="Back to LIT" es="Volver a LIT" />
      </button>
    </>
  );
}

function Stat({
  label,
  value,
  loading,
}: {
  label: string;
  value: number;
  loading?: boolean;
}) {
  return (
    <div className="rounded-2xl bg-[color:var(--color-darker-indigo)] p-5">
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

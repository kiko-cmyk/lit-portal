"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type {
  CancelStep1Response,
  CancelStep4Response,
  CancellationReason,
  CustomerProfile,
  Subscription,
} from "@/lib/types";

const REASONS: { value: CancellationReason; label: string }[] = [
  { value: "too_expensive", label: "Too expensive" },
  { value: "too_much_product", label: "Too much product" },
  { value: "not_using_enough", label: "Not using enough" },
  { value: "taking_a_break", label: "Taking a break" },
  { value: "other", label: "Other" },
];

type Step = 1 | 2 | 3 | 4 | "done";

/**
 * Cancel takeover — full-screen Board 3 (dark indigo). 4 steps + done state.
 * Per Master Spec § 7.
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

  // Load stats on mount
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
      {/* Close X */}
      <button
        type="button"
        onClick={onClose}
        className="absolute right-5 top-5 z-10 text-2xl opacity-60"
        aria-label="Close"
      >
        ×
      </button>

      <div className="mx-auto max-w-md px-6 pt-16 pb-10">
        {step === 1 && stats && (
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
  stats: CancelStep1Response["data"];
  onContinue: () => void;
  onKeepGoing: () => void;
}) {
  return (
    <>
      <h1 className="font-display text-5xl font-black uppercase leading-none">
        This is what<br />you&apos;ve built<span className="text-[color:var(--color-bold-yellow)]">.</span>
      </h1>
      <div className="mt-10 grid grid-cols-2 gap-4">
        <Stat label="Boxes received" value={stats.boxes} />
        <Stat label="Cards collected" value={stats.cards} />
        <Stat label="Drops stacked" value={stats.drops} />
        <Stat label="Months in inner circle" value={stats.monthsInCircle} />
      </div>
      <div className="mt-10 space-y-3">
        <button
          type="button"
          onClick={onKeepGoing}
          className="w-full rounded-sm bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
        >
          Keep going
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="w-full text-[11px] uppercase tracking-[0.18em] opacity-60 underline"
        >
          I still want to cancel
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
      <h1 className="font-display text-5xl font-black uppercase leading-none">
        We can<br />adjust<span className="text-[color:var(--color-bold-yellow)]">.</span>
      </h1>
      <div className="mt-8 space-y-3">
        <Alternative
          label="Skip the next one"
          subtitle="Take a breather. Resume any time."
          onClick={onAlternative}
        />
        <Alternative
          label="Change your plan"
          subtitle="Fewer boxes, longer cadence — your call."
          onClick={onAlternative}
        />
        <Alternative
          label="New flavors in June"
          subtitle="Hold tight — Salty Peach is coming."
          onClick={onAlternative}
        />
      </div>
      <div className="mt-10 flex justify-between">
        <button type="button" onClick={onBack} className="text-[11px] uppercase tracking-[0.18em] opacity-60">
          ← Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="text-[11px] uppercase tracking-[0.18em] underline"
        >
          None of these. Cancel →
        </button>
      </div>
    </>
  );
}

function Alternative({
  label,
  subtitle,
  onClick,
}: {
  label: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded-2xl border border-[color:var(--color-brisky-cream)]/15 bg-[color:var(--color-darker-indigo)] px-5 py-4 text-left"
    >
      <div className="font-display text-lg font-black uppercase">{label}</div>
      <div className="mt-1 text-xs opacity-60">{subtitle}</div>
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
  return (
    <>
      <h1 className="font-display text-5xl font-black uppercase leading-none">
        Why are you<br />leaving<span className="text-[color:var(--color-bold-yellow)]">?</span>
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
              <span>{r.label}</span>
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
          placeholder="Tell us more (optional)"
          className="mt-3 w-full rounded-sm border border-[color:var(--color-brisky-cream)]/20 bg-transparent p-3 text-sm placeholder:opacity-40"
          rows={3}
        />
      )}
      <div className="mt-10 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-[11px] uppercase tracking-[0.18em] opacity-60">
          ← Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!reason}
          className="rounded-sm bg-[color:var(--color-bold-yellow)] px-6 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] disabled:opacity-30"
        >
          Continue
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
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h1 className="font-display text-5xl font-black uppercase leading-none">
        Your last box<br />still ships<span className="text-[color:var(--color-bold-yellow)]">.</span>
      </h1>
      <div className="mt-8 space-y-3 rounded-2xl border border-[color:var(--color-brisky-cream)]/15 p-5 text-sm">
        <Detail
          label="Current box ships"
          value={
            subscription?.nextShipDate
              ? new Date(subscription.nextShipDate).toLocaleDateString("en", {
                  month: "short",
                  day: "numeric",
                })
              : "—"
          }
        />
        <Detail label="Next billing" value="None" />
        <Detail label="Drops held 90 days" value={stats?.drops ?? 0} />
        <Detail label="Cards (yours to keep)" value={stats?.cards ?? 0} />
      </div>
      <div className="mt-10 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-[11px] uppercase tracking-[0.18em] opacity-60">
          ← Back
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
          {busy ? "Cancelling…" : "Cancel subscription"}
        </button>
      </div>
    </>
  );
}

function DoneState({ done, onClose }: { done: CancelStep4Response; onClose: () => void }) {
  const heldUntil = done.dropsHeldUntil ? new Date(done.dropsHeldUntil) : null;
  return (
    <>
      <h1 className="font-display text-6xl font-black uppercase leading-none text-[color:var(--color-bold-yellow)]">
        Your last box<br />is on the way<span className="text-[color:var(--color-brisky-cream)]">.</span>
      </h1>
      <p className="mt-8 text-sm opacity-80">
        {heldUntil
          ? `Your Drops are held for 90 days. ${done.cardsKept} cards are yours. The door's still open.`
          : `Your Drops were reset. ${done.cardsKept} cards are yours.`}
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-10 w-full rounded-sm bg-[color:var(--color-bold-yellow)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
      >
        Back to LIT
      </button>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-[color:var(--color-darker-indigo)] p-5">
      <div className="font-display text-4xl font-black">{value}</div>
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

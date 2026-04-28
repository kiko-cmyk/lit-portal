"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BottomNav } from "@/components/BottomNav";
import { TierPill } from "@/components/TierPill";
import { api, ApiClientError } from "@/lib/api-client";
import type { DropsBalance, PuzzleState, ReferralCodeResponse } from "@/lib/types";

const REWARD_LABELS: Record<string, { en: string; es: string }> = {
  bottle_500: { en: "LIT Water Bottle", es: "Botella LIT" },
  merch_1000: { en: "LIT Merch", es: "Merch LIT" },
  event_2500: { en: "Event Invite", es: "Invitación a evento" },
};

export default function DropsPage() {
  const [balance, setBalance] = useState<DropsBalance | null>(null);
  const [puzzle, setPuzzle] = useState<PuzzleState | null>(null);
  const [referral, setReferral] = useState<ReferralCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<DropsBalance>("/api/drops/balance"),
      api<PuzzleState>("/api/drops/puzzle").catch(() => null),
      api<ReferralCodeResponse>("/api/referral/code"),
    ])
      .then(([b, p, r]) => {
        setBalance(b);
        setPuzzle(p);
        setReferral(r);
      })
      .catch((e: ApiClientError) => setError(e.code));
  }, []);

  if (error) {
    return (
      <main className="zone-retro flex flex-1 items-center justify-center">
        <p className="text-xs">Error: {error}</p>
      </main>
    );
  }
  if (!balance) {
    return (
      <main className="zone-retro flex flex-1 items-center justify-center">
        <p className="text-xs uppercase tracking-[0.2em] opacity-50">Loading…</p>
      </main>
    );
  }

  return (
    <div
      className="flex min-h-full flex-col"
      style={{
        background: "linear-gradient(180deg, #E2C9A0 0%, #D9B788 100%)",
        color: "#3A2F22",
      }}
    >
      <header className="flex items-center justify-between px-6 pt-5 pb-3">
        <Link href="/your-lit" className="text-xs font-bold uppercase tracking-[0.2em] opacity-70">
          ← Your LIT
        </Link>
        <span className="rounded-sm bg-[color:var(--color-lit-grey)]/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em]">
          Drops
        </span>
        <TierPill visible={balance.tierEarned} />
      </header>

      <main className="flex-1 pb-24">
        {/* Counter hero */}
        <section className="px-6 pt-8 pb-6 text-center">
          <div className="font-display text-[120px] font-black leading-none tracking-tighter">
            {balance.balance}
          </div>
          <div className="mt-2 text-xs font-bold uppercase tracking-[0.25em]">Drops</div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.18em] opacity-60">
            Lifetime: {balance.lifetimeEarned}
          </div>
        </section>

        {/* Active puzzle */}
        {puzzle && (
          <section className="mx-6 rounded-2xl bg-[color:var(--color-sharp-white)] p-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
              Active reward
            </div>
            <div className="mt-1 font-display text-2xl font-black uppercase">
              {REWARD_LABELS[puzzle.rewardId]?.en ?? puzzle.rewardId}
            </div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.15em] opacity-60">
              {puzzle.currentDrops} / {puzzle.rewardThreshold} Drops
            </div>

            {/* 4×4 puzzle grid */}
            <div className="mt-5 grid grid-cols-4 gap-1">
              {Array.from({ length: 16 }).map((_, i) => (
                <div
                  key={i}
                  className={`aspect-square rounded-sm ${
                    i < puzzle.piecesRevealed
                      ? "bg-[color:var(--color-bold-yellow)]"
                      : "bg-[color:var(--color-lit-grey)]/10"
                  }`}
                />
              ))}
            </div>

            {balance.claimableRewards.find((r) => r.rewardId === puzzle.rewardId) && (
              <button
                type="button"
                onClick={() => alert("Claim flow coming soon")}
                className="mt-5 w-full rounded-sm bg-[color:var(--color-bold-yellow)] py-3 text-xs font-black uppercase tracking-[0.2em]"
              >
                Claim it
              </button>
            )}
          </section>
        )}

        {/* HOW TO STACK */}
        <section className="mx-6 mt-6">
          <h2 className="font-display text-2xl font-black uppercase mb-3">How to stack</h2>
          <ul className="space-y-2 text-sm">
            <Earner amount="+100" label="Each box you receive" />
            <Earner amount="+250" label="Each friend who subscribes" />
            <Earner amount="+50" label="Each consecutive month" />
            <Earner amount="+50" label="Leave a product review" />
            <Earner amount="+25" label="Share on social (capped 100/mo)" />
          </ul>
        </section>

        {/* Referral */}
        {referral && (
          <section className="mx-6 mt-7 rounded-2xl bg-[color:var(--color-lit-grey)] p-6 text-[color:var(--color-brisky-cream)]">
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
              Bring someone in
            </div>
            <div className="mt-1 font-display text-3xl font-black uppercase">
              Your code
            </div>
            <div className="mt-4 flex items-center justify-between rounded-sm bg-[color:var(--color-brisky-cream)] px-4 py-3 text-[color:var(--color-lit-grey)]">
              <code className="font-mono text-lg font-black">{referral.code}</code>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(referral.shareUrl)}
                className="text-[10px] font-bold uppercase tracking-[0.18em]"
              >
                Copy link
              </button>
            </div>
            <div className="mt-3 text-[11px] uppercase tracking-[0.15em] opacity-70">
              {referral.conversions} converted · {referral.dropsEarned} Drops earned
            </div>
          </section>
        )}

        {/* Streak */}
        {balance.streakMonths > 0 && (
          <section className="mx-6 mt-5 rounded-2xl bg-[color:var(--color-sharp-white)] px-6 py-4">
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
              Streak
            </div>
            <div className="mt-1 font-display text-3xl font-black">
              {balance.streakMonths} mo
            </div>
          </section>
        )}

        <div className="mx-6 mt-8 text-center text-[10px] uppercase tracking-[0.25em] opacity-50">
          Stack · Unlock · Stay in
        </div>
      </main>

      <BottomNav />
    </div>
  );
}

function Earner({ amount, label }: { amount: string; label: string }) {
  return (
    <li className="flex items-center justify-between rounded-sm bg-[color:var(--color-sharp-white)] px-4 py-3">
      <span className="text-[11px] uppercase tracking-[0.12em]">{label}</span>
      <span className="font-display text-lg font-black">{amount}</span>
    </li>
  );
}

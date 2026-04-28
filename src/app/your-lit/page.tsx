"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BottomNav } from "@/components/BottomNav";
import { FirstLoginWelcome } from "@/components/FirstLoginWelcome";
import { TierPill } from "@/components/TierPill";
import { api, ApiClientError } from "@/lib/api-client";
import type { CustomerProfile, HubDashboard } from "@/lib/types";

export default function HubPage() {
  const [data, setData] = useState<HubDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);

  useEffect(() => {
    api<HubDashboard>("/api/hub/dashboard")
      .then(setData)
      .catch((e: ApiClientError) => setError(e.code));
    // Probe first-login flag via Shopify metafield (read through the customer endpoint
    // for now — when we wire customer_preferences fully, switch to that source).
    api<CustomerProfile & { firstLoginCompleted?: boolean }>("/api/customer")
      .then((c) => {
        // If we don't yet expose first_login_completed, default to false the first time
        // and let the user dismiss it.
        if (!c.firstLoginCompleted && typeof window !== "undefined") {
          const localKey = `lit_firstlogin_${c.email}`;
          if (!window.localStorage.getItem(localKey)) {
            setShowWelcome(true);
            window.localStorage.setItem(localKey, "shown");
          }
        }
      })
      .catch(() => null);
  }, []);

  if (error === "subscription_not_found") {
    return (
      <main className="zone-cream flex flex-1 flex-col items-center justify-center p-8 text-center">
        <h1 className="text-3xl mb-3">No active subscription.</h1>
        <p className="text-sm opacity-70">
          Once you start your first LIT subscription, you&apos;ll see your hub here.
        </p>
      </main>
    );
  }
  if (error) {
    return (
      <main className="zone-cream flex flex-1 flex-col items-center justify-center p-8 text-center">
        <h1 className="text-2xl mb-3">Something went wrong.</h1>
        <p className="text-xs opacity-50">{error}</p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="zone-cream flex flex-1 items-center justify-center">
        <p className="text-xs uppercase tracking-[0.2em] opacity-50">Loading…</p>
      </main>
    );
  }

  const { subscription, drops, nextEvent } = data;
  const next = subscription.nextShipDate ? new Date(subscription.nextShipDate) : null;
  const daysToShip = next ? Math.ceil((next.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;

  return (
    <div className="zone-cream flex min-h-full flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 pt-5 pb-3">
        <span className="font-display text-2xl font-black tracking-tight">LIT.</span>
        <TierPill visible={drops.tierEarned} />
      </header>

      <main className="flex-1 pb-24">
        {/* Next-box hero card */}
        <section className="mx-6 mt-2 rounded-2xl bg-[color:var(--color-sharp-white)] p-7 shadow-[0_4px_24px_rgba(50,55,67,0.06)]">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">
            Next box
          </div>
          {next ? (
            <>
              <div className="mt-2 font-display text-6xl font-black uppercase leading-none">
                {next.toLocaleDateString("en", { month: "short", day: "numeric" })}
              </div>
              <div className="mt-3 flex items-baseline gap-3 text-xs uppercase tracking-[0.15em]">
                <span className="opacity-60">{next.toLocaleDateString("en", { weekday: "long" })}</span>
                <span>·</span>
                <span>{subscription.flavor}</span>
                {daysToShip !== null && (
                  <>
                    <span>·</span>
                    <span className="rounded-sm bg-[color:var(--color-bold-yellow)] px-1.5 py-0.5 text-[color:var(--color-lit-grey)]">
                      {daysToShip}d
                    </span>
                  </>
                )}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.18em] opacity-50">
                Box #{subscription.nextBoxNumber} · {subscription.boxCount}
                {subscription.boxCount === 1 ? " box" : " boxes"}, every {subscription.frequencyLabel}
              </div>
            </>
          ) : (
            <div className="mt-2 text-sm opacity-70">Awaiting next ship date.</div>
          )}
        </section>

        {/* Quick Actions — 2x2 */}
        <section className="mx-6 mt-5 grid grid-cols-2 gap-2.5">
          <QuickAction label="Change plan" href="/account#plan" />
          <QuickAction label="Skip next box" href="/account#skip" />
          <QuickAction label="Switch flavor" subtitle="June" href="/account#flavor" disabled />
          <QuickAction label="Extras" href="/account#extras" />
        </section>

        {/* Drops peek */}
        <Link
          href="/drops"
          className="group mx-6 mt-5 flex items-center justify-between rounded-2xl bg-[color:var(--color-zesty-beige)] px-6 py-5 text-[color:var(--color-lit-grey)]"
        >
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-70">Drops</div>
            <div className="mt-1 font-display text-4xl font-black">{drops.balance}</div>
            {drops.activeReward && (
              <div className="mt-1 text-[10px] uppercase tracking-[0.15em] opacity-70">
                {drops.activeReward.percentComplete}% to next reward
              </div>
            )}
          </div>
          <span className="text-2xl transition-transform group-hover:translate-x-1">→</span>
        </Link>

        {/* World peek */}
        <Link
          href="/the-world"
          className="group mx-6 mt-3 flex items-center justify-between rounded-2xl bg-[color:var(--color-dark-indigo)] px-6 py-5 text-[color:var(--color-brisky-cream)]"
        >
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">The World</div>
            {nextEvent ? (
              <>
                <div className="mt-1 font-display text-2xl font-black uppercase">
                  {nextEvent.title}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.15em] opacity-70">
                  {new Date(nextEvent.datetime).toLocaleDateString("en", {
                    month: "short",
                    day: "numeric",
                    weekday: "short",
                  })}
                </div>
              </>
            ) : (
              <div className="mt-1 text-sm opacity-70">No upcoming events.</div>
            )}
          </div>
          <span className="text-2xl transition-transform group-hover:translate-x-1">→</span>
        </Link>
      </main>

      <BottomNav />

      {showWelcome && <FirstLoginWelcome onDismiss={() => setShowWelcome(false)} />}
    </div>
  );
}

function QuickAction({
  label,
  href,
  subtitle,
  disabled,
}: {
  label: string;
  href: string;
  subtitle?: string;
  disabled?: boolean;
}) {
  const inner = (
    <div
      className={`flex h-full flex-col justify-between rounded-2xl bg-[color:var(--color-sharp-white)] p-4 ${
        disabled ? "opacity-40" : ""
      }`}
    >
      <div className="text-xs font-bold uppercase tracking-[0.12em]">{label}</div>
      {subtitle && (
        <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">{subtitle}</div>
      )}
    </div>
  );
  if (disabled) {
    return <div aria-disabled className="cursor-not-allowed">{inner}</div>;
  }
  return (
    <Link href={href} className="block">
      {inner}
    </Link>
  );
}

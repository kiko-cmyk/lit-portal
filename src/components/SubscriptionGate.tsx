"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getSelectedSubscription, setSelectedSubscription } from "@/lib/api-client";
import { SubscriptionChooser } from "@/components/SubscriptionChooser";
import { T } from "@/lib/i18n";
import type { Subscription } from "@/lib/types";

/**
 * Lets any page (e.g. Account) offer a "switch subscription" control that
 * re-opens the chooser, and know whether the customer even has >1 sub.
 */
type SubscriptionSwitch = { canSwitch: boolean; openChooser: () => void };
const SwitchContext = createContext<SubscriptionSwitch>({ canSwitch: false, openChooser: () => {} });
export function useSubscriptionSwitch(): SubscriptionSwitch {
  return useContext(SwitchContext);
}

// Lightweight per-device hint of the last known sub count ("single" | "multi").
// Lets a RETURNING customer skip the loading wait: single-sub renders the portal
// immediately (no penalty for the 99%), multi-sub goes straight to the chooser
// (never flashing the portal). The background fetch always confirms/corrects it.
const COUNT_HINT_KEY = "lit_sub_count_hint";

function GateSplash() {
  return (
    <div className="zone-cream flex min-h-screen items-center justify-center bg-[color:var(--color-brisky-cream)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="https://litsalt.com/cdn/shop/t/31/assets/lit-logo-dark-indigo.png"
        alt="LIT"
        className="h-7 w-auto animate-pulse opacity-50"
      />
    </div>
  );
}

/**
 * Portal-wide gate for multi-subscription customers, mounted once per session in
 * the layout.
 *
 * - Single-sub (99%): renders the portal (children) — invisible.
 * - Multi-sub: shows the first-screen chooser on every entry; once picked,
 *   api-client injects ?seal_subscription_id into every call so the whole portal
 *   operates on the chosen sub. A "Switch" control re-opens the chooser.
 *
 * Never flashes a portal page before the chooser: it renders a neutral splash
 * until the decision is made (instant for returning customers via the count hint).
 */
export function SubscriptionGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"loading" | "children" | "chooser">("loading");
  const [subs, setSubs] = useState<Subscription[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Instant decision for returning customers (avoids both a loading wait for
    // single-sub AND a portal flash for multi-sub).
    try {
      const hint = window.localStorage.getItem(COUNT_HINT_KEY);
      if (hint === "single") setPhase("children");
      else if (hint === "multi") setPhase("chooser");
    } catch {
      // ignore
    }
    api<{ subscriptions: Subscription[] }>("/api/subscriptions")
      .then((d) => {
        if (cancelled) return;
        const list = d.subscriptions ?? [];
        setSubs(list);
        const multi = list.length > 1;
        try {
          window.localStorage.setItem(COUNT_HINT_KEY, multi ? "multi" : "single");
        } catch {
          // ignore
        }
        setPhase(multi ? "chooser" : "children");
      })
      .catch(() => {
        // Not logged in / transient error → let the page handle it (login etc.).
        if (!cancelled) setPhase("children");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "loading") return <GateSplash />;

  if (phase === "chooser") {
    // Reached via the hint before the list loaded → keep the splash until ready
    // (never a portal flash). If the fetch later says single-sub, phase flips to
    // "children" and we fall through.
    if (subs.length <= 1) return <GateSplash />;
    return (
      <SubscriptionChooser
        subs={subs}
        onPick={(id) => {
          setSelectedSubscription(id);
          setPhase("children");
        }}
      />
    );
  }

  return (
    <SwitchContext.Provider value={{ canSwitch: subs.length > 1, openChooser: () => setPhase("chooser") }}>
      {/* Desktop switches from the TopNav ("Cambiar de cuenta"). This floating
          pill is MOBILE-ONLY, where the compact header has no menu bar. */}
      {subs.length > 1 && (
        <button
          type="button"
          onClick={() => setPhase("chooser")}
          className="fixed right-3 top-3 z-[60] rounded-full border border-[color:var(--color-lit-grey)]/20 bg-[color:var(--color-brisky-cream)]/90 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.15em] opacity-70 backdrop-blur transition hover:opacity-100 md:hidden"
        >
          <T en="Switch account" es="Cambiar de cuenta" />
        </button>
      )}
      {children}
    </SwitchContext.Provider>
  );
}

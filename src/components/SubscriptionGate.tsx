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

/**
 * Portal-wide gate for multi-subscription customers. Wraps every [locale] page
 * (mounted once per session in the layout).
 *
 * - Single-sub customers (the 99%): /api/subscriptions returns <=1 → renders
 *   children immediately, no chooser, no flash, no "switch" button. Fully
 *   invisible. (While the rollout allowlist is on, non-allowlisted customers get
 *   an empty list back instantly, so this is a no-op for them too.)
 * - Multi-sub customers: if no valid selection is stored yet, shows the
 *   first-screen chooser; once picked (persisted in localStorage), api-client
 *   injects ?seal_subscription_id into every call so the whole portal — Hub,
 *   Account, mutations — operates on the chosen sub. A "Switch" button re-opens
 *   the chooser.
 *
 * Renders children by default (optimistic) and only swaps in the chooser after
 * the async check, so single-sub never sees a loading blank.
 */
export function SubscriptionGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState(false);
  const [subs, setSubs] = useState<Subscription[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Optimistic: a stored pick means this is a returning multi-sub customer, so
    // show the chooser at once (no Hub flash before the fetch resolves). The
    // fetch below confirms/corrects.
    try {
      if (getSelectedSubscription()) setGate(true);
    } catch {
      // ignore
    }
    api<{ subscriptions: Subscription[] }>("/api/subscriptions")
      .then((d) => {
        if (cancelled) return;
        const list = d.subscriptions ?? [];
        setSubs(list);
        // Chooser is the landing screen on EVERY portal entry for multi-sub
        // customers (Juan: "pantalla inicial al loguearme"). Single-sub (<=1)
        // never sees it. The gate mounts once per session (in the layout), so
        // this is once-per-session, not per navigation.
        setGate(list.length > 1);
      })
      .catch(() => {
        // Not logged in / transient error → drop the gate, let the page handle it.
        if (!cancelled) setGate(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Chooser is the landing screen for multi-sub. While optimistically gated but
  // the list hasn't loaded yet, render nothing (brief) instead of a wrong-sub flash.
  if (gate && subs.length > 1) {
    return (
      <SubscriptionChooser
        subs={subs}
        onPick={(id) => {
          setSelectedSubscription(id);
          setGate(false);
        }}
      />
    );
  }
  if (gate) return null;

  return (
    <SwitchContext.Provider value={{ canSwitch: subs.length > 1, openChooser: () => setGate(true) }}>
      {subs.length > 1 && (
        <button
          type="button"
          onClick={() => setGate(true)}
          className="fixed right-3 top-3 z-[60] rounded-full border border-[color:var(--color-lit-grey)]/20 bg-[color:var(--color-brisky-cream)]/90 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.15em] opacity-70 backdrop-blur transition hover:opacity-100"
        >
          <T en="Switch" es="Cambiar" />
        </button>
      )}
      {children}
    </SwitchContext.Provider>
  );
}

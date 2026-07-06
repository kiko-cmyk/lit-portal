"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api, getSelectedSubscription, setSelectedSubscription } from "@/lib/api-client";
import { SubscriptionChooser } from "@/components/SubscriptionChooser";
import { T } from "@/lib/i18n";
import type { Subscription } from "@/lib/types";

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
    api<{ subscriptions: Subscription[] }>("/api/subscriptions")
      .then((d) => {
        if (cancelled) return;
        const list = d.subscriptions ?? [];
        setSubs(list);
        if (list.length <= 1) return; // single-sub / gated → no chooser
        const sel = getSelectedSubscription();
        if (!sel || !list.some((s) => s.sealSubscriptionId === sel)) setGate(true);
      })
      .catch(() => {
        // Not logged in / transient error → let the page handle it (login etc.).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (gate) {
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

  return (
    <>
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
    </>
  );
}

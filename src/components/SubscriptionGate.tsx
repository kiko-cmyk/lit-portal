"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiClientError, getSelectedSubscription, setSelectedSubscription } from "@/lib/api-client";
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
// (never flashing the portal). The background fetch always confirms/corrects it,
// and it doubles as a resilience fallback when the list can't be fetched (see
// below): a known multi-sub customer keeps the switch instead of being silently
// collapsed to single.
const COUNT_HINT_KEY = "lit_sub_count_hint";

function readHint(): "single" | "multi" | null {
  try {
    const h = window.localStorage.getItem(COUNT_HINT_KEY);
    return h === "single" || h === "multi" ? h : null;
  } catch {
    return null;
  }
}

function writeHint(multi: boolean) {
  try {
    window.localStorage.setItem(COUNT_HINT_KEY, multi ? "multi" : "single");
  } catch {
    // ignore
  }
}

/**
 * A failed /api/subscriptions call must NOT silently collapse a multi-sub
 * customer to single. Retry transient upstream failures (Seal throttle 429,
 * upstream 5xx / seal_busy, gateway timeout, network blips). Do NOT retry auth
 * failures (not logged in) — those are terminal and the page renders login.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof ApiClientError) {
    return (
      err.status === 429 ||
      err.status === 503 ||
      err.status === 504 ||
      err.code === "seal_busy" ||
      err.code === "gateway_timeout"
    );
  }
  return true; // network / abort / unknown → treat as transient
}

async function loadSubs(): Promise<Subscription[]> {
  const delays = [600, 1200, 2000, 3000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const d = await api<{ subscriptions: Subscription[] }>("/api/subscriptions");
      return d.subscriptions ?? [];
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length && isTransient(err)) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

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
 *
 * Resilient: if the sub list can't be loaded (transient Seal throttle etc.), it
 * retries; if it still fails it falls back to the count hint so a known multi-sub
 * customer keeps the switch and can re-open the chooser (which re-fetches) rather
 * than being stranded on a single-sub view with no way back.
 */
export function SubscriptionGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"loading" | "children" | "chooser">("loading");
  const [subs, setSubs] = useState<Subscription[]>([]);
  // Fallback flag: when the list couldn't be fetched, keep the switch alive for a
  // customer the hint says is multi-sub. Cleared/confirmed on a successful load.
  const [hintMulti, setHintMulti] = useState(false);

  const refresh = useCallback(async (): Promise<Subscription[]> => {
    const list = await loadSubs();
    setSubs(list);
    writeHint(list.length > 1);
    setHintMulti(list.length > 1);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Instant decision for returning customers (avoids both a loading wait for
    // single-sub AND a portal flash for multi-sub).
    const hint = readHint();
    if (hint === "single") setPhase("children");
    else if (hint === "multi") {
      setHintMulti(true);
      setPhase("chooser");
    }
    refresh()
      .then((list) => {
        if (!cancelled) setPhase(list.length > 1 ? "chooser" : "children");
      })
      .catch((err) => {
        if (cancelled) return;
        // Retries exhausted. Don't trap the customer on the splash and don't
        // collapse a known multi-sub to single: render the portal, but keep the
        // switch available (via the hint) so they can re-open the chooser, which
        // re-fetches. Auth errors are terminal → let the page render login.
        setHintMulti(isTransient(err) && readHint() === "multi");
        setPhase("children");
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const openChooser = useCallback(() => {
    if (subs.length > 1) {
      setPhase("chooser");
      return;
    }
    // Switch pressed but the list isn't loaded (initial fetch failed): show the
    // splash while we re-fetch, then open the chooser (or fall back to portal).
    setPhase("chooser");
    refresh()
      .then((list) => setPhase(list.length > 1 ? "chooser" : "children"))
      .catch(() => setPhase("children"));
  }, [subs.length, refresh]);

  if (phase === "loading") return <GateSplash />;

  if (phase === "chooser") {
    // Reached via the hint (or a re-fetch) before the list is ready → keep the
    // splash until it loads (never a portal flash). If it resolves to single-sub,
    // phase flips to "children" and we fall through.
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

  const canSwitch = subs.length > 1 || hintMulti;
  return (
    <SwitchContext.Provider value={{ canSwitch, openChooser }}>
      {/* Desktop switches from the TopNav pill ("Cambiar"). This floating pill
          is MOBILE-ONLY, where the compact header has no menu bar. */}
      {canSwitch && (
        <button
          type="button"
          onClick={openChooser}
          className="fixed right-3 top-3 z-[60] rounded-full border border-[color:var(--color-lit-grey)]/20 bg-[color:var(--color-brisky-cream)]/90 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.15em] opacity-70 backdrop-blur transition hover:opacity-100 md:hidden"
        >
          <T en="Switch" es="Cambiar" />
        </button>
      )}
      {children}
    </SwitchContext.Provider>
  );
}

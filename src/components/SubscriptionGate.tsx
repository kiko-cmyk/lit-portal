"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  api,
  ApiClientError,
  clearSelectedSubscription,
  getSelectedSubscription,
  setSelectedSubscription,
} from "@/lib/api-client";
import { SubscriptionChooser } from "@/components/SubscriptionChooser";
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

// Time caps for the gate's initial load (audit 2026-07-08). Uncapped, a HUNG
// App Proxy/function (the documented Supabase-paused failure mode) meant each
// attempt burned api()'s full 65s client timeout: 5 × 65s + backoff ≈ 5.5 min
// of splash before the existing degraded fallback kicked in. Cap each attempt
// short (abort maps to gateway_timeout → still transient, retry semantics
// unchanged) and stop retrying past a total budget — the catch below then
// applies the exact same fallback (children + count hint), just ~25s in.
const GATE_ATTEMPT_TIMEOUT_MS = 8_000;
const GATE_TOTAL_BUDGET_MS = 25_000;

async function loadSubs(): Promise<Subscription[]> {
  const delays = [600, 1200, 2000, 3000];
  const startedAt = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GATE_ATTEMPT_TIMEOUT_MS);
    try {
      const d = await api<{ subscriptions: Subscription[] }>("/api/subscriptions", {
        signal: ctrl.signal,
      });
      return d.subscriptions ?? [];
    } catch (err) {
      lastErr = err;
      if (
        attempt < delays.length &&
        isTransient(err) &&
        Date.now() - startedAt < GATE_TOTAL_BUDGET_MS
      ) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
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
    // Stale-selection cleanup (audit 2026-07-06): if the stored pick is no
    // longer in the manageable list (customer cancelled that sub, or a previous
    // user of this browser left theirs), drop it. Without this, api-client keeps
    // scoping EVERY call to the dead sub: the portal pins to its post-cancel
    // view, the switch hides (1 manageable sub) and the remaining ACTIVE sub
    // becomes unreachable.
    const sel = getSelectedSubscription();
    if (sel && !list.some((s) => String(s.sealSubscriptionId) === sel)) {
      clearSelectedSubscription();
    }
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
  // The switch control lives in each header's right edge (TopNav pill on desktop,
  // and the mobile header pill on Hub/Account) so it never floats over the user
  // chip. The gate just provides the context; it renders no button of its own.
  return (
    <SwitchContext.Provider value={{ canSwitch, openChooser }}>
      {children}
    </SwitchContext.Provider>
  );
}

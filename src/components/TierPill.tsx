"use client";

import { useEffect, useState } from "react";
import { T } from "@/lib/i18n";

const TIER_SEEN_KEY = "lit:tier-seen-at";

/**
 * INNER CIRCLE pill — visible only when tier earned (300 lifetime Drops).
 * Per Master Spec § 10: "Earned, not assumed" — silent until threshold crossed.
 *
 * Pass a `tierEarnedAt` ISO timestamp to trigger the `tier-appear` keyframe
 * the first time the user sees it (compared against sessionStorage). Once
 * acknowledged, future renders are silent.
 *
 * `fresh` used to be decided once in a lazy useState initializer — but the
 * pill usually MOUNTS with visible=false (tier arrives async), so the
 * "first seen" animation could never fire on those pages, and writing
 * sessionStorage inside render was a side effect StrictMode could consume
 * on a discarded render. It's now derived on render (pure read of state)
 * and the seen-marker is persisted in an effect once actually shown.
 * (audit 2026-07-08)
 */
export function TierPill({
  visible,
  tierEarnedAt,
}: {
  visible: boolean;
  tierEarnedAt?: string | null;
}) {
  const [seen] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.sessionStorage.getItem(TIER_SEEN_KEY);
    } catch {
      return null;
    }
  });
  const fresh = visible && !!tierEarnedAt && seen !== tierEarnedAt;

  useEffect(() => {
    // Persist "seen" once the pill actually shows. Deliberately NOT mirrored
    // into state: flipping `fresh` mid-mount would cancel the running
    // animation; the next mount reads the marker and stays silent.
    if (!fresh || !tierEarnedAt) return;
    try {
      window.sessionStorage.setItem(TIER_SEEN_KEY, tierEarnedAt);
    } catch {
      // ignore
    }
  }, [fresh, tierEarnedAt]);

  if (!visible) return null;
  return (
    // min-w-0 + overflow-hidden let the pill truncate in tight mobile headers
    // (multi-sub pill + toggle + chip + TierPill on ≤390px) instead of
    // overflowing the viewport (audit 2026-07-08).
    <span
      className="inline-flex min-w-0 items-center overflow-hidden rounded-full bg-[color:var(--color-bold-yellow)] px-3 py-1.5 text-[9px] font-extrabold uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
      style={fresh ? { animation: "tier-appear 0.6s ease-out" } : undefined}
    >
      <span className="min-w-0 truncate">
        <T en="Inner Circle" es="Círculo Interior" />
      </span>
    </span>
  );
}

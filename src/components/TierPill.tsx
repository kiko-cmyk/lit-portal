"use client";

import { useState } from "react";
import { T } from "@/lib/i18n";

const TIER_SEEN_KEY = "lit:tier-seen-at";

/**
 * INNER CIRCLE pill — visible only when tier earned (300 lifetime Drops).
 * Per Master Spec § 10: "Earned, not assumed" — silent until threshold crossed.
 *
 * Pass a `tierEarnedAt` ISO timestamp to trigger the `tier-appear` keyframe
 * the first time the user sees it (compared against sessionStorage). Once
 * acknowledged, future renders are silent. The flag is decided once at mount
 * via a lazy initializer so we don't ping-pong setState inside an effect.
 */
export function TierPill({
  visible,
  tierEarnedAt,
}: {
  visible: boolean;
  tierEarnedAt?: string | null;
}) {
  const [fresh] = useState<boolean>(() => {
    if (!visible || !tierEarnedAt || typeof window === "undefined") return false;
    const seen = window.sessionStorage.getItem(TIER_SEEN_KEY);
    if (seen === tierEarnedAt) return false;
    window.sessionStorage.setItem(TIER_SEEN_KEY, tierEarnedAt);
    return true;
  });

  if (!visible) return null;
  return (
    <span
      className="inline-flex items-center rounded-sm bg-[color:var(--color-bold-yellow)] px-3 py-1.5 text-[9px] font-extrabold uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]"
      style={fresh ? { animation: "tier-appear 0.6s ease-out" } : undefined}
    >
      <T en="Inner Circle" es="Círculo Interior" />
    </span>
  );
}

/**
 * INNER CIRCLE pill — visible only when tier earned (300 lifetime Drops).
 * Per Master Spec § 10: "Earned, not assumed" — silent until threshold crossed.
 */
export function TierPill({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span className="inline-flex items-center rounded-sm bg-[color:var(--color-bold-yellow)] px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.15em] text-[color:var(--color-lit-grey)]">
      Inner Circle
    </span>
  );
}

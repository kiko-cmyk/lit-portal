"use client";

import { useSubscriptionSwitch } from "@/components/SubscriptionGate";
import { useLang } from "@/lib/i18n";

/**
 * Multi-sub "Cambiar / Switch" pill — same size/style as the header pill on
 * the Hub and Account mobile headers (Juan 2026-07-06). Renders nothing for
 * single-sub customers. Added so Collection and the order detail don't lose
 * the switch on mobile, where TopNav (which carries it on desktop) is hidden
 * (audit 2026-07-08).
 */
export function SubSwitchPill() {
  const { canSwitch, openChooser } = useSubscriptionSwitch();
  const t = useLang();
  if (!canSwitch) return null;
  return (
    <button
      type="button"
      onClick={openChooser}
      className="shrink-0 inline-flex cursor-pointer items-center rounded-full border border-[color:var(--color-lit-grey)]/22 bg-[color:var(--color-sharp-white)] px-3.5 py-[8px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-lit-grey)] transition-transform duration-150 ease-out hover:-translate-y-[1px] hover:border-[color:var(--color-lit-grey)]/50"
      style={{ fontFamily: "var(--font-body)", fontSize: 11 }}
    >
      {t({ en: "Switch", es: "Cambiar" })}
    </button>
  );
}

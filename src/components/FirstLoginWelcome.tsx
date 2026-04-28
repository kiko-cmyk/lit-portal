"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";

/**
 * First-login welcome takeover. Full-screen, dismissible.
 * 2 options: WhatsApp opt-in (+50 Drops one-time), language picker.
 *
 * Trigger: shown on first /your-lit visit when customer_preferences
 * .first_login_completed is false. Caller marks complete on dismiss
 * (any path: take-me-to-LIT, skip, X close).
 */
export function FirstLoginWelcome({ onDismiss }: { onDismiss: () => void }) {
  const [whatsapp, setWhatsapp] = useState(false);
  const [lang, setLang] = useState<"en" | "es">("en");
  const [busy, setBusy] = useState(false);

  const dismiss = async () => {
    setBusy(true);
    try {
      // Persist any selections made (best-effort)
      if (whatsapp) {
        await api("/api/first-login/whatsapp", {
          method: "POST",
          body: JSON.stringify({ optIn: true }),
        }).catch(() => null);
      }
      await api("/api/first-login/language", {
        method: "POST",
        body: JSON.stringify({ language: lang }),
      }).catch(() => null);
      await api("/api/first-login/complete", { method: "POST" }).catch(() => null);
    } finally {
      onDismiss();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-[#0F0E1A]/85 backdrop-blur-sm sm:items-center">
      <div className="zone-cream relative mx-auto w-full max-w-md rounded-t-3xl bg-[color:var(--color-brisky-cream)] px-6 pb-8 pt-9 sm:rounded-3xl">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close"
          className="absolute right-4 top-4 text-2xl opacity-60"
        >
          ×
        </button>

        <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
          First 50 Drops · One minute
        </div>
        <h1 className="mt-2 font-display text-4xl font-black uppercase leading-none">
          Two things to set<br />
          before your first<br />
          box lands<span className="text-[color:var(--color-bold-yellow)]">.</span>
        </h1>
        <p className="mt-3 text-sm opacity-70">
          Skip if you want — we&apos;ll remember.
        </p>

        {/* Option 1: WhatsApp */}
        <div className="mt-7 rounded-2xl bg-[color:var(--color-sharp-white)] p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.15em]">
                WhatsApp updates
              </div>
              <div className="mt-1 text-[11px] opacity-60">
                Delivery alerts, flavor drops. Max 3/month.
              </div>
            </div>
            <Toggle on={whatsapp} onChange={setWhatsapp} />
          </div>
          {whatsapp && (
            <div className="mt-3 inline-flex rounded-sm bg-[color:var(--color-bold-yellow)] px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.15em]">
              +50 First Drops stacked
            </div>
          )}
        </div>

        {/* Option 2: Language */}
        <div className="mt-3 rounded-2xl bg-[color:var(--color-sharp-white)] p-5">
          <div className="text-xs font-bold uppercase tracking-[0.15em] mb-3">Language</div>
          <div className="flex gap-2">
            {(["en", "es"] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`flex-1 rounded-sm py-2 text-[11px] font-bold uppercase tracking-[0.18em] ${
                  lang === l
                    ? "bg-[color:var(--color-bold-yellow)]"
                    : "bg-[color:var(--color-lit-grey)]/5 opacity-70"
                }`}
              >
                {l === "en" ? "English" : "Español"}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={dismiss}
          className="mt-7 w-full rounded-sm bg-[color:var(--color-lit-grey)] py-4 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-brisky-cream)] disabled:opacity-50"
        >
          {busy ? "Saving…" : "Take me to LIT"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={dismiss}
          className="mt-2 w-full text-[11px] uppercase tracking-[0.18em] opacity-50 underline"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
        on ? "bg-[color:var(--color-bold-yellow)]" : "bg-[color:var(--color-lit-grey)]/20"
      }`}
    >
      <span
        className={`absolute top-1 left-1 h-5 w-5 rounded-full bg-[color:var(--color-lit-grey)] transition-transform ${
          on ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}

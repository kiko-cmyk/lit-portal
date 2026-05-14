"use client";

import { useState } from "react";
import { runSealMutation, type SealMutationResult } from "@/lib/seal-popup";

/**
 * Temporary dev page used during the JWT spike. Triggers a no-op Seal
 * mutation through the Customer Account UI Extension popup so we can
 * confirm Seal accepts JWTs minted for OUR app's audience.
 *
 * Test path: `add_remove_products` with `deleted_items: "999999999"` —
 * an item ID that doesn't exist on the customer's sub. If Seal accepts
 * our JWT (success or graceful error other than 401/403), the bridge
 * works. If Seal returns 401/403 / auth failure, our audience is rejected
 * and we need a different path.
 *
 * Remove this page once the spike is over.
 */

export default function TestSealPopup() {
  const [result, setResult] = useState<SealMutationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [subId, setSubId] = useState("12635109");
  const [itemId, setItemId] = useState("999999999");

  const fire = async () => {
    setRunning(true);
    setResult(null);
    try {
      const r = await runSealMutation("add_remove_products", {
        subscriptionId: Number(subId),
        deleted_items: itemId,
      });
      setResult(r);
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="zone-cream min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="font-display text-3xl font-black uppercase mb-2">JWT spike</h1>
      <p className="text-sm opacity-70 mb-6">
        Triggers a no-op Seal mutation through the extension popup to see whether Seal
        accepts a JWT minted for our app's audience.
      </p>

      <div className="space-y-3 mb-6">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-[0.18em] opacity-60">
            subscriptionId
          </span>
          <input
            value={subId}
            onChange={(e) => setSubId(e.target.value)}
            className="mt-1 w-full rounded-sm border border-[color:var(--color-lit-grey)]/20 bg-[color:var(--color-sharp-white)] px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-[0.18em] opacity-60">
            deleted_items (use a fake ID like 999999999 to keep it harmless)
          </span>
          <input
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            className="mt-1 w-full rounded-sm border border-[color:var(--color-lit-grey)]/20 bg-[color:var(--color-sharp-white)] px-3 py-2 text-sm"
          />
        </label>
      </div>

      <button
        type="button"
        disabled={running}
        onClick={fire}
        className="rounded-sm bg-[color:var(--color-lit-grey)] px-6 py-3 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-brisky-cream)] disabled:opacity-50"
      >
        {running ? "Running…" : "Fire test popup"}
      </button>

      {result && (
        <pre className="mt-6 rounded-sm bg-[color:var(--color-sharp-white)] p-4 text-[11px] leading-relaxed whitespace-pre-wrap break-all">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}

      <div className="mt-8 text-xs opacity-50 space-y-1">
        <p>
          What we&apos;re looking for:
        </p>
        <ul className="list-disc ml-5">
          <li>
            <strong>ok: true</strong> — Seal accepted our JWT. Full popup-based architecture works.
          </li>
          <li>
            <strong>seal.error mentions item not found / not yours</strong> — JWT was
            accepted, only the test payload failed. Still a green light.
          </li>
          <li>
            <strong>HTTP 401 / 403 / signature failure</strong> — JWT audience mismatch.
            Need Seal to whitelist us or migrate off Seal.
          </li>
          <li>
            <strong>popup_blocked / popup_closed_by_user</strong> — browser blocked
            popup. Allow popups for litsalt.com and retry.
          </li>
        </ul>
      </div>
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { T } from "@/lib/i18n";
import type { Subscription } from "@/lib/types";

/**
 * Multi-subscription selector.
 *
 * Renders NOTHING for the 99% of customers with a single subscription — it only
 * appears when `GET /api/subscriptions` returns more than one manageable sub.
 * That self-gating is what keeps the whole feature invisible to single-sub
 * customers even after launch. On select, the parent persists the choice and
 * refetches the Hub/Account for that subscription.
 */
export function SubscriptionSelector({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (sealSubscriptionId: string) => void;
}) {
  const [subs, setSubs] = useState<Subscription[] | null>(null);

  useEffect(() => {
    api<{ subscriptions: Subscription[] }>("/api/subscriptions")
      .then((d) => setSubs(d.subscriptions))
      .catch(() => setSubs([]));
  }, []);

  if (!subs || subs.length <= 1) return null; // single-sub → invisible

  const active = selectedId ?? subs[0]?.sealSubscriptionId ?? null;

  return (
    <section className="mx-6 mt-4 md:mx-0">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
        <T en="Your subscriptions" es="Tus suscripciones" />
      </div>
      <div className="flex flex-wrap gap-2">
        {subs.map((s) => {
          const isSel = s.sealSubscriptionId === active;
          return (
            <button
              key={s.sealSubscriptionId}
              type="button"
              onClick={() => onSelect(s.sealSubscriptionId)}
              aria-pressed={isSel}
              className={
                "rounded-full border px-4 py-2 text-xs font-semibold transition " +
                (isSel
                  ? "border-[color:var(--color-lit-grey)] bg-[color:var(--color-lit-grey)] text-[color:var(--color-brisky-cream)]"
                  : "border-[color:var(--color-lit-grey)]/25 bg-transparent opacity-70 hover:opacity-100")
              }
            >
              {s.flavor} · {s.frequencyLabel}
            </button>
          );
        })}
      </div>
    </section>
  );
}

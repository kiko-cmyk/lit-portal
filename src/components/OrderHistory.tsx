"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLangValue } from "@/lib/i18n";
import { orderStatusStyle, translateOrderStatus } from "@/lib/order-status";
import { orderDetailHref } from "@/lib/portal-link";
import type { OrderHistoryItem } from "@/lib/types";

/**
 * Past orders list. Loaded lazily off `/api/orders?limit=N` on mount, never
 * blocks the Hub's first paint.
 *
 * Renders nothing while loading and an empty hint when the customer has no
 * delivered orders yet (which is what most subscribers will see on day 0).
 */
export function OrderHistory({ limit = 10 }: { limit?: number }) {
  const [orders, setOrders] = useState<OrderHistoryItem[] | null>(null);
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  useEffect(() => {
    api<OrderHistoryItem[]>(`/api/orders?limit=${limit}`)
      .then(setOrders)
      .catch(() => setOrders([]));
  }, [limit]);

  if (orders === null) return null;

  return (
    <section className="mx-6 mt-5 md:mx-0">
      {/* Per Juan 2026-05-18 round 6: drop the inner "Historial de pedidos"
          label and the order-count meta — the SectionDivider above already
          says "Historial", this internal eyebrow was duplicate noise. */}
      {orders.length === 0 ? (
        <div className="rounded-[20px] border border-dashed border-[color:var(--color-lit-grey)]/15 bg-[color:var(--color-sharp-white)]/60 px-5 py-6 text-center text-[12px] text-[color:var(--color-warm-gray)] md:rounded-[22px]">
          <T
            en="Your past orders will appear here after your first order."
            es="Tus pedidos pasados aparecerán aquí tras tu primer pedido."
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {orders.map((o) => (
            <li
              key={o.id}
              className="overflow-hidden rounded-[14px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)]"
              style={{ boxShadow: "0 10px 30px -14px rgba(40,34,20,0.22)" }}
            >
              <Link
                href={orderDetailHref(lang, o.id)}
                className="flex items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-[color:var(--color-brisky-cream)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-[color:var(--color-lit-grey)]">
                    {o.orderNumber} ·{" "}
                    {new Date(o.date).toLocaleDateString(dateLocale, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[color:var(--color-warm-gray)]">
                    {o.total.toFixed(2)} {o.currency} · {translateOrderStatus(o.status, lang)}
                  </div>
                </div>
                <span
                  className="rounded-full px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.18em]"
                  style={orderStatusStyle(o.status)}
                >
                  {translateOrderStatus(o.status, lang).toUpperCase()}
                </span>
                <span
                  className="ml-2 text-[12px] text-[color:var(--color-warm-gray)]"
                  aria-hidden
                >
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


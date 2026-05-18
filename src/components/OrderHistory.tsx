"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { T, useLang, useLangValue } from "@/lib/i18n";
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
  const t = useLang();
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
      <div className="section-label mb-3 flex items-center justify-between">
        <span>
          <T en="Order history" es="Historial de pedidos" />
        </span>
        <span className="font-extrabold text-[color:var(--color-lit-grey)]">
          {orders.length}{" "}
          {orders.length === 1
            ? t({ en: "order", es: "pedido" })
            : t({ en: "orders", es: "pedidos" })}
        </span>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[color:var(--color-lit-grey)]/15 bg-[color:var(--color-sharp-white)]/60 px-5 py-6 text-center text-[12px] text-[color:var(--color-warm-gray)]">
          <T
            en="Your past orders will appear here after your first delivery."
            es="Tus pedidos pasados aparecerán aquí tras tu primera entrega."
          />
        </div>
      ) : (
        <ul className="overflow-hidden rounded-2xl border border-[color:var(--color-lit-grey)]/5 bg-[color:var(--color-sharp-white)]">
          {orders.map((o) => (
            <li
              key={o.id}
              className="flex items-center justify-between gap-3 border-b border-[color:var(--color-lit-grey)]/5 px-5 py-3.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold text-[color:var(--color-lit-grey)]">
                  {o.orderNumber} ·{" "}
                  {new Date(o.date).toLocaleDateString(dateLocale, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </div>
                <div className="mt-0.5 text-[11px] text-[color:var(--color-warm-gray)]">
                  {o.total.toFixed(2)} {o.currency} · {translateStatus(o.status, lang)}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span
                  className="rounded-[2px] px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.18em]"
                  style={statusStyle(o.status)}
                >
                  {translateStatus(o.status, lang).toUpperCase()}
                </span>
                {o.invoiceUrl && (
                  <a
                    href={o.invoiceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] tracking-[0.1em] text-[color:var(--color-warm-gray)] underline hover:text-[color:var(--color-lit-grey)]"
                  >
                    {t({ en: "Invoice", es: "Factura" })}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function translateStatus(s: string, lang: "en" | "es"): string {
  const key = (s || "").toLowerCase();
  const map: Record<string, { en: string; es: string }> = {
    delivered: { en: "Delivered", es: "Entregada" },
    shipped: { en: "Shipped", es: "Enviada" },
    scheduled: { en: "Scheduled", es: "Programada" },
    upcoming: { en: "Upcoming", es: "Próxima" },
    fulfilled: { en: "Delivered", es: "Entregada" },
    paid: { en: "Paid", es: "Pagada" },
    refunded: { en: "Refunded", es: "Reembolsada" },
  };
  return map[key]?.[lang] ?? s;
}

function statusStyle(s: string): { background: string; color: string } {
  const key = (s || "").toLowerCase();
  if (key === "delivered" || key === "fulfilled") {
    return { background: "var(--color-success)", color: "var(--color-cream)" };
  }
  if (key === "scheduled" || key === "upcoming") {
    return {
      background: "var(--color-bold-yellow)",
      color: "var(--color-lit-grey)",
    };
  }
  if (key === "refunded") {
    return { background: "var(--color-danger)", color: "var(--color-cream)" };
  }
  return {
    background: "rgba(50, 55, 67, 0.12)",
    color: "var(--color-lit-grey)",
  };
}

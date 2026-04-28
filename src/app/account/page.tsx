"use client";

import { useEffect, useState } from "react";
import { BottomNav } from "@/components/BottomNav";
import { TierPill } from "@/components/TierPill";
import { CancelTakeover } from "@/components/CancelTakeover";
import { api, ApiClientError } from "@/lib/api-client";
import type {
  CustomerProfile,
  OrderHistoryItem,
  Subscription,
  TierResponse,
} from "@/lib/types";

export default function AccountPage() {
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [tier, setTier] = useState<TierResponse | null>(null);
  const [orders, setOrders] = useState<OrderHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  useEffect(() => {
    Promise.all([
      api<CustomerProfile>("/api/customer"),
      api<Subscription>("/api/subscription").catch(() => null),
      api<TierResponse>("/api/tier"),
    ])
      .then(([c, s, t]) => {
        setCustomer(c);
        setSubscription(s);
        setTier(t);
      })
      .catch((e: ApiClientError) => setError(e.code));
  }, []);

  if (error) {
    return (
      <main className="zone-cream flex flex-1 items-center justify-center p-8 text-center">
        <p className="text-xs">Error: {error}</p>
      </main>
    );
  }
  if (!customer) {
    return (
      <main className="zone-cream flex flex-1 items-center justify-center">
        <p className="text-xs uppercase tracking-[0.2em] opacity-50">Loading…</p>
      </main>
    );
  }

  return (
    <div className="zone-cream flex min-h-full flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <header className="flex items-center justify-between px-6 pt-5 pb-3">
        <span className="font-display text-2xl font-black tracking-tight">LIT.</span>
        <TierPill visible={tier?.earned ?? false} />
      </header>

      <main className="flex-1 pb-24">
        <h1 className="px-6 font-display text-5xl font-black uppercase">Account</h1>

        {/* Identity card */}
        <section className="mx-6 mt-5 rounded-2xl bg-[color:var(--color-sharp-white)] px-6 py-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--color-bold-yellow)] font-display text-xl font-black">
              {(customer.name[0] ?? "L").toUpperCase()}
            </div>
            <div>
              <div className="font-display text-xl font-black uppercase">{customer.name}</div>
              <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">
                Member since{" "}
                {new Date(customer.memberSince).toLocaleDateString("en", {
                  month: "long",
                  year: "numeric",
                })}{" "}
                · {customer.boxesReceived}{" "}
                {customer.boxesReceived === 1 ? "box" : "boxes"} in
              </div>
            </div>
          </div>
        </section>

        {/* Quick actions */}
        <section className="mx-6 mt-4 grid grid-cols-4 gap-2">
          <QuickAction label="Plan" />
          <QuickAction label="Skip" />
          <QuickAction label="Flavor" subtitle="June" disabled />
          <QuickAction label="Extras" />
        </section>

        {/* Subscription summary */}
        {subscription && (
          <section className="mx-6 mt-5 rounded-2xl bg-[color:var(--color-sharp-white)] px-6 py-5">
            <div className="grid grid-cols-2 gap-y-4 gap-x-3 text-[11px] uppercase tracking-[0.15em]">
              <Cell label="Boxes" value={String(subscription.boxCount)} />
              <Cell label="Every" value={subscription.frequencyLabel} />
              <Cell label="Flavor" value={subscription.flavor} />
              <Cell
                label="Next ship"
                value={
                  subscription.nextShipDate
                    ? new Date(subscription.nextShipDate).toLocaleDateString("en", {
                        month: "short",
                        day: "numeric",
                      })
                    : "—"
                }
              />
            </div>
            <button
              type="button"
              className="mt-4 text-[11px] font-bold uppercase tracking-[0.18em] underline"
            >
              Change boxes or frequency →
            </button>
          </section>
        )}

        {/* Your details */}
        <Section title="Your details">
          <Row label="Email" value={customer.email} />
          <Row label="Phone" value={customer.phone ?? "—"} />
        </Section>

        {/* Language */}
        <Section title="Language">
          <LanguageToggle initial={customer.languagePref} />
        </Section>

        {/* Orders */}
        <OrdersSection
          orders={orders}
          loadOrders={() =>
            api<OrderHistoryItem[]>("/api/orders?limit=10").then(setOrders).catch(() => setOrders([]))
          }
        />

        {/* Cancel link */}
        <div className="mx-6 mt-10 mb-4 text-center">
          <button
            type="button"
            onClick={() => setCancelOpen(true)}
            className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)]/60 underline"
          >
            Cancel subscription
          </button>
        </div>
      </main>

      <BottomNav />

      {cancelOpen && (
        <CancelTakeover
          customer={customer}
          subscription={subscription}
          onClose={() => setCancelOpen(false)}
        />
      )}
    </div>
  );
}

function QuickAction({
  label,
  subtitle,
  disabled,
}: {
  label: string;
  subtitle?: string;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex h-16 flex-col items-center justify-center rounded-xl bg-[color:var(--color-sharp-white)] ${
        disabled ? "opacity-40" : ""
      }`}
    >
      <span className="text-[10px] font-bold uppercase tracking-[0.15em]">{label}</span>
      {subtitle && <span className="text-[8px] uppercase tracking-[0.18em] opacity-60">{subtitle}</span>}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">{label}</div>
      <div className="mt-0.5 font-display text-lg font-black">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mx-6 mt-5 rounded-2xl bg-[color:var(--color-sharp-white)] px-6 py-5">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] opacity-60">{title}</h2>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-[11px] uppercase tracking-[0.15em] opacity-70">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function LanguageToggle({ initial }: { initial: "en" | "es" }) {
  const [lang, setLang] = useState(initial);
  const change = async (next: "en" | "es") => {
    if (next === lang) return;
    setLang(next);
    try {
      await api("/api/customer/language", {
        method: "PATCH",
        body: JSON.stringify({ language: next }),
      });
    } catch {
      // revert on error
      setLang(lang);
    }
  };
  return (
    <div className="flex gap-2">
      {(["en", "es"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => change(l)}
          className={`flex-1 rounded-sm py-2 text-[11px] font-bold uppercase tracking-[0.18em] ${
            lang === l
              ? "bg-[color:var(--color-bold-yellow)]"
              : "bg-[color:var(--color-lit-grey)]/5 opacity-60"
          }`}
        >
          {l === "en" ? "English" : "Español"}
        </button>
      ))}
    </div>
  );
}

function OrdersSection({
  orders,
  loadOrders,
}: {
  orders: OrderHistoryItem[] | null;
  loadOrders: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Your orders">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          if (!orders) loadOrders();
        }}
        className="flex w-full items-center justify-between text-sm"
      >
        <span className="text-[11px] uppercase tracking-[0.15em] opacity-70">
          {orders ? `${orders.length} order${orders.length === 1 ? "" : "s"}` : "View history"}
        </span>
        <span className="opacity-60">{open ? "−" : "+"}</span>
      </button>
      {open && orders && (
        <ul className="mt-3 space-y-2">
          {orders.map((o) => (
            <li key={o.id} className="flex items-center justify-between rounded-sm bg-[color:var(--background)] px-3 py-2">
              <div>
                <div className="text-xs font-bold">{o.orderNumber}</div>
                <div className="text-[10px] uppercase tracking-[0.15em] opacity-60">
                  {new Date(o.date).toLocaleDateString()} · {o.status}
                </div>
              </div>
              <div className="text-sm font-bold">
                {o.total.toFixed(2)} {o.currency}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

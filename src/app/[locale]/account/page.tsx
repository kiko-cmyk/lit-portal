"use client";

import { useEffect, useState } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { TierPill } from "@/components/TierPill";
import { AddressOverlay } from "@/components/AddressOverlay";
import { CancelTakeover } from "@/components/CancelTakeover";
import { ExtrasOverlay } from "@/components/ExtrasOverlay";
import { FlavorOverlay } from "@/components/FlavorOverlay";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { PlanOverlay } from "@/components/PlanOverlay";
import { SkipOverlay } from "@/components/SkipOverlay";
import { api, ApiClientError } from "@/lib/api-client";
import { T, useLang, useLangSetter, useLangValue } from "@/lib/i18n";
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
  const [flavorOpen, setFlavorOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const t = useLang();

  useEffect(() => {
    Promise.all([
      api<CustomerProfile>("/api/customer"),
      api<Subscription>("/api/subscription").catch(() => null),
      api<TierResponse>("/api/tier"),
    ])
      .then(([c, s, ti]) => {
        setCustomer(c);
        setSubscription(s);
        setTier(ti);
      })
      .catch((e: ApiClientError) => setError(e.code));
  }, []);

  if (error === "unauthorized") return <LoginScreen />;
  if (error) {
    return (
      <main className="zone-cream flex flex-1 items-center justify-center p-8 text-center">
        <p className="text-xs">
          <T en="Something went wrong." es="Algo no fue bien." /> ({error})
        </p>
      </main>
    );
  }
  if (!customer) {
    return (
      <main className="zone-cream flex flex-1 items-center justify-center">
        <p className="text-xs uppercase tracking-[0.2em] opacity-50">
          <T en="Loading…" es="Cargando…" />
        </p>
      </main>
    );
  }

  return (
    <div className="zone-cream flex min-h-full flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />
      <header className="flex items-center justify-between px-6 pt-5 pb-3 md:hidden">
        <Logo />
        <TierPill visible={tier?.earned ?? false} />
      </header>

      <main className="flex-1 pt-6 pb-24 md:mx-auto md:w-full md:max-w-3xl md:px-8 md:pt-12 md:pb-12">
        <h1 className="px-6 font-display text-5xl font-black uppercase md:px-0 md:text-6xl">
          <T en="Account" es="Cuenta" />
        </h1>

        {/* Identity */}
        <section className="mx-6 mt-5 rounded-2xl bg-[color:var(--color-sharp-white)] px-6 py-5 md:mx-0">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--color-bold-yellow)] font-display text-xl font-black">
              {(customer.name[0] ?? "L").toUpperCase()}
            </div>
            <div>
              <div className="font-display text-xl font-black uppercase">{customer.name}</div>
              <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">
                <T en="Member since" es="Miembro desde" />{" "}
                {new Date(customer.memberSince).toLocaleDateString(
                  t({ en: "en", es: "es" }),
                  { month: "long", year: "numeric" },
                )}{" "}
                · {customer.boxesReceived}{" "}
                <T
                  en={customer.boxesReceived === 1 ? "box in" : "boxes in"}
                  es={customer.boxesReceived === 1 ? "caja recibida" : "cajas recibidas"}
                />
              </div>
            </div>
          </div>
        </section>

        {/* Quick actions */}
        <section className="mx-6 mt-4 grid grid-cols-4 gap-2 md:mx-0">
          <QuickAction
            label={t({ en: "Plan", es: "Plan" })}
            onClick={() => subscription && setPlanOpen(true)}
            disabled={!subscription}
          />
          <QuickAction
            label={t({ en: "Skip", es: "Saltar" })}
            onClick={() => subscription && setSkipOpen(true)}
            disabled={!subscription}
          />
          <QuickAction
            label={t({ en: "Flavor", es: "Sabor" })}
            subtitle={t({ en: "Soon", es: "Pronto" })}
            comingSoon
            onClick={() => setFlavorOpen(true)}
          />
          <QuickAction
            label={t({ en: "Extras", es: "Extras" })}
            onClick={() => subscription && setExtrasOpen(true)}
            disabled={!subscription}
          />
        </section>

        {/* Subscription summary */}
        {subscription && (
          <section className="mx-6 mt-5 rounded-2xl bg-[color:var(--color-sharp-white)] px-6 py-5 md:mx-0">
            <div className="grid grid-cols-2 gap-y-4 gap-x-3 text-[11px] uppercase tracking-[0.15em] md:grid-cols-4">
              <Cell label={t({ en: "Boxes", es: "Cajas" })} value={String(subscription.boxCount)} />
              <Cell label={t({ en: "Every", es: "Cada" })} value={subscription.frequencyLabel} />
              <Cell label={t({ en: "Flavor", es: "Sabor" })} value={subscription.flavor} />
              <Cell
                label={t({ en: "Next ship", es: "Próximo envío" })}
                value={
                  subscription.nextShipDate
                    ? new Date(subscription.nextShipDate).toLocaleDateString(
                        t({ en: "en", es: "es" }),
                        { month: "short", day: "numeric" },
                      )
                    : "—"
                }
              />
            </div>
            <button
              type="button"
              onClick={() => setPlanOpen(true)}
              className="mt-4 text-[11px] font-bold uppercase tracking-[0.18em] underline"
            >
              <T en="Change boxes or frequency" es="Cambiar cajas o frecuencia" /> →
            </button>
          </section>
        )}

        {/* Details */}
        <Section title={t({ en: "Your details", es: "Tus datos" })}>
          <EditableRow
            label={t({ en: "Name", es: "Nombre" })}
            value={customer.name}
            inputType="text"
            onSave={async (v) => {
              const [firstName, ...rest] = v.trim().split(/\s+/);
              const lastName = rest.join(" ");
              await api("/api/customer", {
                method: "PATCH",
                body: JSON.stringify({ firstName, lastName }),
              });
              setCustomer({ ...customer, name: v });
            }}
          />
          <EditableRow
            label={t({ en: "Email", es: "Email" })}
            value={customer.email}
            inputType="email"
            onSave={async (v) => {
              await api("/api/customer", {
                method: "PATCH",
                body: JSON.stringify({ email: v }),
              });
              setCustomer({ ...customer, email: v });
            }}
          />
          <EditableRow
            label={t({ en: "Phone", es: "Teléfono" })}
            value={customer.phone ?? ""}
            placeholder="—"
            inputType="tel"
            onSave={async (v) => {
              await api("/api/customer", {
                method: "PATCH",
                body: JSON.stringify({ phone: v }),
              });
              setCustomer({ ...customer, phone: v });
            }}
          />
        </Section>

        {/* Address */}
        {subscription && (
          <Section title={t({ en: "Shipping address", es: "Dirección de envío" })}>
            <AddressBlock
              address={subscription.shippingAddress}
              onEdit={() => setAddressOpen(true)}
            />
          </Section>
        )}

        {/* Payment */}
        {subscription && (
          <Section title={t({ en: "Payment method", es: "Método de pago" })}>
            <PaymentBlock subscription={subscription} />
          </Section>
        )}

        {/* Language */}
        <Section title={t({ en: "Language", es: "Idioma" })}>
          <LanguageToggle />
        </Section>

        {/* Orders */}
        <OrdersSection
          orders={orders}
          loadOrders={() =>
            api<OrderHistoryItem[]>("/api/orders?limit=10")
              .then(setOrders)
              .catch(() => setOrders([]))
          }
        />

        {/* Cancel */}
        <div className="mx-6 mt-10 mb-4 text-center md:mx-0">
          <button
            type="button"
            onClick={() => setCancelOpen(true)}
            className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-lit-grey)]/60 underline"
          >
            <T en="Cancel subscription" es="Cancelar suscripción" />
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
      {flavorOpen && <FlavorOverlay onClose={() => setFlavorOpen(false)} />}
      {planOpen && subscription && (
        <PlanOverlay
          subscription={subscription}
          onClose={() => setPlanOpen(false)}
          onUpdated={(updated) => setSubscription(updated)}
        />
      )}
      {skipOpen && subscription && (
        <SkipOverlay
          subscription={subscription}
          onClose={() => setSkipOpen(false)}
          onSkipped={(newDate) =>
            setSubscription({ ...subscription, nextShipDate: newDate })
          }
        />
      )}
      {extrasOpen && <ExtrasOverlay onClose={() => setExtrasOpen(false)} />}
      {addressOpen && subscription && (
        <AddressOverlay
          subscription={subscription}
          onClose={() => setAddressOpen(false)}
          onUpdated={(updated) => setSubscription(updated)}
        />
      )}
    </div>
  );
}

function QuickAction({
  label,
  subtitle,
  comingSoon,
  disabled,
  onClick,
}: {
  label: string;
  subtitle?: string;
  comingSoon?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const inner = (
    <div
      className={`relative flex h-16 flex-col items-center justify-center rounded-xl bg-[color:var(--color-sharp-white)] ${disabled ? "opacity-40" : ""}`}
    >
      {comingSoon && (
        <span className="absolute right-1.5 top-1.5 rounded-sm bg-[color:var(--color-lit-grey)]/8 px-1 py-0.5 text-[7px] font-bold uppercase tracking-[0.15em] opacity-70">
          {subtitle ?? "Soon"}
        </span>
      )}
      <span
        className={`text-[10px] font-bold uppercase tracking-[0.15em] ${comingSoon ? "opacity-70" : ""}`}
      >
        {label}
      </span>
      {!comingSoon && subtitle && (
        <span className="text-[8px] uppercase tracking-[0.18em] opacity-60">{subtitle}</span>
      )}
    </div>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="block w-full text-left disabled:cursor-not-allowed"
      >
        {inner}
      </button>
    );
  }
  return inner;
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
    <section className="mx-6 mt-5 rounded-2xl bg-[color:var(--color-sharp-white)] px-6 py-5 md:mx-0">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] opacity-60">{title}</h2>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

function EditableRow({
  label,
  value,
  placeholder,
  inputType = "text",
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  inputType?: "text" | "email" | "tel";
  onSave: (v: string) => Promise<void>;
}) {
  const t = useLang();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch {
      setError(t({ en: "Couldn't save.", es: "No se pudo guardar." }));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.15em] opacity-70">{label}</div>
          <div className="text-sm truncate">{value || placeholder || "—"}</div>
        </div>
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          className="text-[10px] font-bold uppercase tracking-[0.18em] underline opacity-60 hover:opacity-100"
        >
          <T en="Edit" es="Editar" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.15em] opacity-70 mb-1">{label}</div>
      <div className="flex gap-2">
        <input
          autoFocus
          type={inputType}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          className="flex-1 rounded-sm border border-[color:var(--color-lit-grey)]/20 bg-[color:var(--color-sharp-white)] px-3 py-2 text-sm focus:border-[color:var(--color-lit-grey)] focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="rounded-sm bg-[color:var(--color-bold-yellow)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] disabled:opacity-50"
        >
          {busy ? <T en="…" es="…" /> : <T en="Save" es="OK" />}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={busy}
          className="rounded-sm border border-[color:var(--color-lit-grey)]/20 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] opacity-60"
        >
          ×
        </button>
      </div>
      {error && (
        <p className="mt-1 text-[10px] text-red-700">{error}</p>
      )}
    </div>
  );
}

function AddressBlock({
  address,
  onEdit,
}: {
  address: import("@/lib/types").SubscriptionAddress | null;
  onEdit: () => void;
}) {
  if (!address || !address.address1) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="block text-[11px] font-bold uppercase tracking-[0.18em] underline opacity-70"
      >
        <T en="Add shipping address" es="Añadir dirección de envío" />
      </button>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 text-sm leading-relaxed">
        <div className="font-bold">{`${address.firstName} ${address.lastName}`.trim()}</div>
        <div>{address.address1}</div>
        {address.address2 && <div>{address.address2}</div>}
        <div>
          {address.postalCode} {address.city}
          {address.province ? `, ${address.province}` : ""}
        </div>
        <div>{address.country}</div>
        {address.phone && <div className="opacity-60">{address.phone}</div>}
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="text-[10px] font-bold uppercase tracking-[0.18em] underline opacity-60 hover:opacity-100"
      >
        <T en="Edit" es="Editar" />
      </button>
    </div>
  );
}

function PaymentBlock({ subscription }: { subscription: Subscription }) {
  const { cardExpiryMonth, cardExpiryYear, sealEditUrl } = subscription.payment;
  const hasCard = cardExpiryMonth && cardExpiryYear;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        {hasCard ? (
          <>
            <div className="text-[11px] uppercase tracking-[0.15em] opacity-70">
              <T en="Active card" es="Tarjeta activa" />
            </div>
            <div className="mt-0.5 font-display text-lg font-black uppercase">
              <T en="Expires" es="Caduca" />{" "}
              {cardExpiryMonth.padStart(2, "0")}/{cardExpiryYear.slice(-2)}
            </div>
          </>
        ) : (
          <div className="text-sm opacity-70">
            <T en="No payment method on file." es="Sin método de pago registrado." />
          </div>
        )}
      </div>
      {sealEditUrl && (
        <a
          href={sealEditUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-sm bg-[color:var(--color-lit-grey)] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-brisky-cream)] whitespace-nowrap"
        >
          <T en="Update card" es="Cambiar tarjeta" />
        </a>
      )}
    </div>
  );
}

function LanguageToggle() {
  const lang = useLangValue();
  const setGlobalLang = useLangSetter();
  const change = (next: "en" | "es") => {
    if (next === lang) return;
    // Fire-and-forget metafield sync so future logins remember the choice
    api("/api/customer/language", {
      method: "PATCH",
      body: JSON.stringify({ language: next }),
    }).catch(() => {
      // Non-fatal — URL navigation still happens
    });
    // Navigate to the equivalent URL in the new locale (setter handles routing)
    setGlobalLang(next);
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
  const t = useLang();
  return (
    <Section title={t({ en: "Your orders", es: "Tus pedidos" })}>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          if (!orders) loadOrders();
        }}
        className="flex w-full items-center justify-between text-sm"
      >
        <span className="text-[11px] uppercase tracking-[0.15em] opacity-70">
          {orders
            ? t({
                en: `${orders.length} order${orders.length === 1 ? "" : "s"}`,
                es: `${orders.length} pedido${orders.length === 1 ? "" : "s"}`,
              })
            : t({ en: "View history", es: "Ver historial" })}
        </span>
        <span className="opacity-60">{open ? "−" : "+"}</span>
      </button>
      {open && orders && orders.length === 0 && (
        <p className="mt-2 text-[11px] opacity-60">
          <T en="No orders yet." es="Aún no hay pedidos." />
        </p>
      )}
      {open && orders && orders.length > 0 && (
        <ul className="mt-3 space-y-2">
          {orders.map((o) => (
            <li
              key={o.id}
              className="flex items-center justify-between rounded-sm bg-[color:var(--background)] px-3 py-2"
            >
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

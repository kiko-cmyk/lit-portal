"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { AddressOverlay } from "@/components/AddressOverlay";
import { CancelTakeover } from "@/components/CancelTakeover";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { PaymentUpdateOverlay } from "@/components/PaymentUpdateOverlay";
import { PlanOverlay } from "@/components/PlanOverlay";
import { QAIcons } from "@/components/QuickActionButton";
import { SkipOverlay } from "@/components/SkipOverlay";
import { TierPill } from "@/components/TierPill";
import { api, ApiClientError } from "@/lib/api-client";
import { frequencyLabel } from "@/lib/frequency-label";
import {
  LangToggle,
  T,
  useLang,
  useLangSetter,
  useLangValue,
  usePageTitle,
} from "@/lib/i18n";
import type {
  CustomerProfile,
  OrderHistoryItem,
  Subscription,
  SubscriptionAddress,
  TierResponse,
} from "@/lib/types";

export default function AccountPage() {
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [tier, setTier] = useState<TierResponse | null>(null);
  const [orders, setOrders] = useState<OrderHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const t = useLang();
  const lang = useLangValue();
  usePageTitle({ en: "Account · LIT", es: "Cuenta · LIT" });

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
    // Order history is shown expanded by default → load it eagerly.
    api<OrderHistoryItem[]>("/api/orders?limit=10")
      .then(setOrders)
      .catch(() => setOrders([]));
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

  const initials = customer.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("") || "L";

  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  return (
    <div className="zone-cream mesh-bg flex min-h-full flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />

      <header className="flex items-center justify-between px-6 pt-5 pb-1 md:hidden">
        <Logo />
        <div className="flex items-center gap-2">
          <LangToggle />
          <TierPill
            visible={tier?.earned ?? false}
            tierEarnedAt={tier?.earnedAt ?? null}
          />
        </div>
      </header>

      <main className="flex-1 pb-24 md:mx-auto md:w-full md:max-w-5xl md:px-8 md:pt-6 md:pb-12">
        <div className="px-6 pt-3 pb-5 md:px-0">
          <h1 className="font-display text-[48px] font-black uppercase leading-[0.85] tracking-[-0.03em] text-[color:var(--color-lit-grey)]">
            <T en="Account" es="Cuenta" />
          </h1>
        </div>

        <section className="mx-6 mb-4 flex items-center gap-3.5 rounded-[14px] border border-[color:var(--color-lit-grey)]/5 bg-[color:var(--color-sharp-white)] px-5 py-4 md:mx-0">
          <div
            className="flex h-[54px] w-[54px] flex-shrink-0 items-center justify-center rounded-xl font-display text-[22px] font-black uppercase tracking-[-0.02em] text-[color:var(--color-lit-grey)]"
            style={{
              background:
                "linear-gradient(135deg, var(--color-bold-yellow) 0%, #d8d754 100%)",
            }}
          >
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-display text-[20px] font-black leading-[1.1] tracking-[-0.01em] uppercase text-[color:var(--color-lit-grey)]">
              {customer.name}
            </div>
            <div className="mt-0.5 text-[11px] tracking-[0.05em] text-[color:var(--color-warm-gray)]">
              <T en="Member since" es="Miembro desde" />{" "}
              {new Date(customer.memberSince).toLocaleDateString(dateLocale, {
                month: "long",
                year: "numeric",
              })}{" "}
              ·{" "}
              <T
                en={`${customer.boxesReceived} ${customer.boxesReceived === 1 ? "box in" : "boxes in"}`}
                es={`${customer.boxesReceived} ${customer.boxesReceived === 1 ? "caja recibida" : "cajas recibidas"}`}
              />
            </div>
          </div>
        </section>

        <section className="mx-6 mb-5 grid grid-cols-4 gap-1.5 md:mx-0">
          <CompactAction
            icon={QAIcons.ChangePlan}
            label={t({ en: "Plan", es: "Plan" })}
            onClick={() => subscription && setPlanOpen(true)}
            disabled={!subscription}
          />
          <CompactAction
            icon={QAIcons.Skip}
            label={t({ en: "Skip", es: "Saltar" })}
            onClick={() => subscription && setSkipOpen(true)}
            disabled={!subscription || subscription.withinCutoff}
          />
          <CompactAction
            icon={QAIcons.Flavor}
            label={t({ en: "Flavor", es: "Sabor" })}
            comingSoon
          />
          <CompactAction
            icon={QAIcons.Extras}
            label={t({ en: "Extras", es: "Extras" })}
            comingSoon
          />
        </section>

        {subscription && (
          <Section title={t({ en: "My subscription", es: "Mi suscripción" })}>
            <div className="grid grid-cols-4 border-t border-[color:var(--color-lit-grey)]/6">
              <SubsummCell
                label={t({ en: "Boxes", es: "Cajas" })}
                value={String(subscription.boxCount)}
                sub={t({
                  en: `${subscription.boxCount * 30} sachets`,
                  es: `${subscription.boxCount * 30} sobres`,
                })}
                showRightBorder
              />
              <SubsummCell
                label={t({ en: "Every", es: "Cada" })}
                value={frequencyLabel(subscription.frequency, lang, { format: "compact" })}
                sub={t({ en: "frequency", es: "frecuencia" })}
                showRightBorder
              />
              <SubsummCell
                label={t({ en: "Flavor", es: "Sabor" })}
                value={subscription.flavor.split(" ")[0]?.toUpperCase() ?? "—"}
                sub={subscription.flavor.split(" ").slice(1).join(" ").toLowerCase()}
                showRightBorder
              />
              <SubsummCell
                label={t({ en: "Next", es: "Próxima" })}
                value={
                  subscription.nextShipDate
                    ? new Date(subscription.nextShipDate)
                        .toLocaleDateString(dateLocale, {
                          month: "short",
                          day: "numeric",
                        })
                        .toUpperCase()
                    : "—"
                }
                sub={t({ en: "ships", es: "sale" })}
              />
            </div>
            <button
              type="button"
              onClick={() => setPlanOpen(true)}
              className="mt-3 flex w-full items-center justify-between border-t border-[color:var(--color-lit-grey)]/6 pt-3 text-[11px] font-bold tracking-[0.05em] text-[color:var(--color-lit-grey)]"
            >
              <span>
                <T
                  en="Change boxes or frequency"
                  es="Cambiar cajas o frecuencia"
                />
              </span>
              <span className="text-[14px] text-[color:var(--color-warm-gray)]">→</span>
            </button>
          </Section>
        )}

        <Section title={t({ en: "My details", es: "Mis datos" })}>
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

        {subscription && (
          <Section title={t({ en: "Where boxes land", es: "Dónde llegan las cajas" })}>
            <AddressBlock
              address={subscription.shippingAddress}
              onEdit={() => setAddressOpen(true)}
            />
          </Section>
        )}

        <Section title={t({ en: "How you pay", es: "Cómo pagas" })}>
          <PaymentBlock />
        </Section>

        <Section title={t({ en: "Language", es: "Idioma" })}>
          <LanguagePicker />
        </Section>

        <OrdersSection orders={orders} />

        <div className="mx-6 mt-8 pb-4 text-center md:mx-0">
          <button
            type="button"
            onClick={() => setCancelOpen(true)}
            className="px-2 py-2 text-[12px] tracking-[0.02em] text-[color:var(--color-danger)] underline underline-offset-[3px]"
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

function CompactAction({
  icon,
  label,
  onClick,
  disabled,
  comingSoon,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  comingSoon?: boolean;
}) {
  const inert = comingSoon || disabled;
  return (
    <button
      type="button"
      onClick={comingSoon ? undefined : onClick}
      disabled={inert}
      aria-disabled={inert}
      className={
        comingSoon
          ? "relative flex flex-col items-center gap-1.5 rounded-lg border border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-lit-grey)]/[0.04] px-1.5 py-3 cursor-not-allowed"
          : "flex flex-col items-center gap-1.5 rounded-lg border border-[color:var(--color-lit-grey)]/6 bg-[color:var(--color-sharp-white)] px-1.5 py-3 transition-all hover:border-[color:var(--color-bold-yellow)] hover:bg-[color:var(--color-bold-yellow)]/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[color:var(--color-lit-grey)]/6 disabled:hover:bg-[color:var(--color-sharp-white)]"
      }
    >
      {comingSoon && (
        <span className="absolute right-1 top-1 rounded-sm bg-[color:var(--color-lit-grey)]/10 px-1 py-0.5 text-[7px] font-extrabold uppercase tracking-[0.15em] text-[color:var(--color-warm-gray)]">
          Soon
        </span>
      )}
      <span
        className={`h-[18px] w-[18px] ${comingSoon ? "text-[color:var(--color-warm-gray)]/60" : "text-[color:var(--color-lit-grey)]"}`}
      >
        {icon}
      </span>
      <span
        className={`text-[9px] font-extrabold uppercase leading-[1.15] tracking-[0.06em] ${comingSoon ? "text-[color:var(--color-warm-gray)]" : "text-[color:var(--color-lit-grey)]"}`}
      >
        {label}
      </span>
    </button>
  );
}

function Section({
  title,
  children,
  actionLabel,
  onAction,
}: {
  title: string;
  children: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="mx-6 mb-3 rounded-xl border border-[color:var(--color-lit-grey)]/5 bg-[color:var(--color-sharp-white)] px-5 py-4 md:mx-0">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-display text-[15px] font-black uppercase tracking-[-0.005em] text-[color:var(--color-lit-grey)]">
          {title}
        </span>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="py-1 text-[10px] font-extrabold uppercase tracking-[0.15em] text-[color:var(--color-warm-gray)] hover:text-[color:var(--color-lit-grey)]"
          >
            {actionLabel}
          </button>
        )}
      </div>
      <div>{children}</div>
    </section>
  );
}

function SubsummCell({
  label,
  value,
  sub,
  showRightBorder,
}: {
  label: string;
  value: string;
  sub: string;
  showRightBorder?: boolean;
}) {
  return (
    <div
      className={`px-1 py-3.5 text-center ${showRightBorder ? "border-r border-[color:var(--color-lit-grey)]/6" : ""}`}
    >
      <div className="text-[8px] font-bold uppercase tracking-[0.2em] text-[color:var(--color-warm-gray)]">
        {label}
      </div>
      <div className="mt-1 font-display text-[16px] font-black uppercase leading-none tracking-[-0.01em] text-[color:var(--color-lit-grey)]">
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-[9px] tracking-[0.05em] text-[color:var(--color-warm-gray)]">
          {sub}
        </div>
      )}
    </div>
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
  const [err, setErr] = useState<string | null>(null);

  const handleSave = async () => {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch {
      setErr(t({ en: "Couldn't save.", es: "No se pudo guardar." }));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex gap-3 border-b border-[color:var(--color-lit-grey)]/4 py-2 last:border-b-0">
        <div className="min-w-[84px] pt-0.5 text-[11px] font-bold uppercase tracking-[0.05em] text-[color:var(--color-warm-gray)]">
          {label}
        </div>
        <div className="flex-1 text-[13px] text-[color:var(--color-lit-grey)]">
          {value || placeholder || "—"}
        </div>
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-[color:var(--color-warm-gray)] underline hover:text-[color:var(--color-lit-grey)]"
        >
          <T en="Edit" es="Editar" />
        </button>
      </div>
    );
  }

  return (
    <div className="border-b border-[color:var(--color-lit-grey)]/4 py-2 last:border-b-0">
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.05em] text-[color:var(--color-warm-gray)]">
        {label}
      </div>
      <div className="flex gap-1.5">
        <input
          autoFocus
          type={inputType}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          className="flex-1 rounded-[4px] border border-[color:var(--color-lit-grey)]/15 bg-[color:var(--color-brisky-cream)] px-2.5 py-2 text-[13px] text-[color:var(--color-lit-grey)] focus:border-[color:var(--color-bold-yellow)] focus:bg-[color:var(--color-sharp-white)] focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="rounded-[2px] bg-[color:var(--color-lit-grey)] px-3 text-[10px] font-black uppercase tracking-[0.15em] text-[color:var(--color-bold-yellow)] disabled:opacity-50"
        >
          {busy ? "…" : <T en="Save" es="OK" />}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={busy}
          className="rounded-[2px] border border-[color:var(--color-lit-grey)]/20 px-2 text-[12px] font-bold text-[color:var(--color-warm-gray)]"
        >
          ×
        </button>
      </div>
      {err && <p className="mt-1 text-[10px] text-[color:var(--color-danger)]">{err}</p>}
    </div>
  );
}

function AddressBlock({
  address,
  onEdit,
}: {
  address: SubscriptionAddress | null;
  onEdit: () => void;
}) {
  if (!address || !address.address1) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="text-[12px] font-bold uppercase tracking-[0.15em] underline opacity-70"
      >
        <T en="Add shipping address" es="Añadir dirección" />
      </button>
    );
  }
  return (
    <div className="flex items-start gap-3 py-1">
      <div className="min-w-[84px] pt-0.5 text-[11px] font-bold uppercase tracking-[0.05em] text-[color:var(--color-warm-gray)]">
        <T en="Address" es="Dirección" />
      </div>
      <div className="flex-1 text-[13px] leading-[1.45] text-[color:var(--color-lit-grey)]">
        <div>{address.address1}</div>
        {address.address2 && <div>{address.address2}</div>}
        <div>
          {address.postalCode} {address.city}
          {address.province ? `, ${address.province}` : ""}
        </div>
        <div>{address.country}</div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-[color:var(--color-warm-gray)] underline hover:text-[color:var(--color-lit-grey)]"
      >
        <T en="Edit" es="Editar" />
      </button>
    </div>
  );
}

interface PaymentMethodResponse {
  instrument: {
    id: string;
    type: "card" | "paypal" | "shop_pay" | "other" | "unknown";
    label: string;
    brand: string | null;
    lastDigits: string | null;
    expiryMonth: string | null;
    expiryYear: string | null;
    paypalEmail: string | null;
  } | null;
  updateUrl: string | null;
}

function PaymentBlock() {
  const t = useLang();
  const [data, setData] = useState<PaymentMethodResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // URL we'll iframe in the PaymentUpdateOverlay. Null = overlay closed.
  // Card flow: comes from `data.updateUrl` directly. PayPal / Shop Pay:
  // generated server-side via send-update-email (returns a fresh updateUrl).
  const [updateUrl, setUpdateUrl] = useState<string | null>(null);

  const refetch = () => {
    setLoading(true);
    api<PaymentMethodResponse>("/api/payment-method")
      .then(setData)
      .catch(() => setData({ instrument: null, updateUrl: null }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = async () => {
    if (!data?.instrument) return;
    setError(null);
    setMessage(null);

    // Card path: Shopify already gave us a single-use update URL — iframe it
    // straight into the in-portal overlay so the customer never leaves
    // litsalt.com visually.
    if (data.updateUrl) {
      setUpdateUrl(data.updateUrl);
      return;
    }

    // Non-card path (PayPal, Shop Pay): Shopify rejects the inline-URL
    // mutation for these, so we trigger send-update-email which mails the
    // customer a secure link. They can either open it from their inbox or
    // we surface the confirmation in-portal.
    setBusy(true);
    try {
      const res = await api<{ sent: boolean; email: string | null }>(
        "/api/payment-method/send-update-email",
        { method: "POST" },
      );
      if (res.sent) {
        setMessage(
          res.email
            ? t({
                en: `We sent a secure link to ${res.email}. Open it from your inbox to update your payment method — you'll be back here after.`,
                es: `Te enviamos un enlace seguro a ${res.email}. Ábrelo desde tu bandeja de entrada para cambiar tu método de pago — vuelves aquí al terminar.`,
              })
            : t({
                en: "We sent you a secure link by email.",
                es: "Te enviamos un enlace seguro por email.",
              }),
        );
      }
    } catch {
      setError(
        t({
          en: "Couldn't send the update email. Try again or contact us.",
          es: "No se pudo enviar el email. Inténtalo de nuevo o escríbenos.",
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="text-[12px] text-[color:var(--color-warm-gray)]">
        <T en="Loading…" es="Cargando…" />
      </div>
    );
  }

  if (!data?.instrument) {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="min-w-[84px] text-[11px] font-bold uppercase tracking-[0.05em] text-[color:var(--color-warm-gray)]">
          <T en="Method" es="Método" />
        </div>
        <div className="flex-1 text-[13px] text-[color:var(--color-warm-gray)]">
          <T en="No payment method on file." es="Sin método de pago registrado." />
        </div>
      </div>
    );
  }

  const inst = data.instrument;
  const typeLabel =
    inst.type === "paypal"
      ? "PayPal"
      : inst.type === "shop_pay"
        ? "Shop Pay"
        : inst.type === "card"
          ? t({ en: "Card", es: "Tarjeta" })
          : t({ en: "Method", es: "Método" });

  return (
    <div>
      <div className="flex items-center gap-3 py-1">
        <div className="min-w-[84px] text-[11px] font-bold uppercase tracking-[0.05em] text-[color:var(--color-warm-gray)]">
          {typeLabel}
        </div>
        <div className="flex-1 text-[13px] text-[color:var(--color-lit-grey)]">
          {inst.label}
        </div>
        <button
          type="button"
          onClick={handleChange}
          disabled={busy}
          className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-[color:var(--color-warm-gray)] underline hover:text-[color:var(--color-lit-grey)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <T en="Sending…" es="Enviando…" />
          ) : (
            <T en="Change" es="Cambiar" />
          )}
        </button>
      </div>
      {message && (
        <p className="mt-2 rounded-sm bg-[color:var(--color-bold-yellow)]/15 px-3 py-2 text-[11px] leading-[1.4] text-[color:var(--color-lit-grey)]">
          {message}
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-sm bg-[color:var(--color-danger)]/10 px-3 py-2 text-[11px] text-[color:var(--color-danger)]">
          {error}
        </p>
      )}
      {updateUrl && (
        <PaymentUpdateOverlay
          url={updateUrl}
          onClose={() => setUpdateUrl(null)}
          onCompleted={() => {
            setUpdateUrl(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}

function LanguagePicker() {
  const lang = useLangValue();
  const setGlobalLang = useLangSetter();
  const change = (next: "en" | "es") => {
    if (next === lang) return;
    api("/api/customer/language", {
      method: "PATCH",
      body: JSON.stringify({ language: next }),
    }).catch(() => {});
    setGlobalLang(next);
  };
  return (
    <div className="flex gap-1.5">
      {(["en", "es"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => change(l)}
          className={`rounded-[3px] border px-3.5 py-2 text-[11px] font-bold uppercase tracking-[0.12em] ${
            lang === l
              ? "border-[color:var(--color-lit-grey)] bg-[color:var(--color-lit-grey)] text-[color:var(--color-bold-yellow)]"
              : "border-[color:var(--color-lit-grey)]/15 text-[color:var(--color-warm-gray)] hover:text-[color:var(--color-lit-grey)]"
          }`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function OrdersSection({ orders }: { orders: OrderHistoryItem[] | null }) {
  const [open, setOpen] = useState(true);
  const t = useLang();
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  return (
    <section className="mx-6 mb-3 rounded-xl border border-[color:var(--color-lit-grey)]/5 bg-[color:var(--color-sharp-white)] px-5 py-4 md:mx-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center justify-between"
      >
        <span className="font-display text-[15px] font-black uppercase tracking-[-0.005em] text-[color:var(--color-lit-grey)]">
          <T en="My orders" es="Mis pedidos" />
        </span>
        <span
          className={`text-[12px] text-[color:var(--color-warm-gray)] transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="mt-3">
          {!orders && (
            <p className="text-[11px] opacity-60">
              <T en="Loading…" es="Cargando…" />
            </p>
          )}
          {orders && orders.length === 0 && (
            <p className="text-[11px] opacity-60">
              <T en="No orders yet." es="Aún no hay pedidos." />
            </p>
          )}
          {orders && orders.length > 0 && (
            <ul>
              {orders.map((o) => (
                <li
                  key={o.id}
                  className="flex items-center justify-between border-t border-[color:var(--color-lit-grey)]/6 py-2.5 text-[12px]"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-bold text-[color:var(--color-lit-grey)]">
                      {o.orderNumber} ·{" "}
                      {new Date(o.date).toLocaleDateString(dateLocale, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <span className="text-[11px] text-[color:var(--color-warm-gray)]">
                      {o.total.toFixed(2)} {o.currency} · {o.status}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className="rounded-[2px] px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.15em]"
                      style={{
                        background:
                          o.status === "delivered"
                            ? "var(--color-success)"
                            : o.status === "scheduled" || o.status === "upcoming"
                              ? "var(--color-bold-yellow)"
                              : "rgba(50, 55, 67, 0.15)",
                        color:
                          o.status === "delivered"
                            ? "var(--color-cream)"
                            : "var(--color-lit-grey)",
                      }}
                    >
                      {(o.status || "—").toUpperCase()}
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
        </div>
      )}
    </section>
  );
}

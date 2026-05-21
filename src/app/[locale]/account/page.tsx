"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { AddressOverlay } from "@/components/AddressOverlay";
import { CancelTakeover } from "@/components/CancelTakeover";
import { CustomerChip } from "@/components/CustomerChip";
import { DangerZone } from "@/components/DangerZone";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { Marquee } from "@/components/Marquee";
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

      {/* Mobile header — fixed so it NEVER hides on scroll (per Juan
          2026-05-19). */}
      <header className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between border-b border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-brisky-cream)]/90 px-6 pt-5 pb-3 backdrop-blur-md md:hidden">
        <Logo />
        <div className="flex items-center gap-2.5">
          <LangToggle />
          {customer && <CustomerChip name={customer.name} />}
          <TierPill
            visible={tier?.earned ?? false}
            tierEarnedAt={tier?.earnedAt ?? null}
          />
        </div>
      </header>

      <main className="flex-1 pt-[68px] pb-24 md:mx-auto md:w-full md:max-w-5xl md:px-8 md:pt-[92px] md:pb-12">
        {/* H1 "CUENTA" eliminado a petición de Juan 2026-05-19: la
            pestaña activa de la nav + el browser tab title ya indican
            dónde está el usuario, el titular interno es redundante. */}

        {/* Profile chip — alineado al estilo MetaCell del Hub: Display
            semibold (no black), eyebrow en Cond. */}
        <section className="mx-6 mb-4 flex items-center gap-3.5 rounded-[20px] border border-[color:var(--color-lit-grey)]/5 bg-[color:var(--color-sharp-white)] px-5 py-4 md:mx-0">
          <div
            className="flex h-[54px] w-[54px] flex-shrink-0 items-center justify-center rounded-2xl font-display font-semibold uppercase tracking-[-0.02em] text-[color:var(--color-lit-grey)]"
            style={{
              fontSize: 22,
              background:
                "linear-gradient(135deg, var(--color-bold-yellow) 0%, var(--color-retro-ochre) 100%)",
              boxShadow:
                "0 0 0 2px var(--color-sharp-white), 0 0 0 3px rgba(50, 55, 67, 0.18)",
            }}
          >
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="font-display font-semibold uppercase leading-[1.05] tracking-[-0.015em] text-[color:var(--color-lit-grey)]"
              style={{ fontSize: "clamp(18px, 4.5vw, 22px)" }}
            >
              {customer.name}
            </div>
            <div
              className="mt-1 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
              style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
            >
              <T en="Member since" es="Miembro desde" />{" "}
              {new Date(customer.memberSince)
                .toLocaleDateString(dateLocale, {
                  month: "short",
                  year: "numeric",
                })
                .toUpperCase()}{" "}
              ·{" "}
              <T
                en={`${customer.boxesReceived} ${customer.boxesReceived === 1 ? "box" : "boxes"}`}
                es={`${customer.boxesReceived} ${customer.boxesReceived === 1 ? "caja" : "cajas"}`}
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
              className="group mt-3 flex w-full items-center justify-between border-t border-[color:var(--color-lit-grey)]/6 pt-3.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)] transition-colors hover:text-[color:var(--color-bold-yellow)]"
              style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
            >
              <span>
                <T
                  en="Change boxes or frequency"
                  es="Cambiar cajas o frecuencia"
                />
              </span>
              <span className="text-[16px] transition-transform group-hover:translate-x-0.5 text-[color:var(--color-warm-gray)] group-hover:text-[color:var(--color-lit-grey)]">→</span>
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

        <Section title={t({ en: "Payment method", es: "Método de pago" })}>
          <PaymentBlock />
        </Section>

        {/* Language picker removed from Account body per Juan 2026-05-18 round 7
            — the LangToggle in the header is the single source of truth. */}
        <OrdersSection orders={orders} />

        <Marquee />

        <DangerZone
          onCancel={() => setCancelOpen(true)}
          signoutUrl="https://litsalt.com/account/logout"
        />
      </main>

      <BottomNav />

      {cancelOpen && (
        <CancelTakeover
          customer={customer}
          subscription={subscription}
          onClose={() => setCancelOpen(false)}
          onPivotToSkip={() => setSkipOpen(true)}
          onPivotToPlan={() => setPlanOpen(true)}
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
          ? "relative flex flex-col items-center gap-2 rounded-2xl border border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-lit-grey)]/[0.04] px-1.5 py-3.5 cursor-not-allowed"
          : "flex flex-col items-center gap-2 rounded-2xl border border-[color:var(--color-lit-grey)]/6 bg-[color:var(--color-sharp-white)] px-1.5 py-3.5 transition-all duration-200 ease-out hover:-translate-y-[1px] hover:border-[color:var(--color-bold-yellow)]/60 hover:bg-[color:var(--color-bold-yellow)]/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:border-[color:var(--color-lit-grey)]/6 disabled:hover:bg-[color:var(--color-sharp-white)]"
      }
    >
      {comingSoon && (
        <span
          className="absolute right-1.5 top-1.5 rounded-sm bg-[color:var(--color-lit-grey)]/10 px-1.5 py-0.5 font-semibold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 8 }}
        >
          Soon
        </span>
      )}
      <span
        className={`h-[20px] w-[20px] ${comingSoon ? "text-[color:var(--color-warm-gray)]/55" : "text-[color:var(--color-lit-grey)]"}`}
      >
        {icon}
      </span>
      <span
        className={`font-semibold uppercase leading-[1.15] tracking-[0.22em] ${comingSoon ? "text-[color:var(--color-warm-gray)]" : "text-[color:var(--color-lit-grey)]"}`}
        style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
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
    <section className="mx-6 mb-3 rounded-[20px] border border-[color:var(--color-lit-grey)]/5 bg-[color:var(--color-sharp-white)] px-5 py-5 md:mx-0 md:px-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h2
          className="font-display font-semibold uppercase leading-[1] tracking-[-0.01em] text-[color:var(--color-lit-grey)]"
          style={{ fontSize: "clamp(16px, 3.6vw, 19px)" }}
        >
          {title}
        </h2>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="py-1 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] hover:text-[color:var(--color-lit-grey)]"
            style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
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
      className={`px-1 py-4 text-center ${showRightBorder ? "border-r border-[color:var(--color-lit-grey)]/6" : ""}`}
    >
      <div
        className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
        style={{ fontFamily: "var(--font-cond)", fontSize: 9 }}
      >
        {label}
      </div>
      <div
        className="mt-1.5 font-display font-semibold uppercase leading-[0.95] tracking-[-0.015em] text-[color:var(--color-lit-grey)]"
        style={{ fontSize: "clamp(18px, 4.2vw, 22px)" }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="mt-1 font-semibold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]/85"
          style={{ fontFamily: "var(--font-cond)", fontSize: 9 }}
        >
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
      <div className="flex gap-3 border-b border-[color:var(--color-lit-grey)]/6 py-3 last:border-b-0">
        <div
          className="min-w-[88px] pt-0.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
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
          className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] underline-offset-2 hover:text-[color:var(--color-lit-grey)] hover:underline"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          <T en="Edit" es="Editar" />
        </button>
      </div>
    );
  }

  return (
    <div className="border-b border-[color:var(--color-lit-grey)]/6 py-3 last:border-b-0">
      <div
        className="mb-2 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
        style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
      >
        {label}
      </div>
      <div className="flex gap-2">
        <input
          autoFocus
          type={inputType}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          className="flex-1 rounded-full border border-[color:var(--color-lit-grey)]/15 bg-[color:var(--color-brisky-cream)] px-4 py-2 text-[13px] text-[color:var(--color-lit-grey)] focus:border-[color:var(--color-bold-yellow)] focus:bg-[color:var(--color-sharp-white)] focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="rounded-full bg-[color:var(--color-lit-grey)] px-4 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-bold-yellow)] disabled:opacity-50"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          {busy ? "…" : <T en="Save" es="OK" />}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={busy}
          className="rounded-full border border-[color:var(--color-lit-grey)]/20 px-2.5 text-[14px] font-bold text-[color:var(--color-warm-gray)] hover:text-[color:var(--color-lit-grey)]"
        >
          ×
        </button>
      </div>
      {err && <p className="mt-2 text-[10px] text-[color:var(--color-danger)]">{err}</p>}
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
        className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)] underline-offset-2 hover:underline"
        style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
      >
        <T en="Add shipping address" es="Añadir dirección" />
      </button>
    );
  }
  return (
    <div className="flex items-start gap-3 py-1">
      <div
        className="min-w-[88px] pt-0.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
        style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
      >
        <T en="Address" es="Dirección" />
      </div>
      <div className="flex-1 text-[13px] leading-[1.5] text-[color:var(--color-lit-grey)]">
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
        className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] underline-offset-2 hover:text-[color:var(--color-lit-grey)] hover:underline"
        style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
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
  // Email destination of the last successful send. Null = no email sent
  // (idle state). String = success banner visible with "Resend" link.
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<PaymentMethodResponse>("/api/payment-method")
      .then(setData)
      .catch(() => setData({ instrument: null, updateUrl: null }))
      .finally(() => setLoading(false));
  }, []);

  // 2026-05-19: unified email-only flow. We used to try to iframe the
  // Shopify `customerPaymentMethodGetUpdateUrl` for cards and only fall
  // back to email for PayPal/Shop Pay. Shopify serves the iframe-blocked
  // tracking.litsalt.com URL with X-Frame-Options:DENY, so 100% of the
  // time we ended up in the popup fallback that visually pulls the
  // customer out of the portal — which is exactly what we promised never
  // to do. Without bringing in our own card form (Stripe Elements, etc.),
  // the only option is to always send the secure email — the customer
  // never sees the second portal inside ours, and Shopify's hosted page
  // only opens from their inbox if they choose to act on the email.
  const sendEmail = async () => {
    if (!data?.instrument) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ sent: boolean; email: string | null }>(
        "/api/payment-method/send-update-email",
        { method: "POST" },
      );
      if (res.sent) setSentTo(res.email);
    } catch {
      setError(
        t({
          en: "Couldn't send the email. Try again or contact us.",
          es: "No se pudo enviar el email. Inténtalo de nuevo o escríbenos.",
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div
        className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
        style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
      >
        <T en="Loading…" es="Cargando…" />
      </div>
    );
  }

  if (!data?.instrument) {
    return (
      <div className="flex items-center gap-3 py-1">
        <div
          className="min-w-[88px] font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
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
        <div
          className="min-w-[88px] font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
        >
          {typeLabel}
        </div>
        <div className="flex-1 text-[13px] text-[color:var(--color-lit-grey)]">
          {inst.label}
        </div>
        {!sentTo && (
          <button
            type="button"
            onClick={sendEmail}
            disabled={busy}
            className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] underline-offset-2 hover:text-[color:var(--color-lit-grey)] hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
          >
            {busy ? (
              <T en="Sending…" es="Enviando…" />
            ) : (
              <T en="Change" es="Cambiar" />
            )}
          </button>
        )}
      </div>

      {sentTo && (
        <div className="mt-3 rounded-[14px] border border-[color:var(--color-bold-yellow)]/40 bg-[color:var(--color-bold-yellow)]/12 px-4 py-3.5">
          <div
            className="mb-1.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-lit-grey)]"
            style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
          >
            <T en="Email sent" es="Email enviado" />
          </div>
          <p className="text-[12px] leading-[1.5] text-[color:var(--color-lit-grey)]">
            <T
              en={`We've sent a secure link to ${sentTo} so you can update your payment method. Come back here when you're done.`}
              es={`Te hemos enviado un enlace seguro a ${sentTo} para que puedas cambiar tu método de pago. Vuelve aquí al terminar.`}
            />
          </p>
          <div className="mt-2.5 flex items-center gap-3">
            <button
              type="button"
              onClick={sendEmail}
              disabled={busy}
              className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] underline-offset-2 hover:text-[color:var(--color-lit-grey)] hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
            >
              {busy ? (
                <T en="Resending…" es="Reenviando…" />
              ) : (
                <T en="Resend email" es="Reenviar email" />
              )}
            </button>
            <span className="text-[color:var(--color-warm-gray)]/40">·</span>
            <button
              type="button"
              onClick={() => setSentTo(null)}
              className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] underline-offset-2 hover:text-[color:var(--color-lit-grey)]"
              style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
            >
              <T en="Close" es="Cerrar" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-[14px] border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/8 px-4 py-3">
          <p
            className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-danger)]"
            style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
          >
            {error}
          </p>
        </div>
      )}
    </div>
  );
}

// LanguagePicker removed 2026-05-18 round 7 — the header LangToggle covers
// the same function and is always visible (sticky header).

function OrdersSection({ orders }: { orders: OrderHistoryItem[] | null }) {
  const [open, setOpen] = useState(true);
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  return (
    <section className="mx-6 mb-3 rounded-[20px] border border-[color:var(--color-lit-grey)]/5 bg-[color:var(--color-sharp-white)] px-5 py-5 md:mx-0 md:px-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-baseline justify-between"
      >
        <h2
          className="font-display font-semibold uppercase leading-[1] tracking-[-0.01em] text-[color:var(--color-lit-grey)]"
          style={{ fontSize: "clamp(16px, 3.6vw, 19px)" }}
        >
          <T en="My orders" es="Mis pedidos" />
        </h2>
        <span
          className={`text-[13px] text-[color:var(--color-warm-gray)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="mt-4">
          {!orders && (
            <p
              className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
              style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
            >
              <T en="Loading…" es="Cargando…" />
            </p>
          )}
          {orders && orders.length === 0 && (
            <p
              className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]"
              style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
            >
              <T en="No orders yet." es="Aún no hay pedidos." />
            </p>
          )}
          {orders && orders.length > 0 && (
            <ul>
              {orders.map((o) => (
                <li
                  key={o.id}
                  className="flex items-center justify-between border-t border-[color:var(--color-lit-grey)]/6 py-3"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-bold text-[color:var(--color-lit-grey)]">
                      {o.orderNumber} ·{" "}
                      {new Date(o.date).toLocaleDateString(dateLocale, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <span
                      className="font-semibold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)]"
                      style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
                    >
                      {o.total.toFixed(2)} {o.currency}
                    </span>
                  </div>
                  {/* Status pill only — enlace a Factura eliminado por
                      Juan 2026-05-19: el cliente no descarga la factura
                      desde el portal. */}
                  <span
                    className="rounded-sm px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.15em]"
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
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

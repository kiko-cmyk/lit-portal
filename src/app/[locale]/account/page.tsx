"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { orderStatusStyle, translateOrderStatus } from "@/lib/order-status";
import { CustomerChip } from "@/components/CustomerChip";
import { DangerZone } from "@/components/DangerZone";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { Marquee } from "@/components/Marquee";
import { QAIcons } from "@/components/QuickActionButton";
import { useSubscriptionSwitch } from "@/components/SubscriptionGate";
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
import { clearJustSkipped, readJustSkipped, writeJustSkipped } from "@/lib/just-skipped";
import { MEMBER_PHOTO_DATA_URI } from "@/lib/member-photo";
import Link from "next/link";
import { orderDetailHref } from "@/lib/portal-link";
import type {
  CustomerProfile,
  OrderHistoryItem,
  Subscription,
  SubscriptionAddress,
  TierResponse,
} from "@/lib/types";

// Modal-only overlays — code-split out of the Account page's initial bundle;
// they download on first open. (2026-06-10 frontend perf pass)
const AddressOverlay = dynamic(() => import("@/components/AddressOverlay").then((m) => m.AddressOverlay));
const PlanOverlay = dynamic(() => import("@/components/PlanOverlay").then((m) => m.PlanOverlay));
const SkipOverlay = dynamic(() => import("@/components/SkipOverlay").then((m) => m.SkipOverlay));
const ChargeNowOverlay = dynamic(() => import("@/components/ChargeNowOverlay").then((m) => m.ChargeNowOverlay));
const CancelTakeover = dynamic(() => import("@/components/CancelTakeover").then((m) => m.CancelTakeover));

export default function AccountPage() {
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [tier, setTier] = useState<TierResponse | null>(null);
  const [orders, setOrders] = useState<OrderHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [chargeNowOpen, setChargeNowOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  // Mirror Mi LIT: an active skip drives the "Saltada" indicator next
  // to the Skip QA + an undo affordance. Persisted in localStorage so
  // it survives navigation between Mi LIT y Cuenta.
  const [justSkipped, setJustSkipped] = useState<boolean>(
    () => readJustSkipped() !== null,
  );
  // Email change verification (audit 2026-05-21 finding #11): when the
  // customer submits a new email we don't apply it until they click
  // the link in the new inbox. UI feedback in the meantime.
  const [emailChangePending, setEmailChangePending] = useState<string | null>(null);
  const [emailChangeConfirmed, setEmailChangeConfirmed] = useState(false);
  const t = useLang();
  const lang = useLangValue();
  const { canSwitch, openChooser } = useSubscriptionSwitch();
  usePageTitle({ en: "Account · LIT", es: "Cuenta · LIT" });

  useEffect(() => {
    Promise.all([
      api<CustomerProfile>("/api/customer"),
      // Only a genuine "no subscription" (404) collapses to null → the page
      // renders the cancelled/empty management UI. Any OTHER failure (e.g. a
      // transient Seal 5xx) must propagate, so we show a retryable error
      // instead of silently hiding the plan + Quick Actions from an active
      // subscriber. (2026-06-10)
      api<Subscription>("/api/subscription").catch((e: ApiClientError) => {
        if (e.code === "subscription_not_found") return null;
        throw e;
      }),
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

    // If the customer just confirmed an email change via magic link,
    // /api/customer/confirm-email redirects back with ?email_changed=1.
    // Show a toast and clean the URL.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("email_changed") === "1") {
        setEmailChangeConfirmed(true);
        params.delete("email_changed");
        const next = params.toString();
        window.history.replaceState(
          null,
          "",
          window.location.pathname + (next ? `?${next}` : ""),
        );
      }
    }
  }, []);

  // Re-pull the subscription on demand. Used when the Cancel takeover closes:
  // the takeover can be dismissed with its × right after a successful cancel
  // (instead of the "Back to LIT" redirect), which left this page holding the
  // stale ACTIVE sub in state, so the management UI kept showing until a full
  // navigation remounted the page. Refetching here flips the gate to the
  // cancelled state immediately. (2026-06-02)
  const refreshSubscription = useCallback(() => {
    api<Subscription>("/api/subscription")
      .then(setSubscription)
      .catch((e: ApiClientError) => {
        // A single-sub cancel purges every session server-side, so this very
        // refetch can 401. Route to login instead of silently pretending the
        // page state is fine on a dead bearer. (audit 2026-07-08)
        if (
          e.code === "unauthorized" ||
          e.code === "session_expired" ||
          e.code === "session_invalid"
        ) {
          setError(e.code);
          return;
        }
        setSubscription(null);
      });
  }, []);

  if (error === "unauthorized" || error === "session_expired" || error === "session_invalid") return <LoginScreen />;
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

  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  // A cancelled/expired sub still comes back from GET /api/subscription: that
  // route falls back to the most recent sub when none is ACTIVE, so
  // `subscription` is non-null even after a cancel. Gate the management UI on
  // the real status (mirrors the Hub, which 404s when there is no ACTIVE sub)
  // so a cancelled customer doesn't see the plan + action buttons. (2026-06-02)
  const subActive =
    subscription != null &&
    (subscription.status === "active" ||
      subscription.status === "paused" ||
      subscription.status === "reactivating");
  const subCancelled = subscription != null && !subActive;

  const handleUndoSkip = async () => {
    if (!subscription) return;
    try {
      await api("/api/subscription/skip/undo", { method: "POST" });
      // Re-pull canonical state. Seal's eventual consistency means we
      // can't trust local state to be exact; the user wanted Hub-parity,
      // so this mirrors Mi LIT's refetch-after-mutation pattern.
      const fresh = await api<Subscription>("/api/subscription");
      setSubscription(fresh);
      clearJustSkipped();
      setJustSkipped(false);
    } catch (e) {
      console.error("[account] undo skip failed", e);
    }
  };

  return (
    <div className="zone-cream mesh-bg flex min-h-screen flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />

      {/* Mobile header — fixed so it NEVER hides on scroll (per Juan
          2026-05-19). */}
      <header className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between border-b border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-brisky-cream)]/90 px-6 pt-5 pb-3 backdrop-blur-md md:hidden">
        <Logo />
        {/* min-w-0 lets the group shrink on narrow phones (≤390px with pill +
            toggle + chip + TierPill); chip name and TierPill truncate under
            pressure instead of overflowing (audit 2026-07-08). */}
        <div className="flex min-w-0 items-center gap-2.5">
          {/* Multi-sub switch: pill a la IZQUIERDA del grupo, con el mismo
              tamaño/estilo que el chip de nombre y el toggle de idioma (Juan
              2026-07-06). */}
          {canSwitch && (
            <button
              type="button"
              onClick={openChooser}
              className="shrink-0 inline-flex cursor-pointer items-center rounded-full border border-[color:var(--color-lit-grey)]/22 bg-[color:var(--color-sharp-white)] px-3.5 py-[8px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-lit-grey)] transition-transform duration-150 ease-out hover:-translate-y-[1px] hover:border-[color:var(--color-lit-grey)]/50"
              style={{ fontFamily: "var(--font-body)", fontSize: 11 }}
            >
              {t({ en: "Switch", es: "Cambiar" })}
            </button>
          )}
          {customer && <CustomerChip name={customer.name} />}
          <TierPill
            visible={tier?.earned ?? false}
            tierEarnedAt={tier?.earnedAt ?? null}
          />
        </div>
      </header>

      <main className="flex-1 pt-[88px] pb-32 md:mx-auto md:w-full md:max-w-5xl md:px-8 md:pt-[92px] md:pb-12">
        {/* H1 "CUENTA" eliminado a petición de Juan 2026-05-19: la
            pestaña activa de la nav + el browser tab title ya indican
            dónde está el usuario, el titular interno es redundante. */}

        {/* Profile chip — alineado al estilo MetaCell del Hub: Display
            semibold (no black), eyebrow en Cond. */}
        <section
          className="relative isolate mx-6 mb-4 flex items-center gap-3.5 overflow-hidden rounded-[22px] bg-[#16130C] px-5 py-4 md:mx-0"
          style={{
            boxShadow:
              "0 1px 0 rgba(255,255,255,0.06) inset, 0 26px 54px -22px rgba(30,24,12,0.5), 0 8px 16px -10px rgba(30,24,12,0.3)",
            isolation: "isolate",
          }}
        >
          {/* Foto de marca velada (PRE) — mismo patrón de bloque oscuro que el hero del Hub */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-cover"
            style={{
              backgroundImage: `url(${MEMBER_PHOTO_DATA_URI})`,
              backgroundPosition: "center 32%",
              filter: "grayscale(1)",
            }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{
              background:
                "linear-gradient(100deg, rgba(13,10,6,.95) 24%, rgba(13,10,6,.6) 72%, rgba(13,10,6,.35))",
            }}
          />
          <div className="min-w-0 flex-1">
            <div
              className="font-display font-semibold uppercase leading-[1.05] tracking-[-0.015em] text-[#F2EEE1]"
              style={{ fontSize: "clamp(18px, 4.5vw, 22px)" }}
            >
              {customer.name}
            </div>
            <div
              className="mt-1 font-semibold uppercase tracking-[0.22em] text-[#b3ab98]"
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
                en={`${customer.boxesReceived} ${customer.boxesReceived === 1 ? "box" : "boxes"} delivered`}
                es={`${customer.boxesReceived} ${customer.boxesReceived === 1 ? "caja" : "cajas"} entregadas`}
              />
            </div>
          </div>
        </section>

        {subActive && (
          <section className="mx-6 mb-5 grid grid-cols-2 gap-1.5 md:mx-0 md:grid-cols-4">
            <CompactAction
              icon={QAIcons.ChargeNow}
              label={t({ en: "Bring fwd", es: "Adelantar" })}
              onClick={() => setChargeNowOpen(true)}
              disabled={!!subscription?.withinCutoff}
            />
            <CompactAction
              icon={QAIcons.ChangePlan}
              label={t({ en: "Plan", es: "Plan" })}
              onClick={() => setPlanOpen(true)}
              // Match Mi LIT: disable when within 24h of next ship so the
              // user doesn't hit a backend cutoff_passed error.
              disabled={!!subscription?.withinCutoff}
            />
            <CompactAction
              icon={QAIcons.Skip}
              label={t({ en: "Skip", es: "Saltar" })}
              onClick={() => setSkipOpen(true)}
              disabled={!!subscription?.withinCutoff}
            />
            <CompactAction
              icon={QAIcons.Flavor}
              label={t({ en: "Flavor", es: "Sabor" })}
              comingSoon
            />
          </section>
        )}

        {justSkipped && subscription?.nextShipDate && (
          <div className="mx-6 mb-5 flex items-center justify-between border-l-[3px] border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/20 px-4 py-2.5 md:mx-0">
            <span className="text-[12px] text-[color:var(--color-lit-grey)]">
              <T
                en="You skipped the previous order. The next one ships on"
                es="Saltaste el pedido anterior. El próximo sale el"
              />{" "}
              <strong>
                {new Date(subscription.nextShipDate).toLocaleDateString(
                  dateLocale,
                  { day: "numeric", month: "long" },
                )}
              </strong>
              .
            </span>
            <button
              type="button"
              onClick={handleUndoSkip}
              className="text-[10px] font-extrabold uppercase tracking-[0.15em] underline"
            >
              <T en="Undo" es="Deshacer" />
            </button>
          </div>
        )}

        {subActive && (
          <Section title={t({ en: "My subscription", es: "Mi suscripción" })}>
            <div className="grid grid-cols-4 border-t border-[color:var(--color-lit-grey)]/6">
              <SubsummCell
                label={t({ en: "Boxes", es: "Cajas" })}
                value={String(subscription.boxCount)}
                showRightBorder
              />
              <SubsummCell
                label={t({ en: "Frequency", es: "Frecuencia" })}
                value={frequencyLabel(subscription.frequency, lang, { format: "short" }).toUpperCase()}
                showRightBorder
              />
              <SubsummCell
                label={t({ en: "Flavor", es: "Sabor" })}
                value={
                  // El "tipo" del producto (LEMON, SUN, …) es lo que el
                  // cliente reconoce. "Salty" es prefijo de gama, se queda
                  // fuera para que la card respire.
                  (subscription.flavor.split(" ").slice(1).join(" ") ||
                    subscription.flavor)
                    .toUpperCase() || "—"
                }
                showRightBorder
              />
              <SubsummCell
                label={t({ en: "Next", es: "Próximo" })}
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
              />
            </div>
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setPlanOpen(true)}
                className="rounded-full border border-[color:var(--color-lit-grey)]/40 px-6 py-3 text-[11px] font-bold uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] transition-colors hover:border-[color:var(--color-lit-grey)]"
              >
                <T
                  en="Change boxes or frequency"
                  es="Cambiar cajas o frecuencia"
                />
              </button>
            </div>
          </Section>
        )}

        {subCancelled && (
          <Section title={t({ en: "My subscription", es: "Mi suscripción" })}>
            <p className="text-[13px] leading-[1.5] text-[color:var(--color-warm-gray)]">
              <T
                en="Your subscription is cancelled. You won't be charged or shipped again."
                es="Tu suscripción está cancelada. No habrá más cobros ni envíos."
              />
            </p>
          </Section>
        )}

        <Section title={t({ en: "My details", es: "Mis datos" })}>
          {emailChangeConfirmed && (
            <div className="mx-6 mb-3 rounded-[14px] bg-green-50 px-4 py-3 text-xs text-green-800 md:mx-0">
              <T
                en="Email updated successfully."
                es="Email actualizado correctamente."
              />
            </div>
          )}
          {emailChangePending && (
            <div className="mx-6 mb-3 rounded-[14px] border-l-[3px] border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/15 px-4 py-3 text-xs leading-relaxed text-[color:var(--color-lit-grey)] md:mx-0">
              <T
                en={`We sent a confirmation link to ${emailChangePending}. Click it from that inbox to apply the change. Until you do, your account email stays the same.`}
                es={`Te hemos enviado un enlace de confirmación a ${emailChangePending}. Ábrelo desde ese correo para aplicar el cambio. Hasta entonces tu email actual sigue activo.`}
              />
            </div>
          )}
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
              // PATCH /api/customer no longer mutates email synchronously.
              // It stages a request and emails the new address; only the
              // magic-link click applies the change. Show the customer
              // a banner so they know to check their inbox.
              const res = await api<{
                updated: boolean;
                emailChangeRequested?: boolean;
                newEmail?: string;
              }>("/api/customer", {
                method: "PATCH",
                body: JSON.stringify({ email: v }),
              });
              if (res.emailChangeRequested && res.newEmail) {
                setEmailChangePending(res.newEmail);
              }
              // Don't mutate local customer.email — the UI keeps showing
              // the old address until confirmation.
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

        {subActive && (
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

        {/* Idioma vive AQUÍ (en el cuerpo de Cuenta), no en el header
            — decisión de Juan 2026-07-13. */}
        <Section title={t({ en: "Language", es: "Idioma" })}>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-[color:var(--color-warm-gray)]">
              {t({ en: "Choose your language", es: "Elige tu idioma" })}
            </span>
            <LangToggle />
          </div>
        </Section>

        <OrdersSection orders={orders} />

        <Marquee />

        {subActive && (
          <DangerZone
            onCancel={() => setCancelOpen(true)}
            signoutUrl="https://litsalt.com/account/logout"
          />
        )}
      </main>

      <BottomNav />

      {cancelOpen && (
        <CancelTakeover
          customer={customer}
          subscription={subscription}
          onClose={() => {
            setCancelOpen(false);
            refreshSubscription();
          }}
          onPivotToSkip={() => setSkipOpen(true)}
          onPivotToPlan={() => setPlanOpen(true)}
        />
      )}
      {planOpen && subscription && (
        <PlanOverlay
          subscription={subscription}
          onClose={() => setPlanOpen(false)}
          onUpdated={(updated) => {
            // Plan change wipes Seal's billing_attempts → the localStorage
            // skip flag would lie about an undoable skip that no longer
            // exists. Same fix as in the Hub. Juan 2026-05-21.
            clearJustSkipped();
            setJustSkipped(false);
            setSubscription(updated);
          }}
        />
      )}
      {skipOpen && subscription && (
        <SkipOverlay
          subscription={subscription}
          onClose={() => setSkipOpen(false)}
          onAdjusted={(updated) => {
            // Spaced out / fewer boxes instead of skipping. Mirror the plan
            // overlay handler: a frequency change wipes Seal's billing_attempts
            // so the local skip flag would lie — clear it and take the new sub.
            clearJustSkipped();
            setJustSkipped(false);
            setSubscription(updated);
          }}
          onSkipped={(newDate) => {
            // Persist the "just-skipped" flag (scoped to the selected sub) so
            // the Hub picks it up next time the customer navigates back
            // (banner + skipped hero).
            writeJustSkipped();
            setJustSkipped(true);
            setSubscription({ ...subscription, nextShipDate: newDate });
          }}
        />
      )}
      {addressOpen && subscription && (
        <AddressOverlay
          subscription={subscription}
          onClose={() => setAddressOpen(false)}
          onUpdated={(updated) => setSubscription(updated)}
        />
      )}
      {chargeNowOpen && subscription && (
        <ChargeNowOverlay
          subscription={subscription}
          onClose={() => setChargeNowOpen(false)}
          onCharged={(newDate) => {
            // Charge-now with reset_schedule re-anchors the cadence on today,
            // so any "just skipped" marker is now stale.
            clearJustSkipped();
            setJustSkipped(false);
            // Optimistic next date; re-pull the canonical sub to reconcile
            // once Seal finishes regenerating the schedule.
            setSubscription({ ...subscription, nextShipDate: newDate ?? subscription.nextShipDate });
            api<Subscription>("/api/subscription")
              .then(setSubscription)
              .catch(() => undefined);
          }}
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
          <T en="Soon" es="Pronto" />
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
    <section
      className="mx-6 mb-3 rounded-[20px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-5 py-5 md:mx-0 md:px-6"
      style={{ boxShadow: "0 10px 30px -14px rgba(40,34,20,0.22)" }}
    >
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
  sub?: string;
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
    <section
      className="mx-6 mb-3 rounded-[20px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-5 py-5 md:mx-0 md:px-6"
      style={{ boxShadow: "0 10px 30px -14px rgba(40,34,20,0.22)" }}
    >
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
                  className="border-t border-[color:var(--color-lit-grey)]/6"
                >
                  <Link
                    href={orderDetailHref(lang, o.id)}
                    className="flex items-center justify-between gap-3 py-3 -mx-2 px-2 rounded-md transition-colors hover:bg-[color:var(--color-brisky-cream)]"
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
                    <div className="flex items-center gap-2">
                      <span
                        className="rounded-sm px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.15em]"
                        style={orderStatusStyle(o.status)}
                      >
                        {o.status ? translateOrderStatus(o.status, lang).toUpperCase() : "—"}
                      </span>
                      <span className="text-[12px] text-[color:var(--color-warm-gray)]" aria-hidden>→</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

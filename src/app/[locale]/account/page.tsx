"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { orderStatusStyle, translateOrderStatus } from "@/lib/order-status";
import { CustomerChip } from "@/components/CustomerChip";
import { DangerZone } from "@/components/DangerZone";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { BrandBand, CardTitle, Figure, Lp2Card } from "@/components/Lp2";
import { Lp2Loader } from "@/components/Lp2Loader";
import { ProfileSurveyBanner } from "@/components/ProfileSurveyBanner";
import { ReferralCard } from "@/components/ReferralCard";
import { SubscribeBanner } from "@/components/SubscribeBanner";
import { QAIcons } from "@/components/QuickActionButton";
import { useSubscriptionSwitch } from "@/components/SubscriptionGate";
import { SignOutPill, SwitchAccountRow } from "@/components/SwitchAccount";
import { TierPill } from "@/components/TierPill";
import { api, ApiClientError } from "@/lib/api-client";
import { flavorVisual, unknownFlavorName } from "@/lib/flavor-visuals";
import { formatEuro } from "@/lib/format-price";
import { frequencyBetweenLabel, frequencyParts } from "@/lib/frequency-label";
import {
  LangToggle,
  T,
  useLang,
  useLangValue,
  usePageTitle,
} from "@/lib/i18n";
import { clearJustSkipped, readJustSkipped, writeJustSkipped } from "@/lib/just-skipped";
import { shortLabel } from "@/lib/mix";
import { FLAVORS, type FlavorKey } from "@/lib/seal-plans";
import Link from "next/link";
import { orderDetailHref } from "@/lib/portal-link";
import type {
  BusinessDetails,
  CustomerProfile,
  PortalAddress,
  OrderHistoryItem,
  Subscription,
  SubscriptionAddress,
  TierResponse,
} from "@/lib/types";

// Modal-only overlays — code-split out of the Account page's initial bundle;
// they download on first open. (2026-06-10 frontend perf pass)
const AddressOverlay = dynamic(() => import("@/components/AddressOverlay").then((m) => m.AddressOverlay));
const PlanOverlay = dynamic(() => import("@/components/PlanOverlay").then((m) => m.PlanOverlay));
const FlavorOverlay = dynamic(() => import("@/components/FlavorOverlay").then((m) => m.FlavorOverlay));
const SkipOverlay = dynamic(() => import("@/components/SkipOverlay").then((m) => m.SkipOverlay));
const ProfileSurveyOverlay = dynamic(() => import("@/components/ProfileSurveyOverlay").then((m) => m.ProfileSurveyOverlay));
const ChargeNowOverlay = dynamic(() => import("@/components/ChargeNowOverlay").then((m) => m.ChargeNowOverlay));
const CancelTakeover = dynamic(() => import("@/components/CancelTakeover").then((m) => m.CancelTakeover));
const BusinessAddressOverlay = dynamic(() =>
  import("@/components/BusinessAddressOverlay").then((m) => m.BusinessAddressOverlay),
);

export default function AccountPage() {
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [tier, setTier] = useState<TierResponse | null>(null);
  const [orders, setOrders] = useState<OrderHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [flavorOpen, setFlavorOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [surveyOpen, setSurveyOpen] = useState(false);
  const [pendingSurvey, setPendingSurvey] = useState(false);
  const [chargeNowOpen, setChargeNowOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
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
  /** null = no banner. A formatted date, or `true` when we have no date. */
  const [addressSaved, setAddressSaved] = useState<string | true | null>(null);
  // Business (wholesale) details: the customer's own Shopify address + fiscal
  // fields. Seeded from /api/customer and replaced by the PATCH read-back.
  const [business, setBusiness] = useState<BusinessDetails | null>(null);
  // Which wholesale address popup is open, if any.
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const t = useLang();
  const lang = useLangValue();
  const { canSwitch, openChooser, accountOnly } = useSubscriptionSwitch();
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
      // The tier pill is decoration; Supabase is its only dependency. Without
      // this catch, a paused or slow Supabase took down the WHOLE page: that is
      // the 2026-06-08 "Algo no fue bien (gateway_timeout)" on CUENTA, and the
      // reason a customer could not even reach the address form. Every usage
      // below already reads it as `tier?.…`, so null degrades to no pill.
      api<TierResponse>("/api/tier").catch(() => null),
    ])
      .then(([c, s, ti]) => {
        setCustomer(c);
        setSubscription(s);
        setTier(ti);
        setBusiness(c.business ?? null);
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

      // Deep-link de las campañas de perfilado (?action=survey). Hasta hoy solo
      // lo leía el Hub, así que quien llegaba desde el email aterrizaba aquí y
      // tenía que buscar la tarjeta a mano.
      //
      // NO se abre aquí, se deja PENDIENTE: este efecto corre al montar, cuando
      // `customer` todavía no ha llegado, así que aún no se sabe si ya contestó.
      // Abrirlo ya y comprobarlo después le enseñaría el formulario a quien lo
      // rellenó la semana pasada. El efecto de abajo lo resuelve con el dato.
      //
      // El parámetro se limpia en el mismo gesto (patrón de `email_changed`):
      // si se queda, recargar o volver atrás reabre el formulario una y otra
      // vez, y ese enlace vive en el historial de todo el que lo pulse.
      if (params.get("action") === "survey") {
        setPendingSurvey(true);
        params.delete("action");
        const qs = params.toString();
        window.history.replaceState(
          null,
          "",
          window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
        );
      }
    }
  }, []);

  // El overlay del deep-link se DERIVA, no se abre desde un efecto: mientras el
  // parámetro esté pendiente y el servidor diga que está abierto y sin
  // contestar, se muestra. Así no hace falta un setState dentro de un efecto
  // (la regla `react-hooks/set-state-in-effect`, que además provoca un render
  // en cascada) y el caso "ya contestó" se resuelve solo.
  //
  // `pendingSurvey` se apaga al cerrar, igual que `surveyOpen`.
  const showSurveyFromLink =
    pendingSurvey &&
    customer?.profileSurvey?.enabled === true &&
    customer.profileSurvey.answered === false;

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
      <main className="zone-lp2 flex flex-1 flex-col items-center justify-center bg-[#EFEEE5] p-8 text-center text-[#2F343D]">
        <h1 className="m-0 font-display text-[28px] font-semibold uppercase leading-[0.98] tracking-[0.005em] md:text-[38px]">
          <T en="Something went wrong." es="Algo no fue bien." />
        </h1>
        <p className="mt-3 mb-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8C8E87]">{error}</p>
      </main>
    );
  }
  // La espera común del portal (lp2, 2026-10-13), la misma que la de la entrada.
  if (!customer) return <Lp2Loader />;

  const dateLocale = lang === "es" ? "es-ES" : "en-US";
  // «HOLA, JUAN»: solo el nombre de pila. Si no hay nombre, queda «Hola,».
  const firstName = (customer.name ?? "").trim().split(/\s+/)[0] ?? "";
  // «ABR 2026»: mes corto sin el punto que pone es-ES («abr.»).
  const memberSince = new Date(customer.memberSince)
    .toLocaleDateString(dateLocale, { month: "short", year: "numeric" })
    .replace(".", "");

  // A cancelled/expired sub still comes back from GET /api/subscription: that
  // route falls back to the most recent sub when none is ACTIVE, so
  // `subscription` is non-null even after a cancel. Gate the management UI on
  // the real status (mirrors the Hub, which 404s when there is no ACTIVE sub)
  // so a cancelled customer doesn't see the plan + action buttons. (2026-06-02)
  //
  // `accountOnly` (wholesale, no subscription) suppresses all of it: the gate
  // has already collapsed the nav to this one tab, and GET /api/subscription
  // falls back to the most recent sub, so without this a partner whose personal
  // subscription was cancelled long ago would still be shown its dead panels.
  const subActive =
    !accountOnly &&
    subscription != null &&
    (subscription.status === "active" ||
      subscription.status === "paused" ||
      subscription.status === "reactivating");
  const subCancelled = !accountOnly && subscription != null && !subActive;
  // Paused (2026-07-28). Cuenta has always rendered a paused sub as fully
  // manageable, which was never true: of the four quick actions, Bring forward,
  // Plan, Skip and Flavor, the backend rejects skip / charge-now / extras and
  // the cancel wizard's last step, because they all reason about a pending
  // billing attempt that a paused sub doesn't have. So the paused customer got a
  // grid of buttons that error. Now they get the one action that makes sense.
  const subPaused = !accountOnly && subscription != null && subscription.status === "paused";

  /**
   * Save one wholesale field. PATCHes only what changed and adopts the
   * server's read-back, so the province and country shown are the ones Shopify
   * canonicalised rather than whatever we guessed locally.
   */
  const saveBusiness = async (patch: {
    delivery?: Record<string, string>;
    billing?: Record<string, string | boolean>;
  }) => {
    const res = await api<{ updated: boolean; business: BusinessDetails }>(
      "/api/customer/business",
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    setBusiness(res.business);
  };

  const handleResume = async () => {
    if (resuming || !subscription) return;
    setResuming(true);
    setResumeError(null);
    try {
      // Name the sub explicitly, same reason as the Hub: the route otherwise
      // resumes "the first paused one", and 18 of the 86 paused subs belong to a
      // customer who has more than one subscription.
      await api("/api/subscription/resume", {
        method: "POST",
        body: JSON.stringify({ sealSubscriptionId: subscription.sealSubscriptionId }),
      });
      const fresh = await api<Subscription>("/api/subscription");
      setSubscription(fresh);
    } catch (e) {
      const code = (e as { code?: string }).code;
      console.error("[account] resume failed", e);
      setResumeError(
        code === "rate_limited"
          ? t({
              en: "Too many tries. Wait a minute and try again.",
              es: "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
            })
          : code === "subscription_not_paused"
            ? t({
                en: "This subscription is already active. Reload the page.",
                es: "Esta suscripción ya está activa. Recarga la página.",
              })
            : t({
                en: "Couldn't resume. Try again or write to us.",
                es: "No se pudo reanudar. Inténtalo de nuevo o escríbenos.",
              }),
      );
    } finally {
      setResuming(false);
    }
  };

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
    <div className="zone-lp2 mesh-bg flex min-h-screen flex-col overflow-x-clip bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />

      {/* Mobile header — fixed so it NEVER hides on scroll (per Juan
          2026-05-19). */}
      <header className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between border-b border-[color:var(--color-lit-grey)]/8 bg-[color:var(--background)]/90 px-6 pt-5 pb-3 backdrop-blur-md md:hidden">
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
              className="shrink-0 self-stretch inline-flex cursor-pointer items-center rounded-full border border-[color:var(--color-lit-grey)]/22 bg-[color:var(--color-sharp-white)] px-3.5 py-[8px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-lit-grey)] transition-transform duration-150 ease-out hover:-translate-y-[1px] hover:border-[color:var(--color-lit-grey)]/50"
              style={{ fontFamily: "var(--font-body)", fontSize: 11 }}
            >
              {t({ en: "Switch", es: "Cambiar" })}
            </button>
          )}
          {/* Idioma SOLO en la cabecera (Juan 2026-10-13). Hasta hoy, en móvil
              vivía en una sección «Idioma» de esta página porque la barra iba
              justa; con el rediseño la barra solo lleva idioma y nombre (más
              «Cambiar» y el TierPill cuando tocan) y el chip se recorta. */}
          {!accountOnly && <LangToggle />}
          {customer && <CustomerChip name={customer.name} />}
          <TierPill
            visible={tier?.earned ?? false}
            tierEarnedAt={tier?.earnedAt ?? null}
          />
          {/* Wholesale: the bottom tab bar is gone, so the way out lives here. */}
          {accountOnly && <SignOutPill />}
        </div>
      </header>

      {/* pb-32 reserves room for the fixed tab bar; without one, that is just a
          hole at the end of the page. */}
      <main
        className={`flex flex-1 flex-col gap-4 pt-[88px] ${accountOnly ? "pb-12" : "pb-32"} md:mx-auto md:w-full md:max-w-[1440px] md:gap-6 md:px-6 md:pt-[100px] md:pb-12`}
      >
        {/* Rediseño lp2 (Juan 2026-10-13, aprobado en el lienzo PRE). Orden:
            saludo con cifras → encuesta (si toca) → «Tu plan» y «Tus datos» a
            la MISMA altura → «Mis pedidos» → referidos → banda → baja.
            Todas las tarjetas se separan con el hueco de esta columna (16 px en
            móvil, 24 en escritorio), así que ninguna lleva margen propio. */}

        {/* Saludo en una línea y a dos pesos («HOLA, JUAN»), con «miembro
            desde» y las cajas entregadas como cifras al lado (Juan: «ponlo de
            otro modo más elegante» que las pastillas). Para un mayorista la
            cifra cuenta pedidos, no cajas de un plan. */}
        <div className="mx-6 mt-1 flex flex-col gap-5 md:mx-0 md:mt-2 md:flex-row md:flex-wrap md:items-end md:justify-between md:gap-x-10 md:gap-y-6">
          <h1 className="m-0 font-display text-[54px] uppercase leading-[0.9] tracking-[0.005em] text-[#2F343D] md:text-[104px] md:leading-[0.88]">
            <span className="font-light">{t({ en: "Hi,", es: "Hola," })}</span>
            {firstName && (
              <>
                {" "}
                <span className="font-semibold">{firstName}</span>
              </>
            )}
          </h1>
          <div className="grid grid-cols-2 border-t border-[#2F343D]/16 pt-4 md:flex md:border-t-0 md:pt-0 md:pb-1.5">
            <div className="pr-3 md:pr-[30px]">
              <p className="m-0 font-display text-[26px] font-semibold uppercase leading-none md:text-[30px]">
                {memberSince}
              </p>
              <p className="mt-[7px] mb-0 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-[#8C8E87] md:mt-[9px]">
                <T en="Member since" es="Miembro desde" />
              </p>
            </div>
            <div className="border-l border-[#2F343D]/16 pl-4 md:pl-[30px]">
              <p className="m-0 font-display text-[26px] font-semibold leading-none md:text-[30px]">
                {customer.boxesReceived}
              </p>
              <p className="mt-[7px] mb-0 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-[#8C8E87] md:mt-[9px]">
                {accountOnly ? (
                  <T
                    en={customer.boxesReceived === 1 ? "Order" : "Orders"}
                    es={customer.boxesReceived === 1 ? "Pedido" : "Pedidos"}
                  />
                ) : (
                  <T
                    en={customer.boxesReceived === 1 ? "Box delivered" : "Boxes delivered"}
                    es={customer.boxesReceived === 1 ? "Caja entregada" : "Cajas entregadas"}
                  />
                )}
              </p>
            </div>
          </div>
        </div>

        {subPaused && (
          <section className="mx-6 rounded-[24px] border border-[#2F343D]/[0.06] bg-[color:var(--color-sharp-white)] px-5 py-5 shadow-[0_22px_44px_-24px_rgba(40,34,20,0.38)] md:mx-0 md:rounded-[28px] md:p-[30px]">
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)]">
              <T en="Paused" es="En pausa" />
            </div>
            <p className="mt-2 text-[13px] leading-[1.5] text-[color:var(--color-lit-grey)]">
              <T
                en="Your subscription is paused, so there are no charges and no shipments. Resume it and the next box is scheduled from today."
                es="Tu suscripción está en pausa, así que no hay cobros ni envíos. Reanúdala y la próxima caja se programa desde hoy."
              />
            </p>
            {resumeError && (
              <p className="mt-3 text-[12px] text-[color:var(--color-danger)]">{resumeError}</p>
            )}
            <button
              type="button"
              onClick={handleResume}
              disabled={resuming}
              className="mt-4 rounded-full bg-[color:var(--color-lit-grey)] px-6 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-[color:var(--color-brisky-cream)] disabled:opacity-60"
            >
              {resuming ? (
                <T en="Resuming…" es="Reanudando…" />
              ) : (
                <T en="Resume subscription" es="Reanudar suscripción" />
              )}
            </button>
            <p className="mt-3 text-[11px] leading-[1.4] text-[color:var(--color-warm-gray)]">
              <T
                en="Prefer to cancel instead of resuming? Write to us at hola@litsalt.com and we'll take care of it."
                es="¿Prefieres cancelar en vez de reanudar? Escríbenos a hola@litsalt.com y lo hacemos nosotros."
              />
            </p>
          </section>
        )}

        {/* Formulario de perfilado, justo debajo del saludo. Deliberadamente
            FUERA de cualquier condición de suscripción activa: contestar no
            toca la suscripción, así que no hay razón para escondérselo a quien
            está en pausa. */}
        {customer?.profileSurvey?.enabled && !customer.profileSurvey.answered && (
          <ProfileSurveyBanner onStart={() => setSurveyOpen(true)} />
        )}

        {justSkipped && subscription?.nextShipDate && (
          <div className="mx-6 flex items-center justify-between rounded-[14px] border-l-[3px] border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/20 px-4 py-2.5 md:mx-0">
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

        {/* «Tu plan» y «Tus datos» en la MISMA fila y a la MISMA altura (Juan
            2026-10-13: «no me gusta que las columnas no sean iguales de
            altas»): la rejilla estira las dos tarjetas y cada una deja sus
            botones abajo con `mt-auto`. Sin suscripción, «Tus datos» va sola. */}
        <div
          className={`flex flex-col gap-4 md:gap-6 ${subActive && subscription ? "lg:grid lg:grid-cols-2 lg:items-stretch" : ""}`}
        >
          {subActive && subscription && (
            <div className="mx-6 md:mx-0">
              <PlanCard
                subscription={subscription}
                paused={subPaused}
                onPlan={() => setPlanOpen(true)}
                onChargeNow={() => setChargeNowOpen(true)}
                onSkip={() => setSkipOpen(true)}
                onFlavor={() => setFlavorOpen(true)}
              />
            </div>
          )}
          <div className="mx-6 md:mx-0">
            <Lp2Card as="article" className="flex h-full flex-col">
              <CardTitle thin={t({ en: "Your", es: "Tus" })} bold={t({ en: "details", es: "datos" })} />
              {emailChangeConfirmed && (
                <div className="mt-4 lp2-notice md:mx-0">
                  <T
                    en="Email updated successfully."
                    es="Email actualizado correctamente."
                  />
                </div>
              )}
              {emailChangePending && (
                <div className="mt-4 rounded-[14px] border-l-[3px] border-[color:var(--color-bold-yellow)] bg-[color:var(--color-bold-yellow)]/15 px-4 py-3 text-xs leading-relaxed text-[color:var(--color-lit-grey)] md:mx-0">
                  <T
                    en={`We sent a confirmation link to ${emailChangePending}. Click it from that inbox to apply the change. Until you do, your account email stays the same.`}
                    es={`Te hemos enviado un enlace de confirmación a ${emailChangePending}. Ábrelo desde ese correo para aplicar el cambio. Hasta entonces tu email actual sigue activo.`}
                  />
                </div>
              )}
              <div className="mt-4 border-t border-[#2F343D]/12 md:mt-[22px]">
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
                {subActive && subscription && (
                  <>
                    <AddressBlock
                      address={subscription.shippingAddress}
                      onEdit={() => {
                        setAddressSaved(null);
                        setAddressOpen(true);
                      }}
                    />
                    {addressSaved && (
                      <div className="my-3 lp2-notice md:mx-0">
                        <T
                          en={
                            addressSaved === true
                              ? "Address updated. It applies from your next shipment."
                              : `Address updated. It applies from your shipment on ${addressSaved}.`
                          }
                          es={
                            addressSaved === true
                              ? "Dirección actualizada. Aplica desde tu próximo envío."
                              : `Dirección actualizada. Aplica desde tu envío del ${addressSaved}.`
                          }
                        />
                      </div>
                    )}
                  </>
                )}
                {/* Sin método de pago para el mayorista: paga cada pedido en el
                    checkout, así que la fila solo enseñaría un vacío. */}
                {!accountOnly && <PaymentBlock />}
              </div>
              {/* Cerrar sesión o entrar con otro email, al pie de la tarjeta
                  (2026-07-29: la gente que está en la cuenta EQUIVOCADA intenta
                  arreglarlo reescribiendo el email). Fuera para el mayorista:
                  ya lleva CERRAR SESIÓN en la cabecera. */}
              {!accountOnly && (
                <div className="mt-auto pt-[18px] md:pt-6">
                  <SwitchAccountRow variant="card" />
                </div>
              )}
            </Lp2Card>
          </div>
        </div>

        {/* Mayorista: su dirección de entrega y la de facturación, que son las
            de su ficha de Shopify (no hay suscripción). */}
        {accountOnly && (
          <div className="flex flex-col gap-4 md:gap-6 lg:grid lg:grid-cols-2 lg:items-stretch">
          {accountOnly && (
            <Section title={t({ en: "Delivery address", es: "Dirección de entrega" })}>
              <BusinessAddressBlock
                value={business?.delivery ?? null}
                onEdit={() => setDeliveryOpen(true)}
                editLabel={t({ en: "Change delivery address", es: "Cambiar dirección de entrega" })}
                note={t({
                  en: "Where your orders ship. It also prefills your checkout.",
                  es: "Donde te llegan los pedidos. También se rellena sola en el checkout.",
                })}
              />
            </Section>
          )}
          {accountOnly && (
            <Section title={t({ en: "Billing details", es: "Datos de facturación" })}>
              <EditableRow
                label={t({ en: "Tax ID", es: "NIF / CIF" })}
                value={business?.billing.taxId ?? ""}
                onSave={(v) => saveBusiness({ billing: { taxId: v } })}
              />
              {/* By default the billing address SHOWS the delivery one (Juan
                  2026-07-29): most partners invoice where the boxes land, and a
                  block that just said "same as delivery" made them go up to read
                  their own address. Underneath, it is still the absence of a
                  separate fiscal address, so the day they move there is no stale
                  duplicate to forget about. */}
              <BusinessAddressBlock
                value={
                  business?.billing.sameAsDelivery === false
                    ? business.billing
                    : business?.delivery ?? null
                }
                onEdit={() => setBillingOpen(true)}
                editLabel={t({
                  en: "Change billing address",
                  es: "Cambiar dirección de facturación",
                })}
                note={
                  business?.billing.sameAsDelivery === false
                    ? t({
                        en: "We invoice to this address.",
                        es: "Facturamos a esta dirección.",
                      })
                    : t({
                        en: "Same as your delivery address. We invoice with this data.",
                        es: "La misma que la de entrega. Facturamos con estos datos.",
                      })
                }
                onReset={
                  business?.billing.sameAsDelivery === false
                    ? () => saveBusiness({ billing: { sameAsDelivery: true } })
                    : undefined
                }
                resetLabel={t({
                  en: "Use the delivery address again",
                  es: "Volver a usar la de entrega",
                })}
              />
            </Section>
          )}
          </div>
        )}

        <OrdersSection orders={orders} />

        {/* «Trae a alguien», debajo de «Mis pedidos» (Juan 2026-10-13). Solo con
            la suscripción ACTIVA, igual que en Suscripción: el programa es para
            quien está suscrito, y una pausada no puede recibir sus 10€ hasta
            que vuelva. La tarjeta se esconde sola si el programa no está
            abierto para este cliente (flag REFERRALS, B2B). */}
        {!accountOnly && subscription?.status === "active" && <ReferralCard placement="account" />}

        {/* `compact` solo cuando debajo viene la invitación a suscribirse (Juan
            2026-09-22): entonces la banda deja de cerrar la página y pasa a ser
            un separador, y el hueco largo abría dos agujeros seguidos. */}
        <BrandBand compact={!accountOnly && subscription == null} />

        {/* La invitación a suscribirse, para quien no tiene NINGUNA suscripción
            (Juan 2026-09-22), DESPUÉS de la banda: el cierre de marca sigue
            cerrando y la oferta queda como remate. `subscription == null` es la
            condición exacta (/api/subscription devuelve la más reciente aunque
            esté cancelada). Fuera para el mayorista. */}
        {!accountOnly && subscription == null && <SubscribeBanner />}

        {/* Baja: oculta mientras está en pausa (el asistente razona sobre el
            próximo cobro, que una pausada no tiene; el aviso de pausa ya dice
            que nos escriban para cancelar). Las dos alternativas abren los
            mismos overlays que «Tu plan», con el mismo bloqueo de la ventana
            de cierre. */}
        {subActive && !subPaused && (
          <div className="mt-7 md:mt-10">
            <DangerZone
              onCancel={() => setCancelOpen(true)}
              onSkip={() => setSkipOpen(true)}
              onChangeFrequency={() => setPlanOpen(true)}
              alternativesDisabled={!!subscription?.withinCutoff}
            />
          </div>
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
      {flavorOpen && subscription && (
        <FlavorOverlay
          subscription={subscription}
          onClose={() => setFlavorOpen(false)}
          onUpdated={(updated) => {
            // Flavor swap keeps the ship date; apply the returned sub, then
            // refetch to reconcile the fresh mainItemId/variant (the unverified
            // fallback response can carry the pre-swap item id). Retry once so a
            // single transient failure can't leave a stale mainItemId that would
            // 403 the next action until reload.
            setSubscription(updated);
            const reconcile = (attempt = 0) => {
              api<Subscription>("/api/subscription")
                .then(setSubscription)
                .catch(() => {
                  if (attempt < 1) setTimeout(() => reconcile(attempt + 1), 1500);
                });
            };
            reconcile();
          }}
        />
      )}
      {(surveyOpen || showSurveyFromLink) && (
        <ProfileSurveyOverlay
          subscription={subscription}
          onClose={() => {
            setSurveyOpen(false);
            setPendingSurvey(false);
            // Relee el perfil para que el banner desaparezca en cuanto ha
            // contestado, sin recargar. `answered` lo resuelve el servidor, así
            // que no se adivina aquí.
            api<CustomerProfile>("/api/customer")
              .then(setCustomer)
              .catch(() => {});
          }}
          onSubscriptionUpdated={setSubscription}
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
      {/* Wholesale address popups. The billing one opens PREFILLED with the
          delivery address when there is no separate fiscal one yet, so the
          customer edits what they already gave us instead of an empty sheet. */}
      {deliveryOpen && (
        <BusinessAddressOverlay
          scope="delivery"
          value={business?.delivery ?? null}
          onClose={() => setDeliveryOpen(false)}
          onSaved={setBusiness}
        />
      )}
      {billingOpen && (
        <BusinessAddressOverlay
          scope="billing"
          value={
            business?.billing.sameAsDelivery === false
              ? business.billing
              : business?.delivery ?? null
          }
          onClose={() => setBillingOpen(false)}
          onSaved={setBusiness}
        />
      )}

      {addressOpen && subscription && (
        <AddressOverlay
          subscription={subscription}
          onClose={() => setAddressOpen(false)}
          onUpdated={(updated) => {
            if (updated) setSubscription(updated);
            // The overlay closes itself right after this, so the confirmation
            // has to live on the page behind it.
            const shipDate = (updated ?? subscription).nextShipDate;
            setAddressSaved(
              shipDate
                ? new Date(shipDate).toLocaleDateString(dateLocale, {
                    day: "numeric",
                    month: "long",
                  })
                : true,
            );
          }}
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
  // Título a dos pesos como el resto de tarjetas del rediseño lp2: la primera
  // palabra fina y el resto en negrita («MI SUSCRIPCIÓN», «DATOS DE
  // FACTURACIÓN»). Una sola palabra va entera en negrita.
  const [first, ...rest] = title.split(" ");
  return (
    <div className="mx-6 md:mx-0">
      <Lp2Card className="h-full">
        <div className="mb-4 flex items-baseline justify-between gap-3 md:mb-5">
          <CardTitle thin={rest.length ? first : ""} bold={rest.length ? rest.join(" ") : first} />
          {actionLabel && onAction && (
            <button
              type="button"
              onClick={onAction}
              className="py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8C8E87] hover:text-[#2F343D]"
            >
              {actionLabel}
            </button>
          )}
        </div>
        <div>{children}</div>
      </Lp2Card>
    </div>
  );
}

/** Clases de las filas de «Tus datos»: etiqueta en versalitas y valor debajo. */
const ROW = "flex items-center justify-between gap-3 border-b border-[#2F343D]/12 py-[15px] md:gap-4 md:py-4";
const ROW_LABEL = "m-0 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-[#8C8E87]";
const ROW_VALUE = "mt-1 mb-0 break-words text-[14px] md:mt-[5px] md:text-[14.5px]";
const ROW_ACTION =
  "flex-none cursor-pointer text-[10px] font-bold uppercase tracking-[0.16em] text-[#2F343D] underline underline-offset-[3px] transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * «Tu plan» (rediseño lp2, Juan 2026-10-13). Sustituye a «Mi suscripción» y a la
 * rejilla de acciones de arriba: los sabores con su caja, cuatro cifras y, al
 * pie, «Cambiar cajas o frecuencia» y las tres acciones rápidas. El pie va con
 * `mt-auto` para que la tarjeta acabe a la vez que «Tus datos».
 *
 * En pausa: sin acciones (el backend las rechaza para una pausada; el aviso de
 * arriba ya ofrece reanudar) y la etiqueta dice «En pausa». Dentro de la ventana
 * de cierre las cuatro acciones se desactivan, como en el Hub, para no acabar en
 * un `cutoff_passed`.
 */
function PlanCard({
  subscription,
  paused,
  onPlan,
  onChargeNow,
  onSkip,
  onFlavor,
}: {
  subscription: Subscription;
  paused: boolean;
  onPlan: () => void;
  onChargeNow: () => void;
  onSkip: () => void;
  onFlavor: () => void;
}) {
  const t = useLang();
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";
  const locked = !!subscription.withinCutoff;
  const freq = frequencyParts(subscription.frequency);
  const next = subscription.nextShipDate ? new Date(subscription.nextShipDate) : null;
  const nextLabel = next
    ? `${next.getDate()} ${next.toLocaleDateString(dateLocale, { month: "short" }).replace(".", "")}`
    : "—";
  const price =
    subscription.chargeTotalCents > 0 ? formatEuro(subscription.chargeTotalCents, lang) : null;
  const cell = "border-[#2F343D]/12";

  return (
    <Lp2Card as="article" className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3">
        <CardTitle thin={t({ en: "Your", es: "Tu" })} bold={t({ en: "plan", es: "plan" })} />
        {/* «Activo», en masculino: habla del plan (Juan 2026-10-13). */}
        <span className="flex flex-none items-center gap-1.5 rounded-full bg-[color:var(--color-bold-yellow)]/60 px-[11px] py-1.5 text-[9.5px] font-bold uppercase tracking-[0.16em] md:px-3 md:py-[7px] md:text-[10px]">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#2F343D]" />
          {paused ? t({ en: "Paused", es: "En pausa" }) : t({ en: "Active", es: "Activo" })}
        </span>
      </div>

      {subscription.composition?.length ? (
        <div className="mt-[18px] grid grid-cols-2 gap-3 border-y border-[#2F343D]/12 py-3.5 md:mt-[22px] md:gap-4">
          {subscription.composition.map((c) => {
            const v = flavorVisual(c.flavor);
            const name = Object.prototype.hasOwnProperty.call(FLAVORS, c.flavor)
              ? shortLabel(c.flavor as FlavorKey)
              : unknownFlavorName(c.flavor);
            return (
              <div key={c.flavor} className="flex items-center gap-2.5 md:gap-3.5">
                <span aria-hidden className="relative h-[58px] w-[66px] flex-none md:h-[68px] md:w-[80px]">
                  <span
                    className="absolute bottom-0 left-1 h-[52px] w-[52px] rounded-full md:left-1.5 md:h-[60px] md:w-[60px]"
                    style={{ background: v.disc }}
                  />
                  {v.box && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={v.box}
                      alt=""
                      className="absolute bottom-0.5 left-0 h-auto w-[62px] max-w-none md:w-[74px]"
                      style={{ filter: "drop-shadow(0 8px 8px rgba(26,28,34,0.22))" }}
                    />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block font-display text-[24px] font-semibold leading-none md:text-[28px]">
                    {c.boxes}×
                  </span>
                  <span className="mt-[5px] block text-[9.5px] font-bold uppercase leading-[1.3] tracking-[0.14em] md:mt-1.5 md:text-[10px]">
                    Salty <br className="md:hidden" />
                    {name}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-[18px] border-y border-[#2F343D]/12 py-3.5 text-[14px] md:mt-[22px]">
          {subscription.flavorSummary || subscription.flavor}
        </p>
      )}

      <div className="grid grid-cols-2">
        <Figure
          size="sm"
          className={`border-b ${cell} py-4 pr-3 md:pr-[18px]`}
          value={subscription.boxCount}
          label={t({ en: "Boxes per delivery", es: "Cajas por envío" })}
        />
        <Figure
          size="sm"
          className={`border-b border-l ${cell} py-4 pl-4 md:pl-[18px]`}
          value={freq.n}
          label={frequencyBetweenLabel(subscription.frequency, lang)}
        />
        <Figure
          size="sm"
          className="pt-4 pr-3 md:pr-[18px]"
          value={nextLabel}
          label={t({ en: "Next delivery", es: "Próximo envío" })}
        />
        {price && (
          <Figure
            size="sm"
            className={`border-l ${cell} pt-4 pl-4 md:pl-[18px]`}
            value={price}
            label={
              <>
                <span className="md:hidden">{t({ en: "Per delivery", es: "Por envío" })}</span>
                <span className="hidden md:inline">
                  {t({ en: "Per delivery · free shipping", es: "Por envío · envío gratis" })}
                </span>
              </>
            }
          />
        )}
      </div>

      {!paused && (
        <div className="mt-auto pt-5 md:pt-6">
          <button
            type="button"
            onClick={onPlan}
            disabled={locked}
            className="flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-full bg-[#2F343D] px-[18px] py-3.5 text-[11px] font-bold uppercase tracking-[0.16em] text-[#F2F1EA] transition-transform duration-150 hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 md:py-[15px]"
          >
            <T en="Change boxes or frequency" es="Cambiar cajas o frecuencia" />
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EBEE62" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" />
              <path d="M13 6l6 6-6 6" />
            </svg>
          </button>
          <div className="mt-2.5 grid grid-cols-3 gap-2 md:gap-2.5">
            {[
              { icon: QAIcons.ChargeNow, label: t({ en: "Bring fwd", es: "Adelantar" }), onClick: onChargeNow },
              { icon: QAIcons.Skip, label: t({ en: "Skip", es: "Saltar" }), onClick: onSkip },
              { icon: QAIcons.Flavor, label: t({ en: "Flavor", es: "Sabor" }), onClick: onFlavor },
            ].map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={a.onClick}
                disabled={locked}
                className="flex cursor-pointer flex-col items-center gap-1.5 rounded-[16px] border border-[#2F343D]/12 px-1 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[#2F343D] transition-colors hover:border-[#2F343D]/35 disabled:cursor-not-allowed disabled:opacity-50 md:flex-row md:justify-center md:gap-2 md:rounded-full md:border-[#2F343D]/18 md:px-2.5 md:py-[13px] md:text-[11px]"
              >
                <span aria-hidden className="inline-flex h-[17px] w-[17px] md:h-4 md:w-4">
                  {a.icon}
                </span>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </Lp2Card>
  );
}

/**
 * A wholesale address, read-only, with the button that opens the popup BELOW the
 * data (Juan 2026-07-29) — the same read-block-then-edit shape the subscription
 * address uses, so both addresses on this page behave like the rest of the
 * portal instead of being seven inline rows.
 */
function BusinessAddressBlock({
  value,
  onEdit,
  editLabel,
  note,
  onReset,
  resetLabel,
}: {
  value: PortalAddress | null;
  onEdit: () => void;
  editLabel: string;
  note?: string;
  /** Only for the billing block, once a separate fiscal address exists. */
  onReset?: () => Promise<void>;
  resetLabel?: string;
}) {
  const [resetting, setResetting] = useState(false);
  const hasAddress = !!value?.address1;
  return (
    <div className="pt-1">
      {hasAddress ? (
        <div className="text-[13px] leading-[1.6] text-[color:var(--color-lit-grey)]">
          {value!.company && <div className="font-semibold">{value!.company}</div>}
          <div>{value!.address1}</div>
          {value!.address2 && <div>{value!.address2}</div>}
          <div>
            {value!.postalCode} {value!.city}
            {value!.province ? `, ${value!.province}` : ""}
          </div>
          <div>{value!.country ?? "España"}</div>
        </div>
      ) : (
        <p className="text-[13px] text-[color:var(--color-warm-gray)]">
          <T en="No address yet." es="Todavía no hay dirección." />
        </p>
      )}

      {note && (
        <p className="mt-3 text-[11px] leading-[1.5] text-[color:var(--color-warm-gray)]">{note}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onEdit}
          className="rounded-full border border-[color:var(--color-lit-grey)]/40 px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)] transition-colors hover:border-[color:var(--color-lit-grey)]"
        >
          {hasAddress ? editLabel : <T en="Add address" es="Añadir dirección" />}
        </button>
        {onReset && (
          <button
            type="button"
            disabled={resetting}
            onClick={async () => {
              setResetting(true);
              try {
                await onReset();
              } finally {
                setResetting(false);
              }
            }}
            className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] underline-offset-2 hover:text-[color:var(--color-lit-grey)] hover:underline disabled:opacity-50"
            style={{ fontFamily: "var(--font-cond)", fontSize: 10 }}
          >
            {resetting ? <T en="Saving…" es="Guardando…" /> : resetLabel}
          </button>
        )}
      </div>
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
    } catch (e) {
      // Bad input (a phone/email Shopify rejects) comes back as a typed 400 so
      // we can point the customer at the field to fix, instead of the generic
      // "couldn't save" that hid what was actually wrong.
      const code = e instanceof ApiClientError ? e.code : null;
      if (code === "invalid_phone") {
        setErr(t({ en: "That phone number isn't valid. Please check it.", es: "El teléfono no es válido, revísalo." }));
      } else if (code === "invalid_email") {
        setErr(t({ en: "That email address isn't valid. Please check it.", es: "El email no es válido, revísalo." }));
      } else {
        setErr(t({ en: "Couldn't save.", es: "No se pudo guardar." }));
      }
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div className={ROW}>
        <div className="min-w-0">
          <p className={ROW_LABEL}>{label}</p>
          <p className={`${ROW_VALUE} ${value ? "text-[#2F343D]" : "text-[#8C8E87]"}`}>
            {value || t({ en: "Not added", es: "Sin añadir" })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          className={ROW_ACTION}
        >
          {value ? <T en="Edit" es="Editar" /> : <T en="Add" es="Añadir" />}
        </button>
      </div>
    );
  }

  return (
    <div className="border-b border-[#2F343D]/12 py-[15px] md:py-4">
      <p className={ROW_LABEL}>{label}</p>
      <div className="mt-2 flex gap-2">
        <input
          autoFocus
          type={inputType}
          value={draft}
          placeholder={placeholder && placeholder !== "—" ? placeholder : undefined}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          className="min-w-0 flex-1 rounded-full border border-[#2F343D]/15 bg-[#EFEEE5] px-4 py-2.5 text-[14px] text-[#2F343D] focus:border-[color:var(--color-bold-yellow)] focus:bg-white focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="cursor-pointer rounded-full bg-[#2F343D] px-4 text-[10px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-bold-yellow)] disabled:opacity-50"
        >
          {busy ? "…" : <T en="Save" es="OK" />}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={busy}
          aria-label={t({ en: "Cancel", es: "Cancelar" })}
          className="cursor-pointer rounded-full border border-[#2F343D]/20 px-3 text-[14px] font-bold text-[#8C8E87] hover:text-[#2F343D]"
        >
          ×
        </button>
      </div>
      {err && <p className="mt-2 mb-0 text-[11px] text-[color:var(--color-danger)]">{err}</p>}
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
  const t = useLang();
  const has = !!address && !!address.address1;
  let line: string | null = null;
  if (has && address) {
    const street = address.address2 ? `${address.address1}, ${address.address2}` : address.address1;
    const town = [address.postalCode, address.city].filter(Boolean).join(" ");
    // La provincia solo si dice algo que la ciudad no dice («28045 Madrid,
    // Madrid» sobra); el país solo fuera de España, donde está casi todo el mundo.
    const province =
      address.province && address.province.toLowerCase() !== (address.city ?? "").toLowerCase()
        ? `, ${address.province}`
        : "";
    const country = address.countryCode && address.countryCode !== "ES" ? ` · ${address.country}` : "";
    line = `${street} · ${town}${province}${country}`;
  }
  return (
    <div className={ROW}>
      <div className="min-w-0">
        <p className={ROW_LABEL}>{t({ en: "Delivery address", es: "Dirección de entrega" })}</p>
        <p className={`${ROW_VALUE} ${line ? "text-[#2F343D]" : "text-[#8C8E87]"}`}>
          {line ?? t({ en: "Not added", es: "Sin añadir" })}
        </p>
      </div>
      <button type="button" onClick={onEdit} className={ROW_ACTION}>
        {has ? <T en="Change" es="Cambiar" /> : <T en="Add" es="Añadir" />}
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

  const rowLabel = t({ en: "Payment method", es: "Método de pago" });

  if (loading) {
    return (
      <div className={ROW}>
        <div className="min-w-0">
          <p className={ROW_LABEL}>{rowLabel}</p>
          <p className={`${ROW_VALUE} text-[#8C8E87]`}>
            <T en="Loading…" es="Cargando…" />
          </p>
        </div>
      </div>
    );
  }

  if (!data?.instrument) {
    return (
      <div className={ROW}>
        <div className="min-w-0">
          <p className={ROW_LABEL}>{rowLabel}</p>
          <p className={`${ROW_VALUE} text-[#8C8E87]`}>
            <T en="No payment method on file." es="Sin método de pago registrado." />
          </p>
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
          : null;

  return (
    <div>
      <div className={ROW}>
        <div className="min-w-0">
          <p className={ROW_LABEL}>{rowLabel}</p>
          <p className={`${ROW_VALUE} text-[#2F343D]`}>
            {typeLabel && inst.label && !inst.label.toLowerCase().startsWith(typeLabel.toLowerCase())
              ? `${typeLabel} · ${inst.label}`
              : inst.label || typeLabel}
          </p>
        </div>
        {!sentTo && (
          <button type="button" onClick={sendEmail} disabled={busy} className={ROW_ACTION}>
            {busy ? <T en="Sending…" es="Enviando…" /> : <T en="Change" es="Cambiar" />}
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

/**
 * Pedidos visibles antes del "Ver más" en Cuenta. Mismo número que tenía el Hub
 * (`VISIBLE_ORDERS` en components/OrderHistory.tsx). Desde el 2026-10-13 el Hub
 * ya no enseña pedidos (Juan): esta es la única lista. Va duplicado y no
 * importado porque es una implementación aparte, con su propio markup compacto.
 */
const VISIBLE_ACCOUNT_ORDERS = 4;

function OrdersSection({ orders }: { orders: OrderHistoryItem[] | null }) {
  // Se ven 4 y el resto se pliega tras «Ver todos los pedidos» (Juan
  // 2026-09-10). El desplegable que escondía la sección entera se fue con el
  // rediseño lp2 (2026-10-13): la tarjeta va siempre abierta.
  const [expanded, setExpanded] = useState(false);
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  const collapsible = !!orders && orders.length > VISIBLE_ACCOUNT_ORDERS;
  const shown =
    orders && collapsible && !expanded
      ? orders.slice(0, VISIBLE_ACCOUNT_ORDERS)
      : orders;

  const t = useLang();
  const toggle = collapsible ? (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      className="inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-full border border-[#2F343D]/20 px-5 py-[13px] text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#2F343D] transition-colors hover:border-[#2F343D]/45"
    >
      {expanded ? t({ en: "Show less", es: "Ver menos" }) : t({ en: "See all orders", es: "Ver todos los pedidos" })}
      <svg
        aria-hidden
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`transition-transform duration-200 ${expanded ? "-rotate-90" : ""}`}
      >
        <path d="M5 12h14" />
        <path d="M13 6l6 6-6 6" />
      </svg>
    </button>
  ) : null;

  return (
    <div className="mx-6 md:mx-0">
      <Lp2Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <CardTitle thin={t({ en: "My", es: "Mis" })} bold={t({ en: "orders", es: "pedidos" })} />
          {toggle && <div className="hidden md:block">{toggle}</div>}
        </div>
        {!orders && (
          <p className="mt-4 mb-0 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8C8E87]">
            <T en="Loading…" es="Cargando…" />
          </p>
        )}
        {orders && orders.length === 0 && (
          <p className="mt-4 mb-0 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8C8E87]">
            <T en="No orders yet." es="Aún no hay pedidos." />
          </p>
        )}
        {orders && orders.length > 0 && (
          <ul className="m-0 mt-4 grid list-none gap-2.5 p-0 md:mt-6 md:grid-cols-2 md:gap-3">
            {(shown ?? []).map((o) => (
              <li key={o.id}>
                <Link
                  href={orderDetailHref(lang, o.id)}
                  className="flex items-center justify-between gap-3 rounded-[16px] bg-[#EFEEE5] px-4 py-[15px] text-[#2F343D] transition-colors hover:bg-[#E7E6DC] md:rounded-[18px] md:px-5 md:py-[18px]"
                >
                  <span className="min-w-0">
                    <span className="block font-display text-[17px] font-semibold leading-none md:text-[20px]">
                      {o.orderNumber}
                    </span>
                    <span className="mt-[5px] block text-[12.5px] text-[#5E6168] md:mt-1.5 md:text-[13.5px]">
                      {new Date(o.date).toLocaleDateString(dateLocale, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      }).replace(".", "")}{" "}
                      · {o.currency === "EUR" ? formatEuro(Math.round(o.total * 100), lang) : `${o.total.toFixed(2)} ${o.currency}`}
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-2.5 md:gap-3">
                    <span
                      className="rounded-full px-2.5 py-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em] md:px-3 md:text-[10px]"
                      style={orderStatusStyle(o.status)}
                    >
                      {o.status ? translateOrderStatus(o.status, lang) : "—"}
                    </span>
                    <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2F343D" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14" />
                      <path d="M13 6l6 6-6 6" />
                    </svg>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {toggle && <div className="mt-3.5 md:hidden [&>button]:w-full">{toggle}</div>}
      </Lp2Card>
    </div>
  );
}

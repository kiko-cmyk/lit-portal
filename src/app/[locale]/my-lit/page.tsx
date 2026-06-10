"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { CancelTakeover } from "@/components/CancelTakeover";
import { ChargeNowOverlay } from "@/components/ChargeNowOverlay";
import { CollectionMiniGrid } from "@/components/CollectionMiniGrid";
import { CustomerChip } from "@/components/CustomerChip";
import { DeliveryCalendar } from "@/components/DeliveryCalendar";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { Marquee } from "@/components/Marquee";
import { NextBoxHero, type NextBoxHeroVariant } from "@/components/NextBoxHero";
import { OrderHistory } from "@/components/OrderHistory";
import { PlanOverlay } from "@/components/PlanOverlay";
import {
  QAIcons,
  QuickActionButton,
} from "@/components/QuickActionButton";
import { ReactivateCard } from "@/components/ReactivateCard";
import { SectionDivider } from "@/components/SectionDivider";
import { SkipOverlay } from "@/components/SkipOverlay";
import { TierPill } from "@/components/TierPill";
import { api, ApiClientError } from "@/lib/api-client";
import { LangToggle, T, useLang, useLangValue, usePageTitle } from "@/lib/i18n";
import { clearJustSkipped, readJustSkipped, writeJustSkipped } from "@/lib/just-skipped";
import { portalHref } from "@/lib/portal-link";
import type {
  CustomerProfile,
  HubDashboard,
  Subscription,
  TimelineEntry,
} from "@/lib/types";

// Persistencia del banner "Saltaste la entrega anterior". Antes vivía
// en sessionStorage (se perdía al cerrar pestaña). Ahora en localStorage
// con la fecha del próximo envío como expiry — el banner se queda
// hasta que el siguiente envío salga, momento en el que ya no aplica.
// Juan 2026-05-19. Helper extraído a @/lib/just-skipped 2026-05-21.

// Window during which the Hub silently re-polls /api/hub/dashboard after a
// plan change, waiting for Seal to finish regenerating billing_attempts.
// Backend already polls for 8 s; the FE picks up the slack for the rare
// cases where Seal takes longer (memory: regenerate can take minutes).
const POST_PLAN_RESYNC_MS = 60_000;
const POST_PLAN_RESYNC_INTERVAL_MS = 5_000;

export default function HubPage() {
  const [data, setData] = useState<HubDashboard | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const [showChargeNow, setShowChargeNow] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [justSkipped, setJustSkipped] = useState<boolean>(
    () => readJustSkipped() !== null,
  );
  const [syncingUntil, setSyncingUntil] = useState<number | null>(null);
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const t = useLang();
  const lang = useLangValue();
  usePageTitle({ en: "Subscription", es: "Suscripción" }); // browser tab title

  useEffect(() => {
    api<CustomerProfile>("/api/customer")
      .then(setCustomer)
      .catch(() => setCustomer(null));
    api<HubDashboard>("/api/hub/dashboard")
      .then((fresh) => {
        setData(fresh);
        // Cold-load arrived with no scheduled date → kick off the silent
        // re-poll just like after a plan change. Covers the case where the
        // customer comes back to the Hub while Seal is still rebuilding.
        if (
          fresh.subscription &&
          !fresh.subscription.nextShipDate &&
          fresh.subscription.status !== "post_cancel" &&
          fresh.subscription.status !== "expired"
        ) {
          setSyncingUntil(Date.now() + POST_PLAN_RESYNC_MS);
        }
      })
      .catch((e: ApiClientError) => setError(e.code));
    api<TimelineEntry[]>("/api/timeline?limit=4")
      .then(setTimeline)
      .catch(() => setTimeline([]));
  }, []);

  // Silent re-poll loop after a plan change. Stops as soon as the dashboard
  // returns a non-null nextShipDate (Seal finished rebuilding), or after the
  // window closes.
  useEffect(() => {
    if (syncingUntil === null) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const fresh = await api<HubDashboard>("/api/hub/dashboard");
        if (cancelled) return;
        setData(fresh);
        if (fresh.subscription.nextShipDate) {
          setSyncingUntil(null);
          return;
        }
      } catch {
        // Swallow transient errors; we'll retry on the next tick.
      }
      if (Date.now() < syncingUntil) {
        setTimeout(tick, POST_PLAN_RESYNC_INTERVAL_MS);
      } else {
        setSyncingUntil(null);
      }
    };
    const id = setTimeout(tick, POST_PLAN_RESYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [syncingUntil]);

  const handleReactivate = async () => {
    // Audit 2026-05-18 [CRIT]: the previous implementation redirected to
    // litsalt.com/products/lit-subscription, which made the customer buy a
    // SECOND subscription instead of reactivating the cancelled one. That
    // reproduces the "sub orfana 13635794" incident. Now we call the proper
    // endpoint; only on `reactivation_window_expired` (90d hold elapsed) or
    // `second_cancel_no_reactivation` do we send them to the storefront.
    try {
      await api("/api/subscription/reactivate", { method: "POST" });
      // Refetch dashboard so the Hub flips out of post-cancel mode.
      const fresh = await api<HubDashboard>("/api/hub/dashboard");
      setData(fresh);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "reactivation_window_expired" || code === "second_cancel_no_reactivation") {
        window.location.href = "https://litsalt.com/products/lit-subscription";
        return;
      }
      console.error("[hub] reactivate failed", e);
      setError(code ?? "reactivate_failed");
    }
  };

  const handlePlanUpdated = (updated: Subscription) => {
    // Seal regenerates billing_attempts on every plan change, which wipes
    // any previously-applied skip. The localStorage `justSkipped` flag would
    // otherwise outlive the actual skip and lie to the customer (banner
    // shown, but real Seal date is the non-skipped one). Clear it here.
    // Juan 2026-05-21: this is exactly the bug that made him think a skip
    // had been reverted after a plan change.
    markSkipped(false);
    setData((prev) => {
      if (!prev) return prev;
      // Preserve the previous nextShipDate when Seal hasn't finished
      // rebuilding billing_attempts yet — the date itself shouldn't move on
      // a plan change (variant/cadence change only).
      return {
        ...prev,
        subscription: {
          ...updated,
          nextShipDate: updated.nextShipDate ?? prev.subscription.nextShipDate,
          cutoffEndsAt: updated.cutoffEndsAt ?? prev.subscription.cutoffEndsAt,
          withinCutoff:
            updated.nextShipDate !== null
              ? updated.withinCutoff
              : prev.subscription.withinCutoff,
        },
      };
    });
    // Kick off the silent re-poll window. The backend already waited ~8 s; if
    // we still don't have a fresh date here it means Seal is slow today.
    // (Date.now is impure but this is inside an event-handler callback,
    // not in render — ESLint over-flags here.)
    // eslint-disable-next-line react-hooks/purity
    if (!updated.nextShipDate) setSyncingUntil(Date.now() + POST_PLAN_RESYNC_MS);
  };

  const markSkipped = (next: boolean, until?: string | null) => {
    setJustSkipped(next);
    if (next && until) {
      writeJustSkipped(until);
    } else {
      clearJustSkipped();
    }
  };

  if (error === "unauthorized" || error === "session_expired" || error === "session_invalid") return <LoginScreen />;
  if (error === "subscription_not_found") return <EmptyState />;
  if (error) return <ErrorState code={error} />;
  if (!data) return <LoadingState />;

  const { subscription, drops } = data;
  const sub = subscription;
  const cutoffEndsAt = sub.cutoffEndsAt ? new Date(sub.cutoffEndsAt) : null;
  const nextShipDate = sub.nextShipDate ? new Date(sub.nextShipDate) : null;
  const isPostCancel = sub.status === "post_cancel" || sub.status === "expired";
  const isNew = sub.nextBoxNumber === 1 && timeline.length === 0;
  // Whenever the sub exists but Seal hasn't reattached a next ship date —
  // either right after a plan change or on cold reloads while Seal rebuilds —
  // show the syncing banner so the customer never sees a blank date hero.
  const showSyncingBanner =
    syncingUntil !== null || (!isPostCancel && !nextShipDate);

  const variant: NextBoxHeroVariant = justSkipped
    ? "skipped"
    : sub.withinCutoff
      ? "locked"
      : isNew
        ? "new"
        : "default";

  const collectionEarned = Math.min(4, Math.floor(timeline.length));

  return (
    <div className="zone-cream mesh-bg flex min-h-screen flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />

      {/* Mobile header — fixed so it NEVER hides on scroll (per Juan
          2026-05-19). z-40 sits above the BottomNav z-40 sibling, fine on
          mobile because they don't overlap (top vs bottom). */}
      <header className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between border-b border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-brisky-cream)]/90 px-6 pt-5 pb-3 backdrop-blur-md md:hidden">
        <Logo />
        <div className="flex items-center gap-2.5">
          <LangToggle />
          {customer && <CustomerChip name={customer.name} />}
          <TierPill
            visible={drops.tierEarned}
            tierEarnedAt={drops.activeReward ? null : null}
          />
        </div>
      </header>

      <main className="flex-1 pt-[88px] pb-24 md:mx-auto md:w-full md:max-w-5xl md:px-8 md:pt-[92px] md:pb-12">
        {showSyncingBanner && <SyncingBanner />}
        {isPostCancel ? (
          <ReactivateCard
            dropsHeld={drops.balance}
            cardsKept={collectionEarned}
            onReactivate={handleReactivate}
          />
        ) : (
          <>
            <NextBoxHero
              shipDate={nextShipDate}
              flavor={sub.flavor}
              variant={variant}
              cutoffEndsAt={cutoffEndsAt}
              onUndoSkip={justSkipped ? () => markSkipped(false) : undefined}
              boxCount={sub.boxCount}
              frequency={sub.frequency}
            />

            <SectionDivider
              title={t({
                en: "Manage my subscription",
                es: "Gestionar mi suscripción",
              })}
            />
            <section className="mx-6 grid grid-cols-2 gap-2.5 md:mx-0 md:grid-cols-5">
              <QuickActionButton
                icon={QAIcons.ChargeNow}
                label={t({ en: "Bring forward", es: "Adelantar pedido" })}
                sub={t({ en: "Order now", es: "Hacer pedido ahora" })}
                onClick={() => setShowChargeNow(true)}
                disabled={sub.withinCutoff}
              />
              <QuickActionButton
                icon={QAIcons.ChangePlan}
                label={t({ en: "Change plan", es: "Cambiar plan" })}
                sub={t({
                  en: "Change boxes or frequency",
                  es: "Cambiar cajas o frecuencia",
                })}
                onClick={() => setShowPlan(true)}
                disabled={sub.withinCutoff}
              />
              <QuickActionButton
                icon={QAIcons.Skip}
                label={t({ en: "Skip next box", es: "Saltar próxima" })}
                sub={t({
                  en: "Skip next order",
                  es: "Saltar próximo pedido",
                })}
                onClick={() => setShowSkip(true)}
                disabled={sub.withinCutoff}
              />
              <QuickActionButton
                icon={QAIcons.Cancel}
                label={t({
                  en: "Cancel subscription",
                  es: "Cancelar suscripción",
                })}
                sub={t({ en: "Delete account", es: "Eliminar cuenta" })}
                onClick={() => setShowCancel(true)}
              />
              <QuickActionButton
                icon={QAIcons.Flavor}
                label={t({ en: "Switch flavor", es: "Cambiar sabor" })}
                sub={t({
                  en: "New flavors coming soon",
                  es: "Nuevos sabores pronto",
                })}
                comingSoon
              />
            </section>

            <SectionDivider
              title={t({ en: "Upcoming", es: "Próximos pedidos" })}
            />
            <DeliveryCalendar
              nextShipDate={nextShipDate}
              upcoming={data.upcomingShipments}
            />

            <SectionDivider
              title={t({ en: "My orders", es: "Mis pedidos" })}
            />
            <OrderHistory limit={10} />

            <Marquee />

            <SectionDivider title={t({ en: "Collection", es: "Colección" })} />
            <CollectionMiniGrid
              earned={collectionEarned}
              href={portalHref(lang, "collection")}
            />
          </>
        )}
      </main>

      <BottomNav />

      {showPlan && (
        <PlanOverlay
          subscription={sub}
          onClose={() => setShowPlan(false)}
          onUpdated={handlePlanUpdated}
        />
      )}
      {showSkip && (
        <SkipOverlay
          subscription={sub}
          onClose={() => setShowSkip(false)}
          onSkipped={(newDate) => {
            // Persistir la marca de "saltado" con la nueva fecha como
            // expiry. El banner se mantendrá hasta que esa fecha pase
            // o hasta que el cliente pulse Deshacer.
            markSkipped(true, newDate);
            // Al saltar:
            //   - nextShipDate avanza un ciclo
            //   - el primer elemento de upcoming queda "consumido" — se
            //     convierte en el nuevo nextShipDate (o cerca). Si no lo
            //     quitamos, el calendario muestra el día duplicado (la
            //     entrega que ahora es nextShipDate aparece TAMBIÉN como
            //     primera upcoming) hasta que el cliente refresque.
            // Seal regenera los attempts en background; lanzamos el
            // silent re-poll para alinear la lista a la verdad de Seal
            // sin romper la UX inmediata.
            setData({
              ...data,
              subscription: { ...sub, nextShipDate: newDate },
              upcomingShipments: data.upcomingShipments.slice(1),
            });
            setSyncingUntil(Date.now() + POST_PLAN_RESYNC_MS);
          }}
        />
      )}
      {showChargeNow && (
        <ChargeNowOverlay
          subscription={sub}
          onClose={() => setShowChargeNow(false)}
          onCharged={(newDate) => {
            // A charge-now with reset_schedule re-anchors the cadence on
            // today, so any local "just skipped" marker is now stale.
            markSkipped(false);
            // Optimistic next date (today + cycle). Seal regenerates the
            // billing_attempts asynchronously, so kick the silent re-poll to
            // reconcile the calendar with Seal's truth.
            setData({
              ...data,
              subscription: { ...sub, nextShipDate: newDate ?? sub.nextShipDate },
            });
            setSyncingUntil(Date.now() + POST_PLAN_RESYNC_MS);
          }}
        />
      )}
      {showCancel && customer && (
        <CancelTakeover
          customer={customer}
          subscription={sub}
          onClose={() => setShowCancel(false)}
          onPivotToSkip={() => {
            setShowCancel(false);
            setShowSkip(true);
          }}
          onPivotToPlan={() => {
            setShowCancel(false);
            setShowPlan(true);
          }}
        />
      )}
    </div>
  );
}

function SyncingBanner() {
  const lang = useLangValue();
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-6 mt-2 flex items-center gap-3 rounded-xl border border-[color:var(--color-bold-yellow)]/40 bg-[color:var(--color-bold-yellow)]/15 px-4 py-3 md:mx-0"
    >
      <span
        className="inline-block h-3 w-3 flex-shrink-0 rounded-full bg-[color:var(--color-bold-yellow)]"
        style={{ animation: "pulse-slot 1.4s ease-in-out infinite" }}
      />
      <div className="text-[11px] leading-[1.4] text-[color:var(--color-lit-grey)]">
        {lang === "es" ? (
          <>
            <strong className="font-extrabold">Actualizando tu calendario.</strong>{" "}
            Tu nueva fecha de envío aparecerá en unos minutos. Refresca la página.
          </>
        ) : (
          <>
            <strong className="font-extrabold">Updating your calendar.</strong>{" "}
            Your new ship date will appear in a few minutes. Refresh the page.
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Estado para visitantes autenticados sin suscripción activa. Cubre:
 *   1. Cliente nuevo que acaba de registrarse y aún no ha comprado.
 *   2. Compra one-shot (no eligieron selling plan).
 *   3. Suscripción cancelada hace tiempo (ya no en post_cancel).
 *
 * Copy neutral ("Bienvenido a LIT") para no asumir que han comprado, ya
 * que el OAuth permite registro on-the-fly. Link directo a Cuenta para
 * que los clientes one-shot puedan ver su histórico de pedidos.
 */
function EmptyState() {
  const lang = useLangValue();
  return (
    <div className="zone-cream mesh-bg flex min-h-screen flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />
      <header className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between border-b border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-brisky-cream)]/90 px-6 pt-5 pb-3 backdrop-blur-md md:hidden">
        <Logo />
        <LangToggle />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-6 pt-[88px] pb-24 text-center md:mx-auto md:w-full md:max-w-2xl md:px-8 md:pt-[92px] md:pb-12">
        <span
          className="font-semibold uppercase tracking-[0.32em] text-[color:var(--color-warm-gray)]"
          style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
        >
          {lang === "es" ? "Tu cuenta LIT" : "Your LIT account"}
        </span>

        <h1
          className="mt-4 font-display font-medium uppercase leading-[0.88] tracking-[-0.035em] text-[color:var(--color-lit-grey)]"
          style={{ fontSize: "clamp(2.6rem, 9vw, 4.4rem)" }}
        >
          {lang === "es" ? (
            <>
              Bienvenido
              <br />
              a LIT
            </>
          ) : (
            <>
              Welcome
              <br />
              to LIT
            </>
          )}
        </h1>

        <p className="mt-6 max-w-md text-[14px] leading-[1.55] text-[color:var(--color-warm-gray)]">
          {lang === "es" ? (
            <>
              Suscríbete y recibe LIT automáticamente cada mes con un{" "}
              <strong className="text-[color:var(--color-lit-grey)]">
                descuento desde el 25%
              </strong>
              , y gestiona pedidos, planes y direcciones desde este portal.
            </>
          ) : (
            <>
              Subscribe and get LIT delivered automatically every month with{" "}
              <strong className="text-[color:var(--color-lit-grey)]">
                25% off or more
              </strong>
              , and manage orders, plans and addresses from this portal.
            </>
          )}
        </p>

        <div className="mt-9 flex flex-col items-center gap-3">
          <a
            href="https://litsalt.com/products/lit-daily-hydration"
            className="inline-flex items-center justify-center rounded-full bg-[color:var(--color-lit-grey)] px-7 py-3.5 font-semibold uppercase tracking-[0.22em] text-[color:var(--color-bold-yellow)] transition-transform duration-200 ease-out hover:-translate-y-[2px]"
            style={{ fontFamily: "var(--font-cond)", fontSize: 12 }}
          >
            {lang === "es" ? "Activar mi suscripción" : "Start my subscription"}
          </a>
          <Link
            href={portalHref(lang, "account")}
            className="font-semibold uppercase tracking-[0.22em] text-[color:var(--color-warm-gray)] underline-offset-2 hover:text-[color:var(--color-lit-grey)] hover:underline"
            style={{ fontFamily: "var(--font-cond)", fontSize: 11 }}
          >
            {lang === "es" ? "Ver mis pedidos" : "View my orders"}
          </Link>
        </div>
      </main>
      <BottomNav />
    </div>
  );
}

function ErrorState({ code }: { code: string }) {
  return (
    <main className="zone-cream flex flex-1 flex-col items-center justify-center p-8 text-center">
      <h1 className="text-2xl mb-3">
        <T en="Something went wrong." es="Algo no fue bien." />
      </h1>
      <p className="text-xs opacity-50">{code}</p>
    </main>
  );
}

function LoadingState() {
  return (
    <main className="zone-cream flex flex-1 items-center justify-center">
      <p className="text-xs uppercase tracking-[0.2em] opacity-50">
        <T en="Loading…" es="Cargando…" />
      </p>
    </main>
  );
}

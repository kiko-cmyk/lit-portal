"use client";

import { useEffect, useState } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { DeliveryCalendar } from "@/components/DeliveryCalendar";
import { NextBoxHero, type NextBoxHeroVariant } from "@/components/NextBoxHero";
import { OrderHistory } from "@/components/OrderHistory";
import {
  CollectionPeekVisual,
  PeekCard,
} from "@/components/PeekCard";
import { PlanOverlay } from "@/components/PlanOverlay";
import {
  QAIcons,
  QuickActionButton,
} from "@/components/QuickActionButton";
import { ReactivateCard } from "@/components/ReactivateCard";
import { SkipOverlay } from "@/components/SkipOverlay";
import { TierPill } from "@/components/TierPill";
import { api, ApiClientError } from "@/lib/api-client";
import { frequencyLabel } from "@/lib/frequency-label";
import { LangToggle, T, useLang, useLangValue, usePageTitle } from "@/lib/i18n";
import type { HubDashboard, Subscription, TimelineEntry } from "@/lib/types";

const JUST_SKIPPED_KEY = "lit:just-skipped";

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
  const [justSkipped, setJustSkipped] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      window.sessionStorage.getItem(JUST_SKIPPED_KEY) === "1",
  );
  const [syncingUntil, setSyncingUntil] = useState<number | null>(null);
  const t = useLang();
  const lang = useLangValue();
  usePageTitle({ en: "My LIT", es: "Mi LIT" }); // browser tab title

  useEffect(() => {
    api<HubDashboard>("/api/hub/dashboard")
      .then(setData)
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

  const handlePlanUpdated = (updated: Subscription) => {
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
    if (!updated.nextShipDate) {
      setSyncingUntil(Date.now() + POST_PLAN_RESYNC_MS);
    }
  };

  const markSkipped = (next: boolean) => {
    setJustSkipped(next);
    if (typeof window !== "undefined") {
      if (next) window.sessionStorage.setItem(JUST_SKIPPED_KEY, "1");
      else window.sessionStorage.removeItem(JUST_SKIPPED_KEY);
    }
  };

  if (error === "unauthorized") return <LoginScreen />;
  if (error === "subscription_not_found") return <EmptyState />;
  if (error) return <ErrorState code={error} />;
  if (!data) return <LoadingState />;

  const { subscription, drops } = data;
  const sub = subscription;
  const cutoffEndsAt = sub.cutoffEndsAt ? new Date(sub.cutoffEndsAt) : null;
  const nextShipDate = sub.nextShipDate ? new Date(sub.nextShipDate) : null;
  const isPostCancel = sub.status === "post_cancel" || sub.status === "expired";
  const isNew = sub.nextBoxNumber === 1 && timeline.length === 0;

  const variant: NextBoxHeroVariant = justSkipped
    ? "skipped"
    : sub.withinCutoff
      ? "locked"
      : isNew
        ? "new"
        : "default";

  const collectionEarned = Math.min(4, Math.floor(timeline.length));

  return (
    <div className="zone-cream flex min-h-full flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />

      <header className="flex items-center justify-between px-6 pt-5 pb-3 md:hidden">
        <Logo />
        <div className="flex items-center gap-2">
          <LangToggle />
          <TierPill visible={drops.tierEarned} tierEarnedAt={drops.activeReward ? null : null} />
        </div>
      </header>

      <main className="flex-1 pb-24 md:mx-auto md:w-full md:max-w-3xl md:px-8 md:pt-6 md:pb-12">
        {syncingUntil !== null && (
          <SyncingBanner />
        )}
        {isPostCancel ? (
          <ReactivateCard
            dropsHeld={drops.balance}
            cardsKept={collectionEarned}
            onReactivate={() => {
              window.location.href = "https://litsalt.com/products/lit-subscription";
            }}
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

            <section className="mx-6 mt-5 grid grid-cols-2 gap-2 md:mx-0 md:grid-cols-4">
              <QuickActionButton
                icon={QAIcons.ChangePlan}
                label={t({ en: "Change plan", es: "Cambiar plan" })}
                sub={`${sub.boxCount} ${
                  sub.boxCount === 1
                    ? t({ en: "box", es: "caja" })
                    : t({ en: "boxes", es: "cajas" })
                } · ${frequencyLabel(sub.frequency, lang, { format: "short" })}`}
                onClick={() => setShowPlan(true)}
                disabled={sub.withinCutoff}
              />
              <QuickActionButton
                icon={QAIcons.Skip}
                label={t({ en: "Skip next box", es: "Saltar próxima" })}
                sub={t({
                  en: "Going somewhere? Skip one.",
                  es: "¿Te vas? Salta una.",
                })}
                onClick={() => setShowSkip(true)}
                disabled={sub.withinCutoff}
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
              <QuickActionButton
                icon={QAIcons.Extras}
                label={t({ en: "Extras", es: "Extras" })}
                sub={t({
                  en: "One-time add to next box",
                  es: "Añadir una vez a la caja",
                })}
                comingSoon
              />
            </section>

            <div className="mt-5">
              <PeekCard
                variant="collection"
                lead={t({
                  en: "Collection · Edition 01",
                  es: "Colección · Edición 01",
                })}
                title={
                  isNew
                    ? t({
                        en: "0 of 12 · just starting",
                        es: "0 de 12 · recién empiezas",
                      })
                    : t({
                        en: `${collectionEarned} of 12 earned`,
                        es: `${collectionEarned} de 12 ganadas`,
                      })
                }
                sub={
                  isNew
                    ? t({
                        en: "Your first card ships with your first box.",
                        es: "Tu primera carta va con tu primera caja.",
                      })
                    : t({
                        en: "One card per box. Finish the set.",
                        es: "Una carta por caja. Completa el set.",
                      })
                }
                cta={t({ en: "Coming soon", es: "Pronto" })}
                comingSoon
                visual={<CollectionPeekVisual earned={collectionEarned} />}
              />
            </div>

            <DeliveryCalendar
              nextShipDate={nextShipDate}
              nextBoxNumber={sub.nextBoxNumber}
              upcoming={data.upcomingShipments}
            />

            <OrderHistory limit={10} />
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
            markSkipped(true);
            setData({
              ...data,
              subscription: { ...sub, nextShipDate: newDate },
            });
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
            <strong className="font-extrabold">Aplicando el cambio de plan.</strong>{" "}
            Tu nueva fecha de envío aparecerá en un momento — mantén esta página abierta.
          </>
        ) : (
          <>
            <strong className="font-extrabold">Applying your plan change.</strong>{" "}
            Your new ship date will appear in a moment — keep this page open.
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="zone-cream flex min-h-full flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <header className="flex items-center justify-between px-6 pt-5 pb-3 md:px-12">
        <Logo />
        <LangToggle />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-8 pb-24 text-center">
        <h1 className="font-display text-4xl font-black uppercase leading-none md:text-5xl">
          <T en="No active subscription" es="Sin suscripción activa" />
          <span className="text-[color:var(--color-bold-yellow)]">.</span>
        </h1>
        <p className="mt-4 max-w-sm text-sm opacity-70">
          <T
            en="Once you start your first LIT subscription, you'll see your hub here."
            es="Cuando empieces tu suscripción a LIT, verás tu hub aquí."
          />
        </p>
        <a
          href="https://litsalt.com"
          className="mt-8 rounded-sm bg-[color:var(--color-lit-grey)] px-6 py-3 text-xs font-black uppercase tracking-[0.2em] text-[color:var(--color-brisky-cream)]"
        >
          <T en="Discover LIT" es="Descubre LIT" />
        </a>
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

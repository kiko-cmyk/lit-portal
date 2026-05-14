"use client";

import { useEffect, useState } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { ExtrasOverlay } from "@/components/ExtrasOverlay";
import { FlavorOverlay } from "@/components/FlavorOverlay";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { NextBoxHero, type NextBoxHeroVariant } from "@/components/NextBoxHero";
import {
  CollectionPeekVisual,
  DropsPeekVisual,
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
import { Timeline } from "@/components/Timeline";
import { api, ApiClientError } from "@/lib/api-client";
import { T, useLang, useLangValue } from "@/lib/i18n";
import { portalHref } from "@/lib/portal-link";
import type { HubDashboard, TimelineEntry } from "@/lib/types";

export default function HubPage() {
  const [data, setData] = useState<HubDashboard | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showFlavor, setShowFlavor] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const [showExtras, setShowExtras] = useState(false);
  const [justSkipped, setJustSkipped] = useState(false);
  const t = useLang();
  const lang = useLangValue();

  useEffect(() => {
    api<HubDashboard>("/api/hub/dashboard")
      .then(setData)
      .catch((e: ApiClientError) => setError(e.code));
    api<TimelineEntry[]>("/api/timeline?limit=4")
      .then(setTimeline)
      .catch(() => setTimeline([]));
  }, []);

  if (error === "unauthorized") return <LoginScreen />;
  if (error === "subscription_not_found") return <EmptyState />;
  if (error) return <ErrorState code={error} />;
  if (!data) return <LoadingState />;

  const { subscription, drops } = data;
  const sub = subscription;
  const cutoffEndsAt = sub.cutoffEndsAt ? new Date(sub.cutoffEndsAt) : null;
  const nextShipDate = sub.nextShipDate ? new Date(sub.nextShipDate) : null;
  const isPostCancel = sub.status === "post_cancel" || sub.status === "expired";
  const isNew = sub.nextBoxNumber === 1 && (timeline.length === 0);

  const variant: NextBoxHeroVariant = justSkipped
    ? "skipped"
    : sub.withinCutoff
      ? "locked"
      : isNew
        ? "new"
        : "default";

  const dropsCount = drops.balance;
  const puzzlePercent = drops.activeReward?.percentComplete ?? 0;
  const collectionEarned = Math.min(4, Math.floor(timeline.length));

  return (
    <div className="zone-cream flex min-h-full flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />

      <header className="flex items-center justify-between px-6 pt-5 pb-3 md:hidden">
        <Logo />
        <TierPill visible={drops.tierEarned} />
      </header>

      <main className="flex-1 pb-24 md:mx-auto md:w-full md:max-w-3xl md:px-8 md:pt-6 md:pb-12">
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
              boxNumber={sub.nextBoxNumber}
              variant={variant}
              cutoffEndsAt={cutoffEndsAt}
              onUndoSkip={justSkipped ? () => setJustSkipped(false) : undefined}
            />

            <section className="mx-6 mt-5 grid grid-cols-2 gap-2 md:mx-0 md:grid-cols-4">
              <QuickActionButton
                icon={QAIcons.ChangePlan}
                label={t({ en: "Change plan", es: "Cambiar plan" })}
                sub={`${sub.boxCount} ${
                  sub.boxCount === 1
                    ? t({ en: "box · every", es: "caja · cada" })
                    : t({ en: "boxes · every", es: "cajas · cada" })
                } ${sub.frequencyLabel}`}
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
                onClick={() => setShowFlavor(true)}
              />
              <QuickActionButton
                icon={QAIcons.Extras}
                label={t({ en: "Extras", es: "Extras" })}
                sub={t({
                  en: "One-time add to next box",
                  es: "Añadir una vez a la caja",
                })}
                onClick={() => setShowExtras(true)}
              />
            </section>

            <div className="mt-5">
              <PeekCard
                variant="drops"
                lead={t({ en: "Drops", es: "Drops" })}
                title={
                  isNew
                    ? t({ en: "Nothing yet.", es: "Nada aún." })
                    : t({
                        en: "Stack rewards.",
                        es: "Acumula recompensas.",
                      })
                }
                sub={
                  isNew
                    ? t({
                        en: "Your first box adds drops. Stack starts there.",
                        es: "Tu primera caja suma drops. Ahí empieza.",
                      })
                    : t({
                        en: `${dropsCount} drops · referrals, reviews, streaks.`,
                        es: `${dropsCount} drops · referidos, reseñas, rachas.`,
                      })
                }
                cta={t({ en: "Soon", es: "Pronto" })}
                comingSoon
                visual={
                  <DropsPeekVisual
                    count={dropsCount}
                    percentComplete={puzzlePercent}
                  />
                }
              />

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
                cta={t({ en: "See all", es: "Ver todas" })}
                href={portalHref(lang, "collection")}
                visual={<CollectionPeekVisual earned={collectionEarned} />}
              />

              {data.nextEvent && (
                <PeekCard
                  variant="world"
                  lead={t({
                    en: `The World · ${capitalize(data.nextEvent.city)}`,
                    es: `El Mundo · ${capitalize(data.nextEvent.city)}`,
                  })}
                  title={data.nextEvent.title}
                  sub={formatEventDate(data.nextEvent.datetime, lang)}
                  cta={t({ en: "Soon", es: "Pronto" })}
                  comingSoon
                />
              )}
            </div>

            <div className="mt-1">
              <Timeline
                past={timeline}
                nextShipDate={nextShipDate}
                nextBoxNumber={sub.nextBoxNumber}
                nextFlavor={sub.flavor}
              />
            </div>
          </>
        )}
      </main>

      <BottomNav />

      {showFlavor && <FlavorOverlay onClose={() => setShowFlavor(false)} />}
      {showPlan && (
        <PlanOverlay
          subscription={sub}
          onClose={() => setShowPlan(false)}
          onUpdated={(updated) =>
            setData({ ...data, subscription: updated })
          }
        />
      )}
      {showSkip && (
        <SkipOverlay
          subscription={sub}
          onClose={() => setShowSkip(false)}
          onSkipped={(newDate) => {
            setJustSkipped(true);
            setData({
              ...data,
              subscription: { ...sub, nextShipDate: newDate },
            });
          }}
        />
      )}
      {showExtras && <ExtrasOverlay onClose={() => setShowExtras(false)} />}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="zone-cream flex min-h-full flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <header className="flex items-center justify-between px-6 pt-5 pb-3 md:px-12">
        <Logo />
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

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function formatEventDate(iso: string, lang: "en" | "es"): string {
  const d = new Date(iso);
  return d.toLocaleDateString(lang === "es" ? "es-ES" : "en-US", {
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

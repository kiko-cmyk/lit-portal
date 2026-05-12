"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { ExtrasOverlay } from "@/components/ExtrasOverlay";
import { FlavorOverlay } from "@/components/FlavorOverlay";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { portalHref } from "@/lib/portal-link";
import { PlanOverlay } from "@/components/PlanOverlay";
import { SkipOverlay } from "@/components/SkipOverlay";
import { TierPill } from "@/components/TierPill";
import { api, ApiClientError } from "@/lib/api-client";
import { T, useLang, useLangValue } from "@/lib/i18n";
import type { HubDashboard } from "@/lib/types";

export default function HubPage() {
  const [data, setData] = useState<HubDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFlavor, setShowFlavor] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const [showExtras, setShowExtras] = useState(false);
  const t = useLang();
  const lang = useLangValue();

  useEffect(() => {
    api<HubDashboard>("/api/hub/dashboard")
      .then(setData)
      .catch((e: ApiClientError) => setError(e.code));
  }, []);

  if (error === "unauthorized") return <LoginScreen />;

  if (error === "subscription_not_found") {
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

  if (error) {
    return (
      <main className="zone-cream flex flex-1 flex-col items-center justify-center p-8 text-center">
        <h1 className="text-2xl mb-3">
          <T en="Something went wrong." es="Algo no fue bien." />
        </h1>
        <p className="text-xs opacity-50">{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="zone-cream flex flex-1 items-center justify-center">
        <p className="text-xs uppercase tracking-[0.2em] opacity-50">
          <T en="Loading…" es="Cargando…" />
        </p>
      </main>
    );
  }

  const { subscription, drops } = data;
  const next = subscription.nextShipDate ? new Date(subscription.nextShipDate) : null;
  const daysToShip = next
    ? Math.ceil((next.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;
  const dateLocale = lang === "es" ? "es-ES" : "en-US";

  return (
    <div className="zone-cream flex min-h-full flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />
      <header className="flex items-center justify-between px-6 pt-5 pb-3 md:hidden">
        <Logo />
        <TierPill visible={drops.tierEarned} />
      </header>

      <main className="flex-1 pb-24 md:mx-auto md:w-full md:max-w-3xl md:px-8 md:pb-12">
        {/* Next-box hero card */}
        <section className="mx-6 mt-2 rounded-2xl bg-[color:var(--color-sharp-white)] p-7 shadow-[0_4px_24px_rgba(50,55,67,0.06)] md:mx-0 md:p-10">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">
            <T en="Next box" es="Próxima caja" />
          </div>
          {next ? (
            <>
              <div className="mt-2 font-display text-6xl font-black uppercase leading-none md:text-8xl">
                {next.toLocaleDateString(dateLocale, { month: "short", day: "numeric" })}
              </div>
              <div className="mt-3 flex flex-wrap items-baseline gap-3 text-xs uppercase tracking-[0.15em]">
                <span className="opacity-60">
                  {next.toLocaleDateString(dateLocale, { weekday: "long" })}
                </span>
                <span>·</span>
                <span>{subscription.flavor}</span>
                {daysToShip !== null && daysToShip >= 0 && (
                  <>
                    <span>·</span>
                    <span className="rounded-sm bg-[color:var(--color-bold-yellow)] px-1.5 py-0.5 text-[color:var(--color-lit-grey)]">
                      {daysToShip}d
                    </span>
                  </>
                )}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.18em] opacity-50">
                <T en={`Box #${subscription.nextBoxNumber}`} es={`Caja #${subscription.nextBoxNumber}`} /> ·{" "}
                {subscription.boxCount}{" "}
                <T
                  en={subscription.boxCount === 1 ? "box, every" : "boxes, every"}
                  es={subscription.boxCount === 1 ? "caja, cada" : "cajas, cada"}
                />{" "}
                {subscription.frequencyLabel}
              </div>
            </>
          ) : (
            <div className="mt-2 text-sm opacity-70">
              <T en="Awaiting next ship date." es="Esperando próxima fecha de envío." />
            </div>
          )}
        </section>

        {/* Quick Actions */}
        <section className="mx-6 mt-5 grid grid-cols-2 gap-2.5 md:mx-0 md:grid-cols-4">
          <QuickAction
            label={t({ en: "Change plan", es: "Cambiar plan" })}
            onClick={() => setShowPlan(true)}
          />
          <QuickAction
            label={t({ en: "Skip next box", es: "Saltar próxima" })}
            onClick={() => setShowSkip(true)}
          />
          <QuickAction
            label={t({ en: "Switch flavor", es: "Cambiar sabor" })}
            subtitle={t({ en: "Coming Soon", es: "Pronto" })}
            comingSoon
            onClick={() => setShowFlavor(true)}
          />
          <QuickAction
            label={t({ en: "Extras", es: "Extras" })}
            onClick={() => setShowExtras(true)}
          />
        </section>

        {/* Collection peek (replaces Drops/World peeks — Phase 2 will surface those) */}
        <Link
          href={portalHref("/collection")}
          className="group mx-6 mt-5 flex items-center justify-between rounded-2xl bg-[color:var(--color-zesty-beige)] px-6 py-5 text-[color:var(--color-lit-grey)] md:mx-0"
        >
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-70">
              <T en="The Collection" es="La Colección" />
            </div>
            <div className="mt-1 font-display text-2xl font-black uppercase">
              <T en="12 cards. One per box." es="12 cartas. Una por caja." />
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.15em] opacity-70">
              <T en="Coming soon" es="Pronto" />
            </div>
          </div>
          <span className="text-2xl transition-transform group-hover:translate-x-1">→</span>
        </Link>
      </main>

      <BottomNav />

      {showFlavor && <FlavorOverlay onClose={() => setShowFlavor(false)} />}
      {showPlan && (
        <PlanOverlay
          subscription={subscription}
          onClose={() => setShowPlan(false)}
          onUpdated={(updated) => setData({ ...data, subscription: updated })}
        />
      )}
      {showSkip && (
        <SkipOverlay
          subscription={subscription}
          onClose={() => setShowSkip(false)}
          onSkipped={(newDate) =>
            setData({
              ...data,
              subscription: { ...subscription, nextShipDate: newDate },
            })
          }
        />
      )}
      {showExtras && <ExtrasOverlay onClose={() => setShowExtras(false)} />}
    </div>
  );
}

function QuickAction({
  label,
  href,
  subtitle,
  comingSoon,
  onClick,
}: {
  label: string;
  href?: string;
  subtitle?: string;
  comingSoon?: boolean;
  onClick?: () => void;
}) {
  const inner = (
    <div className="relative flex h-full flex-col justify-between rounded-2xl bg-[color:var(--color-sharp-white)] p-4">
      {comingSoon && (
        <span className="absolute right-2 top-2 rounded-sm bg-[color:var(--color-lit-grey)]/8 px-1.5 py-0.5 text-[7px] font-bold uppercase tracking-[0.18em] opacity-70">
          {subtitle ?? "Coming Soon"}
        </span>
      )}
      <div
        className={`text-xs font-bold uppercase tracking-[0.12em] ${comingSoon ? "opacity-70" : ""}`}
      >
        {label}
      </div>
      {!comingSoon && subtitle && (
        <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">{subtitle}</div>
      )}
    </div>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="block w-full text-left cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(50,55,67,0.08)]"
      >
        {inner}
      </button>
    );
  }
  if (href) {
    return (
      <Link
        href={href}
        className="block cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(50,55,67,0.08)]"
      >
        {inner}
      </Link>
    );
  }
  return <div>{inner}</div>;
}

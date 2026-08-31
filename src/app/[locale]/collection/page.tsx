"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { LoginScreen } from "@/components/LoginScreen";
import { SubSwitchPill } from "@/components/SubSwitchPill";
import { TierPill } from "@/components/TierPill";
import { api } from "@/lib/api-client";
import { T, useLang, useLangValue, usePageTitle } from "@/lib/i18n";
import { portalHref } from "@/lib/portal-link";
import type { TierResponse, TimelineEntry } from "@/lib/types";

/**
 * Collection page hi-fi — matches `designs/mobile/lit-collection-hifi/index.html`.
 *
 * Phase 1 reality: physical cards are not yet shipping (per
 * `feedback_portal_arquitectura`). `earnedCount` is derived from how many
 * shipments the customer has — until the cards.shipped webhook fires for real,
 * cards visually show as "locked" but the page layout is hi-fi-complete.
 *
 * Source-of-truth scenarios from the hi-fi: default / early / near / complete /
 * new / post-cancel. We render the same DOM structure regardless and toggle
 * locked-state per-card.
 */

interface CardDef {
  num: number;
  title: { en: string; es: string };
  caption: { en: string; es: string };
  art: string; // CSS gradient key
}

const EDITION_01: CardDef[] = [
  {
    num: 1,
    title: { en: "DAWN SHIFT", es: "TURNO DEL ALBA" },
    caption: {
      en: "Park lap before the city wakes up.",
      es: "Vuelta al parque antes de que la ciudad despierte.",
    },
    art: "dawn",
  },
  {
    num: 2,
    title: { en: "PAVEMENT", es: "ASFALTO" },
    caption: { en: "Eight miles, one bottle.", es: "Trece kilómetros, una botella." },
    art: "pavement",
  },
  {
    num: 3,
    title: { en: "LOCKER", es: "VESTIDOR" },
    caption: {
      en: "The routine you build on your worst day.",
      es: "La rutina que construyes en tu peor día.",
    },
    art: "locker",
  },
  {
    num: 4,
    title: { en: "NIGHT CROWD", es: "NOCHE" },
    caption: {
      en: "Rooftop, end of May. Everyone stayed until the sun came up.",
      es: "Azotea, fin de mayo. Todos se quedaron hasta el amanecer.",
    },
    art: "night",
  },
  {
    num: 5,
    title: { en: "TENNIS HOUR", es: "HORA DE TENIS" },
    caption: { en: "Clay, sweat, and whoever showed up.", es: "Tierra, sudor, y quien apareciera." },
    art: "tennis",
  },
  {
    num: 6,
    title: { en: "SUNSET", es: "ATARDECER" },
    caption: {
      en: "End of the ride, start of the rest.",
      es: "Fin del recorrido, inicio del descanso.",
    },
    art: "sunset",
  },
  {
    num: 7,
    title: { en: "BOXING", es: "BOXEO" },
    caption: { en: "Rooftop gym. Nothing to prove.", es: "Gym en la azotea. Nada que probar." },
    art: "boxing",
  },
  {
    num: 8,
    title: { en: "ICE BATH", es: "HIELO" },
    caption: { en: "Sixty seconds. Still not easy.", es: "Sesenta segundos. Sigue sin ser fácil." },
    art: "ice",
  },
  {
    num: 9,
    title: { en: "PIZZA NIGHT", es: "NOCHE DE PIZZA" },
    caption: {
      en: "After the miles. Before the miles.",
      es: "Después del kilómetro. Antes del kilómetro.",
    },
    art: "pizza",
  },
  {
    num: 10,
    title: { en: "TRACK DAY", es: "DÍA DE PISTA" },
    caption: { en: "The first time it felt easy.", es: "La primera vez que se sintió fácil." },
    art: "track",
  },
  {
    num: 11,
    title: { en: "CHEERS", es: "SALUD" },
    caption: {
      en: "You don't always win. But sometimes you win.",
      es: "No siempre ganas. Pero a veces ganas.",
    },
    art: "cheers",
  },
  {
    num: 12,
    title: { en: "ROOFTOP", es: "AZOTEA" },
    caption: {
      en: "Edition closes here. Next one opens on Box 13.",
      es: "La edición cierra aquí. La siguiente abre en la Caja 13.",
    },
    art: "rooftop",
  },
];

const ART_GRADIENTS: Record<string, string> = {
  dawn: "linear-gradient(180deg, #E8B473 0%, #C89B5F 45%, #4A3A2A 100%)",
  pavement: "linear-gradient(180deg, #8B7355 0%, #2a1f18 100%)",
  locker: "linear-gradient(180deg, #5a3d2a 0%, #3d2a1f 100%)",
  night: "radial-gradient(circle at 50% 30%, #5a4a7a 0%, #373554 50%, #1a1625 100%)",
  tennis: "linear-gradient(180deg, #C89B5F 0%, #8B4A3A 100%)",
  sunset:
    "linear-gradient(180deg, #EBEE62 0%, #E8B473 30%, #C05A3A 60%, #4a2a1f 100%)",
  boxing: "linear-gradient(135deg, #4a2a1f 0%, #2a1510 100%)",
  ice: "linear-gradient(180deg, #8AA8B5 0%, #2a3a4a 100%)",
  pizza: "radial-gradient(circle at 50% 50%, #E8B473 0%, #C89B5F 70%)",
  track: "linear-gradient(180deg, #8B4A3A 0%, #5a2e1a 100%)",
  cheers: "linear-gradient(180deg, #C89B5F 0%, #5a2e28 100%)",
  rooftop:
    "linear-gradient(180deg, #373554 0%, #C89B5F 70%, #8B4A3A 100%)",
};

type Scenario = "new" | "early" | "default" | "near" | "complete" | "post-cancel";

export default function CollectionPage() {
  const lang = useLangValue();
  const t = useLang();
  usePageTitle({ en: "Collection · LIT", es: "Colección · LIT" });
  const [tier, setTier] = useState<TierResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A dead session must send the customer back to login like the other
    // pages do — otherwise Collection silently showed an empty 00/12 grid as
    // if they were a brand-new customer. Non-auth errors keep degrading
    // gracefully to the empty state.
    const onAuthErr = (e: unknown) => {
      const code = (e as { code?: string }).code;
      if (code === "unauthorized" || code === "session_expired" || code === "session_invalid") {
        setError(code);
      }
    };
    api<TierResponse>("/api/tier").then(setTier).catch((e) => {
      setTier(null);
      onAuthErr(e);
    });
    api<TimelineEntry[]>("/api/timeline?limit=12")
      .then(setTimeline)
      .catch((e) => {
        setTimeline([]);
        onAuthErr(e);
      });
  }, []);

  if (error === "unauthorized" || error === "session_expired" || error === "session_invalid") {
    return <LoginScreen />;
  }

  const earnedCount = Math.min(12, timeline.length);
  const scenario: Scenario =
    earnedCount === 0
      ? "new"
      : earnedCount >= 12
        ? "complete"
        : earnedCount === 11
          ? "near"
          : earnedCount <= 1
            ? "early"
            : "default";

  return (
    <div
      className="zone-retro flex min-h-screen flex-col text-[color:var(--color-lit-grey)]"
      style={{
        background:
          "linear-gradient(180deg, var(--color-cream) 0%, var(--color-brisky-warm) 100%)",
      }}
    >
      <TopNav />

      {/* Mobile header — fixed so it NEVER hides on scroll (per Juan
          2026-05-19). */}
      <header className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between border-b border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-cream)]/90 px-6 pt-5 pb-3 backdrop-blur-md md:hidden">
        <Link
          href={portalHref(lang, "home")}
          className="text-[13px] font-medium text-[color:var(--color-lit-grey)] hover:opacity-60"
        >
          ← <T en="Subscription" es="Suscripción" />
        </Link>
        {/* min-w-0: same overflow guard as the Hub/Account headers — with the
            multi-sub pill + toggle + TierPill the row must shrink, not spill
            past the viewport on ≤390px (audit 2026-07-08). */}
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded-sm bg-[color:var(--color-lit-grey)] px-3 py-[5px] text-[9px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-bold-yellow)]">
            <T en="Collection" es="Colección" />
          </span>
          {/* Multi-sub switch, a la IZQUIERDA del toggle como en Hub/Cuenta
              (audit 2026-07-08: el pill faltaba en Colección y en el detalle
              de pedido, dejando al multi-sub móvil sin forma de cambiar). */}
          <SubSwitchPill />
          <TierPill
            visible={tier?.earned ?? false}
            tierEarnedAt={tier?.earnedAt ?? null}
          />
        </div>
      </header>

      <main className="flex-1 pt-[88px] pb-24 md:mx-auto md:w-full md:max-w-5xl md:px-8 md:pt-[92px] md:pb-12">
        <section className="px-6 pt-2 pb-5 md:px-0">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-[color:var(--color-warm-gray)]">
              <T en="Edition 01" es="Edición 01" />
            </span>
            <span className="rounded-[2px] bg-[color:var(--color-bold-yellow)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.15em] tabular-nums text-[color:var(--color-lit-grey)]">
              {String(earnedCount).padStart(2, "0")} / 12
            </span>
          </div>
          <h1 className="font-display text-[60px] font-black uppercase leading-[0.86] tracking-[-0.035em] text-[color:var(--color-lit-grey)]">
            <T en="The" es="La" />
            <br />
            <T en="Collection" es="Colección" />
          </h1>
          <div className="mt-3 h-[3px] w-11 bg-[color:var(--color-lit-grey)]" />
          <p className="mt-3 text-[12px] italic leading-[1.5] text-[color:var(--color-warm-gray)]">
            <ScenarioHero scenario={scenario} count={earnedCount} />
          </p>
          <div className="mt-5 flex h-[5px] gap-[3px]">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 rounded-[1px]"
                style={{
                  background:
                    i < earnedCount
                      ? "var(--color-bold-yellow)"
                      : i === earnedCount
                        ? "var(--color-lit-grey)"
                        : "rgba(50, 55, 67, 0.15)",
                  animation:
                    i === earnedCount
                      ? "pulse-slot 2s ease-in-out infinite"
                      : undefined,
                }}
              />
            ))}
          </div>
        </section>

        {scenario === "new" && (
          <section className="py-12 text-center">
            <h2 className="font-display text-[42px] font-black uppercase leading-[0.9] tracking-[-0.02em] text-[color:var(--color-lit-grey)]">
              {lang === "es" ? (
                <>
                  Tu primera
                  <br />
                  carta viene
                  <br />
                  en camino.
                </>
              ) : (
                <>
                  Your first
                  <br />
                  card is
                  <br />
                  on the way.
                </>
              )}
            </h2>
            <p className="mt-3.5 px-8 text-[14px] leading-[1.55] text-[color:var(--color-warm-gray)]">
              <T
                en="Every box drops one. Watch the first slot light up."
                es="Cada caja trae una. Mira cómo se enciende la primera."
              />
            </p>
          </section>
        )}

        <section className="mb-6">
          <div className="flex gap-4 overflow-x-auto px-6 pt-3 pb-7 [scroll-snap-type:x_mandatory] [scrollbar-width:none] md:px-0 [&::-webkit-scrollbar]:hidden">
            {EDITION_01.map((card, i) => {
              const isEarned = i < earnedCount;
              const isCurrent = i === earnedCount;
              return (
                <button
                  type="button"
                  key={i}
                  onClick={() => {
                    setActiveIdx(i);
                    setDetailIdx(i);
                  }}
                  className={`relative h-[372px] w-[268px] flex-shrink-0 cursor-pointer overflow-hidden rounded-[14px] shadow-[0_12px_32px_rgba(40,30,20,0.25)] transition-transform [scroll-snap-align:center] hover:-translate-y-0.5 ${isEarned ? "" : "bg-[#1a1712]"}`}
                  style={
                    isEarned ? { background: ART_GRADIENTS[card.art] } : undefined
                  }
                >
                  {!isEarned && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-8 opacity-95">
                      <div
                        className="font-display text-[66px] font-black leading-[0.9] tracking-[-0.04em]"
                        style={{ color: "rgba(235, 238, 98, 0.25)" }}
                      >
                        {String(card.num).padStart(2, "0")}
                      </div>
                      <div className="mt-2 text-[10px] font-bold uppercase tracking-[0.2em] text-[color:var(--color-cream)]/40">
                        <T
                          en={`Ships with box #${card.num}`}
                          es={`Va con la caja #${card.num}`}
                        />
                      </div>
                    </div>
                  )}
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background:
                        "linear-gradient(135deg, rgba(200, 155, 95, 0.15), rgba(139, 74, 58, 0.2))",
                      mixBlendMode: "multiply",
                    }}
                  />
                  <span className="absolute right-3.5 top-3.5 z-[3] rounded-[2px] bg-[#1a1610]/50 px-2 py-0.5 font-display text-[9px] font-bold tracking-[0.25em] text-[color:var(--color-bold-yellow)]">
                    ED 01
                  </span>
                  {isEarned && (
                    <div
                      className="absolute bottom-0 left-0 right-0 z-[2] p-4.5 text-[color:var(--color-cream)]"
                      style={{
                        background:
                          "linear-gradient(to top, rgba(26, 22, 18, 0.92) 20%, transparent)",
                      }}
                    >
                      <span className="mb-2.5 block font-display text-[11px] font-black tracking-[0.22em] text-[color:var(--color-bold-yellow)]">
                        #{String(card.num).padStart(3, "0")}
                      </span>
                      <div className="font-display text-[24px] font-black uppercase leading-[0.94] tracking-[-0.015em]">
                        {card.title[lang]}
                      </div>
                    </div>
                  )}
                  {isCurrent && (
                    <div className="absolute inset-x-0 bottom-0 z-[3] bg-[color:var(--color-bold-yellow)] py-2 text-center text-[10px] font-extrabold uppercase tracking-[0.2em] text-[color:var(--color-lit-grey)]">
                      <T en="Next box" es="Próxima caja" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mx-auto flex max-w-[280px] flex-wrap justify-center gap-[5px] px-6 pb-2">
            {EDITION_01.map((_, i) => (
              <div
                key={i}
                className="h-[6px] w-[6px] rounded-full"
                style={{
                  background:
                    i < earnedCount
                      ? "var(--color-bold-yellow)"
                      : i === activeIdx
                        ? "var(--color-lit-grey)"
                        : "rgba(50, 55, 67, 0.2)",
                  transform: i === activeIdx ? "scale(1.25)" : undefined,
                }}
              />
            ))}
          </div>
        </section>

        {/* Edition reward */}
        <section className="mx-6 mb-7 md:mx-0">
          <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.3em] text-[color:var(--color-warm-gray)]">
            <T en="Edition reward" es="Recompensa de edición" />
          </div>
          <div
            className={`relative overflow-hidden rounded-[14px] px-6 py-6 ${scenario === "complete" ? "text-[color:var(--color-lit-grey)]" : "text-[color:var(--color-cream)]"}`}
            style={{
              background:
                scenario === "complete"
                  ? "linear-gradient(135deg, var(--color-bold-yellow) 0%, #d8d754 100%)"
                  : "var(--color-dark-indigo)",
            }}
          >
            <div
              className="absolute inset-0 pointer-events-none opacity-20"
              style={{
                background:
                  "radial-gradient(circle at 90% 20%, var(--color-bold-yellow) 0%, transparent 50%)",
              }}
            />
            <div className="relative">
              <div
                className={`mb-2.5 text-[10px] font-bold uppercase tracking-[0.3em] ${scenario === "complete" ? "text-[color:var(--color-lit-grey)]" : "text-[color:var(--color-bold-yellow)]"}`}
              >
                {scenario === "complete"
                  ? t({ en: "Reward unlocked", es: "Recompensa desbloqueada" })
                  : scenario === "near"
                    ? t({ en: "Almost complete", es: "Casi completa" })
                    : t({ en: "Complete the edition", es: "Completa la edición" })}
              </div>
              <h3 className="mb-2.5 font-display text-[26px] font-black uppercase leading-[0.95] tracking-[-0.02em]">
                {/* Nombraba "Salty Peach" y prometia enterarse "antes que nadie". Salty Peach
                    sale al publico el 2026-09-02, asi que dejo de ser verdad ese mismo dia.
                    La recompensa sigue siendo la misma (acceso anticipado al proximo drop),
                    solo se le quita el sabor concreto y la promesa de secreto, para que no
                    haya que reescribirla en cada lanzamiento. */}
                <T
                  en="Early access to the next drop"
                  es="Acceso anticipado al próximo drop"
                />
              </h3>
              <p
                className={`mb-4 text-[13px] leading-[1.5] ${scenario === "complete" ? "text-[color:var(--color-lit-grey)]/80" : "text-[color:var(--color-warm-gray-lt)]"}`}
              >
                <T
                  en="Finish Edition 01 and you're first in line for the next drop."
                  es="Termina la Edición 01 y eres el primero en el próximo drop."
                />
              </p>
              <div
                className={`flex items-center gap-3 border-t border-dashed pt-3.5 ${scenario === "complete" ? "border-[color:var(--color-lit-grey)]/30" : "border-[color:var(--color-bold-yellow)]/30"}`}
              >
                <div
                  className={`font-display text-[22px] font-black ${scenario === "complete" ? "text-[color:var(--color-lit-grey)]" : "text-[color:var(--color-bold-yellow)]"}`}
                >
                  {scenario === "complete" ? "✓" : 12 - earnedCount}
                </div>
                <div
                  className={`flex-1 text-[11px] ${scenario === "complete" ? "text-[color:var(--color-lit-grey)]/75" : "text-[color:var(--color-warm-gray-lt)]"}`}
                >
                  {scenario === "complete" ? (
                    <T en="reward unlocked" es="recompensa desbloqueada" />
                  ) : 12 - earnedCount === 1 ? (
                    <T en="card to go" es="carta te falta" />
                  ) : (
                    <T en="cards to go" es="cartas te faltan" />
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 12 cards grid */}
        <section className="mx-6 mb-6 md:mx-0">
          <h3 className="font-display text-[22px] font-black uppercase leading-[0.9] tracking-[-0.02em] text-[color:var(--color-lit-grey)]">
            {lang === "es" ? (
              <>
                Las 12
                <br />
                de esta edición
              </>
            ) : (
              <>
                All 12
                <br />
                this edition
              </>
            )}
          </h3>
          <div className="mt-2 mb-4 h-[3px] w-10 bg-[color:var(--color-lit-grey)]" />
          <div className="grid grid-cols-3 gap-2">
            {EDITION_01.map((card, i) => {
              const isEarned = i < earnedCount;
              return (
                <button
                  type="button"
                  key={i}
                  onClick={() => setDetailIdx(i)}
                  className={`relative aspect-[3/4] overflow-hidden rounded-md transition-transform hover:scale-[1.03] ${isEarned ? "" : "bg-[#1a1712]"}`}
                  style={
                    isEarned ? { background: ART_GRADIENTS[card.art] } : undefined
                  }
                >
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background:
                        "linear-gradient(135deg, rgba(200, 155, 95, 0.12), rgba(139, 74, 58, 0.15))",
                      mixBlendMode: "multiply",
                    }}
                  />
                  <span className="absolute right-2 top-1.5 font-display text-[9px] font-black tracking-[0.15em] text-[color:var(--color-bold-yellow)] [text-shadow:0_1px_2px_rgba(0,0,0,0.5)]">
                    #{String(card.num).padStart(3, "0")}
                  </span>
                  {!isEarned && (
                    <div
                      className="absolute inset-0 flex items-center justify-center font-display text-[18px] font-black"
                      style={{ color: "rgba(235, 238, 98, 0.35)" }}
                    >
                      {String(card.num).padStart(2, "0")}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      </main>

      <BottomNav />

      {detailIdx !== null && (
        <CardDetailModal
          card={EDITION_01[detailIdx]!}
          earned={detailIdx < earnedCount}
          onClose={() => setDetailIdx(null)}
        />
      )}
    </div>
  );
}

function ScenarioHero({
  scenario,
  count,
}: {
  scenario: Scenario;
  count: number;
}) {
  if (scenario === "new") {
    return (
      <T
        en="Your first card ships with your first box."
        es="Tu primera carta va con tu primera caja."
      />
    );
  }
  if (scenario === "early") {
    return (
      <T
        en={`First card in. ${12 - count} to go.`}
        es={`Primera carta dentro. Faltan ${12 - count}.`}
      />
    );
  }
  if (scenario === "near") {
    return (
      <T en="One more. The last one's coming." es="Una más. La última está por llegar." />
    );
  }
  if (scenario === "complete") {
    return <T en="All 12. Edition closed." es="Las 12. Edición cerrada." />;
  }
  if (scenario === "post-cancel") {
    return (
      <T
        en="Held 87 days. Collection paused."
        es="Guardados 87 días. Colección en pausa."
      />
    );
  }
  return (
    <T
      en="One card every box. Keep stacking."
      es="Una carta por cada caja. Sigue acumulando."
    />
  );
}

function CardDetailModal({
  card,
  earned,
  onClose,
}: {
  card: CardDef;
  earned: boolean;
  onClose: () => void;
}) {
  const lang = useLangValue();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(26,22,18,0.85)] p-5"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-[320px] overflow-hidden rounded-2xl bg-[color:var(--color-lit-grey)] shadow-[0_32px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "pop-in 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3.5 top-3.5 z-[5] flex h-8 w-8 items-center justify-center rounded-full bg-[#1a1610]/70 text-[16px] text-[color:var(--color-cream)]"
        >
          ×
        </button>
        <div
          className="aspect-[3/4] w-full"
          style={
            earned
              ? { background: ART_GRADIENTS[card.art] }
              : { background: "#1a1510" }
          }
        >
          {!earned && (
            <div
              className="flex h-full w-full items-center justify-center font-display text-[96px] font-black"
              style={{ color: "rgba(235, 238, 98, 0.25)" }}
            >
              {String(card.num).padStart(2, "0")}
            </div>
          )}
        </div>
        <div className="px-5 pb-6 pt-5 text-[color:var(--color-cream)]">
          <span className="block font-display text-[12px] font-black tracking-[0.25em] text-[color:var(--color-bold-yellow)]">
            #{String(card.num).padStart(3, "0")}
          </span>
          <h2 className="mt-3.5 font-display text-[34px] font-black uppercase leading-[0.92] tracking-[-0.02em]">
            {card.title[lang]}
          </h2>
          <p className="mt-2.5 text-[13px] italic leading-[1.55] text-[color:var(--color-cream)]/80">
            {earned ? (
              card.caption[lang]
            ) : (
              <T
                en={`Ships with box #${card.num}.`}
                es={`Va con la caja #${card.num}.`}
              />
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

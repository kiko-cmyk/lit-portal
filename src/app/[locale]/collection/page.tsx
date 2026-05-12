"use client";

import Link from "next/link";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { TierPill } from "@/components/TierPill";
import { T, useLang, useLangValue } from "@/lib/i18n";
import { portalHref } from "@/lib/portal-link";

/**
 * Collection page — Phase 1 BLURRED state.
 *
 * Per locked decision 2026-05-06: Collection visible but not interactive.
 * Physical cards not yet shipping → all 12 cards rendered as locked
 * (zesty-beige bg + faded number, opacity 0.18 per design).
 *
 * When physical cards launch (Phase 2), this page wires to /api/collection/*.
 */

const EDITION_NAME = "Edition 01";
const EDITION_LABEL_EN = "Edition 01 · 2026";
const EDITION_LABEL_ES = "Edición 01 · 2026";

export default function CollectionPage() {
  const t = useLang();
  const lang = useLangValue();

  return (
    <div
      className="zone-retro flex min-h-full flex-col"
      style={{
        background: "linear-gradient(180deg, #E2C9A0 0%, #D9B788 100%)",
        color: "#3A2F22",
      }}
    >
      <TopNav />
      <header className="flex items-center justify-between px-6 pt-5 pb-3 md:hidden">
        <Link
          href={portalHref(lang, "home")}
          className="text-xs font-bold uppercase tracking-[0.2em] opacity-70 cursor-pointer hover:opacity-100"
        >
          ← <T en="Your LIT" es="Tu LIT" />
        </Link>
        <span className="rounded-sm bg-[color:var(--color-lit-grey)]/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em]">
          <T en="Collection" es="Colección" />
        </span>
        <TierPill visible={false} />
      </header>

      <main className="flex-1 pb-24 md:mx-auto md:w-full md:max-w-3xl md:pb-12">
        <section className="px-6 pt-2 pb-6">
          <h1 className="font-display text-6xl font-black uppercase leading-[0.85] tracking-tight">
            <T en="The" es="La" />
            <br />
            <T en="Collection" es="Colección" />
            <span className="text-[color:var(--color-bold-yellow)]">.</span>
          </h1>
          <div className="mt-3 h-[3px] w-11 bg-[color:var(--color-bold-yellow)]" />
          <div className="mt-4 text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
            {t({ en: EDITION_LABEL_EN, es: EDITION_LABEL_ES })}
          </div>
        </section>

        {/* Coming soon banner */}
        <section className="mx-6 mb-6 rounded-2xl bg-[color:var(--color-sharp-white)] p-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
            <T en="Coming soon" es="Pronto" />
          </div>
          <h2 className="mt-1 font-display text-2xl font-black uppercase">
            <T
              en="12 cards. One per box."
              es="12 cartas. Una por caja."
            />
          </h2>
          <p className="mt-2 text-xs opacity-70">
            <T
              en="Each box you receive includes a collectible card. Earn the full set to unlock early access to new flavors."
              es="Cada caja que recibes incluye una carta coleccionable. Consigue el set completo para desbloquear acceso anticipado a nuevos sabores."
            />
          </p>
        </section>

        {/* Progress strip — 12 slots, all empty (Phase 1) */}
        <section className="mx-6 mb-6">
          <div className="mb-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
            <span>
              <T en="Progress" es="Progreso" />
            </span>
            <span>0 / 12</span>
          </div>
          <div className="grid grid-cols-12 gap-1">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="h-2 rounded-sm bg-[color:var(--color-lit-grey)]/10"
              />
            ))}
          </div>
        </section>

        {/* 12 cards grid — all locked */}
        <section className="mx-6">
          <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
            {EDITION_NAME}
          </div>
          <div className="grid grid-cols-3 gap-3 md:grid-cols-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <LockedCard key={i} number={i + 1} />
            ))}
          </div>
        </section>

        {/* Edition reward placeholder */}
        <section className="mx-6 mt-8 rounded-2xl border border-dashed border-[color:var(--color-lit-grey)]/20 p-5 text-center">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
            <T en="Edition reward" es="Recompensa de edición" />
          </div>
          <div className="mt-1 font-display text-xl font-black uppercase">
            <T
              en="Complete Edition 01 → Early access to Salty Peach"
              es="Completa la Edición 01 → Acceso anticipado a Salty Peach"
            />
          </div>
        </section>
      </main>

      <BottomNav />
    </div>
  );
}

/**
 * Locked card placeholder — beige background + large semi-transparent number.
 * Used until physical cards launch (Phase 2).
 */
function LockedCard({ number }: { number: number }) {
  return (
    <div className="relative aspect-[5/7] overflow-hidden rounded-xl bg-[color:var(--color-zesty-beige)]">
      <div
        className="absolute inset-0 flex items-center justify-center font-display text-[64px] font-black"
        style={{ color: "rgba(50, 55, 67, 0.18)" }}
      >
        {String(number).padStart(2, "0")}
      </div>
      <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 text-center text-[8px] font-bold uppercase tracking-[0.2em] opacity-50">
        Locked
      </div>
    </div>
  );
}

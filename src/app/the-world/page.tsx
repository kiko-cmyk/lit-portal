"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BottomNav } from "@/components/BottomNav";
import { TierPill } from "@/components/TierPill";
import { api, ApiClientError } from "@/lib/api-client";
import type { EventsResponse, MomentItem, StoryItem, TierResponse } from "@/lib/types";

type Tab = "events" | "moments" | "stories";

export default function TheWorldPage() {
  const [tab, setTab] = useState<Tab>("events");
  const [city, setCity] = useState<"madrid" | "barcelona">("madrid");
  const [events, setEvents] = useState<EventsResponse | null>(null);
  const [moments, setMoments] = useState<MomentItem[] | null>(null);
  const [stories, setStories] = useState<StoryItem[] | null>(null);
  const [tier, setTier] = useState<TierResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<TierResponse>("/api/tier").then(setTier).catch(() => null);
  }, []);

  useEffect(() => {
    api<EventsResponse>(`/api/events?city=${city}`)
      .then(setEvents)
      .catch((e: ApiClientError) => setError(e.code));
  }, [city]);

  useEffect(() => {
    if (tab === "moments" && !moments) {
      api<MomentItem[]>("/api/moments?limit=10").then(setMoments).catch(() => setMoments([]));
    }
    if (tab === "stories" && !stories) {
      api<StoryItem[]>("/api/stories?limit=3").then(setStories).catch(() => setStories([]));
    }
  }, [tab, moments, stories]);

  return (
    <div
      className="zone-indigo flex min-h-full flex-col"
      style={{ background: "#0F0E1A", color: "#E9EBDE" }}
    >
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 pt-5 pb-3">
        <Link href="/your-lit" className="text-xs font-bold uppercase tracking-[0.2em] opacity-70">
          ← Your LIT
        </Link>
        <span className="rounded-sm bg-[color:var(--color-brisky-cream)]/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em]">
          The World
        </span>
        <TierPill visible={tier?.earned ?? false} />
      </header>

      {/* Hero title */}
      <div className="px-6 pt-2 pb-6">
        <h1 className="font-display text-7xl font-black uppercase leading-[0.82] tracking-tight">
          The<br />World
          <span className="text-[color:var(--color-bold-yellow)]">.</span>
        </h1>
        <div className="mt-3 h-[3px] w-11 bg-[color:var(--color-bold-yellow)]" />
      </div>

      {/* City chips */}
      <div className="flex gap-2 overflow-x-auto px-6 pb-4 [scrollbar-width:none]">
        <CityChip active={city === "madrid"} onClick={() => setCity("madrid")} label="Madrid" />
        <CityChip
          active={city === "barcelona"}
          onClick={() => setCity("barcelona")}
          label="Barcelona"
        />
        <span className="rounded-full border border-[color:var(--color-brisky-cream)]/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] opacity-50">
          Coming
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-6 pb-2">
        <TabButton active={tab === "events"} onClick={() => setTab("events")}>
          Events
        </TabButton>
        <TabButton active={tab === "moments"} onClick={() => setTab("moments")}>
          Moments
        </TabButton>
        <TabButton active={tab === "stories"} onClick={() => setTab("stories")}>
          Stories
        </TabButton>
      </div>

      <main className="flex-1 pb-24">
        {tab === "events" && (
          <EventsView events={events} error={error} city={city} />
        )}
        {tab === "moments" && <MomentsGrid items={moments} />}
        {tab === "stories" && <StoriesView items={stories} />}
      </main>

      <BottomNav />
    </div>
  );
}

function CityChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] ${
        active
          ? "bg-[color:var(--color-bold-yellow)] text-[color:var(--color-lit-grey)]"
          : "border border-[color:var(--color-brisky-cream)]/20 text-[color:var(--color-brisky-cream)]/70"
      }`}
    >
      {label}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 py-2 text-[11px] font-bold uppercase tracking-[0.2em] ${
        active
          ? "border-b-2 border-[color:var(--color-bold-yellow)] text-[color:var(--color-brisky-cream)]"
          : "border-b-2 border-transparent text-[color:var(--color-brisky-cream)]/40"
      }`}
    >
      {children}
    </button>
  );
}

function EventsView({
  events,
  error,
  city,
}: {
  events: EventsResponse | null;
  error: string | null;
  city: "madrid" | "barcelona";
}) {
  if (city === "barcelona") {
    return (
      <div className="mx-6 mt-6 rounded-2xl bg-[color:var(--color-darker-indigo)] p-6">
        <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
          Barcelona
        </div>
        <div className="mt-1 font-display text-2xl font-black uppercase">Hold my spot</div>
        <p className="mt-2 text-sm opacity-70">
          Drop your email and we&apos;ll tell you when the first Barcelona event lands.
        </p>
      </div>
    );
  }
  if (error) return <p className="px-6 text-xs">Error: {error}</p>;
  if (!events) return <p className="px-6 text-xs opacity-50">Loading events…</p>;
  if (!events.heroEvent && events.upcoming.length === 0) {
    return <p className="px-6 mt-6 text-sm opacity-60">No upcoming events in this city.</p>;
  }

  return (
    <>
      {events.heroEvent && <EventHero event={events.heroEvent} />}
      <ul className="mx-6 space-y-2 mt-3">
        {events.upcoming.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
      </ul>
    </>
  );
}

function EventHero({ event }: { event: EventsResponse["heroEvent"] }) {
  if (!event) return null;
  const d = new Date(event.datetime);
  return (
    <article className="mx-6 mb-3 overflow-hidden rounded-2xl bg-[color:var(--color-darker-indigo)] shadow-2xl">
      <div className="relative h-64 w-full bg-gradient-to-b from-[color:var(--color-dark-indigo)] to-[#0F0E1A]" />
      <div className="px-6 py-5">
        <div className="mb-3 flex items-center gap-3">
          <div className="rounded-sm bg-[color:var(--color-bold-yellow)] px-2.5 py-1 text-center font-display text-[11px] font-black uppercase tracking-[0.1em] text-[color:var(--color-lit-grey)]">
            <div>{d.getDate()}</div>
            <div>{d.toLocaleDateString("en", { month: "short" }).toUpperCase()}</div>
          </div>
        </div>
        <h2 className="font-display text-3xl font-black uppercase leading-tight">{event.title}</h2>
        <p className="mt-2 text-xs opacity-70">{event.description}</p>
        <div className="mt-4 flex gap-2">
          {event.ticketUrl && (
            <a
              href={event.ticketUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm bg-[color:var(--color-bold-yellow)] px-5 py-3 text-[11px] font-black uppercase tracking-[0.15em] text-[color:var(--color-lit-grey)]"
            >
              Get tickets
            </a>
          )}
          <SaveButton eventId={event.id} initial={event.saved} />
        </div>
      </div>
    </article>
  );
}

function EventRow({ event }: { event: EventsResponse["upcoming"][number] }) {
  return (
    <li className="flex items-center justify-between rounded-2xl bg-[color:var(--color-darker-indigo)]/60 px-4 py-4">
      <div>
        <div className="font-display text-sm font-black uppercase tracking-tight">{event.title}</div>
        <div className="text-[10px] uppercase tracking-[0.12em] opacity-60">{event.description}</div>
      </div>
      <SaveButton eventId={event.id} initial={event.saved} compact />
    </li>
  );
}

function SaveButton({
  eventId,
  initial,
  compact,
}: {
  eventId: string;
  initial: boolean;
  compact?: boolean;
}) {
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ saved: boolean }>(`/api/events/${eventId}/save`, { method: "POST" });
          setSaved(r.saved);
        } finally {
          setBusy(false);
        }
      }}
      className={`${compact ? "text-2xl" : "rounded-sm border border-[color:var(--color-brisky-cream)]/20 px-4 py-3 text-[11px] font-bold uppercase tracking-[0.15em]"} ${
        saved ? "text-[color:var(--color-bold-yellow)]" : "opacity-60"
      }`}
    >
      {compact ? (saved ? "★" : "☆") : saved ? "Saved" : "Save"}
    </button>
  );
}

function MomentsGrid({ items }: { items: MomentItem[] | null }) {
  if (!items) return <p className="px-6 text-xs opacity-50">Loading…</p>;
  if (items.length === 0) return <p className="px-6 mt-6 text-sm opacity-60">No moments yet.</p>;
  return (
    <div className="mx-6 mt-3 grid grid-cols-2 gap-2">
      {items.map((m) => (
        <div key={m.id} className="aspect-[3/4] overflow-hidden rounded-xl bg-[color:var(--color-darker-indigo)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={m.imageUrl} alt={m.caption} className="h-full w-full object-cover" />
        </div>
      ))}
    </div>
  );
}

function StoriesView({ items }: { items: StoryItem[] | null }) {
  if (!items) return <p className="px-6 text-xs opacity-50">Loading…</p>;
  if (items.length === 0) return <p className="px-6 mt-6 text-sm opacity-60">No stories yet.</p>;
  return (
    <ul className="mx-6 space-y-3 mt-3">
      {items.map((s) => (
        <li key={s.id} className="rounded-2xl bg-[color:var(--color-darker-indigo)] p-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
            {s.type}
          </div>
          <div className="mt-1 font-display text-xl font-black uppercase">{s.title}</div>
          {s.excerpt && <p className="mt-2 text-xs opacity-70">{s.excerpt}</p>}
        </li>
      ))}
    </ul>
  );
}

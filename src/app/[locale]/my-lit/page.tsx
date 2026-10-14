"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TopNav } from "@/components/BottomNav";
import { MobileHeader } from "@/components/MobileHeader";
import { CollectionMiniGrid } from "@/components/CollectionMiniGrid";
import { DeliveryCalendar } from "@/components/DeliveryCalendar";
import { LoginScreen } from "@/components/LoginScreen";
import { BrandBand, CardTitle, Lp2Card } from "@/components/Lp2";
import { Lp2Loader } from "@/components/Lp2Loader";
import { NextBoxHero, type NextBoxHeroVariant } from "@/components/NextBoxHero";
import {
  DateChange,
  QAIcons,
  QuickActionButton,
} from "@/components/QuickActionButton";
import { ReactivateCard } from "@/components/ReactivateCard";
import { ReferralCard } from "@/components/ReferralCard";
import { SectionDivider } from "@/components/SectionDivider";
import { TierPill } from "@/components/TierPill";

// Overlays are modal-only (rendered behind a click), so we code-split them out
// of the Hub's initial bundle — they download on first open instead of slowing
// every Hub load. (2026-06-10 frontend perf pass)
const PlanOverlay = dynamic(() => import("@/components/PlanOverlay").then((m) => m.PlanOverlay));
const FlavorOverlay = dynamic(() => import("@/components/FlavorOverlay").then((m) => m.FlavorOverlay));
const SkipOverlay = dynamic(() => import("@/components/SkipOverlay").then((m) => m.SkipOverlay));
const ChargeNowOverlay = dynamic(() => import("@/components/ChargeNowOverlay").then((m) => m.ChargeNowOverlay));
const CancelTakeover = dynamic(() => import("@/components/CancelTakeover").then((m) => m.CancelTakeover));
const ProfileSurveyOverlay = dynamic(() => import("@/components/ProfileSurveyOverlay").then((m) => m.ProfileSurveyOverlay));
import { api, ApiClientError } from "@/lib/api-client";
import { T, useLang, useLangValue, usePageTitle } from "@/lib/i18n";
import { clearJustSkipped, readJustSkipped, writeJustSkipped } from "@/lib/just-skipped";
import { portalHref, COLLECTION_ENABLED } from "@/lib/portal-link";
import { SUBSCRIBE_URL } from "@/lib/storefront-links";
import { FREQUENCIES } from "@/lib/plan-options";
import { flavorVisual } from "@/lib/flavor-visuals";
import { frequencyLabel } from "@/lib/frequency-label";
import type {
  CustomerProfile,
  Frequency,
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
// Tras reactivar o reanudar, Seal tarda 27-170 s en regenerar el calendario (medido
// el 14-oct) y después el portal aún trae a mañana el cobro de quien volvió tras un
// impago. El Hub sigue preguntando mientras el panel diga que hay algo pendiente.
const POST_REACTIVATE_RESYNC_MS = 240_000;

export default function HubPage() {
  const [data, setData] = useState<HubDashboard | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [showFlavor, setShowFlavor] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const [showSurvey, setShowSurvey] = useState(false);
  const [pendingSurvey, setPendingSurvey] = useState(false);
  const [planInitialFrequency, setPlanInitialFrequency] = useState<Frequency | undefined>();
  const [showChargeNow, setShowChargeNow] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  // Inline error for the Reactivate button. Kept out of `error` on purpose:
  // that one replaces the WHOLE Hub with the full-page error state, which for
  // a transient reactivation failure destroyed the ReactivateCard the customer
  // needs to retry. (audit 2026-07-08)
  const [reactivateError, setReactivateError] = useState<string | null>(null);
  const [justSkipped, setJustSkipped] = useState<boolean>(
    () => readJustSkipped() !== null,
  );
  const [syncingUntil, setSyncingUntil] = useState<number | null>(null);
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const t = useLang();
  const lang = useLangValue();
  usePageTitle({ en: "Subscription", es: "Suscripción" }); // browser tab title

  // Deep-link desde el email de recordatorio de renovación
  // (litsalt.com/apps/portal/es/mi-lit?action=skip): abre el overlay de Skip
  // automáticamente al montar el Hub. Evita una página /skip dedicada y reutiliza
  // el SkipOverlay existente. Si el cliente llega deslogueado, LoginScreen preserva
  // pathname+search, así que el `?action=skip` sobrevive al OAuth.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    if (action === "skip") setShowSkip(true);
    // El email de la campaña apunta aquí. Igual que `skip`, sobrevive al OAuth
    // porque LoginScreen preserva pathname+search. A diferencia de los overlays
    // de mutación, este NO se gatea con `!isPaused`: de un cliente pausado es
    // justo de quien más interesa aprender, y contestar no toca su suscripción.
    //
    // NO se abre aquí, se DEJA PENDIENTE. Este efecto corre al montar, cuando
    // `data` todavía no ha llegado, así que aquí no se puede saber si el
    // formulario está abierto para este cliente. Abrirlo ya y comprobarlo
    // después sería enseñar un formulario que el servidor va a rechazar con un
    // 403 al enviar, después de nueve preguntas.
    //
    // Y se limpia el parámetro de la URL en el mismo gesto (patrón de
    // `account/page.tsx` con `?email_changed=1`): si se queda, recargar o
    // volver desde el historial reabre el formulario una y otra vez, y el
    // enlace del email de la campaña vive en el historial de todo el que lo
    // pulse. El `?action=skip` de arriba tiene el mismo hueco, pero es del
    // flujo de recordatorio de renovación y no lo toco desde aquí.
    if (action === "survey") {
      setPendingSurvey(true);
      params.delete("action");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
      );
    }
    // Salida secundaria de la propuesta de cadencia ("prefiero verlo yo"), y de
    // paso sirve para un email de seguimiento. La cadencia se valida contra la
    // lista canónica: un `?frequency=` inventado se ignora y el overlay abre con
    // la del cliente, nunca con un valor que Seal no vende.
    if (action === "plan") {
      const f = params.get("frequency");
      if (f && FREQUENCIES.some((x) => x.value === f)) setPlanInitialFrequency(f as Frequency);
      setShowPlan(true);
    }
  }, []);

  useEffect(() => {
    api<CustomerProfile>("/api/customer")
      .then(setCustomer)
      .catch(() => setCustomer(null));
    api<HubDashboard>(
      "/api/hub/dashboard",
    )
      .then((fresh) => {
        setData(fresh);
        // Cold-load arrived with no scheduled date → kick off the silent
        // re-poll just like after a plan change. Covers the case where the
        // customer comes back to the Hub while Seal is still rebuilding.
        if (
          fresh.subscription &&
          !fresh.subscription.nextShipDate &&
          fresh.subscription.status !== "post_cancel" &&
          fresh.subscription.status !== "expired" &&
          // A paused sub has no scheduled charge by definition — polling for one
          // would spin the "updating your calendar" banner for 60 s and then
          // give up, on a screen whose only job is to offer the resume button.
          fresh.subscription.status !== "paused"
        ) {
          setSyncingUntil(Date.now() + POST_PLAN_RESYNC_MS);
        }
      })
      .catch((e: ApiClientError) => setError(e.code));
    api<TimelineEntry[]>("/api/timeline?limit=4")
      .then(setTimeline)
      .catch(() => setTimeline([]));
  }, []);

  // Silent re-poll loop after a plan change. Stops once the dashboard reports
  // the re-anchor is no longer pending (Seal finished regenerating AND the
  // cadence was re-anchored to the preserved date), or after the window closes.
  // We DON'T stop on the first non-null date: the PATCH returns an optimistic
  // date right away, but the real schedule is still settling — stopping early
  // would hide the banner before the cadence is correct.
  useEffect(() => {
    if (syncingUntil === null) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const fresh = await api<HubDashboard>("/api/hub/dashboard");
        if (cancelled) return;
        setData(fresh);
        if (fresh.reanchorPending !== true) {
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
    if (reactivating) return; // guard against a double-tap firing two POSTs
    setReactivating(true);
    setReactivateError(null);
    try {
      await api("/api/subscription/reactivate", { method: "POST" });
      // Refetch dashboard so the Hub flips out of post-cancel mode.
      const fresh = await api<HubDashboard>("/api/hub/dashboard");
      setData(fresh);
      // El calendario lo regenera Seal después (y con un impago, el portal lo trae
      // a mañana): «actualizando tu calendario» hasta que el panel lo dé por hecho.
      setSyncingUntil(Date.now() + POST_REACTIVATE_RESYNC_MS);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "reactivation_window_expired" || code === "second_cancel_no_reactivation") {
        // `lit-subscription` no existe en el catálogo y llevaba dando 404
        // (comprobado contra el sitemap 2026-09-22: los handles vivos son
        // lit-daily-hydration y lit-daily-hydration-compra-unica). Es la salida
        // de quien YA no puede reactivar, así que el 404 caía justo sobre quien
        // quería volver y no tenía otra puerta.
        window.location.href = SUBSCRIBE_URL;
        return;
      }
      console.error("[hub] reactivate failed", e);
      // Show the failure inline in the ReactivateCard (friendly copy, not the
      // raw code) and keep the Hub + button rendered so the customer can retry.
      setReactivateError(
        code === "rate_limited"
          ? t({
              en: "Too many tries. Wait a minute and try again.",
              es: "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
            })
          : code === "gateway_timeout"
            ? t({
                en: "The service is taking longer than usual. Try again in a moment.",
                es: "El servicio está tardando más de lo normal. Inténtalo de nuevo en un momento.",
              })
            : t({
                en: "Couldn't reactivate. Try again or contact us.",
                es: "No se pudo reactivar. Inténtalo de nuevo o escríbenos.",
              }),
      );
    } finally {
      setReactivating(false);
    }
  };

  /**
   * Resume a PAUSED subscription. Separate endpoint from reactivate: a pause
   * never entered the cancel accounting, so there's no 90-day window and no
   * Drops snapshot to restore, and /reactivate would 400 with `no_cancellation`.
   *
   * Shares the `reactivating` / `reactivateError` state with handleReactivate —
   * same card, same in-flight and inline-failure semantics.
   */
  const handleResume = async () => {
    if (reactivating) return; // guard against a double-tap firing two POSTs
    setReactivating(true);
    setReactivateError(null);
    try {
      // Name the sub explicitly. The route falls back to "the customer's first
      // paused sub" when no id arrives, and 18 of the 86 paused subs belong to a
      // customer with more than one, so an id-less POST could resume, and start
      // charging, a subscription other than the one on screen.
      await api("/api/subscription/resume", {
        method: "POST",
        body: JSON.stringify({ sealSubscriptionId: sub.sealSubscriptionId }),
      });
      const fresh = await api<HubDashboard>("/api/hub/dashboard");
      setData(fresh);
      // Seal regenerates billing_attempts asynchronously after a resume, so the
      // next-ship date can still be missing here. Kick off the same silent
      // re-poll a plan change uses instead of showing a blank hero.
      // Desde el 14-oct siempre: el aviso de confirmación también espera a ese
      // calendario, y el panel dice «pendiente» hasta que sale.
      // Same tolerated impurity as the dropsHeldDays computation below: this
      // runs inside an event handler, not during render, and the value is a
      // wall-clock deadline for the poll loop.
      // eslint-disable-next-line react-hooks/purity
      setSyncingUntil(Date.now() + POST_REACTIVATE_RESYNC_MS);
    } catch (e) {
      const code = (e as { code?: string }).code;
      console.error("[hub] resume failed", e);
      setReactivateError(
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
                en: "Couldn't resume. Try again or contact us.",
                es: "No se pudo reanudar. Inténtalo de nuevo o escríbenos.",
              }),
      );
    } finally {
      setReactivating(false);
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
    // Always show the syncing banner immediately after a plan change — no
    // refresh needed. Seal ALWAYS regenerates billing_attempts on a frequency
    // change and the webhook re-anchors the cadence asynchronously (~1-2 min),
    // so even though the PATCH returns an optimistic date, the real schedule is
    // still settling. Keep the banner up for the resync window so the customer
    // sees "updating" the moment they save. (Date.now is impure but this is an
    // event-handler callback, not render — ESLint over-flags here.)
    // eslint-disable-next-line react-hooks/purity
    setSyncingUntil(Date.now() + POST_PLAN_RESYNC_MS);
  };

  // A flavor swap changes the product/variant (and, since it removes+re-adds the
  // Seal line, the mainItemId) but NOT the ship date — so no syncing banner. We
  // apply the returned sub optimistically, then refetch the dashboard once to
  // reconcile the fresh mainItemId/variant (the unverified fallback response can
  // carry the pre-swap item id, which a later action would reject).
  const handleFlavorUpdated = (updated: Subscription) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            subscription: {
              ...prev.subscription,
              flavor: updated.flavor,
              currentVariantId: updated.currentVariantId,
              mainItemId: updated.mainItemId || prev.subscription.mainItemId,
            },
          }
        : prev,
    );
    // Retry once: the reconcile fixes a stale mainItemId from the unverified
    // fallback response, so we don't want a single transient failure to leave it
    // stale (the next action would 403 until reload).
    const reconcile = (attempt = 0) => {
      api<HubDashboard>("/api/hub/dashboard")
        .then(setData)
        .catch(() => {
          if (attempt < 1) setTimeout(() => reconcile(attempt + 1), 1500);
        });
    };
    reconcile();
  };

  const markSkipped = (next: boolean) => {
    setJustSkipped(next);
    if (next) {
      writeJustSkipped();
    } else {
      clearJustSkipped();
    }
  };

  // Actually revert the skip in Seal (not just hide the banner). Before this,
  // "Undo" only cleared the local flag, so the customer thought they'd
  // recovered the box but Seal kept it skipped. (2026-06-10)
  const handleUndoSkip = async () => {
    try {
      await api("/api/subscription/skip/undo", { method: "POST" });
      markSkipped(false);
      const fresh = await api<HubDashboard>("/api/hub/dashboard");
      setData(fresh);
    } catch (e) {
      // Leave the banner up so the customer can retry; nothing destructive.
      console.error("[hub] undo skip failed", e);
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
  // Paused (2026-07-28). Until today this state was unreachable here: the
  // dashboard 404'd on a PAUSED sub and the customer got the "buy a
  // subscription" empty state. Rendered as its own card with resume copy.
  const isPaused = sub.status === "paused";
  const isNew = sub.nextBoxNumber === 1 && timeline.length === 0;
  // Whenever the sub exists but Seal hasn't reattached a next ship date —
  // either right after a plan change or on cold reloads while Seal rebuilds —
  // show the syncing banner so the customer never sees a blank date hero.
  const showSyncingBanner =
    syncingUntil !== null || (!isPostCancel && !isPaused && !nextShipDate);

  const variant: NextBoxHeroVariant = justSkipped
    ? "skipped"
    : sub.withinCutoff
      ? "locked"
      : isNew
        ? "new"
        : "default";

  const collectionEarned = Math.min(4, Math.floor(timeline.length));

  // «20 ene» de la próxima y de la siguiente: las tarjetas de «Gestiona tu plan»
  // enseñan con ellas qué cambia al adelantar o al saltar.
  const shortDate = (d: Date) =>
    `${d.getDate()} ${d.toLocaleDateString(lang === "es" ? "es-ES" : "en-US", { month: "short" }).replace(".", "")}`;
  const nextLabel = nextShipDate ? shortDate(nextShipDate) : null;
  const followingLabel = data.upcomingShipments[0]?.date
    ? shortDate(new Date(data.upcomingShipments[0].date))
    : null;
  const boxesLabel = `${sub.boxCount} ${
    sub.boxCount === 1 ? t({ en: "box", es: "caja" }) : t({ en: "boxes", es: "cajas" })
  }`;

  // Days left of the 90-day drops hold (post-cancel only; null when there is
  // no hold). Display-only, re-derived on every render/refetch — sub-render
  // precision is irrelevant here, hence the tolerated impurity.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const dropsHeldDays = drops.dropsReleaseAt
    ? Math.max(
        0,
        Math.ceil((new Date(drops.dropsReleaseAt).getTime() - nowMs) / 86_400_000),
      )
    : null;

  return (
    <div className="zone-lp2 mesh-bg flex min-h-screen flex-col overflow-x-clip bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />

      {/* Cabecera móvil (Juan 2026-10-14): menú, logo e iniciales, como la de
          litsalt.com. Fija: nunca se esconde al hacer scroll (Juan 2026-05-19). */}
      <MobileHeader name={customer?.name} extra={<TierPill visible={drops.tierEarned} tierEarnedAt={drops.tierEarnedAt ?? null} />} />

      {/* Abajo, 48 px bajo la banda, el mismo hueco que entre los referidos y
          la banda (Juan 2026-10-13), más la zona de la barra de inicio del
          iPhone. Ya no hay barra fija abajo (Juan 2026-10-14). */}
      <main className="flex flex-1 flex-col gap-4 pt-[calc(88px+var(--safe-top))] pb-[calc(48px+var(--safe-bottom))] md:mx-auto md:w-full md:max-w-[1440px] md:gap-6 md:px-8 md:pt-[100px] md:pb-12">
        {showSyncingBanner && <SyncingBanner />}
        {isPaused ? (
          <ReactivateCard
            variant="paused"
            onReactivate={handleResume}
            busy={reactivating}
            error={reactivateError}
          />
        ) : isPostCancel ? (
          <ReactivateCard
            variant={data.reactivationKind === "unpaid" ? "unpaid" : "cancelled"}
            dropsHeld={drops.balance}
            dropsHeldDays={dropsHeldDays ?? undefined}
            cardsKept={collectionEarned}
            onReactivate={handleReactivate}
            busy={reactivating}
            error={reactivateError}
          />
        ) : (
          <>
            <NextBoxHero
              shipDate={nextShipDate}
              flavor={sub.flavor}
              composition={sub.composition}
              variant={variant}
              cutoffEndsAt={cutoffEndsAt}
              onUndoSkip={justSkipped ? handleUndoSkip : undefined}
              boxCount={sub.boxCount}
              frequency={sub.frequency}
              chargeTotalCents={sub.chargeTotalCents}
            />

            <div className="mx-6 md:mx-0">
              <Lp2Card>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <CardTitle
                    thin={t({ en: "Manage", es: "Gestiona" })}
                    bold={t({ en: "your plan", es: "tu plan" })}
                  />
                  <p className="m-0 hidden text-[14.5px] text-[#5E6168] md:block">
                    <T
                      en="Bring forward, skip or change your LIT whenever you need."
                      es="Adelanta, salta o cambia tu LIT cuando lo necesites."
                    />
                  </p>
                </div>
                {/* Cada tarjeta dice abajo qué cambia (Juan 2026-10-13: «las cards
                    muy sosas»). Las fechas salen de la suscripción: la próxima y
                    la siguiente de la cola de Seal, que es la que queda al saltar. */}
                <section className="mt-4 grid grid-cols-2 gap-2.5 md:mt-[22px] md:gap-3 lg:grid-cols-4">
                  <QuickActionButton
                    icon={QAIcons.ChargeNow}
                    label={t({ en: "Bring forward", es: "Adelantar envío" })}
                    sub={
                      nextLabel
                        ? t({
                            en: `Get it now, no need to wait for ${nextLabel}`,
                            es: `Recíbelo ya, sin esperar al ${nextLabel}`,
                          })
                        : t({ en: "Order now", es: "Haz tu pedido ahora" })
                    }
                    state={nextLabel ? <DateChange from={nextLabel} to={t({ en: "Today", es: "Hoy" })} /> : undefined}
                    onClick={() => setShowChargeNow(true)}
                    disabled={sub.withinCutoff}
                  />
                  <QuickActionButton
                    icon={QAIcons.ChangePlan}
                    label={t({ en: "Change plan", es: "Cambiar plan" })}
                    sub={t({
                      en: "Boxes or how often it arrives",
                      es: "Cajas o cada cuánto te llega",
                    })}
                    state={
                      <>
                        <span className="md:hidden">
                          {boxesLabel} · {frequencyLabel(sub.frequency, lang, { format: "short" })}
                        </span>
                        <span className="hidden md:inline">
                          {boxesLabel} · {frequencyLabel(sub.frequency, lang, { format: "long" })}
                        </span>
                      </>
                    }
                    onClick={() => setShowPlan(true)}
                    disabled={sub.withinCutoff}
                  />
                  <QuickActionButton
                    icon={QAIcons.Skip}
                    label={t({ en: "Skip next", es: "Saltar próximo" })}
                    sub={t({
                      en: "Free, only the next delivery",
                      es: "Sin coste, solo el próximo envío",
                    })}
                    state={
                      nextLabel && followingLabel ? (
                        <DateChange from={nextLabel} to={followingLabel} />
                      ) : undefined
                    }
                    onClick={() => setShowSkip(true)}
                    disabled={sub.withinCutoff}
                  />
                  <QuickActionButton
                    icon={QAIcons.Flavor}
                    label={t({ en: "Switch flavor", es: "Cambiar sabor" })}
                    sub={
                      // Pluralised by box count (Juan 2026-07-28). Deliberately does NOT name
                      // the flavours: that copy goes stale the day a third flavour ships.
                      sub.boxCount > 1
                        ? t({ en: "Choose the flavor of your boxes", es: "Elige el sabor de tus cajas" })
                        : t({ en: "Choose the flavor of your box", es: "Elige el sabor de tu caja" })
                    }
                    // Los sabores en UNA fila también en móvil (Juan 2026-10-14):
                    // en media tarjeta caben 3 con la caja a 18 px y menos aire.
                    stateOneLine
                    state={
                      sub.composition?.length ? (
                        <>
                          {sub.composition.map((c, i) => (
                            <span
                              key={c.flavor}
                              className={`inline-flex flex-none items-center gap-0.5 md:gap-1 ${i > 0 ? "ml-[3px] md:ml-2" : ""}`}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={flavorVisual(c.flavor).box}
                                alt=""
                                className="h-auto w-[18px] md:w-[30px]"
                              />
                              {c.boxes}×
                            </span>
                          ))}
                        </>
                      ) : undefined
                    }
                    onClick={() => setShowFlavor(true)}
                    disabled={sub.withinCutoff}
                  />
                </section>
              </Lp2Card>
            </div>

            <DeliveryCalendar
              nextShipDate={nextShipDate}
              upcoming={data.upcomingShipments}
              frequency={sub.frequency}
            />

            {/* Referidos, fase 0 (2026-10-10). Solo en esta rama (suscripción
                activa): el programa es para quien está suscrito. Va debajo de
                «Próximos pedidos» (Juan 2026-10-13), y también en Cuenta. La
                tarjeta pide sus propios datos y no se pinta si el programa no
                está abierto para este cliente (flag REFERRALS, B2B) o si algo
                falla.

                «Mis pedidos» ya no está aquí (Juan 2026-10-13): los pedidos se
                consultan en Cuenta, que tiene su propia lista. */}
            <ReferralCard placement="hub" />

            <BrandBand />

            {/* La Colección está oculta mientras la función no exista
                (COLLECTION_ENABLED en lib/portal-link.ts). Este era el único enlace
                CLICABLE a /coleccion: el del BottomNav ya salía como "Pronto". */}
            {COLLECTION_ENABLED && (
              <>
                <SectionDivider title={t({ en: "Collection", es: "Colección" })} />
                <CollectionMiniGrid
                  earned={collectionEarned}
                  href={portalHref(lang, "collection")}
                />
              </>
            )}
          </>
        )}
      </main>


      {/* Overlays live outside the isPaused/isPostCancel branch, so they can open
          on top of the resume card. One route reaches them without a click: the
          renewal-reminder email deep-links to mi-lit?action=skip, and the mount
          effect sets showSkip before the dashboard has loaded, so a customer whose
          subscription got paused between the email and the click would land on
          SkipOverlay over a paused sub (where the backend rejects the skip). Gate
          every mutation overlay on the sub being live. */}
      {showPlan && !isPaused && (
        <PlanOverlay
          subscription={sub}
          initialFrequency={planInitialFrequency}
          onClose={() => setShowPlan(false)}
          onUpdated={handlePlanUpdated}
        />
      )}
      {showFlavor && !isPaused && (
        <FlavorOverlay
          subscription={sub}
          onClose={() => setShowFlavor(false)}
          onUpdated={handleFlavorUpdated}
        />
      )}
      {showSkip && !isPaused && (
        <SkipOverlay
          subscription={sub}
          onClose={() => setShowSkip(false)}
          // Adjusting (spacing/fewer boxes) instead of skipping runs through the
          // same plan-change handler: optimistic update + syncing banner +
          // silent re-poll until Seal finishes regenerating the cadence.
          onAdjusted={handlePlanUpdated}
          onSkipped={(newDate) => {
            // Persistir la marca de "saltado" (scoped a la sub seleccionada;
            // expira sola a los 5 min o cuando el cliente pulsa Deshacer).
            markSkipped(true);
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
      {showChargeNow && !isPaused && (
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
      {/* NO va gateado con `!isPaused`, a diferencia de los overlays de mutación:
          contestar no toca la suscripción, y de un cliente pausado es justo de
          quien más interesa aprender. */}
      {/* Se DERIVA, no se guarda en estado con un efecto: el deep link deja una
          intención pendiente al montar (cuando `data` aún no existe) y aquí ya
          se sabe si el formulario está abierto para este cliente. Traducir eso a
          estado con un useEffect sería estado duplicado y un render en cascada.
          Si no está abierto para él, no se abre y no se le dice nada: un aviso de
          "no estás en la lista" solo sirve para contarle que existe algo que no
          le hemos ofrecido. */}
      {(showSurvey || (pendingSurvey && customer?.profileSurvey?.enabled)) && (
        <ProfileSurveyOverlay
          subscription={sub}
          onClose={() => {
            setShowSurvey(false);
            setPendingSurvey(false);
            // El estado del formulario vive en /api/customer desde el
            // 2026-09-15, no en el dashboard. El banner ya no está en el Hub,
            // pero el deep-link `?action=survey` del email sí sigue aterrizando
            // aquí, así que se refresca lo que de verdad lo gobierna.
            api<CustomerProfile>("/api/customer").then(setCustomer).catch(() => {});
          }}
          onSubscriptionUpdated={handlePlanUpdated}
        />
      )}
      {showCancel && !isPaused && (
        <CancelTakeover
          customer={customer}
          subscription={sub}
          onClose={() => {
            setShowCancel(false);
            // Reflect the cancellation (or any change the wizard made) in the
            // Hub without a manual reload — mirrors account/page.tsx. Without
            // this the Hub kept showing the active state after cancelling.
            api<HubDashboard>("/api/hub/dashboard")
              .then(setData)
              .catch((e: ApiClientError) => {
                // Don't swallow a dead session (the cancel purge can kill
                // this very one) or a gone subscription: keeping the stale
                // ACTIVE dashboard made the customer doubt the cancel went
                // through (audit 2026-07-08). Transient errors still keep
                // the current view.
                if (
                  e.code === "unauthorized" ||
                  e.code === "session_expired" ||
                  e.code === "session_invalid" ||
                  e.code === "subscription_not_found"
                ) {
                  setError(e.code);
                }
              });
          }}
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
      className="mx-6 mt-2 flex items-center gap-3 rounded-[20px] border border-[color:var(--color-lit-grey)]/10 bg-[color:var(--color-sharp-white)] px-4 py-3 shadow-[0_10px_30px_-14px_rgba(40,34,20,0.22)] md:mx-0"
    >
      <span
        className="inline-block h-3 w-3 flex-shrink-0 rounded-full bg-[color:var(--color-bold-yellow)]"
        style={{ animation: "pulse-slot 1.4s ease-in-out infinite" }}
      />
      <div className="text-[11px] leading-[1.4] text-[color:var(--color-lit-grey)]">
        {lang === "es" ? (
          <>
            <strong className="font-extrabold">Actualizando tu calendario.</strong>{" "}
            Tu nueva fecha de envío se confirmará en unos instantes.
          </>
        ) : (
          <>
            <strong className="font-extrabold">Updating your calendar.</strong>{" "}
            Your new ship date will be confirmed in a moment.
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Sin suscripción que gestionar, esto no es su sitio: a Cuenta.
 *
 * Cubre a quien compró one-shot, a quien se registró y aún no ha comprado, y a
 * quien canceló hace tanto que ya no hay nada que reactivar. Antes aterrizaban
 * aquí en una pantalla de bienvenida que les vendía la suscripción, cuando lo
 * que venían buscando era su pedido: el enlace de la tienda apunta a Mi LIT
 * para todo el mundo, así que el cliente one-shot entraba por la puerta del
 * suscriptor y se encontraba un escaparate. (Juan, 2026-09-22)
 *
 * Solo llega aquí un `subscription_not_found` del dashboard, que es más
 * estrecho que "no tiene suscripción activa": una sub pausada, o cancelada y
 * todavía dentro de la ventana de 90 días, SÍ devuelve contenido y se queda en
 * el Hub con su tarjeta de reanudar o reactivar. Esas no se redirigen.
 *
 * `replace` y no `push` para que el botón de atrás no les devuelva a un Hub que
 * volvería a rebotar. La salida de "cuenta equivocada" no se pierde: Cuenta
 * tiene su propio SwitchAccountRow.
 */
function EmptyState() {
  const router = useRouter();
  const lang = useLangValue();
  useEffect(() => {
    router.replace(portalHref(lang, "account"));
  }, [router, lang]);
  return <LoadingState />;
}

function ErrorState({ code }: { code: string }) {
  return (
    <main className="zone-lp2 flex flex-1 flex-col items-center justify-center bg-[#EFEEE5] p-8 text-center text-[#2F343D]">
      <h1 className="m-0 font-display text-[28px] font-semibold uppercase leading-[0.98] tracking-[0.005em] md:text-[38px]">
        <T en="Something went wrong." es="Algo no fue bien." />
      </h1>
      <p className="mt-3 mb-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8C8E87]">{code}</p>
    </main>
  );
}

// La espera común del portal (lp2, 2026-10-13), la misma que la de la entrada.
function LoadingState() {
  return <Lp2Loader />;
}

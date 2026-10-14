import { alertSlackError } from "@/lib/alert";
import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { claimChargeNowIntent, hasOpenChargeNowIntent, recordChargeNowIntent } from "@/lib/charge-now-recovery";
import { isWithinCutoff } from "@/lib/cutoff";
import { klaviyo } from "@/lib/klaviyo";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  getNextBillingAttempt,
  isChargeAlreadyScheduledError,
  normalizeFrequency,
  seal,
  SealApiError,
  type SealSubscription,
} from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertNoPendingLineRepair } from "@/lib/line-repair-runner";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { verifyOwnershipFast } from "@/lib/sub-ownership";
import { pickRequestedSub, requestedSubIdFrom } from "@/lib/sub-resolve";
import { supabaseAdmin } from "@/lib/supabase";
import type { ChargeNowResponse, Frequency } from "@/lib/types";

// Max plausible duration of a chargeNow call — a lock older than this is
// treated as stale (a crashed prior request) and reclaimed.
const CHARGE_LOCK_STALE_MS = 120_000;

// POST /apps/portal/api/subscription/charge-now
//
// "Adelantar mi pedido": charges the customer's active subscription RIGHT
// NOW and resets the billing schedule from today (Seal
// /subscription-create-charge-now with reset_schedule). The next order moves
// to ~today + one cycle.
//
// This is a real, immediate card charge — tighter rate limit than skip, and
// the customer explicitly confirms in the overlay before this fires.
//
// Body (optional): { sealSubscriptionId } — fast-path (Supabase ownership +
// targeted Seal GET), same optimisation as skip/plan to dodge the 33-page
// pagination scan on cold starts.
export const POST = withCustomer<ChargeNowResponse>(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "charge-now", { limit: 5, windowMs: 60_000 });

  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;

  const body = (await req.json().catch(() => ({}))) as {
    sealSubscriptionId?: number | string;
  };

  let sub: SealSubscription | null = null;
  let email: string | null = null;

  const requestedSubId = requestedSubIdFrom(req, body.sealSubscriptionId);
  if (requestedSubId) {
    const owns = await verifyOwnershipFast(Number(requestedSubId), ctx.customerId);
    if (owns) {
      sub = await seal.getSubscriptionById(Number(requestedSubId));
      if (sub) {
        email = sub.email ?? null;
        assertSubscriptionBelongsToCustomer(sub, email ?? "", "subscription/charge-now:fast");
      }
    }
  }

  if (!sub) {
    email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
    if (!email) {
      throw new ApiHttpError(404, "customer_not_found", `No email for Shopify customer ${ctx.customerId}`);
    }
    const subs = await seal.getSubscriptionsByEmail(email);
    // Multi-sub: never charge a DIFFERENT sub than the one requested — resolve
    // the requested id from the email-scoped list, or 404.
    sub = pickRequestedSub(subs, requestedSubId);
    if (!sub) throw new ApiHttpError(404, "subscription_not_found", `No active subscription for ${email}`);
    assertSubscriptionBelongsToCustomer(sub, email, "subscription/charge-now");
  }
  if (!email) email = sub.email ?? null;
  if (!email) throw new ApiHttpError(404, "customer_not_found", "");

  if (sub.status !== "ACTIVE") {
    throw new ApiHttpError(400, "subscription_not_active", "Subscription is not active");
  }

  // If the next order is already inside the 24h ship window, there's nothing
  // to bring forward — block it the same way skip/plan do.
  const next = getNextBillingAttempt(sub);
  if (next && isWithinCutoff(next.date)) {
    throw new ApiHttpError(400, "cutoff_passed", "Next order already ships within 24h");
  }

  // Un cambio de plan a medio aplicar (14-oct-2026): la sub puede tener las líneas viejas y
  // las nuevas a la vez hasta que termine, y Adelantar en ese hueco las cobraría todas.
  await assertNoPendingLineRepair(ctx.customerId, sub.id, "charge-now");

  // Un Adelantar de esta sub aún en curso (2026-10-14): o se está cobrando, o la
  // tarjeta lo acaba de rechazar y el webhook lo está rescatando, o Seal no
  // contestó y aún no sabemos si cobró. Lanzar otro encima puede cobrar dos
  // veces. Antes del lock a propósito: aquí aún no hay nada que soltar.
  if (await hasOpenChargeNowIntent(String(sub.id))) {
    throw new ApiHttpError(
      409,
      "charge_already_scheduled",
      "A charge for this subscription is already being processed. Try again in a few minutes.",
    );
  }

  // Idempotency mutex: acquire a per-subscription lock BEFORE calling Seal so
  // two near-simultaneous charge-now requests can't both reach Seal and
  // double-charge. FAIL-OPEN — any lock-infra error just proceeds (Seal's own
  // "already scheduled" guard still applies); the lock can only ADD protection,
  // never block a legitimate charge.
  const sb = supabaseAdmin();
  let lockHeld = false;
  try {
    // Self-heal a stale lock left by a crashed request.
    await sb
      .from("charge_now_locks")
      .delete()
      .eq("seal_subscription_id", sub.id)
      .lt("created_at", new Date(Date.now() - CHARGE_LOCK_STALE_MS).toISOString());
    const { error: lockErr } = await sb
      .from("charge_now_locks")
      .insert({ seal_subscription_id: sub.id, customer_id: ctx.customerId });
    if (lockErr) {
      if ((lockErr as { code?: string }).code === "23505") {
        throw new ApiHttpError(
          409,
          "charge_already_scheduled",
          "A charge for this subscription is already being processed. Try again in a few minutes.",
        );
      }
      console.error("[charge-now] lock acquire failed, proceeding (fail-open):", lockErr.message);
    } else {
      lockHeld = true;
    }
  } catch (e) {
    if (e instanceof ApiHttpError) throw e; // the 409 above
    console.error("[charge-now] lock error, proceeding (fail-open):", e);
  }

  // La fecha que el cliente tenía ANTES de adelantar. Es el punto de rescate: Seal
  // aplica `reset_schedule` en cuanto acepta la llamada y NO lo deshace si la tarjeta
  // declina, así que sin esto un cobro fallido deja al cliente sin caja y sin cobro,
  // con el pedido empujado un ciclo entero (13-sep → 24-nov en la 14245323, aviso de
  // Kiko 24-ago-2026). (2026-08-24)
  const preChargeDate = getNextBillingAttempt(sub)?.date?.slice(0, 10) ?? null;

  // Apunte ANTES de llamar a Seal (2026-10-14). Casi todos los rechazos llegan
  // segundos DESPUÉS de que Seal acepte el cobro, cuando esta petición ya ha
  // contestado: entonces es el webhook de Seal quien rescata el calendario, y usa
  // esta fila para saber que el cobro era nuestro y qué fecha tenía el cliente
  // (lib/charge-now-recovery.ts). Best effort: sin fila, el Adelantar sigue igual.
  const intentId = await recordChargeNowIntent({
    sealSubscriptionId: String(sub.id),
    customerId: ctx.customerId,
    preChargeDate,
  });

  // Charge now + reset the schedule so the cadence re-anchors on today.
  try {
    await seal.chargeNow(sub.id, { resetSchedule: true });
  } catch (err) {
    const alreadyScheduled = isChargeAlreadyScheduledError(err);
    // Solo un rechazo EXPLÍCITO de Seal (success:false, o un 4xx) dice que el
    // cobro no ha entrado. Un timeout o un 5xx no lo dice: Seal puede haber
    // cobrado y contestado tarde, y devolver entonces la fecha de antes le
    // cobraría dos veces (hoy y en esa fecha). En ese caso no se toca nada aquí:
    // la fila sigue «requested» y deciden el webhook de Seal o el cron con lo que
    // diga Seal (revisión adversarial, 14-oct). Antes del 14-oct este catch
    // devolvía la fecha con CUALQUIER error.
    // «Ya hay un cobro en curso» también es un rechazo explícito aunque llegue
    // como 503: Seal lo identifica por el mensaje y no ha cobrado nada nuevo.
    const explicitRejection =
      alreadyScheduled || (err instanceof SealApiError && err.status >= 200 && err.status < 500);
    let syncOwned = explicitRejection;
    if (explicitRejection && intentId !== null) {
      // Se marca la fila antes de mover nada, para que el rescate asíncrono no
      // mueva el mismo calendario a la vez; si el webhook ya la había reclamado,
      // decide él y aquí no se toca.
      syncOwned = await claimChargeNowIntent(intentId, alreadyScheduled ? "superseded" : "sync_failed").catch(
        () => true,
      );
    }
    if (!explicitRejection) {
      console.warn("[charge-now] respuesta ambigua de Seal; el calendario lo decide el rescate asíncrono", {
        sealSubscriptionId: sub.id,
        msg: err instanceof Error ? err.message : String(err),
      });
      if (intentId === null) {
        // Sin fila no hay rescate asíncrono: que lo mire una persona.
        alertSlackError({
          path: "/api/subscription/charge-now",
          code: "charge_now_ambiguous_no_intent",
          msg:
            `sub ${sub.id}: Seal no contestó claro al Adelantar y no se pudo guardar la fila de ` +
            `rescate. Mirar en Seal si cobró; si no, el próximo cobro puede haberse ido un ciclo.`,
          customerId: ctx.customerId,
        });
      }
    }
    // El cobro no ha entrado, pero el calendario YA está reanclado. Devolverlo a su
    // sitio antes de propagar el error: pullCadenceBackTo solo mueve hacia atrás y
    // nunca a una fecha pasada, así que el peor caso es que no haga nada. Best effort,
    // el error original manda.
    if (preChargeDate && !alreadyScheduled && syncOwned) {
      try {
        const moved = await seal.pullCadenceBackTo(sub.id, preChargeDate);
        console.log("[charge-now] schedule restored after failed charge", {
          sealSubscriptionId: sub.id,
          preChargeDate,
          moved,
        });
        if (moved === 0) {
          // No se ha podido devolver (la fecha ya pasó, o Seal no tenía pendientes):
          // el cliente se queda sin ese envío y alguien tiene que llamarle.
          alertSlackError({
            path: "/api/subscription/charge-now",
            code: "charge_now_schedule_not_restored",
            msg:
              `sub ${sub.id}: el cobro adelantado falló y no se ha podido devolver el ` +
              `calendario a ${preChargeDate}. Revisar a mano: puede haberse quedado sin envío.`,
            customerId: ctx.customerId,
          });
        }
      } catch (restoreErr) {
        console.error("[charge-now] schedule restore FAILED", {
          sealSubscriptionId: sub.id,
          preChargeDate,
          msg: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
        });
        alertSlackError({
          path: "/api/subscription/charge-now",
          code: "charge_now_schedule_not_restored",
          msg:
            `sub ${sub.id}: el cobro adelantado falló y el intento de devolver el ` +
            `calendario a ${preChargeDate} también falló. Revisar a mano.`,
          customerId: ctx.customerId,
        });
      }
    }
    // Seal refuses a second charge while one is already queued ("…already has
    // an attempt scheduled for processing. Try again in 15 minutes."). That's
    // an expected, transient condition — a charge is already in flight for
    // this subscription and re-charging would risk a double charge. Surface it
    // as a typed 409 so the customer gets a calm "already processing" message
    // instead of a scary 500, and so `withCustomer` returns it WITHOUT firing
    // an `internal_error` P0 in #n8n-errors. Any other Seal failure (card
    // declined, real 503 outage, etc.) still bubbles up as a genuine alert.
    if (isChargeAlreadyScheduledError(err)) {
      throw new ApiHttpError(
        409,
        "charge_already_scheduled",
        "A charge for this subscription is already being processed. Try again in a few minutes.",
      );
    }
    // RESPUESTA AMBIGUA = "NO SABEMOS", NO "FALLÓ" (14-oct-2026). Relanzar el error lo convertía
    // en un 5xx que la App Proxy sustituye por HTML, y el cliente leía "No se pudo procesar el
    // pago… inténtalo más tarde". Si Seal sí había cobrado, el bloqueo de 15 minutos caducaba
    // y un segundo intento cobraba OTRA caja. Un 409 llega tal cual: la pantalla le dice que no
    // lo repita y que lo verá en sus pedidos. El rescate asíncrono (webhook o cron) decide con
    // lo que diga Seal, como antes.
    if (!explicitRejection) {
      throw new ApiHttpError(
        409,
        "charge_unconfirmed",
        "Seal did not answer clearly; the charge may have gone through. Do not retry.",
      );
    }
    throw err;
  } finally {
    // Release the lock (best-effort) so a later legitimate charge isn't blocked.
    // On success, Seal's own "already scheduled" guard covers any request that
    // arrives after this point.
    if (lockHeld) {
      await sb.from("charge_now_locks").delete().eq("seal_subscription_id", sub.id);
    }
  }

  // Best-effort estimate of the new next ship date (today + one cycle) for
  // instant UI feedback. Seal regenerates billing_attempts asynchronously,
  // so the authoritative date arrives via the FE silent re-poll.
  const frequency = normalizeFrequency(sub.delivery_interval);
  const newNextShipDate = estimateNextShipDate(frequency).toISOString();

  klaviyo
    .trackEvent("subscription_charge_now", email, {
      newNextShipDate,
      sealSubscriptionId: String(sub.id),
    })
    .catch((err) => console.warn("[charge-now] klaviyo event failed:", err));

  return { charged: true, newNextShipDate };
});

/**
 * Add one subscription cycle to today. Used only for the optimistic next-ship
 * estimate shown right after a charge; the real value is reconciled by the
 * Hub's silent re-poll once Seal finishes rebuilding the schedule.
 */
function estimateNextShipDate(frequency: Frequency, from = new Date()): Date {
  const d = new Date(from);
  switch (frequency) {
    case "15d":
      d.setDate(d.getDate() + 15);
      break;
    case "45d":
      d.setDate(d.getDate() + 45);
      break;
    case "1mo":
      d.setMonth(d.getMonth() + 1);
      break;
    case "2mo":
      d.setMonth(d.getMonth() + 2);
      break;
    case "3mo":
      d.setMonth(d.getMonth() + 3);
      break;
    case "4mo":
      d.setMonth(d.getMonth() + 4);
      break;
    case "5mo":
      d.setMonth(d.getMonth() + 5);
      break;
    case "6mo":
      d.setMonth(d.getMonth() + 6);
      break;
  }
  return d;
}

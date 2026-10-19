/**
 * Los avisos de Klaviyo de un cambio que el cliente GUARDA en su suscripción
 * (19-oct-2026): dirección (SUB-03), sabor (SUB-04) y plan (SUB-05).
 *
 *   - `subscription_address_updated`: dirección de envío distinta.
 *   - `subscription_plan_updated`: cambian las cajas o la frecuencia, aunque cambie
 *     también el sabor.
 *   - `subscription_flavor_updated`: solo el sabor, o el reparto de sabores con las
 *     mismas cajas y la misma frecuencia.
 *
 * Un evento por cambio guardado y en el momento. Si llegan varios seguidos, el flow
 * espera 30 min y solo manda el email del último: aquí no se agrupa ni se retrasa.
 *
 * Solo se emite lo CONFIRMADO en Seal. Un cambio que la ruta no puede confirmar al
 * momento (`change_applying`, verificación sin respuesta) lo emite quien lo confirma
 * después, con el mismo `uniqueId`, así que si dos caminos lo confirman Klaviyo se
 * queda con uno. Ver `notifyConfirmedRepair`.
 *
 * Los emails leen estas propiedades con estos nombres exactos (brief de CRM del
 * 19-oct). `nextShipDate` va en ISO crudo de Seal y los emails sacan el día de sus
 * 10 primeros caracteres: con las horas de Seal (09:00 o 13:00 UTC) y la optimista
 * de la ruta de plan (`T13:00:00Z`) esos 10 caracteres son el día en España.
 */

import { alertSlackError } from "@/lib/alert";
import type { NormalizedAddress } from "@/lib/address-core";
import { klaviyo, type KlaviyoEvent } from "@/lib/klaviyo";
import { compositionLabel, mixBoxCount, sameComposition, type FlavorComposition } from "@/lib/mix";
import { getComposition, getNextBillingAttempt, normalizeFrequency, seal, type SealSubscription } from "@/lib/seal";
import { formatShipDateEs } from "@/lib/ship-date-label";
import { customerLocale, subscriptionSnapshotProps } from "@/lib/sub-event-props";
import { supabaseAdmin } from "@/lib/supabase";
import type { Frequency } from "@/lib/types";

// ─── qué evento toca ──────────────────────────────────────────────────────────

export interface PlanState {
  frequency: Frequency;
  composition: FlavorComposition[];
}

export type PlanChangeKind = "plan" | "flavor";

/**
 * «plan», «sabor» o nada, a partir del antes y el después.
 *
 * Por semántica, nunca por los campos que trae la petición: PlanOverlay manda
 * `boxCount` siempre, así que un cambio de solo frecuencia llega con las cajas de
 * siempre, y un cambio de cajas de una mezcla llega como `mix`.
 */
export function classifyPlanChange(before: PlanState, after: PlanState): PlanChangeKind | null {
  if (mixBoxCount(before.composition) !== mixBoxCount(after.composition)) return "plan";
  if (before.frequency !== after.frequency) return "plan";
  if (!sameComposition(before.composition, after.composition)) return "flavor";
  return null;
}

export function planChangeEventName(kind: PlanChangeKind): KlaviyoEvent {
  return kind === "plan" ? "subscription_plan_updated" : "subscription_flavor_updated";
}

/** «Salty Watermelon» para un sabor; «2× Lemon · 1× Watermelon» para una mezcla. */
export function flavourLabel(composition: FlavorComposition[]): string {
  return compositionLabel(composition);
}

/**
 * ¿Cambia también el sabor? Los sabores y su reparto, NO las cajas: de 1 a 2 cajas de
 * Watermelon no es cambiar de sabor, ni subir una mezcla de 2+1 a 4+2. Hasta el 19-oct
 * se comparaba la composición entera y un cambio de cajas salía como cambio de sabor
 * (visto en la prueba real: «Watermelon → Watermelon» con `flavourChanged: true`).
 */
export function flavourChanged(before: FlavorComposition[], after: FlavorComposition[]): boolean {
  const shares = (c: FlavorComposition[]) => {
    const boxes = new Map<string, number>();
    for (const x of c) boxes.set(x.flavor, (boxes.get(x.flavor) ?? 0) + x.boxes);
    const total = [...boxes.values()].reduce((s, n) => s + n, 0) || 1;
    return new Map([...boxes].map(([flavor, n]) => [flavor, n / total]));
  };
  const a = shares(before);
  const b = shares(after);
  if (a.size !== b.size) return true;
  for (const [flavor, share] of a) {
    const other = b.get(flavor);
    if (other === undefined || Math.abs(other - share) > 1e-9) return true;
  }
  return false;
}

/**
 * Las pantallas que usan la ruta de plan, para poder filtrarlas en Klaviyo.
 *
 * El `source` llega del cuerpo de la petición, así que solo pasan los valores
 * conocidos. PlanOverlay y FlavorOverlay no mandan ninguno y en el ledger siguen
 * siendo `portal` (`scripts/demix-subscription.ts` busca ese valor exacto): en el
 * evento son `portal_plan`.
 */
export const PLAN_EVENT_SOURCES = ["portal_plan", "skip_overlay", "cancel_takeover", "profile_survey"] as const;
export type PlanEventSource = (typeof PLAN_EVENT_SOURCES)[number] | "whatsapp_bot";

export function planEventSource(raw: unknown): PlanEventSource {
  return (PLAN_EVENT_SOURCES as readonly string[]).includes(String(raw))
    ? (raw as PlanEventSource)
    : "portal_plan";
}

// ─── propiedades ──────────────────────────────────────────────────────────────

function shipDateProps(nextShipDate: string | null | undefined) {
  const iso = nextShipDate || null;
  // Igual que `subscriptionSnapshotProps`: sin fecha, los dos a null.
  return { nextShipDate: iso, nextShipDateLabel: iso ? formatShipDateEs(iso) || null : null };
}

export function planChangeProps(
  kind: PlanChangeKind,
  before: PlanState,
  after: PlanState,
  ctx: { nextShipDate: string | null | undefined; sealSubscriptionId: number | string; source: PlanEventSource },
): Record<string, unknown> {
  const flavours = {
    newFlavour: flavourLabel(after.composition),
    previousFlavour: flavourLabel(before.composition),
  };
  return {
    ...(kind === "plan"
      ? {
          boxes: mixBoxCount(after.composition),
          previousBoxes: mixBoxCount(before.composition),
          frequency: after.frequency,
          previousFrequency: before.frequency,
          // De regalo para el email de plan, por si quiere decir que cambió también el sabor.
          ...flavours,
          flavourChanged: flavourChanged(before.composition, after.composition),
        }
      : flavours),
    ...shipDateProps(ctx.nextShipDate),
    sealSubscriptionId: String(ctx.sealSubscriptionId),
    source: ctx.source,
  };
}

/**
 * ¿Ha cambiado la dirección? La misma línea que se le lee al cliente
 * (`formatAddress`), sin mayúsculas ni espacios de más y SIN la provincia: la
 * provincia se deriva del código postal (`normalizeAddress`), así que si el CP no
 * cambia tampoco cambia ella, y una sub vieja guardada sin provincia daría un
 * «Dirección actualizada» por guardar la misma dirección.
 */
export function addressChanged(before: ComparableAddress, after: ComparableAddress): boolean {
  return comparableLine(before) !== comparableLine(after);
}

interface ComparableAddress {
  address1?: string | null;
  address2?: string | null;
  postalCode?: string | null;
  city?: string | null;
}

function comparableLine(a: ComparableAddress): string {
  const clean = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("es-ES");
  return [clean(a.address1), clean(a.address2), clean(a.postalCode), clean(a.city)].join("|");
}

function sealAddressOf(s: SealSubscription): ComparableAddress {
  return { address1: s.s_address1, address2: s.s_address2, postalCode: s.s_zip, city: s.s_city };
}

/**
 * ¿Enseña ya Seal la dirección escrita? Solo los campos que deciden A DÓNDE llega la caja
 * (calle, CP y ciudad), los mismos que verifica `writeAddress`: el resto, piso incluido,
 * Seal los normaliza a su gusto, y exigirlos dejaría sin aviso un cambio bien guardado.
 */
function sealShowsAddress(s: SealSubscription, addr: ComparableAddress): boolean {
  const { address1, postalCode, city } = sealAddressOf(s);
  return !addressChanged(
    { address1, postalCode, city },
    { address1: addr.address1, postalCode: addr.postalCode, city: addr.city },
  );
}

/**
 * Seal tarda ~1 s en reflejar una escritura de dirección, y la ruta del portal no la
 * verifica (las esperas se comerían el margen del App Proxy). Así que el evento, que
 * va detrás de la respuesta, mira él mismo que Seal ya la enseña antes de decirle al
 * cliente que la ha cambiado: el `edit` de Seal puede contestar 200 sin guardar nada.
 */
const ADDRESS_CONFIRM_DELAYS_MS = [1_000, 2_500];

/**
 * SUB-03. Lo llaman las dos entradas del cambio de dirección DESPUÉS de escribir, dentro
 * de `after()`. No emite si la dirección no cambia respecto a la que había, ni si Seal
 * no llega a enseñar la nueva. Nunca lanza.
 */
export async function notifyAddressUpdated(input: {
  /** La sub leída ANTES de escribir. */
  before: SealSubscription;
  addr: NormalizedAddress;
  /** La relectura de `writeAddress`, si la hubo. */
  refreshed: SealSubscription | null;
  email: string | null | undefined;
  customerId: string | null | undefined;
  source: "portal" | "whatsapp_bot";
  uniqueId: string;
  path: string;
  delaysMs?: number[];
}): Promise<void> {
  try {
    if (!addressChanged(sealAddressOf(input.before), input.addr)) return;
    let confirmed = input.refreshed && sealShowsAddress(input.refreshed, input.addr) ? input.refreshed : null;
    for (const delay of confirmed ? [] : input.delaysMs ?? ADDRESS_CONFIRM_DELAYS_MS) {
      await new Promise((r) => setTimeout(r, delay));
      const s = await seal.getSubscriptionById(input.before.id).catch(() => null);
      if (s && sealShowsAddress(s, input.addr)) {
        confirmed = s;
        break;
      }
    }
    if (!confirmed) {
      console.warn("[sub-change-events] Seal no enseña la dirección nueva; no se emite", {
        sub: input.before.id,
        uniqueId: input.uniqueId,
      });
      return;
    }
    await sendSubChangeEvent("subscription_address_updated", {
      email: input.email,
      customerId: input.customerId,
      sub: confirmed,
      props: addressUpdatedProps(input.addr, {
        nextShipDate: getNextBillingAttempt(confirmed)?.date ?? null,
        sealSubscriptionId: confirmed.id,
        source: input.source,
      }),
      uniqueId: input.uniqueId,
      path: input.path,
    });
  } catch (err) {
    console.error("[sub-change-events] notifyAddressUpdated", {
      sub: input.before.id,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

export function addressUpdatedProps(
  addr: NormalizedAddress,
  ctx: {
    nextShipDate: string | null | undefined;
    sealSubscriptionId: number | string;
    source: "portal" | "whatsapp_bot";
  },
): Record<string, unknown> {
  const t = (v: string | null | undefined) => (v ?? "").trim();
  return {
    address1: t(addr.address1),
    address2: t(addr.address2),
    city: t(addr.city),
    zip: t(addr.postalCode),
    province: t(addr.province),
    country: t(addr.country),
    countryCode: t(addr.countryCode).toUpperCase(),
    firstName: t(addr.firstName),
    lastName: t(addr.lastName),
    ...shipDateProps(ctx.nextShipDate),
    sealSubscriptionId: String(ctx.sealSubscriptionId),
    source: ctx.source,
  };
}

// ─── envío ────────────────────────────────────────────────────────────────────

/**
 * Manda el evento con la foto de la sub DESPUÉS del cambio y el idioma. Nunca lanza:
 * el cambio ya está guardado y un fallo de Klaviyo no deshace nada.
 *
 * El llamante lo envuelve en `after(() => runWithoutRequestDeadline(...))`: no retrasa
 * la respuesta y no se corta al cerrarse la función.
 */
export async function sendSubChangeEvent(
  event: KlaviyoEvent,
  input: {
    email: string | null | undefined;
    customerId: string | null | undefined;
    /** La sub ya cambiada; sus campos los pisan las propiedades propias del evento. */
    sub: SealSubscription | null;
    props: Record<string, unknown>;
    uniqueId: string;
    path: string;
  },
): Promise<void> {
  const email = (input.email ?? "").trim();
  const customerId = input.customerId ? String(input.customerId) : null;
  if (!email) {
    console.warn(`[sub-change-events] ${event} sin email; no se emite`, { customerId, uniqueId: input.uniqueId });
    return;
  }
  try {
    await klaviyo.trackEvent(
      event,
      email,
      {
        ...(input.sub ? subscriptionSnapshotProps(input.sub) : {}),
        ...input.props,
        locale: await customerLocale(customerId),
      },
      { uniqueId: input.uniqueId, ...(customerId ? { externalId: customerId } : {}) },
    );
    console.log(`[sub-change-events] ${event} emitido`, { customerId, uniqueId: input.uniqueId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sub-change-events] ${event} fallido`, { customerId, uniqueId: input.uniqueId, msg });
    // Sin evento no sale el email de confirmación, y nadie lo ve: que lo sepa alguien.
    alertSlackError({
      path: input.path,
      code: `klaviyo_event_failed:${event}`,
      msg: `El evento ${event} no salió (${input.uniqueId}): ${msg}`,
      customerId: customerId ?? undefined,
    });
  }
}

/** El `uniqueId` de un cambio de plan: el `requestId` de la petición que lo pidió. */
export function planChangeUniqueId(requestId: string): string {
  return `plan-change-${requestId}`;
}

// ─── confirmado más tarde: la reparación de líneas ────────────────────────────

interface LedgerIntentPayload {
  requestId?: string;
  source?: string;
  from?: { composition?: FlavorComposition[]; frequency?: Frequency };
  to?: { composition?: FlavorComposition[]; frequency?: Frequency };
}

/**
 * Cuánto antes de armar (o rearmar) la red puede estar la fila `intent` de su
 * petición. La ruta la escribe antes de la primera escritura en Seal y rearma, como
 * mucho, unos 25 s después; el margen es por si Supabase va lento.
 */
const LEDGER_INTENT_MAX_AGE_MS = 10 * 60_000;
/**
 * `applied_at` lo pone el reloj de Supabase y `created_at` de la red el de Vercel. Entre
 * escribir la fila y armar la red puede haber solo un viaje a Supabase, así que se deja
 * margen. No deja entrar la fila de OTRA petición: con la red pendiente, la ruta de plan
 * rechaza cualquier cambio nuevo sobre la sub.
 */
const LEDGER_CLOCK_SKEW_MS = 5_000;

/**
 * Una reparación de líneas acaba de dejar la sub como la pidió su petición: el aviso
 * que esa petición no pudo dar al momento (`change_applying`, o una verificación que
 * no respondió). Lo llama `processRepairIntent` al cerrar con `applied`, tanto desde
 * el `after()` de la ruta como desde el cron `mix-repair-drain`.
 *
 * El antes y el después salen de la fila `intent` de esa petición en
 * `subscription_changes` (la última antes de armar la red), y solo se emite si Seal
 * enseña ahora exactamente lo que pidió. Con su mismo `requestId` como `uniqueId`.
 * Nunca lanza.
 */
export async function notifyConfirmedRepair(
  intent: { customer_id: string; seal_subscription_id: string; created_at: string },
  sub: SealSubscription,
  path: string,
): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("subscription_changes")
      .select("payload, applied_at")
      .eq("customer_id", intent.customer_id)
      .eq("payload->>sealSubscriptionId", String(intent.seal_subscription_id))
      .eq("payload->>outcome", "intent")
      .lte("applied_at", new Date(Date.parse(intent.created_at) + LEDGER_CLOCK_SKEW_MS).toISOString())
      .order("applied_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      console.warn("[sub-change-events] reparación sin su fila intent; no se emite", {
        sub: intent.seal_subscription_id,
        msg: error?.message ?? "sin fila",
      });
      return;
    }
    const age = Date.parse(intent.created_at) - Date.parse(String(data.applied_at));
    const p = (data.payload ?? {}) as LedgerIntentPayload;
    const fresh = age >= -LEDGER_CLOCK_SKEW_MS && age <= LEDGER_INTENT_MAX_AGE_MS;
    if (!fresh || !p.requestId || !p.from?.frequency || !p.to?.frequency) {
      console.warn("[sub-change-events] la fila intent no es de esta reparación; no se emite", {
        sub: intent.seal_subscription_id,
        ageMs: age,
      });
      return;
    }
    const before: PlanState = { frequency: p.from.frequency, composition: p.from.composition ?? [] };
    const target: PlanState = { frequency: p.to.frequency, composition: p.to.composition ?? [] };
    // Lo que de verdad hay en Seal tiene que ser lo que pidió esa petición.
    const live: PlanState = { frequency: normalizeFrequency(sub.delivery_interval ?? ""), composition: getComposition(sub) };
    if (live.frequency !== target.frequency || !sameComposition(live.composition, target.composition)) {
      console.warn("[sub-change-events] Seal no enseña lo que pidió la petición; no se emite", {
        sub: intent.seal_subscription_id,
        requestId: p.requestId,
      });
      return;
    }
    const kind = classifyPlanChange(before, target);
    if (!kind) return;

    await sendSubChangeEvent(planChangeEventName(kind), {
      email: sub.email,
      customerId: intent.customer_id,
      sub,
      props: planChangeProps(kind, before, target, {
        nextShipDate: await confirmedNextShipDate(intent.customer_id, sub, before.frequency !== target.frequency),
        sealSubscriptionId: sub.id,
        source: planEventSource(p.source),
      }),
      uniqueId: planChangeUniqueId(p.requestId),
      path,
    });
  } catch (err) {
    console.error("[sub-change-events] notifyConfirmedRepair", {
      sub: intent.seal_subscription_id,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * La próxima entrega que se le puede decir al cliente. Si cambió la frecuencia, Seal
 * regenera el calendario y lo que sujeta la fecha es la intención de re-anclaje
 * pendiente: esa es la fecha, con la misma hora optimista que promete la ruta.
 */
async function confirmedNextShipDate(
  customerId: string,
  sub: SealSubscription,
  frequencyChanged: boolean,
): Promise<string | null> {
  if (frequencyChanged) {
    const { data } = await supabaseAdmin()
      .from("subscription_reanchor_intents")
      .select("preserve_date")
      .eq("customer_id", customerId)
      .eq("seal_subscription_id", String(sub.id))
      .eq("status", "pending")
      .maybeSingle();
    if (data?.preserve_date) return `${String(data.preserve_date).slice(0, 10)}T13:00:00Z`;
  }
  return getNextBillingAttempt(sub)?.date ?? null;
}

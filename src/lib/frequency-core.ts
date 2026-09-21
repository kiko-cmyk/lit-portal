/**
 * El cambio de SOLO frecuencia, como módulo propio.
 *
 * Extraído del plan route el 2026-09-21 para que la ruta del cliente y la nueva
 * entrada máquina a máquina (`/api/internal/subscription/frequency`, la que usa
 * el bot de WhatsApp de Permut cuando un cliente acepta estirar el tiempo entre
 * cajas en vez de saltar) compartan UNA implementación de las tres cosas que aquí
 * cuestan dinero si se duplican mal:
 *
 *   1. El `delivery_interval` exacto que Seal acepta en el `edit`
 *      (`SEAL_INTERVAL_BY_FREQUENCY`). Con un campo de más, Seal hace no-op en
 *      silencio (Juan, 2026-05-19).
 *   2. La fecha natural a la que cae la próxima entrega tras el cambio
 *      (`naturalNextShipDate`): último cobro completado + intervalo nuevo, que es
 *      como Seal regenera el calendario. Es la fecha que enseña el SkipOverlay y
 *      la que hay que preservar con el re-anclaje, porque Seal ignora los saltos
 *      previos al regenerar y puede ADELANTAR el cobro (LIT-464).
 *   3. La intención de re-anclaje (`writeReanchorIntent`) que el cron
 *      `/api/cron/reanchor-drain` converge cuando Seal termina de regenerar.
 *
 * `changeFrequencyOnly` es la orquestación completa para la entrada del bot:
 * auditoría → edit con un reintento → relectura con presupuesto → intención de
 * re-anclaje. Devuelve la fecha con la que el bot puede comprometerse. La ruta del
 * cliente conserva su propia orquestación porque allí el cambio de frecuencia va
 * entrelazado con el de líneas; lo que comparte son las tres piezas de arriba.
 *
 * Todo lo que toca red entra por `FrequencyChangeDeps`, con valores por defecto
 * reales: los tests (`scripts/test-frequency-core.ts`) pasan dobles y no
 * necesitan Seal ni Supabase.
 */

import { ApiHttpError } from "@/lib/api-helpers";
import { addCycle, subCycle } from "@/lib/cadence";
import { isWithinCutoff } from "@/lib/cutoff";
import { FREQUENCY_DAYS, longerFrequencies } from "@/lib/plan-options";
import {
  getLastCompletedChargeDate,
  getNextBillingAttempt,
  normalizeFrequency,
  seal,
  type SealSubscription,
} from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";
import type { Frequency } from "@/lib/types";

/**
 * Lo que se manda a Seal en `edit { delivery_interval }`, por frecuencia. En
 * SINGULAR: es la forma que lleva aceptando en producción desde mayo. Seal
 * devuelve después su propia forma («45 days», «2 months»), así que la
 * verificación compara con `normalizeFrequency`, nunca con la cadena.
 */
export const SEAL_INTERVAL_BY_FREQUENCY: Record<Frequency, string> = {
  "15d": "15 day",
  "1mo": "1 month",
  "45d": "45 day",
  "2mo": "2 month",
  "3mo": "3 month",
  "4mo": "4 month",
  "5mo": "5 month",
  "6mo": "6 month",
};

export const VALID_FREQUENCIES: Frequency[] = ["15d", "1mo", "45d", "2mo", "3mo", "4mo", "5mo", "6mo"];

export function isFrequency(v: unknown): v is Frequency {
  return typeof v === "string" && (VALID_FREQUENCIES as string[]).includes(v);
}

/**
 * Fecha (YYYY-MM-DD) a la que cae la próxima entrega si la frecuencia pasa a
 * `target`: el ancla es el último cobro COMPLETADO que Seal enseña y, si no
 * enseña ninguno (la lista trae sobre todo futuros), la próxima fecha menos un
 * ciclo actual. Mismo cálculo que usaba el plan route en línea
 * (`computeNaturalYYYYMMDD`, 2026-06-19) y que el SkipOverlay hace en el cliente.
 * Null solo si no hay ni cobro completado ni próxima fecha.
 */
export function naturalNextShipDate(
  sub: SealSubscription | null,
  nextAttemptDate: string | null,
  current: Frequency,
  target: Frequency,
): string | null {
  let anchorIso = sub ? getLastCompletedChargeDate(sub) : null;
  if (!anchorIso && nextAttemptDate) {
    anchorIso = subCycle(new Date(nextAttemptDate), current).toISOString();
  }
  if (!anchorIso) return null;
  return addCycle(new Date(anchorIso), target).toISOString().slice(0, 10);
}

export interface LongerOption {
  frequency: Frequency;
  /** Dónde caería la próxima entrega con esa frecuencia. */
  naturalNextShipDate: string | null;
  /**
   * Si de verdad ALEJA la entrega respecto a la fecha que ya tiene. A quien ya
   * había saltado, el último cobro le queda lejos y la fecha regenerada puede
   * caer antes: pedir más tiempo y cobrar antes es LIT-464. El bot no ofrece
   * las que no ganan.
   */
  gains: boolean;
}

/** Las frecuencias más largas que la actual, cada una con su fecha natural. */
export function longerOptions(sub: SealSubscription, current: Frequency): LongerOption[] {
  const next = getNextBillingAttempt(sub)?.date ?? null;
  const nextDay = next ? next.slice(0, 10) : null;
  return longerFrequencies(current).map((frequency) => {
    const natural = naturalNextShipDate(sub, next, current, frequency);
    return {
      frequency,
      naturalNextShipDate: natural,
      gains: natural !== null && nextDay !== null && natural > nextDay,
    };
  });
}

/**
 * La entrada del bot solo ALARGA. Acortar tiene su sitio en el área personal, y
 * la misma frecuencia no es un cambio: las dos salen como `not_longer`.
 */
export function assertLonger(current: Frequency, target: Frequency): void {
  if (FREQUENCY_DAYS[target] <= FREQUENCY_DAYS[current]) {
    throw new ApiHttpError(
      409,
      "not_longer",
      `Target frequency ${target} is not longer than the current ${current}`,
    );
  }
}

/**
 * Persiste (o refresca) la intención «la próxima entrega tiene que quedarse en
 * esta fecha» para que el cron drain (`/api/cron/reanchor-drain`) remate el
 * trabajo cuando Seal termine de regenerar el calendario. Una intención viva por
 * (cliente, suscripción); la siguiente la sobrescribe.
 */
export async function writeReanchorIntent(
  customerId: string,
  sealSubscriptionId: number,
  preserveYYYYMMDD: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await supabaseAdmin()
    .from("subscription_reanchor_intents")
    .upsert(
      {
        customer_id: customerId,
        seal_subscription_id: String(sealSubscriptionId),
        preserve_date: preserveYYYYMMDD,
        status: "pending",
        attempts: 0,
        created_at: nowIso,
        updated_at: nowIso,
      },
      // Multi-sub: una intención por (cliente, sub); la PK compuesta impide que un
      // cambio en una sub pise la intención pendiente de una hermana.
      { onConflict: "customer_id,seal_subscription_id" },
    );
}

export interface FrequencyAuditRow {
  customerId: string;
  payload: Record<string, unknown>;
  appliesFrom: string | null;
}

/**
 * Fila en `subscription_changes`. Best effort, nunca fatal: un apunte de
 * auditoría no puede tumbar un cambio de plan (plan route, 2026-08-30).
 */
export async function writeFrequencyAudit(row: FrequencyAuditRow): Promise<void> {
  try {
    const { error } = await supabaseAdmin().from("subscription_changes").insert({
      customer_id: row.customerId,
      change_type: "plan",
      payload: row.payload,
      applies_from: row.appliesFrom,
    });
    if (error) console.warn(`[frequency-core] audit-write-failed: ${error.message}`);
  } catch (e) {
    console.warn(`[frequency-core] audit-write-threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Todo lo que toca red, inyectable. Los valores por defecto son los reales. */
export interface FrequencyChangeDeps {
  editSubscription: (id: number, edits: Record<string, unknown>) => Promise<void>;
  readBack: (id: number, signal: AbortSignal) => Promise<SealSubscription | null>;
  writeAudit: (row: FrequencyAuditRow) => Promise<void>;
  writeReanchorIntent: (customerId: string, id: number, preserveYYYYMMDD: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export function defaultFrequencyChangeDeps(): FrequencyChangeDeps {
  return {
    editSubscription: (id, edits) => seal.editSubscription(id, edits),
    readBack: (id, signal) => seal.getSubscriptionById(id, signal),
    writeAudit: writeFrequencyAudit,
    writeReanchorIntent,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export interface FrequencyChangeArgs {
  sealSub: SealSubscription;
  target: Frequency;
  /** Id numérico del cliente en Shopify: la intención y la auditoría cuelgan de él. */
  customerId: string;
  /** Quién pide el cambio (`whatsapp`, `portal`…). Va a la auditoría. */
  source: string;
  /** El motivo que dio el cliente, si lo dio (los valores del SkipOverlay). */
  reason?: string | null;
  /**
   * `natural`: la próxima entrega cae en último cobro + intervalo nuevo (lo que
   * hace el SkipOverlay al «Ajustar mi plan»). `preserve`: se queda en la fecha
   * que ya tenía (cambio de plan normal).
   */
  reanchorMode: "natural" | "preserve";
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

export interface FrequencyChangeResult {
  /** false = ya estaba en `target`; no se ha tocado nada. Idempotente. */
  changed: boolean;
  frequency: Frequency;
  previousFrequency: Frequency;
  /** El `delivery_interval` que Seal tiene DESPUÉS, releído. */
  deliveryInterval: string;
  /**
   * La fecha con la que se puede comprometer el bot. Con intención escrita es la
   * preservada (optimista: el cron la hace real, y como solo mueve hacia adelante
   * el error está acotado a lo que Seal ancle más tarde, nunca a un ciclo entero).
   */
  nextShipDate: string | null;
  preserveDate: string | null;
  reanchor: "intent_written" | "intent_failed" | "within_cutoff" | "none";
}

/** Reintento único del edit, como en el plan route: Seal a veces suelta la primera. */
const EDIT_RETRY_DELAY_MS = 700;
/** Lo que tarda Seal en reflejar el edit antes de que la relectura lo vea. */
const SETTLE_MS = 500;
/** Presupuesto duro de la relectura. */
const VERIFY_BUDGET_MS = 4_000;

/**
 * Cambia SOLO la frecuencia y devuelve una fecha con la que comprometerse.
 *
 * Aquí no hay pantalla ni re-poll: quien llama es un bot que le va a decir al
 * cliente «hecho». Por eso, al revés que la ruta del cliente, una escritura que
 * no se ha podido releer NO se da por buena: se deja la intención de re-anclaje
 * (para que el cron converja lo que Seal haya hecho) y se lanza
 * `frequency_unverified`. Y una relectura que enseña el intervalo viejo es
 * `frequency_not_persisted`, el no-op silencioso de Seal, que jamás se confirma.
 */
export async function changeFrequencyOnly(
  args: FrequencyChangeArgs,
  deps: FrequencyChangeDeps = defaultFrequencyChangeDeps(),
): Promise<FrequencyChangeResult> {
  const { sealSub, target, customerId, source, reanchorMode } = args;
  const log = args.log ?? (() => undefined);
  const id = Number(sealSub.id);
  const current = normalizeFrequency(sealSub.delivery_interval);
  const nextAttempt = getNextBillingAttempt(sealSub);
  const nextIso = nextAttempt?.date ?? null;

  if (current === target) {
    log("frequency-noop", { current });
    return {
      changed: false,
      frequency: current,
      previousFrequency: current,
      deliveryInterval: sealSub.delivery_interval,
      nextShipDate: nextIso,
      preserveDate: null,
      reanchor: "none",
    };
  }

  const expectedInterval = SEAL_INTERVAL_BY_FREQUENCY[target];
  const preserve =
    reanchorMode === "natural"
      ? naturalNextShipDate(sealSub, nextIso, current, target)
      : (nextIso?.slice(0, 10) ?? null);

  const audit = (outcome: string) =>
    deps.writeAudit({
      customerId,
      payload: {
        sealSubscriptionId: String(id),
        outcome,
        from: { frequency: current },
        to: { frequency: target },
        reanchorMode,
        preserveDate: preserve,
        reason: args.reason ?? null,
        source,
      },
      appliesFrom: preserve,
    });

  // El apunte va ANTES de tocar Seal: una petición que muera después de mutar
  // deja al menos la intención, y «intent sin verified» es lo que delata un
  // cambio a medias (plan route, 2026-08-24).
  await audit("intent");

  // ── edit, con un reintento ──
  try {
    await deps.editSubscription(id, { delivery_interval: expectedInterval });
    log("seal-edit-interval-ok", { interval: expectedInterval, attempt: 1 });
  } catch (e1) {
    log("seal-edit-interval-retry", { msg: e1 instanceof Error ? e1.message : String(e1) });
    await deps.sleep(EDIT_RETRY_DELAY_MS);
    try {
      await deps.editSubscription(id, { delivery_interval: expectedInterval });
      log("seal-edit-interval-ok", { interval: expectedInterval, attempt: 2 });
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2);
      log("seal-edit-interval-failed-twice", { msg });
      await audit("edit_failed");
      // Nada más se ha tocado: la suscripción sigue como estaba.
      throw new ApiHttpError(502, "frequency_change_failed", `Frequency change rejected by Seal: ${msg}`);
    }
  }

  // ── relectura con presupuesto ──
  await deps.sleep(SETTLE_MS);
  let verified: SealSubscription | null = null;
  let outcome: "ok" | "timeout" | "error" | "not_found" = "ok";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_BUDGET_MS);
  try {
    verified = await deps.readBack(id, controller.signal);
    if (!verified) outcome = "not_found";
  } catch (e) {
    outcome = (e as { name?: string }).name === "AbortError" ? "timeout" : "error";
    log("verify-read-failed", { outcome, msg: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }

  const canReanchor = preserve !== null && !isWithinCutoff(`${preserve}T13:00:00Z`);

  if (!verified) {
    // La mutación puede haberse aplicado. Se deja la intención para que el cron
    // converja lo que Seal haya hecho, y se falla: sin relectura no hay «hecho».
    if (canReanchor) {
      await deps.writeReanchorIntent(customerId, id, preserve!).catch((e) =>
        log("reanchor-intent-write-failed", { msg: e instanceof Error ? e.message : String(e) }),
      );
    }
    await audit(`verify_${outcome}`);
    throw new ApiHttpError(
      502,
      "frequency_unverified",
      `Seal accepted the edit but could not be read back (${outcome}); the change may have applied`,
    );
  }

  if (normalizeFrequency(verified.delivery_interval) !== target) {
    log("verification-mismatch", { expected: expectedInterval, actual: verified.delivery_interval });
    await audit("verify_mismatch");
    throw new ApiHttpError(
      502,
      "frequency_not_persisted",
      `Seal accepted the edit but delivery_interval is still "${verified.delivery_interval}" (expected "${expectedInterval}")`,
    );
  }
  await audit("verified");

  // ── re-anclaje ──
  //
  // Seal borra los pendientes y regenera el calendario en asíncrono (~60-100 s,
  // a veces más) anclado en «último cobro + intervalo», ignorando saltos previos.
  // No se puede arreglar en la petición; se deja la intención y el cron drain
  // mueve hacia adelante lo que haga falta. Dentro del corte no se re-ancla:
  // una entrega que ya se está preparando no se toca.
  let nextShipDate: string | null = getNextBillingAttempt(verified)?.date ?? null;
  let reanchor: FrequencyChangeResult["reanchor"] = "none";
  if (preserve !== null) {
    if (!canReanchor) {
      reanchor = "within_cutoff";
    } else {
      try {
        await deps.writeReanchorIntent(customerId, id, preserve);
        nextShipDate = `${preserve}T13:00:00Z`;
        reanchor = "intent_written";
        log("reanchor-intent-recorded", { preserve, reanchorMode });
      } catch (e) {
        // El cambio ya está hecho y verificado; sin intención, la fecha será la que
        // Seal regenere (en modo natural es la misma salvo saltos previos). Se dice.
        log("reanchor-intent-write-failed", { msg: e instanceof Error ? e.message : String(e) });
        reanchor = "intent_failed";
      }
    }
  }

  return {
    changed: true,
    frequency: target,
    previousFrequency: current,
    deliveryInterval: verified.delivery_interval,
    nextShipDate,
    preserveDate: preserve,
    reanchor,
  };
}

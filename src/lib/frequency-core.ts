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
 *   2. La fecha a la que cae la próxima entrega cuando el cliente ESPACIA
 *      (`shiftedNextShipDate` y `spacedNextShipDate`): la que tiene, menos un ciclo
 *      actual, más uno nuevo (`spacedFromNext` de `@/lib/cadence`, la misma función
 *      con la que calculan su vista previa el SkipOverlay y CancelTakeover). Es la
 *      que hay que preservar con el re-anclaje, porque Seal regenera el calendario
 *      por su cuenta y puede caer ANTES (LIT-464). Hasta el 2026-10-02 el área
 *      personal usaba otra, la natural (último cobro completado + intervalo nuevo),
 *      que a quien había saltado le caía en el pasado (PR #122).
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
import { spacedFromNext } from "@/lib/cadence";
import { isWithinCutoff } from "@/lib/cutoff";
import { FREQUENCY_DAYS, longerFrequencies } from "@/lib/plan-options";
import {
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
 * Fecha (YYYY-MM-DD) de la próxima entrega si la frecuencia pasa a `target`,
 * contada DESDE LA QUE YA TIENE: un ciclo actual hacia atrás y uno nuevo hacia
 * delante. De cada 2 a cada 3 meses con la próxima el 4-oct: el 4-nov.
 *
 * Es la que promete el bot de WhatsApp desde el 2026-10-01 (modo `fromNext`,
 * decisión de Kiko). La natural, contada desde el último cobro, dejaba a quien ya
 * había saltado sin escalones cercanos: en la 12320700 (cada 2 meses, último
 * cobro 27-may, próxima 4-oct) 3 y 4 meses caían en agosto y septiembre, y el
 * primero que alejaba la entrega era 5. Contada desde la próxima, un ritmo más
 * largo siempre la aleja. Seal regenera el calendario por su cuenta (en los cuatro
 * casos medidos el 2026-10-02 ancló en el último intento, aunque estuviera
 * saltado, y cayó aquí mismo); si no, el re-anclaje (`seal.reanchorCadence`, que
 * REPROGRAMA todos los pendientes) la lleva hasta aquí. Espejo:
 * `next_date_from_next` de lit-agentic-workflows.
 */
export function shiftedNextShipDate(
  nextAttemptDate: string | null,
  current: Frequency,
  target: Frequency,
): string | null {
  if (!nextAttemptDate) return null;
  return spacedFromNext(new Date(nextAttemptDate), current, target).toISOString().slice(0, 10);
}

/**
 * La fecha de la próxima entrega cuando el cliente ESPACIA desde el área personal:
 * «Ajustar mi plan» del SkipOverlay, la oferta de CancelTakeover y la de la
 * encuesta de perfil. Es la misma cuenta que `shiftedNextShipDate`, y es la que
 * esas tres pantallas ya ENSEÑABAN (`spacedFromNext` de `@/lib/cadence`, que ahora
 * comparten con el backend).
 *
 * Hasta el 2026-10-02 el plan route escribía otra: la natural, contada desde el
 * último cobro completado. A quien había saltado le caía en el pasado (la 12320700:
 * pantalla 4-nov, intención 27-ago), la intención moría en el guard del corte y el
 * re-anclaje no hacía nada. Al cliente se le prometía una fecha y se guardaba otra.
 *
 * Solo devuelve la fecha si de verdad ALEJA la entrega. Si no (frecuencia igual o
 * más corta, que hoy ninguna de las tres ofrece), null: quien llama se queda en la
 * fecha que el cliente ya tiene, porque el próximo cobro nunca va hacia atrás.
 */
export function spacedNextShipDate(
  nextAttemptDate: string | null,
  current: Frequency,
  target: Frequency,
): string | null {
  const shifted = shiftedNextShipDate(nextAttemptDate, current, target);
  if (!shifted || !nextAttemptDate) return null;
  return shifted > nextAttemptDate.slice(0, 10) ? shifted : null;
}

/**
 * En modo `fromNext` la fecha nueva tiene que quedar DESPUÉS de la próxima que ya
 * tiene. Contada desde la próxima, un ritmo más largo siempre lo cumple; se
 * comprueba igual porque es la fecha que se le promete al cliente.
 */
export function assertMovesLater(nextAttemptDate: string | null, newYYYYMMDD: string | null): void {
  if (!nextAttemptDate || !newYYYYMMDD || newYYYYMMDD <= nextAttemptDate.slice(0, 10)) {
    throw new ApiHttpError(
      409,
      "no_gain",
      `The new date ${newYYYYMMDD ?? "?"} would not move the next delivery past ${nextAttemptDate?.slice(0, 10) ?? "?"}`,
    );
  }
}

export interface LongerOptionFromNext {
  frequency: Frequency;
  /** Dónde caería la próxima entrega con esa frecuencia, contada desde la próxima. */
  nextShipDate: string | null;
  /** Si la aleja. Contada desde la próxima, siempre que haya próxima. */
  gains: boolean;
}

/** Las frecuencias más largas con la fecha que promete el bot (`fromNext`). */
export function longerOptionsFromNext(sub: SealSubscription, current: Frequency): LongerOptionFromNext[] {
  const next = getNextBillingAttempt(sub)?.date ?? null;
  return longerFrequencies(current).map((frequency) => {
    const nextShipDate = shiftedNextShipDate(next, current, frequency);
    return {
      frequency,
      nextShipDate,
      gains: !!next && !!nextShipDate && nextShipDate > next.slice(0, 10),
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
 * esta fecha» para que el webhook de Seal y el cron drain (`/api/cron/reanchor-drain`)
 * rematen el trabajo cuando Seal termine de regenerar el calendario. Una intención
 * viva por (cliente, suscripción); la siguiente la sobrescribe.
 *
 * LANZA si no se ha escrito. supabase-js no lanza por sí solo: devuelve `{ error }`,
 * también cuando salta el timeout de `fetchDeadline`. Hasta el 2026-10-05 este
 * `error` no se miraba, así que una intención que no se escribía pasaba por escrita:
 * el plan route anotaba `reanchor-intent-recorded` y devolvía la fecha como hecha, y
 * el `502 reanchor_intent_failed` de la ruta del bot no podía saltar nunca (revisión
 * de Kiko del PR #122). Con `fromNext` la intención es lo único que sujeta la fecha
 * prometida, así que quien llama TIENE que enterarse.
 *
 * `db` solo existe para los tests.
 */
export async function writeReanchorIntent(
  customerId: string,
  sealSubscriptionId: number,
  preserveYYYYMMDD: string,
  db: Pick<ReturnType<typeof supabaseAdmin>, "from"> = supabaseAdmin(),
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await db
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
  if (error) {
    throw new Error(`reanchor intent not written for sub ${sealSubscriptionId} → ${preserveYYYYMMDD}: ${error.message}`);
  }
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
   * `preserve`: se queda en la fecha que ya tenía (cambio de plan normal).
   * `fromNext`: la próxima menos un ciclo actual más uno nuevo
   * (`shiftedNextShipDate`), la que promete el bot desde el 2026-10-01 y la que
   * enseña el área personal; aquí el re-anclaje es lo único que impide que Seal
   * cobre antes, así que sin intención escrita no hay «hecho». (El modo `natural`,
   * último cobro + intervalo nuevo, se quitó el 2026-10-05: no lo usaba nadie.)
   */
  reanchorMode: "preserve" | "fromNext";
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
    reanchorMode === "fromNext"
      ? shiftedNextShipDate(nextIso, current, target)
      : (nextIso?.slice(0, 10) ?? null);

  // En `fromNext` lo que Seal regenere puede caer ANTES de la fecha que tenía el
  // cliente (LIT-464) y solo el re-anclaje lo arregla. Si la fecha no aleja la
  // entrega o ya no se puede re-anclar (corte de 24 h), no se toca Seal.
  if (reanchorMode === "fromNext") {
    assertMovesLater(nextIso, preserve);
    if (isWithinCutoff(`${preserve}T13:00:00Z`)) {
      throw new ApiHttpError(409, "cutoff_passed", `Cannot reanchor onto ${preserve}: within the 24h cutoff`);
    }
  }

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
        // Seal regenere. Se dice. (Desde el 2026-10-05 este catch SÍ salta cuando
        // Supabase no escribe: `writeReanchorIntent` ya no se traga el `error`.)
        const msg = e instanceof Error ? e.message : String(e);
        log("reanchor-intent-write-failed", { msg });
        reanchor = "intent_failed";
        // En `fromNext` lo regenerado puede caer ANTES de la fecha que tenía: sin
        // intención nadie lo mueve y Seal cobraría antes de lo prometido. No hay
        // «hecho»; el 502 avisa a Slack y hay que re-anclar a mano.
        if (reanchorMode === "fromNext") {
          await audit("reanchor_intent_failed");
          throw new ApiHttpError(
            502,
            "reanchor_intent_failed",
            `Frequency changed to ${target} but the reanchor intent to ${preserve} could not be written (${msg}); Seal may charge before it`,
          );
        }
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

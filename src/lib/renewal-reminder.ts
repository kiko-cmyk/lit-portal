/**
 * Engine behind the pre-charge reminder crons. One scan, one dedup, one fire
 * loop — parameterised per bucket (48h, 7d) by {@link RenewalReminderConfig}.
 *
 * Every bucket fires the SAME Klaviyo metric (`subscription_renewal_reminder`)
 * and is told apart by `hoursBefore`, which each flow filters on. Buckets exist
 * as separate crons (not branches of one) so a failure in one never costs the
 * other its send.
 *
 * SOURCE OF TRUTH = SEAL, NOT THE SUPABASE CACHE.
 * Earlier this scanned `subscriptions.next_ship_date` in Supabase, but that
 * table is only a webhook-populated cache: it held ~20% of the live book (the
 * subs that happened to fire a webhook since the webhook was wired up) and went
 * stale when a `billing_attempt.succeeded` was missed (active rows stuck on a
 * past ship date). Result: it fired ~1-2 events/day against a real ~12-26/day of
 * renewals, so almost no reminders went out. We now scan Seal's full book
 * (`seal.listAllSubscriptions`) and read the real next pending billing attempt.
 *
 * Why a cron and not a Seal webhook: Seal only emits POST-charge webhooks
 * (billing_attempt.succeeded/failed), never a pre-charge "upcoming" event, so the
 * only way to remind BEFORE the charge is to scan upcoming billing attempts.
 *
 * WINDOW SHAPE. Each bucket's window is TWICE the cron interval (48h wide for a
 * daily cron) on purpose. A sub's lead time only ever decreases, so the FIRST run
 * that sees it is always in the window's top 24h — i.e. the reminder normally
 * lands at the bucket's nominal lead. The lower half is a self-healing catch-up
 * tail: a missed cron run or a transient Klaviyo failure re-fires the next day
 * instead of being lost forever. A window only as wide as the interval would give
 * each renewal exactly one shot and no recovery.
 *
 * IDEMPOTENCY. A single `email_logs` lookup over the last 5 days builds the set
 * of sealSubscriptionIds already reminded FOR THIS bucket (`template_id` is the
 * dedup partition, so buckets never eat each other's sends), keyed on sub id
 * alone so a mid-window reschedule across a day boundary doesn't re-send. We skip
 * those and write a row immediately after each successful fire. Re-running the
 * cron the same day, a missed run, or a transient single-fire failure never
 * double-sends — and the catch-up tail re-fires anything that was dropped.
 * NOTE: the 5-day lookback is shared by every bucket. Two buckets whose windows
 * sit closer than the lookback are still safe (dedup filters by template_id), but
 * if the lookback ever grows, re-check it against every bucket's cadence.
 *
 * FAILURE IS INVISIBLE WITHOUT THE ALERTS. A cron has no customer to complain and
 * no `withCustomer` wrapper (that is where the rest of the app's Slack alerting
 * lives), so a Seal 5xx that survives the retries, a dedup query error, or Klaviyo
 * rejecting every single fire all end as a 500 that only exists in the Vercel logs.
 * Hence the three alerts below: the run died, the run sent nothing, or it sent but
 * could not record it (risk of re-sending). They are AWAITED — see alert.ts.
 */

import { NextResponse, type NextRequest } from "next/server";
import { alertSlackErrorAwaited } from "./alert";
import { isDryRunRequest } from "./api-helpers";
import { CronAuthError, requireCron } from "./cron-auth";
import { runAsBackgroundJob } from "./http-timeout";
import { klaviyo } from "./klaviyo";
import {
  diffLines,
  type FlavorComposition,
  centsToPrice,
  ladderTotalCents,
  MAX_BOXES,
  planTargetLines,
  repriceInPlace,
  shortLabel,
} from "./mix";
import { BOX_COUNT_BY_VARIANT } from "./seal-plans";
import { getLadderPrices } from "./pricing";
import {
  extractFlavorSummary,
  getBoxCount,
  getChargeTotalCents,
  getComposition,
  getLines,
  getNextBillingAttempt,
  mapStatus,
  normalizeFrequency,
  seal,
  type SealSubscription,
} from "./seal";
import { formatShipDateEs } from "./ship-date-label";
import { supabaseAdmin } from "./supabase";

const H = 60 * 60 * 1000;

/** Dedup lookback — bounds a bucket to one reminder per renewal cycle. */
const DEDUP_LOOKBACK_DAYS = 5;

/** Klaviyo fan-out concurrency. */
const POOL = 6;

export type RenewalReminderConfig = {
  /**
   * `email_logs.template_id` — ALSO the dedup partition. MUST be unique per
   * bucket: two buckets sharing it would make one mark the sub as reminded and
   * the other skip it.
   */
  templateId: string;
  /** Event property every Klaviyo flow filters on. Identifies the bucket. */
  hoursBefore: number;
  /** Window, hours from now: `[fromH, toH)`. Keep it 2x the cron interval. */
  fromH: number;
  toH: number;
  /** Log prefix, e.g. "renewal-reminder 48h". */
  label: string;
  /** Route path, for the Slack alerts. */
  path: string;
  /**
   * Send the saved shipping address in the event. Only the 7d email prints it
   * (its whole point is "confirm your address before we ship"); the 48h email
   * doesn't, and shipping it there would copy a postal address into twice as
   * many Klaviyo event payloads for nothing.
   */
  withShippingAddress?: boolean;
  /** Run the mix price-drift assertion. 48h only — see the check itself. */
  checkMixPrice?: boolean;
};

/** Shipping address exactly as the 7d template reads it (`event.shippingAddress.*`). */
export type ReminderAddress = {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string;
  postalCode: string;
  city: string;
  country: string;
};

type Candidate = {
  sealId: string;
  email: string;
  shipDate: string; // YYYY-MM-DD (dedup key + merge tag)
  nextShipDate: string; // full ISO with tz
  nextShipDateLabel: string; // "30 de julio"
  boxCount: number;
  frequency: string;
  /** Mix summary when split; the plain flavor label otherwise. */
  flavor: string;
  /** Boxes per flavor, so the email can list a mix. */
  composition: FlavorComposition[];
  shippingAddress: ReminderAddress;
};

/**
 * Address for the email. Seal stores whatever checkout sent, and every ES record
 * in the book says "Spain" — which reads wrong in a Spanish email — while the
 * portal's own address form writes "España". Normalise by country code so both
 * origins print the same thing.
 */
function addressOf(s: SealSubscription): ReminderAddress {
  const code = (s.s_country_code ?? "").trim().toUpperCase();
  return {
    firstName: (s.s_first_name ?? "").trim(),
    lastName: (s.s_last_name ?? "").trim(),
    address1: (s.s_address1 ?? "").trim(),
    address2: (s.s_address2 ?? "").trim(),
    postalCode: (s.s_zip ?? "").trim(),
    city: (s.s_city ?? "").trim(),
    country: code === "ES" ? "España" : (s.s_country ?? "").trim(),
  };
}

/**
 * THE MONEY ASSERTION (flavor mix, 2026-07-28).
 *
 * A split subscription carries a CUSTOM per-unit price so a mix costs the same as
 * the equivalent pure plan. If Seal ever refreshes item prices from Shopify (the
 * merchant "propagate product price changes" action, an app update, a price edit),
 * that override is silently replaced by the catalogue price and the customer is
 * over-charged by ~25% with no signal anywhere in the portal.
 *
 * The 48h cron is the last scan of the WHOLE Seal book before every charge, so it
 * is the cheapest possible early-warning: check the split subs and alert while
 * there is still time to fix it before the card is hit. Deliberately NOT run by
 * the 7d bucket — it would only double the Slack alerts for the same drift.
 */
type PriceCheckOutcome = "ok" | "por-debajo" | "no-comparable" | "sobre-cobro";

async function assertMixPrice(
  s: SealSubscription,
  cfg: RenewalReminderConfig,
  boxCount: number,
  composition: FlavorComposition[],
  chargeDate: string,
  /** Lo que este contrato tiene DERECHO a pagar y para CUÁNTAS cajas
   *  (subscriptions.preserved_charge_cents + preserved_box_count). null = paga
   *  catálogo y la escalera es su referencia. */
  preserved: { chargeCents: number; boxCount: number } | null,
): Promise<PriceCheckOutcome> {
  try {
    const lines = getLines(s);
    if (!lines.length) return "no-comparable";

    // ── DOS GUARDAS ANTES DE COMPARAR NADA (31-ago-2026) ──
    //
    // `boxCount` viene de getBoxCount, que CLAMPA a 6. Sin esto, la 13007758 (SL90×4
    // = 12 cajas reales, cobra 271,72) se compararía contra el tramo de 6 (141,75),
    // saldría como sobre-cobro de 129,97 y el heal le rebanaría 130 € a un cliente
    // que paga exactamente la tarifa vieja por caja. Igual la 12752359 con 9 cajas.
    const realBoxes = lines.reduce((sum, l) => sum + l.boxes, 0);
    if (realBoxes !== boxCount || realBoxes > MAX_BOXES) {
      console.warn(
        `[${cfg.label}] sub ${s.id}: ${realBoxes} cajas reales frente a ${boxCount} leídas ` +
          `(clamp de getBoxCount) — fuera de lo que la escalera sabe tarificar, no se compara`,
      );
      return "no-comparable";
    }
    // Una variante fuera del registro cuenta como 1 caja del sabor por defecto (las
    // "LIT Caja Regalo"), así que el número de cajas es una suposición y el precio
    // que saldría de ella también.
    const unmapped = lines
      .map((l) => String(l.variantId))
      .filter((v) => BOX_COUNT_BY_VARIANT[v] === undefined);
    if (unmapped.length) {
      console.warn(
        `[${cfg.label}] sub ${s.id}: variante(s) ${unmapped.join(", ")} fuera del registro ` +
          `de cajas — su número de cajas no es fiable, no se compara`,
      );
      return "no-comparable";
    }

    const prices = await getLadderPrices(composition[0].flavor);
    const catalogueCents = ladderTotalCents(boxCount, prices);
    // ── EL OBJETIVO ES EL CONTRATO, NO SIEMPRE LA ESCALERA (3-sep-2026) ──
    //
    // A un contrato con precio preservado la escalera NO le aplica: tiene derecho a
    // pagar lo suyo. Comparar contra la escalera aquí tendría dos efectos malos, y el
    // segundo es el grave:
    //   - por debajo: se le clasificaría "por-debajo" para siempre (inofensivo pero
    //     ciego, porque es su estado correcto, no una anomalía).
    //   - por ENCIMA: si Seal le pisara una línea al precio de catálogo, el line-set
    //     preservado es idéntico al de una sub nueva legítima, así que `isNewModelLineSet`
    //     sería true y esta función le "curaría" SUBIÉNDOLE el precio hasta el catálogo.
    //     Justo lo contrario de lo que existe para hacer. Antes de preservar precios eso
    //     no era alcanzable: el line-set viejo (SL90/SL180) daba adds+removes y caía en
    //     la rama de curar en sitio.
    // EL IMPORTE PRESERVADO SOLO VALE PARA SUS CAJAS (aviso de Kiko, 3-sep-2026).
    //
    // La regla que decide si se preserva es el nº de cajas, así que un importe sin sus
    // cajas es un dato desacoplado de su propia regla. Un preservado de 3 cajas (67,92)
    // sobre una sub que hoy tiene 4 a catálogo (85,05) le da la vuelta a esta función:
    // ve sobre-cobro, entra a curar, repriceInPlace APLICA y le deja el cobro en 67,92,
    // regalando 17,13 por entrega sobre un contrato legítimo. Se llega ahí por tres
    // caminos nada raros: cambio de cajas fuera del portal (Seal admin, CS, portal de
    // Seal — el webhook actualiza box_count sin tocar estas columnas), un 502 de
    // verificación parcial que sale antes del clear, o que falle el write best-effort
    // que las limpia.
    //
    // La asimetría es lo importante: fallar al ESCRIBIR la preservación es inocuo (la
    // sub se queda a catálogo), pero fallar al LIMPIARLA deja una entitlement fantasma
    // que este cron EJECUTA. Por eso la validación va aquí, en quien la consume, y no
    // solo en quien la escribe: si las cajas no coinciden, la preservación queda inerte
    // y la referencia vuelve a ser el catálogo.
    const preservedApplies = preserved !== null && preserved.boxCount === realBoxes;
    if (preserved !== null && !preservedApplies) {
      console.warn(
        `[${cfg.label}] sub ${s.id}: precio preservado de ${preserved.chargeCents}c para ` +
          `${preserved.boxCount} cajas, pero hoy tiene ${realBoxes} — se ignora y se compara ` +
          `contra el catálogo. Alguien le cambió las cajas fuera del portal, o el clear no corrió.`,
      );
    }
    const expected = preservedApplies ? preserved.chargeCents : catalogueCents;
    const actual = getChargeTotalCents(s);
    // Tolerance = one cent per line: the tier split can legitimately land a cent
    // under (4 boxes as 2+2 is mathematically impossible to hit exactly).
    if (Math.abs(actual - expected) <= lines.length) return "ok";

    // ── GUARDA DE LA ESCALERA (2026-08-22) ──
    //
    // `expected` es ahora la escalera WEB (1-3: n×28,35 · 4: pack 85,05 · 5-6:
    // pack+sueltas). Los contratos del modelo VIEJO (SL90 @67,93, splits con
    // precio custom 22,64/22,65...) quedan POR DEBAJO de ella a propósito y solo
    // se reprecian cuando su dueño edita cajas o mezcla (decisión de Juan). Por
    // debajo de la escalera ya no es una anomalía: es el estado permanente de la
    // escalera vieja, así que ni Slack ni heal — un warn en logs deja rastro.
    //
    // Limitación asumida: si Seal pisara los precios custom de un split viejo con
    // el catálogo (28,35), el total aterriza exactamente en la escalera web y este
    // check ya no puede distinguirlo de una sub nueva legítima. Esa protección
    // murió con el reprecio; la mitigación real es que "propagate price changes"
    // sigue apagado en Seal.
    // Por debajo de la escalera es el estado PERMANENTE de ~560 contratos de la
    // escalera vieja, así que ya no se imprime uno por sub: en el pico de fin de mes
    // caen 91 en la misma ventana y 91 líneas esperadas entierran las de verdad. Se
    // cuenta y runBucket saca una sola línea con el total. El censo
    // (scripts/audit-ladder-drift.ts) es la herramienta para mirar esa población.
    if (actual < expected) return "por-debajo";

    // actual > expected: sobre-cobro respecto a la escalera web. Distinguir si el
    // line-set vivo ya es del modelo nuevo (mismas variantes que el target: pack
    // PACK4-* y/o cajas sueltas) — solo entonces curamos; un line-set del modelo
    // viejo por encima de la escalera (SL120 @90,57 > 85,05) se deja tal cual.
    const plan = planTargetLines(composition, prices);
    const diff = diffLines(lines, plan.lines);
    // Un contrato con precio preservado NUNCA se cura con `plan.lines`: esas líneas van
    // a precio de CATÁLOGO, así que "curarlo" por ahí sería subirle el precio hasta lo
    // que este cambio existe para no cobrarle. Sus líneas ya son las correctas; lo único
    // que puede estar mal es el precio, y eso se arregla en sitio (solo edit_items).
    const isNewModelLineSet =
      !preservedApplies && !diff.adds.length && !diff.removes.length;

    // ── CURAR EN SITIO EL MODELO VIEJO (31-ago-2026) ──
    //
    // Hasta hoy esta rama se rendía: un line-set del modelo viejo por encima de la
    // escalera se dejaba tal cual "hasta que el cliente edite". Eso dejaba a 5 subs
    // cobrando de más de forma indefinida (la 13089232 son 28,35 cada 2 meses) y
    // ninguna se iba a curar sola, porque además el filtro de entrada las excluía.
    //
    // No se cura con `plan.lines`: eso es el line-set del CATÁLOGO, así que para la
    // 13089232 significaría añadir el PACK4 y quitar tres líneas, o sea la ventana
    // add+remove que cobró doble a 7 subs en junio. `repriceInPlace` mantiene las
    // líneas y las cantidades y solo BAJA los precios por unidad, que es la condición
    // que puso Kiko: solo puede bajar hacia el contrato.
    let editsToApply = diff.edits.map((e) => ({
      itemId: e.itemId,
      quantity: e.quantity,
      price: e.unitPrice,
    }));
    let healStrategy: "catalogo" | "en-sitio" = "catalogo";
    // El total que de verdad vamos a dejar escrito. Por el camino del catálogo es el
    // tramo exacto (planTargetLines lo garantiza con un assert interno); por el
    // camino en sitio queda hasta `cajas − 1` céntimos por debajo, porque el reparto
    // por caja usa floor. Verificar contra `expected` en vez de contra esto daba un
    // "FAILED" falso justo en las subs de más cajas: la 14682293 aterriza 3 céntimos
    // por debajo del tramo con solo 2 líneas, y la tolerancia era de 1 céntimo por
    // línea. Un aviso de fallo sobre una cura correcta es la clase de ruido que hace
    // que se dejen de leer los avisos.
    let intendedTotalCents = plan.totalCents;

    if (!isNewModelLineSet) {
      const inPlace = repriceInPlace(lines, expected);
      if (!inPlace) {
        console.warn(
          `[${cfg.label}] sub ${s.id}: charge ${actual}c > escalera web ${expected}c con line-set ` +
            `del modelo viejo, y el reparto en sitio no es posible (alguna línea subiría de precio ` +
            `o sus cajas no son múltiplo de su quantity) — no se toca`,
        );
        await alertSlackErrorAwaited({
          path: cfg.path,
          code: "mix_price_drift",
          msg:
            `sub ${s.id}: cobra ${actual}c y el tramo de ${boxCount} cajas es ${expected}c, pero no ` +
            `se puede bajar en sitio sin reestructurar líneas. A mano. EL COBRO ENTRA ` +
            `${chargeDate.slice(0, 10)}.`,
        });
        return "sobre-cobro";
      }
      healStrategy = "en-sitio";
      if (inPlace.raisesAnyLine) {
        // El total baja, que es lo que paga el cliente, pero alguna línea sube de
        // precio unitario al promediar por caja. Queda dicho en el log para que no
        // sorprenda a quien mire el contrato después.
        console.warn(
          `[${cfg.label}] sub ${s.id}: el reparto en sitio baja el total a ` +
            `${inPlace.totalCents}c pero sube el precio unitario de alguna línea`,
        );
      }
      intendedTotalCents = inPlace.totalCents;
      editsToApply = inPlace.edits.map((e) => ({
        itemId: e.itemId,
        quantity: e.quantity,
        price: centsToPrice(e.unitPriceCents),
      }));
    }

    console.error(`[${cfg.label}] mix price drift`, {
      sealId: s.id, actual, expected, boxCount, charge: chargeDate, healStrategy,
    });

    // ── SELF-HEAL, only in the over-charge direction (aquí siempre lo es) ──
    //
    // An alert that nobody reads within 48h is not a control, so it repairs itself
    // and then reports. Safe to run from a cron: edit_items is idempotent, preserves
    // item ids and does not touch billing_attempts (verified 2026-07-27). El diff es
    // edits-only por construcción (la guarda de arriba ya filtró adds/removes).
    let healed: "not-attempted" | "healed" | "failed" = "not-attempted";
    try {
      if (editsToApply.length) {
        await seal.editItems(s.id, editsToApply);
        await new Promise<void>((r) => setTimeout(r, 1200));
        // Verify by reading back, never by trusting the mutation response.
        const after = await seal.getSubscriptionById(s.id);
        const now = after ? getChargeTotalCents(after) : -1;
        // Contra lo que pretendíamos escribir, no contra el tramo: la tolerancia de
        // un céntimo por línea absorbe el redondeo de Seal, no el del reparto.
        healed = Math.abs(now - intendedTotalCents) <= lines.length ? "healed" : "failed";
      }
    } catch (e) {
      healed = "failed";
      console.error(`[${cfg.label}] self-heal failed for sub ${s.id}:`, e);
    }

    await alertSlackErrorAwaited({
      path: cfg.path,
      code: healed === "healed" ? "mix_price_drift_healed" : "mix_price_drift",
      // El texto tiene que decir contra QUÉ se compara. Con un precio preservado,
      // `expected` NO es el tramo: es lo que ese contrato tiene derecho a pagar, y
      // llamarlo "tier" mandaba a quien lo lee a buscar un fallo de Seal que no existe
      // (aviso de Kiko, 3-sep-2026). Lo mismo con "why Seal dropped them": sobre un
      // contrato preservado la causa probable es un cambio de cajas fuera del portal.
      msg: (() => {
        const ref = preservedApplies
          ? `the preserved contract amount for ${preserved!.boxCount} boxes is ${expected}c`
          : `the ${boxCount}-box tier is ${expected}c`;
        const causa = preservedApplies
          ? `This sub has a preserved (legacy) price, so check whether its boxes changed outside the portal before blaming Seal.`
          : `Worth checking why Seal dropped them.`;
        return healed === "healed"
          ? `sub ${s.id}: charge total was ${actual}c but ${ref} — the per-unit prices were ` +
            `REPAIRED automatically and verified. Charge lands ${chargeDate.slice(0, 10)}. ${causa}`
          : `sub ${s.id}: charge total ${actual}c but ${ref}. ` +
            `Automatic repair ${healed === "failed" ? "FAILED" : "was not possible"}. ` +
            `THE CHARGE LANDS ${chargeDate.slice(0, 10)} — fix before then.`;
      })(),
    });
    return "sobre-cobro";
  } catch (e) {
    // Never let the price check stop the reminder from going out.
    console.warn(`[${cfg.label}] price check failed for sub ${s.id}:`, e);
    return "no-comparable";
  }
}

export async function runRenewalReminder(
  req: NextRequest,
  cfg: RenewalReminderConfig,
): Promise<NextResponse> {
  try {
    requireCron(req);
  } catch (err) {
    if (err instanceof CronAuthError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  // Dry run (non-prod only, see api-helpers.dryRunAllowed): scan and build the
  // exact payloads, fire nothing, write nothing. This is how you verify a bucket
  // against the real book without emailing anyone or burning its dedup rows.
  const dryRun = isDryRunRequest(req);

  try {
    // No App Proxy is waiting on a cron, so the Seal client may use its wider
    // budget and its retry-on-stall (incident 2026-07-30: one page crossing 6s
    // killed the whole run and nobody got their email). Entered only AFTER
    // requireCron passed, so no interactive request can ever reach either.
    return await runAsBackgroundJob(() => runBucket(cfg, dryRun));
  } catch (err) {
    // Still re-thrown after alerting, so Vercel marks the run as failed.
    await alertSlackErrorAwaited({
      path: cfg.path,
      code: "renewal_reminder_failed",
      msg:
        `${cfg.label} murió: ${err instanceof Error ? err.message : String(err)}. ` +
        `Nadie recibió aviso en esta tirada; la cola de la ventana lo reintenta mañana.`,
    });
    throw err;
  }
}

async function runBucket(
  cfg: RenewalReminderConfig,
  dryRun: boolean,
): Promise<NextResponse> {
  const sb = supabaseAdmin();
  const now = Date.now();
  const lower = now + cfg.fromH * H;
  const upper = now + cfg.toH * H;

  // 1. Scan the whole Seal book and keep ACTIVE subs whose next pending charge
  //    lands in this bucket's window. (A failed page propagates → we fail loud
  //    rather than remind a truncated slice of the book.)
  const subs = await seal.listAllSubscriptions();

  // Los importes preservados de toda la cartera, en UNA consulta: el bucle recorre
  // cientos de subs y no vamos a pedir una fila por cada una. Si la consulta falla, el
  // mapa queda vacío y assertMixPrice compara contra el catálogo, que es exactamente el
  // comportamiento anterior a este campo: se pierde precisión, no se rompe la tirada.
  // TOPE DE 1.000 FILAS de Supabase/PostgREST: hoy son ~533 preservadas y este
  // select no pagina. Si la cifra se acerca al millar hay que paginar, porque las
  // que se queden fuera se comparan contra el catálogo en silencio (degrada seguro,
  // pero degrada). El contador de abajo lo deja a la vista en cada tirada.
  const preservedBySealId = new Map<string, { chargeCents: number; boxCount: number }>();
  if (cfg.checkMixPrice) {
    const { data: preservedRows, error: preservedErr } = await sb
      .from("subscriptions")
      .select("seal_subscription_id, preserved_charge_cents, preserved_box_count")
      .not("preserved_charge_cents", "is", null);
    if (preservedErr) {
      console.warn(
        `[${cfg.label}] no se pudieron leer los precios preservados (${preservedErr.message}) — ` +
          `se comparará contra el catálogo en esta tirada`,
      );
    } else {
      if ((preservedRows ?? []).length >= 1000) {
        console.warn(
          `[${cfg.label}] el select de precios preservados ha devuelto ${preservedRows!.length} filas: ` +
            `se está tocando el tope de 1.000 de PostgREST y hay preservaciones sin cargar. HAY QUE PAGINAR.`,
        );
      }
      for (const row of preservedRows ?? []) {
        const cents = Number(row.preserved_charge_cents);
        const boxes = Number(row.preserved_box_count);
        // Sin cajas no se puede validar contra qué composición vale el importe, así
        // que la fila se descarta: preferimos comparar contra el catálogo (el
        // comportamiento de antes de la columna) a aplicar un importe a ciegas.
        if (!Number.isInteger(cents) || cents <= 0) continue;
        if (!Number.isInteger(boxes) || boxes <= 0) {
          console.warn(
            `[${cfg.label}] sub ${row.seal_subscription_id}: precio preservado sin nº de cajas ` +
              `— se ignora (fila anterior a la migración o escritura a medias)`,
          );
          continue;
        }
        preservedBySealId.set(String(row.seal_subscription_id), { chargeCents: cents, boxCount: boxes });
      }
    }
  }

  const candidates: Candidate[] = [];
  const priceCheck: Record<PriceCheckOutcome, number> = {
    "ok": 0,
    "por-debajo": 0,
    "no-comparable": 0,
    "sobre-cobro": 0,
  };
  for (const s of subs) {
    if (mapStatus(s) !== "active") continue; // skips paused / post_cancel / cancelled
    const next = getNextBillingAttempt(s);
    if (!next?.date) continue;
    const t = Date.parse(next.date);
    if (Number.isNaN(t) || t < lower || t >= upper) continue;
    const email = s.email?.trim();
    if (!email) continue;
    const boxCount = getBoxCount(s);
    const composition = getComposition(s);

    // Antes solo se revisaban las subs SPLIT (`getShape(s) === "split"`, o sea 2+
    // sabores), así que una sub de un solo sabor no se miraba JAMÁS, ni un PACK4
    // nuevo. Por eso ninguna de las 5 que cobran de más se curaba nunca: todas son
    // de un solo sabor. (Aviso de Kiko, 31-ago-2026.)
    if (cfg.checkMixPrice) {
      priceCheck[
        await assertMixPrice(
          s, cfg, boxCount, composition, next.date,
          preservedBySealId.get(String(s.id)) ?? null,
        )
      ]++;
    }

    candidates.push({
      sealId: String(s.id),
      email,
      shipDate: next.date.slice(0, 10),
      nextShipDate: next.date,
      nextShipDateLabel: formatShipDateEs(next.date),
      boxCount,
      frequency: normalizeFrequency(s.delivery_interval),
      // The mix summary, so the email names both flavors. A single flavor yields
      // the same string extractFlavor always returned.
      flavor: extractFlavorSummary(s),
      composition,
      shippingAddress: addressOf(s),
    });
  }

  if (cfg.checkMixPrice) {
    console.log(
      `[${cfg.label}] precios: ${priceCheck.ok} al tramo · ${priceCheck["por-debajo"]} por debajo ` +
        `(escalera vieja, no se tocan) · ${priceCheck["no-comparable"]} no comparables · ` +
        `${priceCheck["sobre-cobro"]} con sobre-cobro`,
    );
  }

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, dryRun, scanned: subs.length, candidates: 0, fired: 0 });
  }

  const sealIds = candidates.map((c) => c.sealId);

  // 2. Dedup: one query for everything this bucket reminded in the last 5 days,
  //    keyed on sealSubscriptionId alone (stored in metadata) — so dedup never
  //    depends on a Shopify customer id, and a legitimate reschedule that moves
  //    the charge across a calendar day mid-window does not re-send.
  //    FAIL LOUD on a query error: a silent empty dedup set would re-fire the
  //    whole in-window book (up to the ~130-customer month-end spike).
  const { data: sentRows, error: dedupErr } = await sb
    .from("email_logs")
    .select("metadata")
    .eq("template_id", cfg.templateId)
    .gte("sent_at", new Date(now - DEDUP_LOOKBACK_DAYS * 24 * H).toISOString());
  if (dedupErr) {
    throw new Error(`${cfg.label} dedup query failed: ${dedupErr.message}`);
  }
  const alreadySent = new Set<string>(
    ((sentRows ?? []) as Array<{ metadata: { sealSubscriptionId?: string } | null }>)
      .map((r) => r.metadata?.sealSubscriptionId)
      .filter((id): id is string => Boolean(id)),
  );

  // 3. Best-effort enrichment from the Supabase cache (no Shopify calls): a real
  //    customer_id and the persisted language. Subs not in the cache get a
  //    `seal:<id>` placeholder id and Spanish (the only live template language).
  const { data: cacheRows } = await sb
    .from("subscriptions")
    .select("seal_subscription_id, customer_id")
    .in("seal_subscription_id", sealIds);
  const customerBySeal = new Map<string, string>();
  for (const r of (cacheRows ?? []) as Array<{ seal_subscription_id: string | null; customer_id: string | null }>) {
    if (r.seal_subscription_id && r.customer_id) {
      customerBySeal.set(String(r.seal_subscription_id), String(r.customer_id));
    }
  }
  const customerIds = [...new Set(customerBySeal.values())];
  const langByCustomer = new Map<string, string>();
  if (customerIds.length > 0) {
    const { data: prefRows } = await sb
      .from("customer_preferences")
      .select("customer_id, language")
      .in("customer_id", customerIds);
    for (const r of (prefRows ?? []) as Array<{ customer_id: string | null; language: string | null }>) {
      if (r.customer_id) langByCustomer.set(String(r.customer_id), r.language === "en" ? "en" : "es");
    }
  }

  const localeFor = (c: Candidate): string => {
    const customerId = customerBySeal.get(c.sealId);
    return customerId ? langByCustomer.get(customerId) ?? "es" : "es";
  };

  // OJO SI AÑADES UN IMPORTE AQUÍ: tiene que salir de getChargeTotalCents(s) o de
  // preserved_charge_cents, NUNCA de ladderTotalCents (importado en este mismo fichero
  // para el chequeo de precios). Desde el 3-sep-2026 hay ~533 contratos que pagan por
  // debajo del catálogo, así que la escalera diría 85,05 en un email cuya tarjeta se
  // va a cobrar 67,93. Hoy el payload no lleva precio y por eso ningún email puede
  // contradecir al cobro.
  const eventProps = (c: Candidate, locale: string): Record<string, unknown> => ({
    hoursBefore: cfg.hoursBefore,
    sealSubscriptionId: c.sealId,
    // RAW ISO, NEVER FORMATTED. This field stopped being a presentation field:
    // the Klaviyo flow's WhatsApp webhook forwards it to Permut as
    // `expected_date`, which matches the exact Seal billing attempt when a
    // customer asks to skip. Format it here and the skip stops finding the
    // charge — silently: it falls to human handoff and the delivery that the
    // customer asked to skip ships anyway. Presentation goes in
    // `nextShipDateLabel`.
    nextShipDate: c.nextShipDate,
    nextShipDateLabel: c.nextShipDateLabel,
    boxCount: c.boxCount,
    frequency: c.frequency,
    flavor: c.flavor,
    is_mix: c.composition.length > 1,
    flavor_mix: c.composition.map((x) => ({ flavor: shortLabel(x.flavor), boxes: x.boxes })),
    locale,
    ...(cfg.withShippingAddress ? { shippingAddress: c.shippingAddress } : {}),
  });

  const pending = candidates.filter((c) => !alreadySent.has(c.sealId));

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      scanned: subs.length,
      candidates: candidates.length,
      skippedDedup: candidates.length - pending.length,
      wouldFire: pending.length,
      events: pending.map((c) => ({ email: c.email, properties: eventProps(c, localeFor(c)) })),
    });
  }

  // 4. Fire the event for the not-yet-reminded candidates (bounded concurrency).
  //    Write each dedup row IMMEDIATELY after its successful fire — not in one
  //    bulk insert at the end — so a transient insert failure only loses dedup
  //    for that single row (which the catch-up tail re-fires next run) instead
  //    of letting the whole batch double-send tomorrow.
  let fired = 0;
  let logFailures = 0;

  for (let start = 0; start < pending.length; start += POOL) {
    const wave = pending.slice(start, start + POOL).map(async (c) => {
      try {
        await klaviyo.trackEvent("subscription_renewal_reminder", c.email, eventProps(c, localeFor(c)));
      } catch (err) {
        // PII sweep: log the Seal sub id, not the email. No dedup row is written,
        // so the catch-up tail re-fires this sub on the next daily run.
        console.warn(`[${cfg.label}] klaviyo failed for seal sub ${c.sealId}:`, err);
        return;
      }
      fired++;
      const { error: logErr } = await sb.from("email_logs").insert({
        customer_id: customerBySeal.get(c.sealId) ?? `seal:${c.sealId}`,
        template_id: cfg.templateId,
        metadata: { shipDate: c.shipDate, hoursBefore: cfg.hoursBefore, sealSubscriptionId: c.sealId },
      });
      if (logErr) {
        // Event already fired but we couldn't record it → may re-send next run.
        logFailures++;
        console.error(
          `[${cfg.label}] FIRED but email_logs insert failed for seal sub ${c.sealId} (ship ${c.shipDate}) — may re-send next run:`,
          logErr.message,
        );
      }
    });
    await Promise.all(wave);
  }

  // A run that scanned fine and emailed nobody looks identical to a quiet day in
  // the logs, so say it out loud.
  if (pending.length > 0 && fired === 0) {
    await alertSlackErrorAwaited({
      path: cfg.path,
      code: "renewal_reminder_no_fires",
      msg:
        `${cfg.label}: ${pending.length} suscripción(es) tocaban aviso y Klaviyo rechazó TODAS. ` +
        `Nadie recibió email en esta tirada.`,
    });
  }
  if (logFailures > 0) {
    await alertSlackErrorAwaited({
      path: cfg.path,
      code: "renewal_reminder_dedup_write_failed",
      msg:
        `${cfg.label}: disparados ${fired}, pero ${logFailures} insert(s) en email_logs fallaron. ` +
        `Esas subs pueden recibir el aviso OTRA VEZ en la siguiente tirada.`,
    });
  }

  return NextResponse.json({
    ok: true,
    scanned: subs.length,
    candidates: candidates.length,
    skippedDedup: candidates.length - pending.length,
    fired,
    logFailures,
  });
}

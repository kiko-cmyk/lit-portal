import { randomUUID } from "node:crypto";
import { ApiHttpError, isDryRunRequest, withCustomer } from "@/lib/api-helpers";
import { isWithinCutoff } from "@/lib/cutoff";
import { mixEnabledForCustomer } from "@/lib/flags";
import { classifyLineState, LINE_REPAIR_TTL_MS, sealWriteDefinitelyRejected } from "@/lib/line-repair";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requestDeadlineLeft, runWithoutRequestDeadline, runWithRequestDeadline } from "@/lib/http-timeout";
import { acquirePlanLock } from "@/lib/plan-lock";
import { alertSlackError, alertSlackErrorAwaited } from "@/lib/alert";
import { naturalNextShipDate, SEAL_INTERVAL_BY_FREQUENCY, VALID_FREQUENCIES, writeReanchorIntent } from "@/lib/frequency-core";
import { findAllAppliedDiscountCodeIds, getChargeTotalCents, getLines, getNextBillingAttempt, mapToSubscription, normalizeFrequency, seal, type SealSubscription } from "@/lib/seal";
import { ensureDiscoveryCreditAttached, pendingDiscoveryCreditForSub } from "@/lib/discovery-renewal-credit";
import {
  centsToPrice,
  chargeTotalCents,
  compositionFromLines,
  compositionLabel,
  diffLines,
  type FlavorComposition,
  ladderTotalCents,
  type TargetLine,
  type LadderPrices,
  MAX_BOXES,
  type MixPlan,
  mixBoxCount,
  planFromCurrentLines,
  planPreservingCharge,
  planTargetLines,
  priceToCents,
  resplitOnBoxChange,
  sameComposition,
  shapeFor,
  type SubscriptionLine,
  validateMix,
} from "@/lib/mix";
import { getLadderPricesForWrite, PricingConfigError } from "@/lib/pricing";
import {
  BOX_COUNT_BY_VARIANT,
  DEFAULT_FLAVOR,
  type FlavorKey,
  flavorKeyForVariant,
  flavorLabel,
  isFlavorKey,
  SELLING_PLAN_BY_FREQUENCY,
} from "@/lib/seal-plans";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { verifyOwnershipFast } from "@/lib/sub-ownership";
import { requestedSubIdFrom } from "@/lib/sub-resolve";
import { supabaseAdmin } from "@/lib/supabase";
import type { Frequency, Subscription } from "@/lib/types";

// `writeReanchorIntent` y `VALID_FREQUENCIES` viven en `@/lib/frequency-core` desde el
// 2026-09-21, compartidos con la entrada máquina a máquina de frecuencia.

/**
 * PATCH /apps/portal/api/subscription/plan
 *
 * Body: { boxCount?: 1..6, frequency?: Frequency }
 *
 * Rewrite 2026-05-14: mutates via Seal Merchant API using `add_items +
 * remove_items` (confirmed by Seal support as the only API path for swapping
 * a subscription's products). Prior attempt to mutate Shopify contracts
 * directly was blocked by the `_own` scope limitation — our app cannot see
 * Seal-owned contracts.
 *
 * Order of operations:
 *   1. add_items(new variant)  — must come FIRST. If it fails we abort
 *      cleanly with the sub still containing the original item.
 *   2. remove_items(old item)  — only runs after add succeeds.
 *   3. (optional) edit { delivery_interval } when frequency changed —
 *      Seal stores cadence at the subscription level too, separate from
 *      each item's selling_plan_id.
 *
 * Open questions to validate empirically:
 *   - Does add_items respect selling_plan_id, or does Seal force the new
 *     item to inherit the sub's existing cadence?
 *   - Does Seal's `edit` with delivery_interval actually mutate, or is it
 *     the same silent no-op we saw on item edits?
 */
/**
 * Whole-request wall-clock budget, shared by every upstream call inside.
 *
 * Why (incident 2026-09-04): this route makes THREE Seal calls back to back
 * (edit_items → add_items → remove_items), each with its own 9 s total budget,
 * plus two 500 ms settle sleeps and a ~4 s verification read. Nothing bounded
 * the sum, so a slow Seal day reached ~28 s while Shopify's App Proxy stops
 * waiting at ~10 s: the customer got `gateway_timeout` and the invocation was
 * killed BETWEEN add_items and remove_items, leaving the old and the new lines
 * both live and the next charge too high. Three subscriptions were left
 * overcharging by 113.40 EUR/cycle before anyone noticed.
 *
 * This REVERSES a deliberate decision documented in address/route.ts:29-31,
 * which excluded /plan on the grounds that "being killed early is worse than
 * being slow (partial state)" and that per-call deadlines were protection
 * enough. The premise was right; the conclusion did not hold. Per-call budgets
 * never bound the SUM, so the route was killed anyway — just later, at Vercel's
 * 60 s, on a request nobody was listening to, and precisely between add_items
 * and remove_items. "Slow" was never on the menu; the real choice was between
 * dying early with a compensation and dying late without one.
 *
 * What makes early death safe now is the pre-armed repair intent below plus the
 * recovery paths running under `runWithoutRequestDeadline`: an aborted swap
 * leaves a row the cron converges, instead of a silent double charge. Without
 * that half of the fix, the original objection would still stand.
 *
 * 9.5 s, same as the address route, sized just under the proxy's patience.
 */
const REQUEST_BUDGET_MS = 9_500;

/**
 * Hard ceiling, above REQUEST_BUDGET_MS so the deadline is what normally stops
 * us, not the kill. The extra room is for the compensation work that runs
 * outside the budget (repair intent, remove retry, snapshot restore) once the
 * customer's response is already lost. The 60 s default let a doomed request
 * mutate Seal for another ~50 s with nobody listening.
 */
export const maxDuration = 20;

export const PATCH = withCustomer<Subscription>((req, ctx) =>
  runWithRequestDeadline(REQUEST_BUDGET_MS, () => patchPlan(req, ctx)),
);

const patchPlan = async (
  req: Parameters<Parameters<typeof withCustomer<Subscription>>[0]>[0],
  ctx: Parameters<Parameters<typeof withCustomer<Subscription>>[0]>[1],
) => {
  await enforceRateLimit(ctx.customerId, "plan", { limit: 10, windowMs: 60_000 });

  const t0 = Date.now();
  const log = (step: string, extra?: Record<string, unknown>) =>
    console.log(
      `[plan-change] ${step} t+${Date.now() - t0}ms customer=${ctx.customerId}`,
      extra ?? {},
    );

  const body = (await req.json().catch(() => ({}))) as {
    boxCount?: number;
    frequency?: Frequency;
    /**
     * Target flavor (product) to swap to. Omitted → keep the current flavor.
     * A flavor change is the SAME variant swap (add_items + remove_items) as a
     * box-count change, just to a different product's variant for the same box
     * count — so it reuses every safety guard below (ownership, retention
     * discount carry-over, verification, rollback). See lib/seal-plans FLAVORS.
     */
    flavor?: FlavorKey;
    /**
     * Target flavor MIX: boxes per flavor, e.g.
     *   [{ flavor: "salty-lemon", boxes: 2 }, { flavor: "salty-watermelon", boxes: 1 }]
     *
     * AUTHORITATIVE for the box count — the sum IS the target — so a mix change and a
     * box-count change are the same operation. Mutually exclusive with `flavor`; if
     * `boxCount` is also sent it must equal the sum.
     *
     * A single-entry mix is a pure flavor and resolves to today's pack variant, so
     * existing subscribers need no migration.
     */
    mix?: unknown;
    /** Optional fast-path: when present, skips the slow Seal pagination. */
    sealSubscriptionId?: number | string;
    mainItemId?: number;
    currentVariantId?: string;
    currentFrequency?: Frequency;
    /**
     * Optimistic concurrency for mix-aware clients: the Seal item ids the client
     * believes the subscription has. If the live set differs, the customer is acting
     * on a stale screen and we refuse rather than apply a diff against a state they
     * never saw. A tab left open for a day is exactly how a mix gets destroyed.
     */
    expectedLineIds?: number[];
    /**
     * The customer's current next-ship date (ISO), sent by the FE so we can
     * re-anchor it after Seal regenerates billing_attempts. Without this, a
     * plan change snaps the next charge back to "today + interval" and
     * silently undoes a prior skip. See re-anchor block near the end.
     */
    preserveNextShipDate?: string | null;
    /**
     * Quién originó el cambio. `portal` por defecto (el cliente lo tocó a mano
     * en la pantalla de plan). El formulario de perfilado manda
     * `profile_survey`, que es lo que permite responder "¿cuántos cambios de
     * cadencia salieron de la encuesta?" desde `subscription_changes`, sin
     * depender de Klaviyo ni de cruzar por fechas. Antes iba hardcodeado y esa
     * pregunta no tenía respuesta.
     */
    source?: string;
    /**
     * Re-anchor policy after a frequency change:
     *   - "preserve" (default): keep the current next-ship date (don't move the
     *     imminent order or undo a prior skip). This is the normal plan-change
     *     behaviour for the Change Plan overlay.
     *   - "natural": let the next order land on Seal's natural regenerated date
     *     (last completed charge + new interval). Used by the skip retention
     *     flow when a customer chooses to space out their cadence instead of
     *     skipping — the imminent order moves later as the customer expects.
     */
    reanchorMode?: "preserve" | "natural";
    /** Simulación: compute + return the projected result without mutating Seal. */
    dryRun?: boolean;
  };
  log("body", { ...body, sealSubscriptionId: body.sealSubscriptionId });

  const dryRun = isDryRunRequest(req, body, ctx.customerId);
  const reanchorMode: "preserve" | "natural" = body.reanchorMode === "natural" ? "natural" : "preserve";
  // Pre-mutation subscription, captured during resolution below. Needed to read
  // the last completed charge date when computing the natural re-anchor target.
  let preMutationSub: SealSubscription | null = null;

  if (
    body.boxCount !== undefined &&
    (!Number.isInteger(body.boxCount) || body.boxCount < 1 || body.boxCount > 6)
  ) {
    throw new ApiHttpError(400, "invalid_box_count", "boxCount must be integer 1..6");
  }
  if (body.frequency !== undefined && !VALID_FREQUENCIES.includes(body.frequency)) {
    throw new ApiHttpError(400, "invalid_frequency", `Unknown frequency: ${body.frequency}`);
  }
  if (body.flavor !== undefined && !isFlavorKey(body.flavor)) {
    throw new ApiHttpError(400, "invalid_flavor", `Unknown flavor: ${body.flavor}`);
  }

  // ── mix ──
  // Validated before anything else touches Seal or Shopify. Unknown flavor keys are
  // REJECTED rather than dropped: silently ignoring an unrecognised entry would ship
  // 1 box to a customer who asked for 3.
  let requestedMix: FlavorComposition[] | null = null;
  if (body.mix !== undefined && body.mix !== null) {
    if (body.flavor !== undefined) {
      throw new ApiHttpError(400, "conflicting_flavor_intent", "Send `mix` or `flavor`, not both");
    }
    const v = validateMix(body.mix);
    if (!v.ok) {
      throw new ApiHttpError(400, "invalid_mix", `Invalid mix (${v.code})`);
    }
    requestedMix = v.mix;
    // Gate CREATION of a mix, not a single-flavor composition: a one-entry `mix` is
    // the `flavor` path in new clothes, so the whole refactor ships with mixing off.
    if (requestedMix.length > 1 && !mixEnabledForCustomer(ctx.customerId)) {
      throw new ApiHttpError(403, "mix_not_enabled", "Flavor mix is not available for this account");
    }
    const sum = mixBoxCount(requestedMix);
    if (body.boxCount !== undefined && body.boxCount !== sum) {
      throw new ApiHttpError(
        400,
        "mix_box_count_mismatch",
        `mix sums to ${sum} but boxCount is ${body.boxCount}`,
      );
    }
  }

  if (
    body.boxCount === undefined &&
    body.frequency === undefined &&
    body.flavor === undefined &&
    requestedMix === null
  ) {
    throw new ApiHttpError(400, "no_changes", "Provide boxCount, frequency, flavor and/or mix");
  }

  // Fast-path: the FE passed sealSubscriptionId + mainItemId + currentVariantId
  // + currentFrequency from its cached dashboard state. Use them directly
  // and skip the ~5 s Seal pagination scan that used to dominate this
  // route. We still resolve email once for ownership verification.
  //
  // Slow-path (fallback): no IDs in body → call getSubscriptionsByEmail
  // and pick the active sub. Kept for backwards compat (mobile that
  // sends an older payload) but should be rare.
  let sealSubscriptionId: number;
  let mainItemNumericId: number;
  let mainItemVariantId: string;
  let currentFrequency: Frequency;
  let nextAttemptDate: string | null = null;

  const ownsOkFast =
    body.sealSubscriptionId !== undefined
      ? await verifyOwnershipFast(Number(body.sealSubscriptionId), ctx.customerId)
      : false;

  if (
    body.sealSubscriptionId &&
    body.mainItemId &&
    body.currentVariantId &&
    body.currentFrequency &&
    ownsOkFast
  ) {
    sealSubscriptionId = Number(body.sealSubscriptionId);
    mainItemNumericId = body.mainItemId;
    mainItemVariantId = body.currentVariantId;
    currentFrequency = body.currentFrequency;
    log("fastpath-ids-from-body", { sealSubscriptionId, mainItemNumericId });
  } else {
    log("slowpath-pagination-scan");
    const url2 = new URL(req.url);
    const devEmail = process.env.NODE_ENV === "development" ? url2.searchParams.get("__dev_email") : null;
    const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
    if (!email) {
      throw new ApiHttpError(404, "customer_not_found", `No email for ${ctx.customerId}`);
    }
    const sealSubsList = await seal.getSubscriptionsByEmail(email);
    // Multi-sub: if the FE named a sub (body/query id) but the fast-path missed
    // (cache gap / Seal blip), we must still change THAT sub's plan — never
    // "the first ACTIVE" one. No id → old auto-pick (older payloads).
    const requestedSubId = requestedSubIdFrom(req, body.sealSubscriptionId);
    const matched = requestedSubId
      ? sealSubsList.find((s) => String(s.id) === requestedSubId) ?? null
      : sealSubsList.find((s) => s.status === "ACTIVE") ??
        sealSubsList.sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0];
    if (!matched) {
      throw new ApiHttpError(404, "subscription_not_found", `No Seal subscription for ${email}`);
    }
    assertSubscriptionBelongsToCustomer(matched, email, "subscription/plan");
    preMutationSub = matched;

    const main = matched.items.find((it) => !it.is_one_time_item) ?? matched.items[0];
    if (!main) {
      throw new ApiHttpError(500, "no_main_line", "Seal subscription has no items");
    }
    sealSubscriptionId = matched.id;
    mainItemNumericId = main.id;
    mainItemVariantId = main.variant_id;
    currentFrequency = normalizeFrequency(matched.delivery_interval);

    const nextAttempt = (matched.billing_attempts ?? []).find(
      (ba) => !ba.completed_at && !ba.status && !ba.skipped_on,
    );
    nextAttemptDate = nextAttempt?.date ?? null;
  }
  log("sub-resolved", { sealSubscriptionId, mainItemNumericId, currentFrequency });

  // Audit 2026-05-21 finding #10: validate `mainItemId` (from body in
  // fast-path) actually belongs to THIS subscription before we use it
  // in `removeItems`. Without this an authenticated customer could
  // pass any item id (e.g. from another sub of theirs, or simply
  // guessed) and trigger removeItems on it. Costs one extra Seal
  // GET (~300ms via getSubscriptionById which is singular, not the
  // 33-page paginated scan); acceptable for the security gain.
  // Only validate when variantChanged (which is the only path that
  // calls removeItems) AND when we came via fast-path (slow-path
  // already has the sub object). Cheap enough either way.
  if (body.sealSubscriptionId !== undefined) {
    const subForCheck = await seal.getSubscriptionById(sealSubscriptionId);
    preMutationSub = subForCheck;
    const ownsItem = (subForCheck?.items ?? []).some(
      (it) => Number(it.id) === Number(mainItemNumericId) && !it.is_one_time_item,
    );
    if (!ownsItem) {
      log("item-ownership-mismatch", { mainItemNumericId });
      throw new ApiHttpError(
        403,
        "item_ownership_mismatch",
        "mainItemId does not belong to this subscription",
      );
    }
    // Read the CURRENT next charge straight from Seal (fast path didn't have
    // the sub object). This is the authoritative date to preserve — using the
    // FE-sent value risks a timezone-truncated day (a local-midnight ISO
    // slices to the day BEFORE; that bug put 27-Jul in as 26-Jul).
    if (subForCheck && nextAttemptDate === null) {
      nextAttemptDate = getNextBillingAttempt(subForCheck)?.date ?? null;
    }
  }

  // Refuse plan changes on a PAUSED sub (2026-07-28). Deliberately HERE and not
  // inside either resolution branch: `preMutationSub` is the one thing both paths
  // populate (slow path from the email scan, fast path from the by-id read above),
  // so this is the only place a single check covers both.
  //
  // An earlier draft of this guard sat inside the slow-path `else`, which made it
  // dead code: verifyOwnershipFast only checks that a cache row exists for
  // (customer_id, seal_subscription_id) and never reads status, and every real
  // caller (PlanOverlay, FlavorOverlay) sends the four fast-path ids, so 100% of
  // production traffic skipped it. Caught by review before shipping.
  //
  // Why it matters: a paused sub has no pending billing attempt, so
  // `nextAttemptDate` is null and the cutoff check right below passes silently.
  // Without this, edit + add_items + remove_items ran against a paused
  // subscription with no cutoff protection at all.
  if (preMutationSub?.status === "PAUSED") {
    throw new ApiHttpError(
      400,
      "subscription_paused",
      "Resume the subscription before changing the plan",
    );
  }

  // Optimistic concurrency (replaces the Phase 1 multi-line block): when a
  // mix-aware client tells us which lines it saw, refuse if the live set differs.
  // Applying a diff against a state the customer never saw is how a mix silently
  // becomes something else.
  if (preMutationSub && body.expectedLineIds?.length) {
    const live = new Set(getLines(preMutationSub).map((l) => l.itemId));
    const expected = new Set(body.expectedLineIds.map(Number));
    const same = live.size === expected.size && [...expected].every((id) => live.has(id));
    if (!same) {
      log("subscription-changed", { live: [...live], expected: [...expected] });
      throw new ApiHttpError(
        409,
        "subscription_changed",
        "This subscription changed since the page loaded; reload and try again",
      );
    }

  }

  // Cutoff against next billing attempt date (only when we have it from
  // the slow path; on fast path we trust the FE's cutoff state which is
  // already enforced at the QuickActionButton level via `disabled={withinCutoff}`).
  if (nextAttemptDate && isWithinCutoff(nextAttemptDate)) {
    throw new ApiHttpError(400, "cutoff_passed", "Cannot change plan within 24h of next ship");
  }

  // CERROJO (2026-09-04). Desde aquí hasta el final hay hasta tres mutaciones en Seal,
  // y `expectedLineIds` de arriba NO las protege de la concurrencia: es una lectura
  // seguida de una escritura, así que dos peticiones simultáneas leen el mismo estado,
  // las dos lo ven igual al esperado y las dos ejecutan `add_items` sobre las mismas
  // variantes. Líneas duplicadas y cliente pagando de más, con un doble clic bastando
  // para provocarlo. Se libera en el `finally` de más abajo.
  // EL LEDGER SIEMPRE SE CIERRA (2-oct-2026). Hasta hoy solo el camino feliz escribía
  // fila después del `intent`: cualquier 502 (add o remove fallidos, restore, red sin
  // armar) salía con el `intent` colgando para siempre. Del 30-ago al 2-oct fueron 22
  // de 448 cambios, y el detector de reprecios no podía distinguir "murió a medias" de
  // "falló limpio" de "lo terminó el cron", así que los cantaba todos igual. Ahora toda
  // salida por error posterior al `intent` deja su cierre: `pending_repair` si hay una
  // reparación armada (la cerrará el cron con `applied` o `rolled_back`) y `failed` si
  // Seal sigue como estaba. Solo una muerte súbita deja el `intent` sin cerrar, y eso es
  // exactamente lo que el detector tiene que ver.
  const ledger: RequestLedger = {
    requestId: randomUUID(),
    open: false,
    repairArmed: false,
    armedAt: null,
    outcomeUnknown: false,
    guardBlind: false,
    close: async () => {},
  };
  const planLock = await acquirePlanLock(ctx.customerId, sealSubscriptionId, "plan-route");
  try {
    return await applyPlanChange();
  } catch (e) {
    if (ledger.open) {
      await ledger.close(
        ledger.repairArmed ? "pending_repair" : ledger.outcomeUnknown ? "unknown" : "failed",
      );
    }
    throw e;
  } finally {
    await planLock.release();
  }

  // El cuerpo real, movido a una función interna para que el `finally` de arriba cubra
  // TODAS las salidas (incluidos los throw de las guardas y de las mutaciones) sin
  // tener que envolver el resto del handler en otro nivel de indentación.
  async function applyPlanChange(): Promise<Subscription> {

  // Date we must keep as the next ship date after Seal regenerates its
  // billing_attempts. Prefer Seal's authoritative attempt date (read above /
  // slow path) — Seal returns it at 10:00Z so slicing the day is timezone-safe.
  // Fall back to the FE-sent value only if Seal gave us nothing. May be null on
  // legacy payloads — then we simply don't re-anchor.
  const preserveYYYYMMDD =
    (nextAttemptDate ?? body.preserveNextShipDate)?.slice(0, 10) ?? null;

  // Resolve target flavor/box/variant + frequency, then detect what changed.
  //
  // Flavor is derived from the current variant so that a box-count OR frequency
  // change ALWAYS stays on the customer's current flavor (before flavors, this
  // route hardcoded the Salty-Lemon variant map — a Watermelon subscriber who
  // changed boxes would have been silently swapped back to Salty Lemon). A
  // flavor change is just a variant swap to another product's variant for the
  // same box count, so it flows through the identical add/remove machinery.
  // Live lines are authoritative. `mainItemId` / `currentVariantId` from the body are
  // only ever used for the ownership check above — every target is computed from what
  // Seal actually holds, which is what makes a retry safe.
  const currentLines: SubscriptionLine[] = preMutationSub
    ? getLines(preMutationSub)
    : [];
  const currentComposition = compositionFromLines(currentLines);

  // ───── NO SE TARIFICA SOBRE UNA ESCRITURA A MEDIAS (2-oct-2026) ─────
  //
  // Incidente de la 12798642. A las 07:26 un cambio de sabor que conservaba sus 67,93
  // murió entre `add_items` y `remove_items`: Seal se quedó con las tres líneas nuevas Y la
  // vieja, 6 cajas. La clienta lo vio, pidió sus 3 cajas a las 07:27, y esta ruta tomó la
  // foto de 6 como el contrato: de 6 a 3 es "cambiar de cantidad", así que no preservó y le
  // escribió catálogo, 85,05 por las mismas 3 cajas. La 14514761 hizo el mismo viaje el
  // 29-sep.
  //
  // `expectedLineIds` no lo frena: la pantalla se había recargado y enseñaba las 6 cajas,
  // así que los ids cuadraban. La guarda del 17-sep tampoco: solo protege a quien ya tiene
  // `preserved_charge_cents`, y en el PRIMER cambio de sabor de un contrato viejo esa
  // columna todavía no existe, que es justo cuando se pierde el precio.
  //
  // La foto solo es sospechosa si hay una escritura nuestra sin cerrar sobre esta sub, y
  // eso lo dice `subscription_line_repairs`:
  //   - una intención PENDIENTE es que el cron todavía no ha decidido: no se toca nada.
  //   - una ya cerrada (el cron no pudo, o expiró) solo bloquea si lo vivo sigue siendo esa
  //     misma escritura a medias. Si soporte ya la dejó bien, o la cambió a otra cosa, la
  //     foto vuelve a ser fiable.
  // Al cliente se le dice la verdad, que su último cambio se está terminando de aplicar.
  // Un 409 cuesta unos minutos; decidir precio sobre esa foto cuesta 17,12 € por entrega.
  ledger.guardBlind = !(await assertNoUnfinishedLineWrite(ctx.customerId, sealSubscriptionId, currentLines, log));

  // ───── EL CONTRATO PRESERVADO, COMO ANCLA (2026-09-17) ─────
  //
  // `currentLines` es una FOTO de Seal en este instante, y una foto tomada a mitad de
  // una ráfaga de escrituras miente. Incidente del 11-sep-2026 (sub 12118357): tres
  // peticiones en 27 segundos; la segunda murió entre `applied` y `verified` dejando en
  // Seal el `edit_items` aplicado pero sus dos `add_items` no, y el reintento leyó UNA
  // caja donde el contrato tenía TRES. Con esa lectura, `boxCountUnchanged` (abajo) es
  // false, la preservación no se evalúa, el cliente aterriza en catálogo y encima la
  // rama de limpieza le BORRA la preservación que la petición anterior ya había ganado.
  // Cobró 85,05 en vez de 67,93.
  //
  // La lección es que el nº de cajas del contrato no puede salir SOLO de la foto. Ya
  // tenemos la intención guardada (`preserved_box_count`, que el cron y el auditor
  // consumen desde el 3-sep); aquí se usa como testigo: si la foto no coincide con lo
  // que el contrato dice que son sus cajas, la foto es sospechosa y NO se decide precio
  // con ella.
  let preservedContract: { chargeCents: number; boxCount: number } | null = null;
  try {
    const { data, error } = await supabaseAdmin()
      .from("subscriptions")
      .select("preserved_charge_cents, preserved_box_count")
      .eq("customer_id", ctx.customerId)
      .eq("seal_subscription_id", String(sealSubscriptionId))
      .maybeSingle();
    if (error) {
      log("preserved-contract-read-failed", { msg: error.message });
    } else if (data?.preserved_charge_cents != null && data?.preserved_box_count != null) {
      const chargeCents = Number(data.preserved_charge_cents);
      const boxCount = Number(data.preserved_box_count);
      if (Number.isFinite(chargeCents) && chargeCents > 0 && Number.isInteger(boxCount) && boxCount > 0) {
        preservedContract = { chargeCents, boxCount };
      }
    }
  } catch (e) {
    // Degradar con aviso, nunca bloquear: sin esta señal el comportamiento es el de
    // antes del 17-sep (decidir con la foto), que es peor pero no rompe al cliente.
    log("preserved-contract-read-threw", { msg: e instanceof Error ? e.message : String(e) });
  }
  const currentShape = shapeFor(currentComposition);
  const currentBoxCount = currentLines.length
    ? currentLines.reduce((s, l) => s + l.boxes, 0)
    : BOX_COUNT_BY_VARIANT[String(mainItemVariantId)] ?? null;
  const currentFlavor: FlavorKey = flavorKeyForVariant(mainItemVariantId) ?? DEFAULT_FLAVOR;
  const targetFrequency = body.frequency ?? currentFrequency;

  // A flavor swap must know which box count to land on. The only way this is
  // unknown is a legacy sub on a variant not in any flavor's map — refuse
  // rather than silently no-op a requested flavor change.
  if ((body.flavor !== undefined || requestedMix === null) && currentBoxCount == null && body.boxCount === undefined) {
    throw new ApiHttpError(
      409,
      "box_count_unknown",
      "Cannot change this subscription: its box count could not be determined.",
    );
  }

  // Legacy clients (a tab opened before the mix shipped) send no `mix`. On a SPLIT
  // sub we must not guess:
  //   - `flavor` means "make it all X", which on a mix is almost certainly not what
  //     the customer has on screen → refuse and make them reload.
  //   - `boxCount` alone → PRESERVE the mix proportionally, never collapse it.
  if (currentShape === "split" && requestedMix === null && body.flavor !== undefined) {
    log("mix-requires-explicit-intent", { currentComposition });
    throw new ApiHttpError(
      409,
      "mix_requires_explicit_intent",
      "This subscription has a flavor mix; reload the page to edit it",
    );
  }

  const targetComposition: FlavorComposition[] = (() => {
    if (requestedMix) return requestedMix;
    if (body.flavor !== undefined) {
      return [{ flavor: body.flavor, boxes: body.boxCount ?? currentBoxCount! }];
    }
    if (body.boxCount !== undefined) {
      // GUARDA >6 CAJAS (aviso de Kiko, 23-ago-2026): getBoxCount clampa a 6 para
      // la UI y la caché, así que PlanOverlay/SkipOverlay envían 6 para las subs
      // fuera de rango (13007758 = SL90×4 = 12 cajas, 12752359 = SL90×3 = 9). Un
      // cambio de solo-frecuencia desde esa UI llegaría como boxCount=6 y le
      // partiría el envío (y el cobro) por la mitad con la verificación en verde.
      // Si la composición real supera MAX_BOXES y el body pide exactamente el
      // clamp, se trata como "sin cambio de cajas" (composición intacta → el
      // cortocircuito del espejo hace el diff noop). Pedir 1-5 sigue siendo una
      // reducción real y pasa por el camino normal.
      if (mixBoxCount(currentComposition) > MAX_BOXES && body.boxCount === MAX_BOXES) {
        return currentComposition;
      }
      // Box-count-only change. resplitOnBoxChange is identity for a single flavor and
      // proportional (largest remainder, deterministic) for a mix, so a legacy client
      // can move boxes without destroying the customer's split.
      return currentComposition.length
        ? resplitOnBoxChange(currentComposition, body.boxCount)
        : [{ flavor: currentFlavor, boxes: body.boxCount }];
    }
    // Frequency-only change: keep the composition exactly as it is.
    return currentComposition.length
      ? currentComposition
      : [{ flavor: currentFlavor, boxes: currentBoxCount! }];
  })();

  const targetBoxCount = mixBoxCount(targetComposition);
  const targetSellingPlanNumeric = SELLING_PLAN_BY_FREQUENCY[targetFrequency];
  if (!targetSellingPlanNumeric) {
    throw new ApiHttpError(500, "selling_plan_not_mapped", `No selling plan for ${targetFrequency}`);
  }

  // ¿Cambió de verdad la composición? SEMÁNTICO, nunca por presencia de campos en
  // el body: PlanOverlay envía `boxCount` SIEMPRE, así que un cambio de solo
  // frecuencia llega con boxCount incluido. Si la composición objetivo es la misma
  // que la viva, el target es un ESPEJO de las líneas actuales (planFromCurrentLines)
  // y el diff es noop estructural: tocar la cadencia no puede repreciar ni reescribir
  // items — ni una SL90 vieja a 67,93, ni un split custom, ni una línea PACK4.
  // (Antes de la escalera web esto se cumplía de carambola porque regenerar el
  // target producía los mismos precios; ahora está garantizado por código.)
  const compositionChanged =
    currentLines.length === 0 || !sameComposition(targetComposition, currentComposition);

  // GUARDA CIEGA = NO SE DECIDE PRECIO (2-oct-2026). Si la guarda de escrituras a medias no
  // pudo leer su tabla (Supabase parpadeó), dejó pasar sin saber si esta foto está rota. Un
  // cambio de solo frecuencia es seguro igual: replica las líneas vivas y no toca precios.
  // Uno de composición no: decide precio sobre la foto, y si había una red ajena viva, el
  // pre-armado de abajo además la pisaría. Esperar a que la base responda cuesta segundos.
  if (ledger.guardBlind && compositionChanged) {
    throw new ApiHttpError(
      503,
      "repair_net_unavailable",
      "Could not check for an unfinished change on this subscription; nothing was changed. Try again in a moment.",
    );
  }

  // ───── Guarda previa a cualquier cálculo de precio (2026-08-24) ─────
  //
  // FUERA DE RANGO. Σ cajas de las líneas vivas puede pasar de MAX_BOXES (13007758 =
  // SL90×4 = 12 cajas, 12752359 = SL90×3 = 9). La escalera no sabe tarificar eso:
  // ladderTotalCents LANZA, y hasta hoy el camino `flavor` moría en un 500 con alerta
  // P0 mientras el camino `mix` (que llega con el boxCount ya clampado a 6 por
  // getBoxCount) le reducía el envío a la mitad y lo llamaba cambio de mezcla. La
  // guarda del camino boxCount no cubría ninguno de los dos. Solo aplica cuando la
  // composición cambia: el espejo no consulta la escalera, así que un cambio de solo
  // frecuencia sobre una de estas subs sigue pasando.
  const liveBoxes = mixBoxCount(currentComposition);
  if (compositionChanged && liveBoxes > MAX_BOXES) {
    log("box-count-out-of-range", { liveBoxes, currentComposition, targetComposition });
    throw new ApiHttpError(
      409,
      "box_count_out_of_range",
      `This subscription holds ${liveBoxes} boxes, above the ${MAX_BOXES} the catalogue can price. Contact support.`,
    );
  }

  let tierTotalCents: number;
  let targetPlan: MixPlan;
  // Los precios vivos del catálogo, cuando esta petición los ha necesitado. El camino
  // del espejo (solo frecuencia) no consulta la escalera, así que se queda en null.
  let ladderPrices: LadderPrices | null = null;
  if (!compositionChanged) {
    targetPlan = planFromCurrentLines(currentLines);
    tierTotalCents = targetPlan.tierTotalCents;
  } else {
    // Escalera web para el TARGET box count, desde precios vivos de Shopify: 1-3 =
    // n × 1 caja, 4 = pack 3+1, 5-6 = pack + sueltas. planTargetLines comparte los
    // MISMOS LadderPrices, así que tier y líneas no pueden divergir.
    //
    // PRECIO DE SUSCRIPCIÓN, LEÍDO PARA ESCRIBIR (6-oct-2026). Desde que el -25% vive en
    // los planes y no en la variante, el precio es variante × (1 − % del plan), y esta
    // rama lo ESCRIBE en Seal (add_items/edit_items con `price` explícito). Por eso se lee
    // en fresco y no de la caché de 60 s que usa la UI, y si Shopify está a medio cambiar
    // (planes que no coinciden, doble descuento, precios moviéndose entre dos lecturas)
    // se rechaza con un 503 y un aviso, sin tocar nada. Nunca se cae al precio crudo.
    let prices: LadderPrices;
    try {
      prices = await getLadderPricesForWrite(targetComposition[0].flavor);
    } catch (e) {
      if (e instanceof PricingConfigError) {
        log("pricing-config-error", { code: e.code, msg: e.message, targetComposition });
        alertSlackError({
          path: "/api/subscription/plan",
          code: `pricing_config:${e.code}`,
          msg:
            `sub ${sealSubscriptionId}: no se puede saber el precio de suscripción con certeza ` +
            `(${e.message}). Cambio RECHAZADO sin tocar nada. Si es el cambio de planes y precios ` +
            `en curso, debería desaparecer en cuanto termine; si no, revisar planes y variantes en Shopify.`,
          customerId: ctx.customerId,
        });
        throw new ApiHttpError(
          503,
          "pricing_unavailable",
          "Our prices are being updated right now. Nothing was changed; please try again in a minute.",
        );
      }
      throw new ApiHttpError(
        500,
        "pricing_unavailable",
        `Could not price ${targetBoxCount} box(es): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    ladderPrices = prices;
    tierTotalCents = ladderTotalCents(targetBoxCount, prices);
    if (!Number.isFinite(tierTotalCents) || tierTotalCents <= 0) {
      throw new ApiHttpError(500, "pricing_unavailable", `Bad tier price ${tierTotalCents}`);
    }
    // Target lines + the minimal set of Seal writes to get there. `diffLines` prefers
    // in-place edit_items, so changing the split of the same total, or the box count
    // while keeping flavors, needs NO add/remove at all — which is what makes this
    // idempotent: a retry sees the target already present and converges instead of
    // adding a second line. That failure mode overcharged 7 subs in June-July 2026.
    targetPlan = planTargetLines(targetComposition, prices);
  }

  // ───── PRESERVAR EL PRECIO DEL CONTRATO (3-sep-2026) ─────
  //
  // Un cambio de composición construye las líneas al precio del CATÁLOGO. Para quien ya
  // está a catálogo eso es un no-op; para los 533 contratos activos que siguen por
  // debajo de la escalera web (522 de ellos a 3 cajas por 67,93 cuando el catálogo pide
  // 85,05) era una subida de 17,12 € por entrega que el cliente no pidió.
  //
  // La contención del 24-ago lo rechazaba con un 409 y una llamada pendiente por cada
  // caso. Con 522 clientes eso no es una cola de migración, es un muro: nadie va a hacer
  // 522 llamadas, así que en la práctica el cliente se quedaba sin poder cambiar de
  // sabor. Decisión de Juan (3-sep-2026): mantener el precio.
  //
  // La línea la seguimos trazando en el NÚMERO DE CAJAS, que es lo que el cliente recibe:
  //   - NO cambian las cajas (sabor o mezcla) → recibe exactamente lo mismo, así que paga
  //     exactamente lo mismo. Se preserva el importe. Es lo que FlavorOverlay le promete
  //     por escrito y lo que prometen las ofertas de retención de CancelTakeover.
  //   - Cambian las cajas → compra otra cantidad, y el catálogo es el precio de esa
  //     cantidad. PlanOverlay ya le enseña el delta contra lo que paga de verdad (a76c07d).
  //
  // EN LAS DOS DIRECCIONES (Juan, 2026-09-04: "cuando alguien cambie de sabor, que no se
  // toquen los precios NUNCA... se le mantiene su precio anterior").
  //
  // Hasta hoy esto solo miraba la subida (`targetPlan.totalCents > liveChargeCents`) y
  // dejaba pasar la bajada: las 14 subs POR_ENCIMA (una SL120 a 90,57 contra el pack a
  // 85,05) se reprecian al catálogo por el mero hecho de cambiar de sabor. Se leía como
  // "el cliente se beneficia", pero es el mismo defecto en espejo: el cliente no pidió
  // cambiar de precio, pidió cambiar de sabor, y su contrato es su contrato. Además es
  // irreversible, porque las variantes de la escalera vieja son de solo lectura y el
  // portal ya no sabe reconstruir 90,57. Ahora la condición es de DESIGUALDAD: mismas
  // cajas y distinto importe, se preserva, suba o baje.
  const liveChargeCents = chargeTotalCents(currentLines);

  // ───── LA FOTO CONTRA EL CONTRATO (2026-09-17) ─────
  //
  // Si el contrato dice que son N cajas y Seal nos enseña otra cosa, o bien el cliente
  // cambió de cantidad por fuera del portal (y entonces la preservación ya no es suya y
  // hay que limpiarla, pero de forma deliberada y no como efecto colateral), o bien
  // estamos leyendo un estado a medio aplicar. Los dos casos se parecen demasiado como
  // para distinguirlos aquí, y equivocarse le cuesta dinero al cliente: se rechaza y se
  // mira a mano. Un 409 es recuperable (el cliente reintenta y la foto ya está limpia);
  // cobrar 17,12 de más durante meses, no.
  const liveBoxCount = mixBoxCount(currentComposition);
  if (preservedContract && currentLines.length > 0 && liveBoxCount !== preservedContract.boxCount) {
    log("preserved-contract-mismatch", {
      liveBoxCount,
      contractBoxCount: preservedContract.boxCount,
      contractChargeCents: preservedContract.chargeCents,
      liveChargeCents,
      currentComposition,
      targetComposition,
    });
    alertSlackError({
      path: "/api/subscription/plan",
      code: "contract_box_count_mismatch",
      msg:
        `sub ${sealSubscriptionId}: el contrato preservado dice ${preservedContract.boxCount} cajas ` +
        `por ${centsToPrice(preservedContract.chargeCents)} y Seal enseña ${liveBoxCount}. O el cliente ` +
        `cambió de cantidad fuera del portal, o es una lectura a medio aplicar. Cambio RECHAZADO para ` +
        `no repreciarle. Revisar a mano: si la cantidad es legítima, limpiar preserved_charge_cents y ` +
        `preserved_box_count; si no, dejar que reintente.`,
      customerId: ctx.customerId,
    });
    throw new ApiHttpError(
      409,
      "subscription_changed",
      "Your subscription is being updated right now. Please reload and try again.",
    );
  }

  const boxCountUnchanged = currentLines.length > 0 && targetBoxCount === mixBoxCount(currentComposition);
  // Cambió de verdad el nº de cajas respecto al contrato vivo. Con esto se limpia el
  // precio preservado: quien compra otra cantidad pasa a catálogo, que es su precio
  // legítimo para esa cantidad.
  const boxCountChangedFromLive = currentLines.length > 0 && !boxCountUnchanged;
  let pricePreservedFromCents: number | null = null;
  if (compositionChanged && boxCountUnchanged && targetPlan.totalCents !== liveChargeCents) {
    // `ladderPrices` está poblado en esta rama: compositionChanged es la única forma de
    // llegar aquí, y es la rama que lo asigna.
    const preserved = ladderPrices ? planPreservingCharge(targetComposition, ladderPrices, liveChargeCents) : null;
    if (preserved) {
      pricePreservedFromCents = liveChargeCents;
      targetPlan = preserved;
      log("price-preserved", {
        liveChargeCents,
        catalogueCents: preserved.tierTotalCents,
        writtenCents: preserved.totalCents,
        savedCents: preserved.tierTotalCents - preserved.totalCents,
        targetBoxCount,
        currentComposition,
        targetComposition,
      });
    } else {
      // El reparto no es aplicable (alguna línea cuyas cajas no son múltiplo de su
      // quantity). Antes que escribir un precio inventado o subírselo en silencio, se
      // rechaza y se hace a mano, que es la contención del 24-ago tal cual.
      log("price-preserve-unavailable", {
        liveChargeCents,
        catalogueCents: targetPlan.totalCents,
        targetBoxCount,
        currentComposition,
        targetComposition,
      });
      alertSlackError({
        path: "/api/subscription/plan",
        code: "price_preserve_unavailable",
        msg:
          `sub ${sealSubscriptionId}: cambio de ${compositionLabel(currentComposition)} a ` +
          `${compositionLabel(targetComposition)} con las MISMAS ${targetBoxCount} cajas. Paga ` +
          `${centsToPrice(liveChargeCents)} y el catálogo pide ${centsToPrice(targetPlan.totalCents)}, ` +
          `pero el reparto en sitio no es posible con sus líneas. Rechazado. Hay que hacerlo a mano ` +
          `conservándole el precio.`,
        customerId: ctx.customerId,
      });
      throw new ApiHttpError(
        409,
        "price_would_increase",
        `This change keeps the same ${targetBoxCount} boxes but we cannot preserve the current ` +
          `${centsToPrice(liveChargeCents)} charge on this subscription's lines. Refused.`,
      );
    }
  }

  // ───── EL CAMINO MUDO (2026-09-17) ─────
  //
  // Hasta hoy, "no preservar" no dejaba rastro: el `if` de arriba se saltaba entero sin
  // log ni aviso, así que una subida de precio por lectura corrupta era indistinguible
  // en los logs de un cambio legítimo a catálogo. Por eso el caso del 11-sep estuvo seis
  // días sin que nadie lo viera, y solo salió porque el cliente lo pagó.
  //
  // Esto NO es una guarda, es observabilidad: si el importe sube y el cliente no ha
  // pedido más cajas, se avisa. Legítimo o no, alguien tiene que mirarlo.
  if (
    compositionChanged &&
    pricePreservedFromCents === null &&
    currentLines.length > 0 &&
    targetBoxCount === mixBoxCount(currentComposition) &&
    targetPlan.totalCents > liveChargeCents
  ) {
    log("price-increase-without-preservation", {
      liveChargeCents,
      writtenCents: targetPlan.totalCents,
      deltaCents: targetPlan.totalCents - liveChargeCents,
      targetBoxCount,
      hadPreservedContract: preservedContract !== null,
      currentComposition,
      targetComposition,
    });
    alertSlackError({
      path: "/api/subscription/plan",
      code: "price_increase_without_preservation",
      msg:
        `sub ${sealSubscriptionId}: mismas ${targetBoxCount} cajas y el importe SUBE de ` +
        `${centsToPrice(liveChargeCents)} a ${centsToPrice(targetPlan.totalCents)} ` +
        `(+${centsToPrice(targetPlan.totalCents - liveChargeCents)}) sin preservación. ` +
        `El cliente cambió de composición, no de cantidad. Revisar.`,
      customerId: ctx.customerId,
    });
  }

  const diff = diffLines(currentLines, targetPlan.lines);

  // ───── LÍNEAS QUE NO SABEMOS LEER (31-ago-2026) ─────
  //
  // `boxesForVariantQuantity` cae a 1 caja por unidad para cualquier variante fuera
  // del registro, y `flavorKeyForVariant` cae al sabor por defecto. O sea que una
  // "LIT Caja Regalo" cuenta como una caja de limón: el portal cree que la sub tiene
  // una caja más de las que paga, tarifica ese número, y el target que construye NO
  // incluye la línea de regalo, así que el diff la RETIRA.
  //
  // Eso ya ha pasado dos veces y nadie lo vio, porque el daño no está en el precio
  // sino en las cajas: la 15457363 pasó de 3 pagadas más 1 de regalo a 3, y la
  // 15436072 de 1 más 1 de regalo a 1. Las dos pagan exactamente lo mismo y reciben
  // un 25% y un 50% menos. Ningún detector de precio lo verá nunca (aviso de Kiko).
  //
  // Va DESPUÉS del diff y condicionado a `!diff.noop` a propósito: lo que no podemos
  // permitir es ESCRIBIR items cuando hay una línea que no sabemos interpretar. Un
  // cambio de solo frecuencia sobre una sub con caja de regalo da diff noop y sigue
  // pasando, que es lo correcto. La guarda anterior solo miraba el camino de
  // composición cambiada, y la 15457363 se colaba por el espejo.
  const unmappedLines = currentLines
    .map((l) => String(l.variantId))
    .filter((v) => BOX_COUNT_BY_VARIANT[v] === undefined);
  if (unmappedLines.length && !diff.noop) {
    log("unmapped-line-blocks-item-write", {
      unmapped: unmappedLines,
      currentComposition,
      targetComposition,
      diff: { edits: diff.edits.length, adds: diff.adds.length, removes: diff.removes.length },
    });
    alertSlackError({
      path: "/api/subscription/plan",
      code: "unmapped_line_blocks_write",
      msg:
        `sub ${sealSubscriptionId}: tiene la(s) variante(s) ${unmappedLines.join(", ")} fuera del ` +
        `registro de cajas (caja de regalo o producto legacy). El cambio se ha rechazado porque ` +
        `habría retirado esa línea sin bajarle el precio. Hay que mapear la variante o hacerlo a mano.`,
      customerId: ctx.customerId,
    });
    throw new ApiHttpError(
      409,
      "box_count_unknown",
      `Cannot change this subscription: variant(s) ${unmappedLines.join(", ")} are not in the box-count registry, so applying this change would silently drop that line.`,
    );
  }

  const planChanged = body.frequency !== undefined && body.frequency !== currentFrequency;
  const itemsChanged = !diff.noop;

  // Skip retention "espaciar": with reanchorMode="natural" the next order should
  // land on Seal's natural regenerated date (last completed charge + new
  // interval) instead of being pinned to the current next-ship date. We compute
  // that date and feed it as the preserve target, so the SAME re-anchor
  // machinery (intent → dashboard drain → reanchorCadence) drives the schedule
  // onto it and the Hub's silent re-poll works unchanged. reanchorCadence only
  // ever shifts FORWARD by a uniform offset, so even if our calendar math is a
  // day off Seal's, the result is bounded to that small delta — never a full
  // extra cycle. (2026-06-19)
  const naturalYYYYMMDD =
    reanchorMode === "natural" && planChanged
      ? naturalNextShipDate(preMutationSub, nextAttemptDate, currentFrequency, targetFrequency)
      : null;
  // Target the optimistic date + re-anchor intent at: natural date (skip
  // retention) when available, else the preserved current date (normal change).
  const effectivePreserveYYYYMMDD = naturalYYYYMMDD ?? preserveYYYYMMDD;

  log("change-detected", {
    planChanged,
    itemsChanged,
    currentComposition,
    targetComposition,
    currentShape,
    targetShape: targetPlan.shape,
    targetFrequency,
    targetBoxCount,
    tierTotalCents,
    charge: targetPlan.totalCents,
    residual: targetPlan.residualCents,
    diff: { edits: diff.edits.length, adds: diff.adds.length, removes: diff.removes.length },
    reanchorMode,
    naturalYYYYMMDD,
  });
  if (!itemsChanged && !planChanged) {
    log("no-op");
    // Already in the target state. Naturally idempotent: a retry of an operation that
    // actually landed returns success instead of mutating again.
    return synthesizeNoOpSub(sealSubscriptionId, targetPlan, currentLines, currentFrequency, ctx.customerId);
  }

  const expectedInterval = SEAL_INTERVAL_BY_FREQUENCY[targetFrequency];

  // Dry-run ("simulación"): short-circuit BEFORE any Seal OR Shopify call
  // (including the Shopify Admin variant lookup below) so local testing never
  // touches an external service. Return the projected post-change subscription
  // including the new next-ship date. Honoured only in non-prod
  // (api-helpers.dryRunAllowed). (2026-06-19)
  if (dryRun) {
    const projectedDate = planChanged ? effectivePreserveYYYYMMDD : preserveYYYYMMDD;
    log("dry-run-short-circuit", { projectedDate, reanchorMode, itemsChanged, planChanged });
    return synthesizePostMutationSub(
      sealSubscriptionId,
      targetPlan,
      currentLines,
      expectedInterval,
      ctx.customerId,
      projectedDate,
    );
  }

  // Shopify details for every variant we're about to ADD (title/sku/taxable/shipping —
  // Seal requires them). Parallel so N adds cost one round-trip, and only for adds:
  // edits and removes need nothing from Shopify.
  const addDetails = await Promise.all(
    diff.adds.map(async (line) => {
      const d = await shopifyAdmin.getVariantForSealAddItems(line.variantId);
      if (!d) {
        throw new ApiHttpError(500, "variant_lookup_failed", `Shopify has no variant ${line.variantId}`);
      }
      return { line, details: d };
    }),
  );
  if (addDetails.length) {
    log("variants-resolved", { skus: addDetails.map((a) => a.details.sku) });
  }

  /**
   * Audit breadcrumb. `subscription_changes` has existed since day one with ZERO
   * writers, and its absence is exactly what hurt when investigating the duplicate-line
   * incident: there was no record of what each customer asked for or when, and it had to
   * be reconstructed from Seal's own `log` field.
   *
   * It also lets a rollback tell a mix the PORTAL created from one the customer bought
   * at checkout — the latter must not be undone, it's what they chose.
   *
   * Best effort, never fatal: an audit row must not fail a plan change.
   */
  const writeAudit = async (outcome: string) => {
    // Cualquier fila que no sea `intent` cierra la petición (ver RequestLedger).
    ledger.open = outcome === "intent";
    try {
      // Fuera del deadline cuando ya no queda presupuesto (2-oct-2026): el cliente de
      // Supabase pasa por `fetchDeadline`, así que con el presupuesto agotado el insert se
      // cortaba a 0 ms. Y el presupuesto agotado es justo el caso en que más falta la fila:
      // una petición que pierde el deadline a mitad del swap se quedaba sin su cierre. Con
      // presupuesto, dentro, como antes: no se alarga una respuesta que el cliente espera.
      const { error } = await afterBudget(async () => await supabaseAdmin().from("subscription_changes").insert({
        customer_id: ctx.customerId,
        change_type: targetPlan.shape === "split" || currentShape === "split" ? "mix" : "plan",
        payload: {
          sealSubscriptionId: String(sealSubscriptionId),
          outcome,
          // Las filas de UNA petición (intent, applied, verified, cierre por error) llevan
          // el mismo id, para emparejarlas sin depender del orden. (2-oct-2026)
          requestId: ledger.requestId,
          from: { composition: currentComposition, shape: currentShape, frequency: currentFrequency },
          to: { composition: targetComposition, shape: targetPlan.shape, frequency: targetFrequency },
          tierTotalCents,
          chargedCents: targetPlan.totalCents,
          residualCents: targetPlan.residualCents,
          // Cuánto se le conservó del contrato viejo, y respecto a qué catálogo. Sin
          // esto, un contrato preservado es indistinguible en la auditoría de uno que
          // simplemente cobra poco, y la población de la escalera vieja solo se puede
          // censar releyendo el libro entero de Seal. (3-sep-2026)
          pricePreservedFromCents,
          pricePreservedSavingCents:
            pricePreservedFromCents !== null ? tierTotalCents - targetPlan.totalCents : null,
          diff: { edits: diff.edits.length, adds: diff.adds.length, removes: diff.removes.length },
          source: body.source ?? "portal",
        },
        applies_from: effectivePreserveYYYYMMDD,
      }), SUPABASE_WRITE_RESERVE_MS);
      if (error) log("audit-write-failed", { msg: error.message });
    } catch (e) {
      // "Best effort, never fatal" tiene que seguir siendo verdad ahora que la fila
      // "intent" se escribe ANTES de mutar Seal: sin este catch, un fallo de red de
      // Supabase dejaria de perder un apunte de auditoria y pasaria a bloquear TODOS
      // los cambios de plan. El insert devuelve `error` en los fallos de la API, pero
      // un fallo de transporte si lanza. (2026-08-30)
      log("audit-write-threw", { msg: e instanceof Error ? e.message : String(e) });
    }
  };
  ledger.close = writeAudit;

  /** Escribe (o limpia) el precio preservado y SUS cajas, siempre juntos. Best effort. */
  const writePreservedColumnsNow = async (values: {
    preserved_charge_cents: number | null;
    preserved_box_count: number | null;
  }) => {
    try {
      const { error } = await supabaseAdmin()
        .from("subscriptions")
        .update(values)
        .eq("customer_id", ctx.customerId)
        .eq("seal_subscription_id", String(sealSubscriptionId));
      if (error) log("preserved-charge-write-failed", { msg: error.message });
    } catch (e) {
      log("preserved-charge-write-threw", { msg: e instanceof Error ? e.message : String(e) });
    }
  };
  /** Igual, sacándola del deadline si ya no queda presupuesto: un clear que no corre deja un
   *  contrato fantasma que luego bloquea con `contract_box_count_mismatch`. */
  const writePreservedColumns = (values: Parameters<typeof writePreservedColumnsNow>[0]) =>
    afterBudget(() => writePreservedColumnsNow(values), SUPABASE_WRITE_RESERVE_MS);

  // Mutation order (REORDERED 2026-05-20 Juan):
  //   Before: add_items → remove_items → editSubscription
  //     Problem: when both vary, Seal often silently no-op'd the third
  //     mutation (editSubscription) — Seal is busy regenerating
  //     billing_attempts after add+remove and the edit fails or is dropped.
  //     Juan reproduced this 2026-05-19: variant change applied but
  //     frequency didn't, no error surfaced because verify timed out
  //     waiting for Seal to re-stabilise.
  //   After: editSubscription → add_items → remove_items
  //     Edit runs while the sub is still in a clean, stable state. The
  //     subsequent add+remove operate on the post-edit cadence; per
  //     reference_seal_api, Seal auto-aligns each item's selling_plan_id
  //     to match the active interval, so the new item lands correctly.
  //
  // Plus: a 500 ms delay between each Seal mutation. Seal's billing_attempts
  // regenerator needs ~300-500 ms to settle between calls; without this
  // pause we've seen the third mutation get silently dropped.

  // El breadcrumb va ANTES de tocar Seal (2026-08-24). Hasta hoy solo se escribía
  // al final, con outcome "applied", así que toda petición que muriera DESPUÉS de
  // mutar Seal (timeout de Vercel, crash) dejaba el contrato cambiado y el ledger
  // vacío. Pasó de verdad: el segundo cambio de la 14317417 (23-ago 17:44, el que
  // dejó la línea PACK4 duplicada con las 3 sueltas y la puso a cobrar 170,10) no
  // dejó ni fila aquí ni intent de reparación, y solo lo delataba el log de Seal.
  // Con la fila de intención, cualquier auditoría futura ve el hueco: intent sin
  // applied = petición que se murió a medias.
  //
  // EL PRECIO PRESERVADO SE APUNTA ANTES DE TOCAR SEAL (2-oct-2026), a la vez que esta fila.
  // Hasta hoy solo se escribía tras verificar, así que una petición que muriera a medias
  // dejaba el contrato viejo SIN ancla: la 12798642 no tenía `preserved_*` cuando la petición
  // de las 07:27 leyó sus 6 cajas, y la guarda del 17-sep, que la habría parado, no tenía con
  // qué comparar.
  //
  // SOLO HACIA ABAJO. Por debajo del catálogo (la escalera vieja: 67,93 contra 85,05) el
  // importe y las cajas son los del contrato vivo, así que el derecho vale igual si el
  // cambio no llega a entrar, y el cron no cura subs por debajo: no cambia nada. Por ENCIMA
  // (un SL120 a 90,57 contra el PACK4 a 85,05) no: sin la fila, el auto-heal de renovación
  // le baja el precio a catálogo, y un cambio de sabor que FALLÓ le habría regalado al
  // contrato un derecho a seguir pagando 90,57. Ese caso se sigue escribiendo solo tras
  // verificar, como antes. Borrar sigue pasando solo después de verificar, en los dos.
  //
  // Dentro del presupuesto y en paralelo con el `intent`: si Supabase va lento, no debe
  // comerse el tiempo que necesita el swap. Si no entra, es inocuo.
  const preWritePreservation =
    pricePreservedFromCents !== null && targetPlan.totalCents <= tierTotalCents;
  await Promise.all([
    writeAudit("intent"),
    preWritePreservation
      ? writePreservedColumnsNow({
          preserved_charge_cents: targetPlan.totalCents,
          preserved_box_count: targetBoxCount,
        })
      : Promise.resolve(),
  ]);

  // ───── Step 1: change delivery_interval FIRST (if needed) ─────
  //
  // Send ONLY delivery_interval. We used to send billing_interval too,
  // but reference_seal_api documents only delivery_interval as editable
  // — Seal silently no-ops the whole edit when an undocumented field
  // is present (Juan 2026-05-19 root cause). Dropping billing_interval
  // makes the edit land cleanly even in combination with later mutations.
  if (planChanged) {
    let firstErr: unknown = null;
    try {
      await seal.editSubscription(sealSubscriptionId, {
        delivery_interval: expectedInterval,
      });
      log("seal-edit-interval-ok", { interval: expectedInterval, attempt: 1 });
    } catch (e) {
      firstErr = e;
      log("seal-edit-interval-retry", {
        msg: e instanceof Error ? e.message : String(e),
        interval: expectedInterval,
      });
      await new Promise((r) => setTimeout(r, 700));
      try {
        await seal.editSubscription(sealSubscriptionId, {
          delivery_interval: expectedInterval,
        });
        log("seal-edit-interval-ok", { interval: expectedInterval, attempt: 2 });
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        log("seal-edit-interval-failed-twice", {
          firstMsg: firstErr instanceof Error ? firstErr.message : String(firstErr),
          secondMsg: msg,
          interval: expectedInterval,
        });
        // Variant hasn't been touched yet — clean abort, sub unchanged.
        throw new ApiHttpError(
          502,
          "frequency_change_failed",
          `Frequency change rejected by Seal: ${msg}`,
        );
      }
    }
    // Pause so Seal can regenerate billing_attempts before the next call.
    if (itemsChanged) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ── Retention-discount carry-over guard (audit 2026-07-06) ──
  // Seal gotcha (incident 2026-06-02): add_items+remove_items with an active
  // discount_code carries the code over to the new item INVISIBLY — absent
  // from item.discount_codes but still discounting the sub. The removal
  // webhook then can't find its UUID and the "one charge only" 15% recurs on
  // every future charge silently. Safe order: detach BEFORE the swap,
  // re-apply AFTER. Never re-apply without a successful detach — applying on
  // top of a carried-over code is the invisible-duplicate scenario.
  //
  // Gated on adds/removes ONLY, not on edits: the carry-over moves a code from a
  // REMOVED line to an ADDED one, so an edit_items-only change (the common mix case:
  // same variants, different quantities) has nothing to move and keeps the code on
  // the same line id. Not detaching there avoids two Seal calls and, more
  // importantly, avoids a window where a failed re-attach costs the customer their
  // 15%. The verification step asserts the code count didn't change, so if Seal ever
  // surprises us on the edit path we find out from production instead of guessing.
  const swapsItems = diff.adds.length > 0 || diff.removes.length > 0;
  let retentionCarry: { code: string; detached: boolean } | null = null;
  if (swapsItems) {
    const { data: rd } = await supabaseAdmin()
      .from("retention_discounts")
      .select("code, discount_code_id")
      .eq("customer_id", ctx.customerId)
      .eq("seal_subscription_id", String(sealSubscriptionId))
      .eq("status", "pending_charge")
      .maybeSingle();
    if (rd) {
      // ALL the UUIDs, not just the first: on a multi-line sub the same code can
      // surface once per line, and removing one would leave a permanent discount on
      // the others (the leak class of incident 2026-07-23).
      const appliedIds = preMutationSub
        ? findAllAppliedDiscountCodeIds(preMutationSub, rd.code as string)
        : [];
      const ids = appliedIds.length
        ? appliedIds
        : rd.discount_code_id
          ? [rd.discount_code_id as string]
          : [];
      retentionCarry = { code: rd.code as string, detached: false };
      if (ids.length) {
        try {
          for (const id of ids) await seal.removeDiscountCode(sealSubscriptionId, id);
          retentionCarry.detached = true;
          log("retention-discount-detached-pre-swap", { count: ids.length });
        } catch (e) {
          log("retention-discount-detach-failed", {
            msg: e instanceof Error ? e.message : String(e),
          });
        }
      } else {
        log("retention-discount-no-uuid-pre-swap");
      }
    }
  }

  // ── Lo mismo con el crédito Discovery de la primera renovación (9-oct-2026) ──
  // Quien compra el Discovery Set junto con su suscripción lleva 4,99 € de descuento en su
  // segundo envío (lib/discovery-renewal-credit). Es un código de Seal como el 15%, así que
  // el arrastre invisible le pasa igual: se repetiría en CADA envío sin que el consumidor
  // pudiera verlo para retirarlo. Mismo trato: soltar antes, reponer después (solo si se le
  // sigue debiendo, ver `ensureDiscoveryCreditAttached`).
  let discoveryCarry: { code: string; detached: boolean } | null = null;
  if (swapsItems) {
    let dc: Awaited<ReturnType<typeof pendingDiscoveryCreditForSub>> = null;
    try {
      dc = await pendingDiscoveryCreditForSub(sealSubscriptionId);
    } catch (e) {
      // Sin saber si hay crédito no podemos soltarlo. Se sigue (como con la retención),
      // pero avisando: si lo había, puede haberse quedado invisible.
      log("discovery-credit-read-failed", { msg: e instanceof Error ? e.message : String(e) });
      alertSlackError({
        path: "/api/subscription/plan",
        code: "discovery_credit_read_failed",
        msg: `sub ${sealSubscriptionId}: no se pudo leer discovery_set_coupons antes de cambiar las líneas. Si tenía crédito Discovery pendiente, comprobar en Seal que sigue puesto UNA vez y visible.`,
        customerId: ctx.customerId,
      });
    }
    if (dc) {
      const appliedIds = preMutationSub ? findAllAppliedDiscountCodeIds(preMutationSub, dc.code) : [];
      const ids = appliedIds.length ? appliedIds : dc.codeId ? [dc.codeId] : [];
      discoveryCarry = { code: dc.code, detached: false };
      if (ids.length) {
        try {
          for (const id of ids) await seal.removeDiscountCode(sealSubscriptionId, id);
          discoveryCarry.detached = true;
          log("discovery-credit-detached-pre-swap", { count: ids.length });
        } catch (e) {
          log("discovery-credit-detach-failed", { msg: e instanceof Error ? e.message : String(e) });
        }
      } else {
        log("discovery-credit-no-uuid-pre-swap");
      }
    }
  }

  // Re-attach after the swap — and after a FAILED swap too (every throw path
  // below calls this first), so the customer never silently loses their 15%.
  // Never applies unless the detach succeeded (see gotcha above).
  const reattachRetentionDiscountNow = async () => {
    if (!retentionCarry) return;
    if (!retentionCarry.detached) {
      // Detach failed or the UUID was unknown: scan fresh state once — if the
      // code is visible now, finish the detach so we can re-apply cleanly; if
      // it is invisible, do NOT apply on top (invisible duplicate). Alert.
      try {
        const fresh = await seal.getSubscriptionById(sealSubscriptionId);
        const lateIds = fresh ? findAllAppliedDiscountCodeIds(fresh, retentionCarry.code) : [];
        if (lateIds.length) {
          for (const id of lateIds) await seal.removeDiscountCode(sealSubscriptionId, id);
          retentionCarry.detached = true;
        }
      } catch {
        // fall through to the alert below
      }
    }
    if (!retentionCarry.detached) {
      alertSlackError({
        path: "/api/subscription/plan",
        code: "retention_discount_carryover",
        msg: `sub ${sealSubscriptionId}: plan swap ran with the 15% attached and detach failed — the code may now be invisible and recurring; verify in Seal (code ${retentionCarry.code})`,
        customerId: ctx.customerId,
      });
      return;
    }
    try {
      await seal.applyDiscountCode(sealSubscriptionId, retentionCarry.code);
      // Refresh the UUID so the removal consumer finds the new application, and
      // REVIVE the row to pending_charge: a consumer (webhook/cron) racing this
      // swap could have read the transient detached state and closed the row
      // ("already-gone"); reviving keeps the freshly re-applied code tracked so
      // it still gets removed after the discounted charge (audit 2026-07-23).
      const after = await seal.getSubscriptionById(sealSubscriptionId);
      const newId = after ? findAllAppliedDiscountCodeIds(after, retentionCarry.code)[0] ?? null : null;
      const revive = () =>
        supabaseAdmin()
          .from("retention_discounts")
          .update({
            discount_code_id: newId,
            status: "pending_charge",
            removed_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("customer_id", ctx.customerId);
      // Retry once: a swallowed revive failure can leave the re-applied code live
      // while the row stays 'removed' (a consumer closed it mid-swap) → untracked
      // leak. One retry absorbs a transient Supabase blip before we alert.
      let { error: reviveErr } = await revive();
      if (reviveErr) ({ error: reviveErr } = await revive());
      if (reviveErr) {
        // The 15% is back on Seal but the tracking row failed to revive. If a
        // racing consumer had closed it, it now stays 'removed' with the code
        // live → the backstops (which filter pending_charge) won't catch it.
        // Surface it so support can re-open the row or remove the code.
        alertSlackError({
          path: "/api/subscription/plan",
          code: "retention_discount_revive_failed",
          msg: `sub ${sealSubscriptionId}: 15% re-applied after swap but tracking revive failed (${reviveErr.message}) — verify retention_discounts row / remove code in Seal`,
          customerId: ctx.customerId,
        });
      }
      log("retention-discount-reattached", { hasUuid: !!newId, revived: !reviveErr });
    } catch (e) {
      // Detached but not re-applied: the customer LOST the 15% (money-safe
      // direction, but support must re-apply). Loud alert.
      log("retention-discount-reapply-failed", {
        msg: e instanceof Error ? e.message : String(e),
      });
      alertSlackError({
        path: "/api/subscription/plan",
        code: "retention_discount_lost",
        msg: `sub ${sealSubscriptionId}: 15% detached for the plan swap but re-apply failed — re-apply code ${retentionCarry.code} manually`,
        customerId: ctx.customerId,
      });
    }
  };

  // Reponer el crédito Discovery, con la misma guarda que el 15%: nunca se aplica encima
  // de un código que no se pudo soltar (sería el duplicado invisible).
  const reattachDiscoveryCreditNow = async () => {
    if (!discoveryCarry) return;
    if (!discoveryCarry.detached) {
      try {
        const fresh = await seal.getSubscriptionById(sealSubscriptionId);
        const lateIds = fresh ? findAllAppliedDiscountCodeIds(fresh, discoveryCarry.code) : [];
        if (lateIds.length) {
          for (const id of lateIds) await seal.removeDiscountCode(sealSubscriptionId, id);
          discoveryCarry.detached = true;
        }
      } catch {
        // cae al aviso de abajo
      }
    }
    if (!discoveryCarry.detached) {
      alertSlackError({
        path: "/api/subscription/plan",
        code: "discovery_credit_carryover",
        msg: `sub ${sealSubscriptionId}: el cambio de líneas se hizo con el crédito Discovery puesto y no se pudo soltar. Puede haberse quedado invisible y repetirse en cada envío: comprobar en Seal (código ${discoveryCarry.code}).`,
        customerId: ctx.customerId,
      });
      return;
    }
    const result = await ensureDiscoveryCreditAttached(sealSubscriptionId, discoveryCarry.code, "/api/subscription/plan");
    log("discovery-credit-reattached", { result });
  };

  // Con el presupuesto casi gastado, el 15% se repone FUERA del deadline (2-oct-2026). Es el
  // caso típico de los caminos de error (se perdió el deadline a mitad del swap) y el del
  // remove que "falló" pero entró: dentro del deadline cada llamada se cortaba y el cliente
  // se quedaba sin su descuento, o con el código puesto y sin seguimiento. Con presupuesto
  // de sobra se sigue corriendo dentro, para no alargar una respuesta que sí espera.
  // Todos los códigos que se soltaron para el swap se reponen juntos, en cada salida de la
  // ruta (la que sale bien y todas las de error), con margen para los dos.
  const reattachCarriedDiscounts = () =>
    afterBudget(
      async () => {
        await reattachRetentionDiscountNow();
        await reattachDiscoveryCreditNow();
      },
      RETENTION_REATTACH_RESERVE_MS * Math.max(1, (retentionCarry ? 1 : 0) + (discoveryCarry ? 1 : 0)),
    );

  // ───── Step 2: converge the lines on the target (edits → adds → removes) ─────
  //
  // Runs AFTER the interval edit so every line Seal creates or realigns is already on
  // the target cadence (Seal overwrites selling_plan_id from the sub's interval no
  // matter what we send).
  //
  // Order matters: EDITS FIRST. An edit-only change — same variants, different
  // quantities, which is the common case for a mix and for a box-count change on a
  // mixed sub — then never enters the add/remove region at all, so it cannot leave
  // both an old and a new line present. That window is what overcharged 7
  // subscriptions in June-July 2026 (scripts/repair-duplicate-lines.mjs). And if an
  // edit fails we abort with the subscription completely untouched.

  // The snapshot IS the manual restore script: log it in full before mutating.
  log("pre-mutation-snapshot", { lines: currentLines });

  /** Undo whatever we managed to apply: drop lines that weren't in the snapshot and
   *  put the snapshot's quantities/prices back. One read, then at most two writes.
   *
   *  Runs OUTSIDE the request deadline on purpose. The most likely reason we are
   *  rolling back is that the budget ran out, and with an exhausted deadline
   *  `fetchDeadline` clamps every call to 0ms and aborts it instantly — the undo
   *  would be dead on arrival exactly when it matters most. The customer is not
   *  waiting on this anyway: the response is already lost to the App Proxy.
   *
   *  SOLO tras un rechazo SEGURO de Seal (2-oct-2026). Esta función decide qué deshacer
   *  con UNA lectura, y tras un timeout esa lectura puede ir por detrás de Seal: la
   *  14345379 y la 13109864 leyeron "no hay nada que deshacer", la ruta desarmó la red,
   *  y segundos después Seal enseñó el add. Con resultado desconocido no se deshace nada
   *  aquí; se deja la red armada y el cron decide con una lectura asentada. */
  const restoreSnapshot = (): Promise<"restored" | "inconsistent"> =>
    runWithoutRequestDeadline(async () => {
    try {
      const live = await seal.getSubscriptionById(sealSubscriptionId);
      if (!live) return "inconsistent";
      const liveLines = getLines(live);
      // Si falta una línea de la foto, deshacer no es posible desde aquí (no se puede
      // volver a añadir) y quitar las nuevas dejaría a la sub sin lo que paga. Que lo vea
      // el cron, que distingue lo nuestro de lo ajeno.
      const missing = currentLines.filter((s) => !liveLines.some((l) => l.itemId === s.itemId));
      if (missing.length) {
        log("snapshot-restore-refused-missing-lines", { missing: missing.map((l) => l.itemId) });
        return "inconsistent";
      }
      const snapIds = new Set(currentLines.map((l) => l.itemId));
      const strays = liveLines.filter((l) => !snapIds.has(l.itemId)).map((l) => l.itemId);
      if (strays.length) await seal.removeItems(sealSubscriptionId, strays);
      const reEdits = currentLines.flatMap((snap) => {
        const now = liveLines.find((l) => l.itemId === snap.itemId);
        if (!now) return [];
        const same = Number(now.quantity) === Number(snap.quantity) && now.unitPrice === snap.unitPrice;
        return same ? [] : [{ itemId: snap.itemId, quantity: snap.quantity, price: snap.unitPrice }];
      });
      if (reEdits.length) await seal.editItems(sealSubscriptionId, reEdits);
      log("snapshot-restored", { strays: strays.length, reEdits: reEdits.length });
      return "restored";
    } catch (e) {
      log("snapshot-restore-failed", { msg: e instanceof Error ? e.message : String(e) });
      return "inconsistent";
    }
    });

  /** Record the desired end state so the repair cron can converge asynchronously.
   *  Written BEFORE we touch Seal (see the pre-arm below) and again from the
   *  catch blocks, for the case where we know precisely why we failed. */
  const scheduleRepair = (reason: string) =>
    // Outside the deadline: this row IS the safety net. Losing it because the
    // budget is spent is the failure it exists to prevent (supabase-js asks for
    // a flat 5s, which `fetchDeadline` clamps to 0 once the budget is gone).
    runWithoutRequestDeadline(async () => {
    const armedAt = new Date().toISOString();
    try {
      const nowIso = armedAt;
      const { error } = await supabaseAdmin()
        .from("subscription_line_repairs")
        .upsert(
          {
            customer_id: ctx.customerId,
            seal_subscription_id: String(sealSubscriptionId),
            desired: targetPlan.lines,
            snapshot: currentLines,
            status: "pending",
            attempts: 0,
            last_error: reason,
            created_at: nowIso,
            updated_at: nowIso,
          },
          { onConflict: "customer_id,seal_subscription_id" },
        );
      if (error) {
        log("repair-intent-write-failed", { msg: error.message });
        return false;
      }
    } catch (e) {
      // Un fallo de transporte LANZA en vez de devolver `error`. Sin este catch el
      // pre-armado reventaba la ruta con el descuento de retención ya despegado.
      log("repair-intent-write-threw", { msg: e instanceof Error ? e.message : String(e) });
      return false;
    }
    ledger.repairArmed = true;
    ledger.armedAt = armedAt;
    log("repair-intent-written");
    return true;
    });

  /** Clear the pre-armed intent once the lines really are where we wanted them.
   *
   *  SOLO LA RED PROPIA, O FILAS YA CERRADAS (2-oct-2026). Nunca una `pending` ajena: si la
   *  guarda no pudo leer (Supabase parpadeó y dejó pasar), esta petición puede convivir con
   *  la red viva de otra que dejó la sub a medias, y borrarla por clave dejaría las líneas
   *  de más cobrando sin nadie que las quite. La propia se reconoce por su `created_at`. */
  const disarmRepairIntent = () =>
    runWithoutRequestDeadline(async () => {
    try {
      const base = supabaseAdmin()
        .from("subscription_line_repairs")
        .delete()
        .eq("customer_id", ctx.customerId)
        .eq("seal_subscription_id", String(sealSubscriptionId));
      const { error } = await (ledger.armedAt
        ? base.eq("created_at", ledger.armedAt)
        : base.neq("status", "pending"));
      if (error) {
        // Left armed: the cron re-reads live Seal state and closes a no-op diff,
        // so a stale row costs one wasted pass, never a wrong write.
        log("repair-intent-disarm-failed", { msg: error.message });
        return;
      }
      ledger.repairArmed = false;
      ledger.armedAt = null;
      log("repair-intent-disarmed");
    } catch (e) {
      log("repair-intent-disarm-failed", { msg: e instanceof Error ? e.message : String(e) });
    }
    });

  // ARM THE SAFETY NET BEFORE THE FIRST MUTATION (incident 2026-09-04).
  //
  // Every recovery path below (retry, restoreSnapshot, scheduleRepair, the Slack
  // alert) lives inside a `catch`, so it only runs when a Seal call *rejects*.
  // It does NOT run when the invocation dies outright — which is the failure that
  // actually happens: three sequential Seal calls (edit → add → remove, up to 9 s
  // each) outlast the App Proxy's ~10 s patience, the customer gets
  // `gateway_timeout`, and the function is killed between add_items and
  // remove_items. The subscription keeps BOTH the old and the new lines and the
  // next charge is too high, with nothing written and no alert raised.
  //
  // That is not hypothetical: on 2026-09-04 it left three live subscriptions
  // overcharging by 113.40 EUR/cycle, and `subscription_line_repairs` was empty
  // — the net built for the June-July duplicates had never caught a single case,
  // because it guards a mode that does not occur.
  //
  // So the intent is written FIRST and deleted on success. If we die mid-swap,
  // the row survives and the repair cron converges the subscription. The cron is
  // idempotent by construction (it diffs live Seal state against `desired`), so
  // a row that outlives a successful change is a harmless no-op.
  //
  // SIN RED NO HAY SALTO (2-oct-2026). Hasta hoy, si este upsert fallaba, la ruta lo
  // apuntaba en el log y seguía con el add+remove igual: justo el swap que la red existe
  // para proteger, hecho sin ella. Ahora se para aquí, antes de tocar las líneas. Si el
  // intervalo ya cambió, el reintento del cliente lo verá hecho y solo hará las líneas.
  if (diff.adds.length || diff.removes.length) {
    const armed = await scheduleRepair("pre-armed before line mutation");
    if (!armed) {
      await reattachCarriedDiscounts();
      throw new ApiHttpError(
        503,
        "repair_net_unavailable",
        "Could not record the repair intent; the lines were not touched. Try again in a moment.",
      );
    }
  }

  /** La escritura falló SIN que Seal la rechazara: puede haber entrado (2-oct-2026).
   *
   *  No se deshace nada sobre una lectura que puede ir por detrás de Seal (ver
   *  restoreSnapshot). Se deja la red armada con el objetivo y el cron decide dentro de
   *  unos minutos con una lectura asentada: completa lo que quedó a medias, o confirma
   *  que no entró nada. Mientras tanto la guarda del principio no deja tarificar encima,
   *  y el cliente ve que su cambio se está terminando de aplicar en vez de "inténtalo de
   *  nuevo", que es lo que le invitaba a pedir otra vez sobre la foto rota. */
  const handOverUnknownOutcome = async (step: string, msg: string): Promise<never> => {
    // Refresca el motivo de la fila. Si este upsert falla pero el pre-armado entró, la red
    // sigue puesta: lo que cuenta es `ledger.repairArmed`, no lo que devuelva este intento.
    await scheduleRepair(`${step}: resultado desconocido (${msg})`);
    const armed = ledger.repairArmed;
    if (!armed) {
      ledger.outcomeUnknown = true;
      await alertSlackErrorAwaited({
        path: "/api/subscription/plan",
        code: "unknown_write_unarmed",
        msg:
          `sub ${sealSubscriptionId}: ${step} falló sin saber si Seal la aplicó (${msg}) y NO se pudo ` +
          `armar la reparación. Revisar a mano. snapshot=${JSON.stringify(currentLines)} ` +
          `desired=${JSON.stringify(targetPlan.lines)}`,
        customerId: ctx.customerId,
      });
    }
    await reattachCarriedDiscounts();
    // 409 y no 5xx: la App Proxy de Shopify sustituye CUALQUIER 5xx por el HTML de la
    // tienda, que el front lee como `gateway_timeout` ("inténtalo de nuevo"). Un 409 sí
    // llega, y `change_in_progress` le dice lo que de verdad pasa y le quita el botón.
    throw new ApiHttpError(
      409,
      "change_in_progress",
      `Your change is still being applied (${step}: unknown outcome, repair ${armed ? "armed" : "NOT armed"}: ${msg})`,
    );
  };

  // 2a. Edits in place — no item ids change, nothing is removed.
  if (diff.edits.length) {
    try {
      await seal.editItems(
        sealSubscriptionId,
        diff.edits.map((e) => ({ itemId: e.itemId, quantity: e.quantity, price: e.unitPrice })),
      );
      log("seal-edit-items-ok", { count: diff.edits.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rejected = sealWriteDefinitelyRejected(e);
      log("seal-edit-items-failed", { msg, rejected });
      if (!rejected) return await handOverUnknownOutcome("edit_items", msg);
      // Nothing added or removed yet, so the sub is either untouched or partially
      // edited; restore and abort.
      const outcome = await restoreSnapshot();
      // Only disarm when the sub really is back on the snapshot. On
      // "inconsistent" the pre-armed intent is the only thing that will fix it.
      if (outcome === "restored") await disarmRepairIntent();
      await reattachCarriedDiscounts();
      throw new ApiHttpError(
        502,
        planChanged ? "variant_change_failed_after_interval" : "seal_edit_items_failed",
        msg,
      );
    }
    if (diff.adds.length || diff.removes.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 2b. Adds — ALL new lines in ONE call, so the number of round-trips (and the
  // latency budget against the App Proxy's ~10s patience) doesn't grow with the
  // number of flavors. Verified 2026-07-27: Seal applies the whole array or none.
  if (diff.adds.length) {
    try {
      await seal.addItems(
        sealSubscriptionId,
        addDetails.map(({ line, details }) => ({
          productId: details.productId,
          variantId: details.variantId,
          quantity: line.quantity,
          title: details.title,
          sku: details.sku,
          taxable: details.taxable,
          requiresShipping: details.requiresShipping,
          // Per-unit, distributing the tier total so a mix costs exactly what the
          // equivalent pure plan costs.
          price: centsToPrice(line.unitPriceCents),
          sellingPlanId: targetSellingPlanNumeric,
        })),
      );
      log("seal-add-items-ok", { count: diff.adds.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rejected = sealWriteDefinitelyRejected(e);
      log("seal-add-items-failed", { msg, rejected });
      // El caso del 2-oct: un add que "falla" aquí y aterriza en Seal segundos después.
      if (!rejected) return await handOverUnknownOutcome("add_items", msg);
      const outcome = await restoreSnapshot();
      if (outcome === "restored") await disarmRepairIntent();
      await reattachCarriedDiscounts();
      throw new ApiHttpError(
        502,
        planChanged ? "variant_change_failed_after_interval" : "seal_add_items_failed",
        msg,
      );
    }
    if (diff.removes.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 2c. Removes — ALL obsolete lines in ONE call. This includes duplicate lines a
  // previous interrupted change may have left behind, so a corrupted subscription
  // heals the first time its owner touches their plan.
  if (diff.removes.length) {
    try {
      await seal.removeItems(sealSubscriptionId, diff.removes);
      log("seal-remove-items-ok", { count: diff.removes.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("seal-remove-items-failed", { msg, rejected: sealWriteDefinitelyRejected(e) });
      // Worse than a failed add: the old AND new lines may both be live, so the next
      // charge would be too HIGH.
      //
      // ANTES DE REINTENTAR, MIRAR (2-oct-2026). Un remove que "falla" aquí puede haber
      // entrado: la 13416998 (1-oct) tiene en el log de Seal la línea quitada a las
      // 08:12:42 y esta ruta la dio por fallida, reintentó contra un item que ya no
      // existía, y acabó con `mix_inconsistent_state` y un 502 sobre una sub que estaba
      // exactamente como pidió la clienta. Si lo viejo ya no está, esto es un ÉXITO y
      // sigue por el camino feliz (applied, verificación, 200).
      //
      // Y ya NO se deshace quitando las líneas nuevas: con una lectura que puede ir por
      // detrás de Seal, "deshacer" puede dejar a la sub sin lo que paga. La red está
      // armada desde antes del primer cambio y el cron sabe terminar este estado hacia el
      // objetivo con un solo remove.
      await new Promise((r) => setTimeout(r, 800));
      let converged = false;
      let stillPresent = diff.removes;
      try {
        const settled = await runWithoutRequestDeadline(() => seal.getSubscriptionById(sealSubscriptionId));
        if (settled) {
          const liveIds = new Set(getLines(settled).map((l) => l.itemId));
          stillPresent = diff.removes.filter((id) => liveIds.has(id));
          converged = stillPresent.length === 0;
          if (converged) log("seal-remove-items-landed-anyway");
        }
      } catch (readErr) {
        log("seal-remove-items-reread-failed", {
          msg: readErr instanceof Error ? readErr.message : String(readErr),
        });
      }
      if (!converged) {
        try {
          // Outside the request deadline: if we got here because the budget ran
          // out, an in-budget retry would be aborted at 0ms and the customer would
          // be left paying for both line sets. Getting the old lines off is worth
          // more than returning fast on a response nobody is waiting for.
          await runWithoutRequestDeadline(() => seal.removeItems(sealSubscriptionId, stillPresent));
          converged = true;
          log("seal-remove-items-ok-on-retry", { count: stillPresent.length });
        } catch (retryErr) {
          log("seal-remove-items-retry-failed", {
            msg: retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
        }
      }
      // Si convergió, no se lanza: el bloque de después desarma la red, apunta `applied`,
      // repone el descuento y verifica, como en cualquier cambio que sale bien.
      if (!converged) {
        await reattachCarriedDiscounts();
        // Refresh the pre-armed intent with the real reason, for the operator
        // reading `last_error` and for the alert below.
        const scheduled = await scheduleRepair(`remove_items failed: ${msg}`);
        await alertSlackErrorAwaited({
          path: "/api/subscription/plan",
          code: "mix_inconsistent_state",
          msg:
            `sub ${sealSubscriptionId}: could not converge lines. desired=${JSON.stringify(targetPlan.lines)} ` +
            `snapshot=${JSON.stringify(currentLines)}. repair intent ${scheduled ? "written" : "FAILED TO WRITE"}. ` +
            `If a charge fires before the cron converges, REFUND the duplicate line.`,
          customerId: ctx.customerId,
        });
        // 409 por lo mismo que `handOverUnknownOutcome`: un 5xx no llega al cliente.
        throw new ApiHttpError(
          409,
          "change_in_progress",
          `Your change is still being applied (${msg}; subscription has extra lines; a repair is scheduled)`,
        );
      }
    }
  }

  // Lines converged: the pre-armed intent has done its job, drop it so the cron
  // has nothing to chase.
  //
  // SIEMPRE, no solo tras un add/remove (2-oct-2026). Un cambio de solo edits no arma
  // red, pero puede encontrarse una fila vieja de esta sub (cerrada por el cron); si
  // sobreviviera, sus valores podrían "explicar" el estado nuevo y la guarda del
  // principio leería a medias una sub que está bien. La sub acaba de converger aquí: no
  // queda nada que esa fila pueda describir.
  await disarmRepairIntent();

  // Lines converged. Record it before the verification step, so the audit trail exists
  // even if verification then times out or reports a mismatch.
  await writeAudit("applied");

  // Happy path: swap done (or no swap needed) — put the 15% back on the sub.
  // The reattach revives the tracking row to pending_charge; the seal webhook /
  // daily cron then removes the code after the (already-happened or upcoming)
  // discounted charge. We do NOT settle it in-request: an unbounded extra Seal
  // read here could time out the plan change and drop the re-anchor intent
  // written below (audit 2026-07-23 round 2). The cron is the backstop.
  await reattachCarriedDiscounts();

  // VERIFICATION POST-MUTATION (Juan 2026-05-19 round 2):
  //
  // Background:
  //   - We removed the synchronous re-fetch in a previous commit because
  //     Seal pagination cost ~2-4 s per call and we kept hitting Vercel's
  //     10 s timeout. We replaced it with a synthetic response.
  //   - Then Juan reported that the frequency change "looked OK" but
  //     never actually applied — exactly the silent Seal lie I warned
  //     about. The synthetic response was masking real failures.
  //
  // Compromise:
  //   1) Wait 500 ms for Seal to settle after edit (gives it a beat to
  //      apply the interval before we read it back).
  //   2) Fetch the sub ONCE with a hard 4 s AbortController budget. If
  //      verification fits in budget AND matches expected state → return
  //      the real sub data. If it MISMATCHES → throw a precise error so
  //      the customer knows what to retry.
  //   3) If the verify call times out or errors → log it loudly and fall
  //      back to the synthetic response. The customer still sees apparent
  //      success, but we have observability to fix in follow-up.
  //
  // Net latency: ~1-4 s extra. Total request stays well under 10 s for
  // the common case (~6-8 s) and only nears the limit on slow Seal days.

  // 500 ms grace period
  await new Promise((r) => setTimeout(r, 500));

  // Verify with strict 4 s budget
  let verified: SealSubscription | null = null;
  // "not_found" existe porque getSubscriptionById puede devolver null SIN lanzar, y
  // entonces el outcome se quedaba en "ok": la fila del ledger salía como
  // `verify_ok`, que se lee como éxito cuando en realidad no hemos verificado nada.
  // (Aviso de Kiko, 31-ago-2026.)
  let verifyOutcome: "ok" | "timeout" | "error" | "not_found" = "ok";
  const verifyController = new AbortController();
  const verifyTimer = setTimeout(() => verifyController.abort(), 4_000);
  try {
    // Singular by-id endpoint (1 call). The legacy getSubscription paginated
    // the WHOLE store (~50 pages, Promise.all) on every plan change — firing
    // exactly while Seal regenerates attempts and the FE re-polls, i.e. the
    // remaining 429 stampede after the 2026-07-06 getSubscriptionsByEmail fix.
    // Con el presupuesto gastado (p.ej. tras un remove que "falló" pero entró) esta lectura
    // nacía muerta a 0 ms y la petición acababa en `verify_error` sobre un cambio bueno.
    // Su propio tope de 4 s sigue mandando. (2-oct-2026)
    verified = await afterBudget(() => seal.getSubscriptionById(sealSubscriptionId, verifyController.signal));
    if (!verified) verifyOutcome = "not_found";
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      verifyOutcome = "timeout";
    } else {
      verifyOutcome = "error";
    }
    console.error("[plan-change] verify fetch failed", {
      sealSubscriptionId,
      outcome: verifyOutcome,
      msg: e instanceof Error ? e.message : String(e),
    });
  } finally {
    clearTimeout(verifyTimer);
  }

  if (verified) {
    const actualInterval = (verified.delivery_interval ?? "").toLowerCase().trim();
    const expectedNormalized = expectedInterval.toLowerCase().trim();
    const stripPlural = (s: string) => s.replace(/s\b/g, "").trim();
    const intervalMatches =
      stripPlural(actualInterval) === stripPlural(expectedNormalized);

    // Verify the whole LINE SET, not just one item: same variants, same quantities,
    // same per-unit prices, every line still recurring, and every line on the target
    // selling plan. Checking only the first item is how a multi-line sub could pass
    // verification while silently holding a duplicate.
    const finalLines = getLines(verified);
    const wanted = new Map(targetPlan.lines.map((l) => [String(l.variantId), l]));
    const linesMatch =
      finalLines.length === targetPlan.lines.length &&
      finalLines.every((l) => {
        const t = wanted.get(String(l.variantId));
        return (
          !!t &&
          Number(l.quantity) === t.quantity &&
          priceToCents(l.unitPrice) === t.unitPriceCents
        );
      });

    // THE MONEY ASSERTION. Σ quantity × unit price must equal the tier total, so a mix
    // costs exactly what the equivalent pure plan costs. Deliberately computed from
    // the items and NOT from Seal's `total_value`, which nets out discount codes and
    // would false-positive for anyone on the retention 15%.
    const actualCents = getChargeTotalCents(verified);
    const moneyMatches = Math.abs(actualCents - targetPlan.totalCents) <= 1;

    // A line that landed as one-time means its product isn't attached to the selling
    // plan: it would ship once and vanish, silently changing what the customer gets.
    const oneTimeLeak = (verified.items ?? []).some(
      (it) => it.is_one_time_item && wanted.has(String(it.variant_id)),
    );

    if (!intervalMatches || !linesMatch || !moneyMatches || oneTimeLeak) {
      console.error("[plan-change] verification MISMATCH — Seal silent lie", {
        expectedInterval,
        actualInterval: verified.delivery_interval,
        wanted: targetPlan.lines.map((l) => `${l.variantId}×${l.quantity}@${centsToPrice(l.unitPriceCents)}`),
        actual: finalLines.map((l) => `${l.variantId}×${l.quantity}@${l.unitPrice}`),
        expectedCents: targetPlan.totalCents,
        actualCents,
        intervalMatches, linesMatch, moneyMatches, oneTimeLeak,
      });
      // Cerrar el apunte con lo que de verdad pasó y, si lo que no cuadra son las LÍNEAS o
      // el IMPORTE, volver a armar la red (2-oct-2026). Esta lectura es una sola y puede ir
      // por detrás de Seal, igual que la del restore; si la sub quedó de verdad a medias,
      // el "inténtalo de nuevo" del cliente partiría de esa foto rota. Con la red armada,
      // la guarda del principio lo para y el cron decide con una lectura asentada: si ya
      // estaba bien, cierra en la siguiente pasada sin escribir nada en Seal.
      await writeAudit("verify_mismatch");
      if (!linesMatch || !moneyMatches) {
        await scheduleRepair(`verificación no cuadra (líneas ${linesMatch ? "ok" : "NO"}, importe ${moneyMatches ? "ok" : "NO"})`);
      }
      if (oneTimeLeak) {
        throw new ApiHttpError(
          502,
          "mix_line_not_recurring",
          `A line landed as one-time (product not attached to the selling plan). Contact support.`,
        );
      }
      // Money first: it is the most consequential mismatch and the early warning that
      // Seal is not honouring our per-unit price.
      if (!moneyMatches) {
        alertSlackError({
          path: "/api/subscription/plan",
          code: "mix_price_mismatch",
          msg:
            `sub ${sealSubscriptionId}: after the change Seal charges ${actualCents}c but the ` +
            `${targetPlan.boxCount}-box tier is ${targetPlan.totalCents}c. Seal may be ignoring the ` +
            `per-unit price we send. Verify before the next charge.`,
          customerId: ctx.customerId,
        });
        throw new ApiHttpError(
          502,
          "mix_price_mismatch",
          `Seal did not apply the expected price (${actualCents}c vs ${targetPlan.totalCents}c).`,
        );
      }
      if (!intervalMatches && linesMatch) {
        throw new ApiHttpError(
          502,
          itemsChanged ? "frequency_change_failed_partial" : "frequency_change_failed",
          `Seal accepted the edit but delivery_interval is still "${verified.delivery_interval}" (expected "${expectedInterval}").`,
        );
      }
      if (intervalMatches && !linesMatch) {
        throw new ApiHttpError(
          502,
          "variant_change_failed",
          `Seal accepted the item changes but the lines don't match the target.`,
        );
      }
      throw new ApiHttpError(
        502,
        "plan_verification_failed",
        `Both interval and lines didn't match expected values after plan change.`,
      );
    }

    // Seal SÍ tiene lo que le pedimos. Fila propia porque "applied" se escribe antes
    // de llegar aquí y por tanto NUNCA significó "Seal cumplió", solo "acabamos de
    // mandarlo": un 502 de verificación deja también su fila "applied". Cualquier
    // detector que cruce el ledger contra Seal necesita esta distinción, o marca como
    // descuadre todo lo que se quedó a medias. (24-ago-2026)
    await writeAudit("verified");

    // ───── Guardar (o limpiar) el precio preservado ─────
    //
    // Seal ya ha confirmado lo que escribimos, así que este es el único punto donde
    // decir "este contrato tiene derecho a pagar X" es cierto.
    //
    // Hace falta porque, una vez preservado, el line-set es idéntico al de una sub
    // nueva legítima: si Seal reseteara una línea al precio de catálogo, la sub
    // aterrizaría EXACTAMENTE en la escalera web y ni el cron ni la auditoría lo
    // verían (comparan contra la escalera). Guardar la intención es lo que permite
    // distinguir un precio preservado de una corrupción de Seal.
    //
    // Se limpia a NULL cuando el cliente cambia de nº de cajas: ahí compra otra
    // cantidad y el catálogo pasa a ser su precio legítimo.
    // Best effort, nunca fatal: el cambio ya está aplicado y verificado en Seal, y
    // fallar aquí solo nos deja sin la señal, no le rompe nada al cliente.
    // ASIMETRÍA (2026-09-17): fallar al ESCRIBIR una preservación es inocuo (el cron
    // vuelve a verla como catálogo); BORRARLA por error le sube el precio al cliente de
    // forma permanente. El 11-sep una lectura a medio aplicar hizo exactamente eso:
    // `boxCountChangedFromLive` salió true porque Seal enseñaba 1 caja de 3, y este
    // bloque borró un preservado legítimo de 67,92 escrito 5 segundos antes.
    //
    // Así que el borrado ya no se fía de la foto a secas: solo limpia cuando las cajas
    // que vamos a ESCRIBIR difieren de las del contrato guardado. Si no hay contrato
    // guardado, se mantiene el comportamiento anterior (la foto es lo único que hay).
    const contractBoxCount = preservedContract?.boxCount ?? null;
    const clearPreservation =
      pricePreservedFromCents === null &&
      boxCountChangedFromLive &&
      (contractBoxCount === null || targetBoxCount !== contractBoxCount);
    if (pricePreservedFromCents === null && boxCountChangedFromLive && !clearPreservation) {
      log("preserved-charge-clear-skipped", {
        contractBoxCount,
        targetBoxCount,
        liveBoxCount: mixBoxCount(currentComposition),
      });
    }
    if (pricePreservedFromCents !== null || clearPreservation) {
      // El importe y SUS cajas van siempre juntos: un importe sin las cajas a las
      // que pertenece es una entitlement que el cron puede aplicar sobre una
      // composición que ya no es la suya. (Aviso de Kiko, 3-sep-2026.)
      await writePreservedColumns(
        pricePreservedFromCents !== null
          ? { preserved_charge_cents: targetPlan.totalCents, preserved_box_count: targetBoxCount }
          : { preserved_charge_cents: null, preserved_box_count: null },
      );
    }

    // ───── Preserve the prior next-ship date (don't revert earlier steps) ─────
    //
    // ONLY a frequency change regenerates the schedule. A box-count change
    // (add_items + remove_items) leaves billing_attempts untouched — same IDs,
    // same dates — so there's nothing to preserve. (Confirmed against the live
    // Seal API 2026-06-12.) So we only act when planChanged.
    //
    // When the frequency changes, Seal DELETES every pending billing_attempt
    // immediately and REGENERATES the schedule ASYNCHRONOUSLY (~60-100 s, up to
    // hours per Seal's docs) anchored on "last completed charge + interval",
    // ignoring any prior skip. If a customer had skipped to 27-Sep, the
    // regenerated next charge can snap back to 27-Jun. Business rule: a plan
    // change must NEVER move the next charge earlier than the date the customer
    // already had.
    //
    // We CANNOT fix this in-request: the regen hasn't happened yet when we
    // return (this is exactly what broke the first two attempts — we read 0
    // pending and concluded "all good", then Seal reset the date a minute
    // later). Instead we persist a "preserve this date" intent and let the
    // Seal `subscription/updated` webhook — which fires WHEN regen completes —
    // skip the regenerated early attempts (seal.skipIntermediateAttempts), so
    // the first surviving charge lands on the preserved date. The Hub dashboard
    // re-poll and the cron drain are backstops. We respond optimistically with
    // the preserved date so the customer sees it immediately.
    let finalNextShipDate: string | null = getNextBillingAttempt(verified)?.date ?? null;
    if (planChanged && effectivePreserveYYYYMMDD && !isWithinCutoff(`${effectivePreserveYYYYMMDD}T13:00:00Z`)) {
      // Fuera del deadline si ya no queda presupuesto: es la red del calendario, y sin ella
      // el próximo cobro puede adelantarse. Con el presupuesto gastado se cortaba a 0 ms.
      // (2-oct-2026)
      await afterBudget(
        () => writeReanchorIntent(ctx.customerId, sealSubscriptionId, effectivePreserveYYYYMMDD!),
        SUPABASE_WRITE_RESERVE_MS,
      ).catch((e) => log("reanchor-intent-write-failed", { msg: String(e) }));
      finalNextShipDate = `${effectivePreserveYYYYMMDD}T13:00:00Z`; // optimistic; webhook/cron makes it real
      log("reanchor-intent-recorded", { effectivePreserveYYYYMMDD, reanchorMode });
    }

    log("done-verified", {
      sealSubscriptionId,
      finalInterval: verified.delivery_interval,
      finalLines: finalLines.map((l) => `${l.variantId}×${l.quantity}`),
      finalChargeCents: actualCents,
      finalNextShipDate,
    });
    return { ...mapToSubscription(verified, ctx.customerId), nextShipDate: finalNextShipDate };
  }

  // Verification timed out or errored — fall back to synthetic response.
  // The mutation may have applied; we just couldn't confirm in time. The
  // FE's silent re-poll picks up the real state on the next refresh.
  //
  // We couldn't run the in-request poll-and-skip here (it needs the verified
  // sub state). Record a re-anchor intent so the cron drain
  // (/api/cron/reanchor-drain) preserves the prior next-ship date once Seal
  // finishes regenerating. This is exactly the case the safety net exists for.
  if (effectivePreserveYYYYMMDD && !isWithinCutoff(`${effectivePreserveYYYYMMDD}T13:00:00Z`)) {
    await afterBudget(
      () => writeReanchorIntent(ctx.customerId, sealSubscriptionId, effectivePreserveYYYYMMDD!),
      SUPABASE_WRITE_RESERVE_MS,
    ).catch((e) => log("reanchor-intent-write-failed", { msg: String(e) }));
    log("reanchor-deferred-to-cron-unverified", { sealSubscriptionId, effectivePreserveYYYYMMDD, verifyOutcome });
  }
  // No hemos podido leer Seal de vuelta (timeout, error o null), así que NO sabemos
  // si cumplió. Queda escrito para que el detector no lo confunda con un "verified".
  // Los cuatro nombres posibles son verify_timeout, verify_error, verify_not_found y
  // verify_ok; el último solo aparece si Seal devolvió algo pero la rama de
  // verificación no llegó a correr, y también significa "sin verificar".
  await writeAudit(`verify_${verifyOutcome}`);

  // SIN VERIFICAR = SIN CONFIRMAR (4-sep-2026). Aquí las mutaciones se aplicaron pero
  // no hemos podido leer Seal de vuelta, así que no sabemos si el line-set quedó como
  // queríamos. Hasta hoy eso se registraba en la auditoría y se devolvía un 200: la
  // fila queda para el forense, pero nadie la mira en tiempo real, así que una
  // escritura mal aplicada salía por la puerta como un éxito.
  //
  // Se vuelve a armar la intención de reparación (el `disarm` de más arriba corrió al
  // converger las líneas, ANTES de este punto). El cron relee el estado vivo y lo
  // compara con `desired`: si de verdad quedó bien, cierra como no-op y no ha costado
  // nada; si no, lo converge. Es exactamente la asimetría que ya asumimos en el resto
  // de la ruta: una intención de sobra es barata, una que falta cuesta dinero.
  if (diff.adds.length || diff.removes.length) {
    await scheduleRepair(`sin verificar (${verifyOutcome})`);
    log("repair-intent-rearmed-unverified", { verifyOutcome });
  }

  log("done-unverified", {
    sealSubscriptionId,
    verifyOutcome,
    finalInterval: expectedInterval,
    finalLines: targetPlan.lines.map((l) => `${l.variantId}×${l.quantity}`),
  });
  return synthesizePostMutationSub(
    sealSubscriptionId,
    targetPlan,
    currentLines,
    expectedInterval,
    ctx.customerId,
    effectivePreserveYYYYMMDD,
  );
  } // fin de applyPlanChange
};

/**
 * Corre `fn` fuera del deadline de la petición solo si ese deadline ya está agotado.
 *
 * Con presupuesto de sobra, el cliente está esperando la respuesta y no se le alarga.
 * Agotado, la App Proxy ya ha dejado de esperar (le ha devuelto `gateway_timeout`) y lo
 * que queda es dejar bien la sub y el ledger: dentro del deadline cada llamada nacería
 * muerta a 0 ms. `maxDuration` (20 s) sigue siendo el techo. (2-oct-2026)
 */
function afterBudget<T>(fn: () => Promise<T>, reserveMs = 0): Promise<T> {
  const left = requestDeadlineLeft();
  return left !== null && left <= reserveMs ? runWithoutRequestDeadline(fn) : fn();
}

/** Margen con el que una escritura a Supabase (~100 ms en un día normal) se saca del
 *  deadline: por debajo, dentro se cortaría y se perdería la fila. */
const SUPABASE_WRITE_RESERVE_MS = 1_000;
/** Margen para reponer el 15%: aplicar el código en Seal, releer y revivir la fila de
 *  seguimiento. Con menos, cada llamada se corta y o se pierde el descuento o queda puesto
 *  sin seguimiento, que es la fuga del 23-jul. */
const RETENTION_REATTACH_RESERVE_MS = 3_000;

/**
 * Lo que el `catch` de fuera necesita saber para cerrar el apunte de la petición en
 * `subscription_changes`. Ver "EL LEDGER SIEMPRE SE CIERRA" en patchPlan.
 */
interface RequestLedger {
  /** Mismo id en todas las filas de UNA petición. */
  requestId: string;
  /** Hay un `intent` escrito y todavía ninguna fila que lo cierre. */
  open: boolean;
  /** Hay una intención de reparación armada: la cerrará el cron, no esta petición. */
  repairArmed: boolean;
  /** `created_at` de la red que armó ESTA petición: es la única que puede borrar. */
  armedAt: string | null;
  /** Una escritura falló sin que Seal la rechazara y NO se pudo armar la red. */
  outcomeUnknown: boolean;
  /** La guarda no pudo leer `subscription_line_repairs`: puede haber una red ajena viva. */
  guardBlind: boolean;
  close: (outcome: string) => Promise<void>;
}

/**
 * 409 `change_in_progress` si esta sub tiene una escritura de líneas nuestra sin cerrar.
 * Ver "NO SE TARIFICA SOBRE UNA ESCRITURA A MEDIAS" en patchPlan.
 *
 * Si Supabase no responde se deja pasar, igual que el cerrojo: bloquear TODOS los
 * cambios de plan por un parpadeo de la base sería peor. Y sin base tampoco se arma la
 * red, así que esa petición no llegará a hacer un add+remove (ver el pre-armado).
 */
async function assertNoUnfinishedLineWrite(
  customerId: string,
  sealSubscriptionId: number,
  currentLines: SubscriptionLine[],
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<boolean> {
  let row: {
    status: string;
    snapshot: unknown;
    desired: unknown;
    created_at: string;
    last_error: string | null;
  } | null = null;
  try {
    const { data, error } = await supabaseAdmin()
      .from("subscription_line_repairs")
      .select("status, snapshot, desired, created_at, last_error")
      .eq("customer_id", customerId)
      .eq("seal_subscription_id", String(sealSubscriptionId))
      .maybeSingle();
    if (error) {
      log("line-repair-read-failed", { msg: error.message });
      return false;
    }
    row = data;
  } catch (e) {
    log("line-repair-read-threw", { msg: e instanceof Error ? e.message : String(e) });
    return false;
  }
  if (!row) return true;

  // Una fila `done` NUNCA bloquea: el cron la cerró con la sub coherente, y comparar contra
  // su foto días después daría falsos "a medias" en cuanto el cliente hiciera un cambio de
  // solo edits que coincida en valores (2L → 1L+1W cerrada, y luego 1L+1W → 2L+1W lee
  // "partial" para siempre). Solo bloquean una pendiente viva, que el cron todavía no ha
  // decidido, o una que el cron abandonó (expiró o se rindió) y que SIGUE a medias.
  if (row.status === "done") return true;
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  const pending = row.status === "pending" && ageMs < LINE_REPAIR_TTL_MS;
  if (!pending) {
    const state = classifyLineState(
      currentLines,
      (row.snapshot ?? []) as SubscriptionLine[],
      (row.desired ?? []) as TargetLine[],
    );
    if (state.kind !== "partial") return true;
  }

  log("unfinished-line-write-blocks-change", {
    status: row.status,
    ageMs,
    pending,
    lastError: row.last_error,
  });
  if (!pending) {
    // El cron ya no la va a cerrar (se rindió o expiró) y la sub SIGUE a medias. Este
    // aviso es lo único que la pone delante de una persona. Awaited: justo después se
    // lanza, y un aviso suelto puede morir con la invocación.
    await alertSlackErrorAwaited({
      path: "/api/subscription/plan",
      code: "unfinished_line_write",
      msg:
        `sub ${sealSubscriptionId}: el cliente intenta cambiar el plan y la sub sigue a medias de una ` +
        `escritura anterior que el cron no pudo cerrar (${row.last_error ?? row.status}). Rechazado para ` +
        `no tarificar sobre esa foto. Dejarla a mano como la foto o como el objetivo de ` +
        `subscription_line_repairs.`,
      customerId,
    });
  }
  throw new ApiHttpError(
    409,
    "change_in_progress",
    "Your last change to this subscription is still being applied; try again in a few minutes",
  );
}

/**
 * Mix fields for a synthetic response, projected from the target plan.
 *
 * A synthetic response never read the subscription back, so the Seal item ids of
 * lines we just ADDED are unknown. Those get `itemId: 0`, and the FE reconciles with
 * a refetch — which it already does after a plan change precisely because item ids
 * churn. `itemId` is reused from the pre-mutation line when the diff kept it (the
 * edit-only path), which is the common case and means the FE's cached ids stay valid.
 */
function projectedMixFields(
  plan: MixPlan,
  previousLines: SubscriptionLine[],
  sellingPlanId: string,
): Pick<Subscription, "lines" | "composition" | "shape" | "flavorSummary" | "chargeTotalCents"> {
  const lines: SubscriptionLine[] = plan.lines.map((t) => ({
    itemId: previousLines.find((p) => String(p.variantId) === String(t.variantId))?.itemId ?? 0,
    productId: t.productId,
    variantId: t.variantId,
    flavor: t.flavor,
    boxes: t.boxes,
    quantity: t.quantity,
    unitPrice: centsToPrice(t.unitPriceCents),
    sellingPlanId,
  }));
  const composition = plan.lines.map((l) => ({ flavor: l.flavor, boxes: l.boxes }));
  return {
    lines,
    composition,
    shape: plan.shape,
    flavorSummary: compositionLabel(composition),
    chargeTotalCents: plan.totalCents,
  };
}

/** Dominant line of a projected plan — the back-compat `mainItemId`/`currentVariantId`. */
function dominantOf(fields: Pick<Subscription, "lines">): SubscriptionLine | null {
  return [...fields.lines].sort((a, b) => b.boxes - a.boxes)[0] ?? null;
}

/**
 * Build the Subscription response shape from what we know, without fetching from
 * Seal. The FE's silent re-poll picks up the regenerated nextShipDate on the next
 * dashboard refresh.
 */
function synthesizePostMutationSub(
  sealSubscriptionId: number,
  plan: MixPlan,
  previousLines: SubscriptionLine[],
  expectedInterval: string,
  customerId: string,
  /** When set, show this date optimistically (a re-anchor intent is pending). */
  preserveYYYYMMDD?: string | null,
): Subscription {
  const frequency = normalizeFrequency(expectedInterval);
  const mix = projectedMixFields(plan, previousLines, SELLING_PLAN_BY_FREQUENCY[frequency]);
  const dom = dominantOf(mix);
  return {
    customerId,
    sealSubscriptionId: String(sealSubscriptionId),
    mainItemId: dom?.itemId ?? 0,
    currentVariantId: dom?.variantId ?? "",
    boxCount: plan.boxCount,
    ...mix,
    // Same rule as mapToSubscription, so a synthetic response never disagrees with a
    // real read about whether the builder is available.
    canEditMix: plan.boxCount >= 2 && mixEnabledForCustomer(customerId),
    frequency,
    frequencyLabel: expectedInterval,
    flavor: flavorLabel(dom?.flavor ?? DEFAULT_FLAVOR),
    // Optimistic: show the preserved date while the cron finishes the skip.
    // Otherwise null and the FE re-polls for the regenerated date.
    nextShipDate: preserveYYYYMMDD ? `${preserveYYYYMMDD}T13:00:00Z` : null,
    nextBoxNumber: null,
    status: "active",
    createdAt: new Date().toISOString(),
    withinCutoff: false,
    cutoffEndsAt: null,
    shippingAddress: null,
    payment: {
      cardExpiryMonth: null,
      cardExpiryYear: null,
    },
  };
}

/**
 * No-op response: already in the target state, so return it without any Seal calls.
 * The FE will refresh the dashboard separately.
 */
function synthesizeNoOpSub(
  sealSubscriptionId: number,
  plan: MixPlan,
  currentLines: SubscriptionLine[],
  frequency: Frequency,
  customerId: string,
): Subscription {
  const mix = projectedMixFields(plan, currentLines, SELLING_PLAN_BY_FREQUENCY[frequency]);
  const dom = dominantOf(mix);
  return {
    customerId,
    sealSubscriptionId: String(sealSubscriptionId),
    mainItemId: dom?.itemId ?? 0,
    currentVariantId: dom?.variantId ?? "",
    boxCount: plan.boxCount,
    ...mix,
    canEditMix: plan.boxCount >= 2 && mixEnabledForCustomer(customerId),
    frequency,
    frequencyLabel: frequency,
    flavor: flavorLabel(dom?.flavor ?? DEFAULT_FLAVOR),
    nextShipDate: null,
    nextBoxNumber: null,
    status: "active",
    createdAt: new Date().toISOString(),
    withinCutoff: false,
    cutoffEndsAt: null,
    shippingAddress: null,
    payment: {
      cardExpiryMonth: null,
      cardExpiryYear: null,
    },
  };
}

// waitForSealBillingAttempts removed 2026-05-19: it was the main cause of
// 10 s Vercel timeouts on this route. Each iteration paginated through 26
// pages of Seal data (~2-4 s per call) and the route ran out of budget
// before completing. Replaced with the synthetic response strategy above,
// where the FE picks up the regenerated nextShipDate via its own 60 s
// silent re-poll. If we need server-side verification again later, ship
// it as a separate light-weight call with a strict timeout (e.g.,
// AbortController.signal after 2 s) so we never block the response.

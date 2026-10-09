/**
 * Referidos «Trae a alguien», fase 0: la orquestación.
 *
 * Reúne los hechos (Supabase, Seal, Shopify) y le pregunta a `referral-core.ts`
 * qué hacer. Cuatro piezas:
 *
 *   1. CÓDIGOS. Un código personal por suscriptor (`MARIA27`), reservado en
 *      `referral_codes` y dado de alta en Shopify en bloque desde el cron. El
 *      portal solo los lee.
 *
 *   2. CONVERSIONES. Un pedido pagado con un código de amigo se registra en el
 *      webhook `orders/paid` (barato y sin lanzar nunca) y se cualifica justo
 *      después, fuera de la respuesta (`after()`), con el cron de respaldo.
 *
 *   3. RECOMPENSAS. Los 10 € de quien invita. Se aplican en su sub de Seal SOLO
 *      desde el cron, SOLO 1-48 h antes del cobro y con el cerrojo del cambio de
 *      plan tomado; se dan por consumidas SOLO con el pedido de renovación que
 *      lleva el código delante; y se retiran en cuanto se consumen. Un código en
 *      Seal se repite en cada cobro hasta que se quita (incidente 2026-07-23 con
 *      LITSTAY15) y `apply` no es idempotente (incidente BONUS5), así que cada paso
 *      que toca Seal relee antes y después, y `apply_sent_at` deja rastro de que la
 *      orden salió por si la pasada muere a mitad.
 *
 *   4. LA GUARDA DEL CAMBIO DE PLAN. Un alta + baja de líneas en Seal arrastra
 *      los códigos de forma INVISIBLE a la línea nueva. `/api/subscription/plan`
 *      llama a `detachReferralRewardsForSwap` antes del swap: el código se
 *      retira y la recompensa vuelve a la cola, y el cron la repone a tiempo.
 *
 * Reglas de la casa que se cumplen aquí: nunca se toca el precio de una línea
 * (el premio es un código); a quien invita nunca se le dice quién ha comprado;
 * ante la duda, no se aplica; y toda alerta de dinero lleva el id de la
 * recompensa en su código (el aviso de Slack deduplica por código durante 60 s,
 * y dos fallos distintos no pueden fundirse en uno).
 */

import { createHmac } from "node:crypto";
import { alertSlackErrorAwaited, alertSlackNoticeAwaited } from "@/lib/alert";
import { ApiHttpError } from "@/lib/api-helpers";
import { referralRewardsEnabledFor, referralRewardsScope, referralsScope } from "@/lib/flags";
import { klaviyo } from "@/lib/klaviyo";
import { acquirePlanLock, type PlanLock } from "@/lib/plan-lock";
import {
  canStartApply,
  checkApplyPostcondition,
  decideRewardAction,
  eurosToCents,
  generateReferralCode,
  generateRewardCode,
  hasB2BTag,
  isRenewalSource,
  isRewardCode,
  nextCheckAt,
  normalizeAddress,
  normalizeCode,
  normalizeEmail,
  normalizePhone,
  QUALIFY_RETRY_MS,
  qualifyConversion,
  REFERRAL_REWARD_CENTS,
  REWARD_EXPIRY_MS,
  VELOCITY_WINDOW_MS,
  type AppliedSubState,
  type RewardAction,
  type RewardStatus,
  type SubCandidate,
} from "@/lib/referral-core";
import {
  bulkAddFriendCodes,
  countPriorLitOrders,
  createRewardDiscount,
  deleteCodeDiscount,
  findCodeDiscountNodeId,
  readBulkCreation,
  readCustomerBasics,
  readOrderForReferral,
  type ReferralOrderFacts,
} from "@/lib/referral-shopify";
import {
  findAllAppliedDiscountCodeIds,
  getNextBillingAttempt,
  mapStatus,
  seal,
  SealApiError,
  type SealSubscription,
} from "@/lib/seal";
import { formatShipDateEs } from "@/lib/ship-date-label";
import { supabaseAdmin } from "@/lib/supabase";

const LOG = "[referrals]";
const PATH = "lib/referral-reward";

/** El código de un solo cobro del flujo de cancelación. Con él puesto, la recompensa espera. */
const RETENTION_CODE = normalizeCode(process.env.RETENTION_DISCOUNT_CODE ?? "LITSTAY15");

/**
 * Vida del cerrojo del cambio de plan mientras el cron aplica: el doble del
 * maxDuration de la función (60 s). Así no puede caducar mientras la aplicación
 * sigue viva, y su `release()` (que borra por cliente y sub sin mirar quién lo
 * tiene) nunca se lleva por delante el cerrojo de una petición del cliente.
 */
const APPLY_LOCK_TTL_SECONDS = 120;

// ═══════════════════════════════════════════════════════════════════════════
// Filas
// ═══════════════════════════════════════════════════════════════════════════

interface CodeRow {
  customer_id: string;
  code: string;
  status: "pending" | "active" | "failed" | "disabled" | "retired";
  bulk_creation_id: string | null;
  attempts: number;
}

interface ConversionRow {
  id: string;
  referrer_customer_id: string;
  converted_order_id: string;
  converted_at: string;
  code: string | null;
  status: "pending" | "qualified" | "rejected" | "review" | "revoked" | "legacy";
  attempts: number;
}

interface RewardRow {
  id: string;
  conversion_id: string;
  referrer_customer_id: string;
  amount_cents: number;
  status: RewardStatus;
  status_reason: string | null;
  seal_subscription_id: string | null;
  reward_code: string | null;
  shopify_discount_id: string | null;
  seal_discount_ids: string[] | null;
  charge_due_at: string | null;
  apply_sent_at: string | null;
  applied_at: string | null;
  consumed_order_id: string | null;
  expires_at: string;
  attempts: number;
  updated_at: string;
  /** Embebida (FK conversion_id): el pedido del amigo. */
  conv?: { converted_order_id: string; converted_at: string } | null;
}

const REWARD_COLUMNS =
  "id, conversion_id, referrer_customer_id, amount_cents, status, status_reason, seal_subscription_id, reward_code, shopify_discount_id, seal_discount_ids, charge_due_at, apply_sent_at, applied_at, consumed_order_id, expires_at, attempts, updated_at";
const REWARD_WITH_CONV = `${REWARD_COLUMNS}, conv:referral_conversions(converted_order_id, converted_at)`;

const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Huella HMAC de un dato personal, para el antifraude sin guardar el dato. */
function fingerprint(value: string | null): string | null {
  const secret = process.env.REFERRAL_FINGERPRINT_SECRET;
  if (!secret || !value) return null;
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);
}

/** Alerta de dinero: el id va en el código para que el dedupe de 60 s no funda dos casos. */
async function moneyAlert(code: string, id: string, msg: string, customerId?: string): Promise<void> {
  await alertSlackErrorAwaited({ path: PATH, code: `${code}:${id}`, msg, customerId });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Códigos personales
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reserva el código de un cliente (fila `pending`). Idempotente: si ya tiene
 * fila no hace nada, salvo una `retired` (la de prueba de abril), que recibe un
 * código nuevo. Lo dará de alta en Shopify el cron.
 */
export async function ensurePendingCode(customerId: string, firstName: string | null): Promise<void> {
  const sb = supabaseAdmin();
  const { data: existing, error: readErr } = await sb
    .from("referral_codes")
    .select("status")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (readErr) throw new Error(`referral_codes read: ${readErr.message}`);
  if (existing && existing.status !== "retired") return;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateReferralCode(firstName, { digits: attempt < 3 ? 2 : 3 });
    const row = { code, status: "pending", attempts: 0, last_error: null, bulk_creation_id: null, updated_at: nowIso() };
    const { error } = existing
      ? await sb.from("referral_codes").update(row).eq("customer_id", customerId).eq("status", "retired")
      : await sb.from("referral_codes").insert({ customer_id: customerId, ...row });
    if (!error) return;
    // 23505 en `code`: ese código ya es de otro cliente → otras cifras. En la PK:
    // otra petición reservó a la vez → ya está.
    if (error.code === "23505" && /customer_id|pkey/i.test(error.message)) return;
    if (error.code !== "23505") throw new Error(`referral_codes reserve: ${error.message}`);
  }
  throw new Error(`referral_codes: 6 colisiones seguidas para ${customerId}`);
}

export interface IssueSummary {
  activated: number;
  regenerated: number;
  disabled: number;
  failed: number;
  stillPending: number;
}

/** Mismo descuento aunque uno venga como gid y otro como id suelto. */
function sameDiscountId(a: string | null | undefined, b: string | null | undefined): boolean {
  const tail = (v: string | null | undefined) => (v ?? "").trim().split("/").pop() ?? "";
  return !!tail(a) && tail(a) === tail(b);
}

/**
 * Da de alta en Shopify los códigos `pending` (como mucho `max`). Lo llama el
 * cron en cada pasada y el script del backfill en bucle. Nunca toca un código activo.
 *
 * Una bulk que Shopify no termina dentro del presupuesto se deja apuntada en
 * `bulk_creation_id` y la siguiente pasada la consulta antes de crear otra. Cada
 * cierre de fila va condicionado a `code` (además de al estado): si dos
 * emisores se cruzan, ninguno puede marcar `active` un código que no es el suyo.
 *
 * Toda fila que se queda pendiente por algo suyo sube su `updated_at`: el lote se
 * coge por `updated_at`, y una fila atascada que no se moviera ocuparía su sitio
 * en el lote de cada pasada, por delante de las que sí pueden darse de alta.
 */
export async function issuePendingCodes(opts: {
  max: number;
  dryRun?: boolean;
  /** Para el backfill: ignora el flag (el script ya filtra a quién le toca). */
  ignoreFlag?: boolean;
  /** Para el backfill con `--only`: solo estos clientes. */
  onlyCustomerIds?: string[];
  deadlineMs?: number;
}): Promise<IssueSummary> {
  const summary: IssueSummary = { activated: 0, regenerated: 0, disabled: 0, failed: 0, stillPending: 0 };
  // El alcance del flag se aplica EN LA CONSULTA, antes del límite (ver referralsScope).
  const scope = opts.ignoreFlag ? ({ mode: "on" } as const) : referralsScope();
  if (scope.mode === "off" || (scope.mode === "allowlist" && !scope.ids.length)) return summary;
  const parentId = process.env.REFERRAL_FRIEND_DISCOUNT_ID;
  if (!parentId) {
    await alertSlackErrorAwaited({
      path: PATH,
      code: "referral_parent_missing",
      msg: "REFERRAL_FRIEND_DISCOUNT_ID no está configurado: no se puede dar de alta ningún código de amigo.",
    });
    return summary;
  }
  const pastDeadline = () => opts.deadlineMs !== undefined && Date.now() > opts.deadlineMs;
  const sb = supabaseAdmin();
  let query = sb
    .from("referral_codes")
    .select("customer_id, code, status, bulk_creation_id, attempts")
    .eq("status", "pending");
  if (scope.mode === "allowlist") query = query.in("customer_id", scope.ids);
  if (opts.onlyCustomerIds?.length) query = query.in("customer_id", opts.onlyCustomerIds);
  const { data, error } = await query.order("updated_at", { ascending: true }).limit(opts.max);
  if (error) throw new Error(`referral_codes pending: ${error.message}`);
  const rows = (data ?? []) as CodeRow[];
  if (!rows.length) return summary;

  /** Cambia una fila pendiente SOLO si sigue siendo la misma (estado y código). */
  const patchPending = async (r: CodeRow, patch: Record<string, unknown>) => {
    const { error: upErr } = await sb
      .from("referral_codes")
      .update({ ...patch, updated_at: nowIso() })
      .eq("customer_id", r.customer_id)
      .eq("status", "pending")
      .eq("code", r.code);
    if (upErr) console.warn(LOG, "referral_codes update falló", r.customer_id, upErr.message);
  };

  // 1. Las que ya tienen una bulk en marcha: se consulta su resultado.
  const withBulk = rows.filter((r) => r.bulk_creation_id);
  const fresh = rows.filter((r) => !r.bulk_creation_id);

  // 2. Las nuevas: cliente y B2B. Solo las válidas van a Shopify.
  const toAdd: CodeRow[] = [];
  const emailByCustomer = new Map<string, string>();
  for (const r of fresh) {
    if (pastDeadline()) {
      summary.stillPending++;
      continue;
    }
    let basics: Awaited<ReturnType<typeof readCustomerBasics>>;
    try {
      basics = await readCustomerBasics(r.customer_id);
    } catch (e) {
      // Shopify no contesta: al final de la cola, sin gastar intentos.
      summary.stillPending++;
      if (!opts.dryRun) await patchPending(r, { last_error: `customer_unreadable: ${errMsg(e)}`.slice(0, 300) });
      continue;
    }
    if (!basics) {
      // El cliente ya no existe en Shopify: tres pasadas por si acaso, y fuera.
      const giveUp = r.attempts + 1 >= 3;
      if (giveUp) summary.failed++;
      else summary.stillPending++;
      if (!opts.dryRun) {
        await patchPending(r, {
          attempts: r.attempts + 1,
          last_error: "customer_not_found",
          ...(giveUp ? { status: "failed" } : {}),
        });
      }
      continue;
    }
    if (basics.email) emailByCustomer.set(r.customer_id, basics.email);
    if (hasB2BTag(basics.tags)) {
      summary.disabled++;
      if (!opts.dryRun) {
        await sb
          .from("referral_codes")
          .update({ status: "disabled", disabled_at: nowIso(), disabled_reason: "b2b", updated_at: nowIso() })
          .eq("customer_id", r.customer_id)
          .eq("status", "pending");
      }
      continue;
    }
    toAdd.push(r);
  }

  if (opts.dryRun) {
    summary.stillPending += toAdd.length + withBulk.length;
    return summary;
  }

  if (toAdd.length) {
    const bulkId = await bulkAddFriendCodes(parentId, toAdd.map((r) => r.code));
    const { error: markErr } = await sb
      .from("referral_codes")
      .update({ bulk_creation_id: bulkId, shopify_discount_id: parentId, updated_at: nowIso() })
      .in("customer_id", toAdd.map((r) => r.customer_id))
      .eq("status", "pending");
    if (markErr) console.warn(LOG, "no se pudo apuntar la bulk", bulkId, markErr.message);
    for (const r of toAdd) withBulk.push({ ...r, bulk_creation_id: bulkId });
  }

  const activate = async (r: CodeRow): Promise<void> => {
    const { data: activated } = await sb
      .from("referral_codes")
      .update({ status: "active", activated_at: nowIso(), last_error: null, updated_at: nowIso() })
      .eq("customer_id", r.customer_id)
      .eq("status", "pending")
      .eq("code", r.code)
      .select("customer_id");
    if (!activated?.length) return;
    summary.activated++;
    const email =
      emailByCustomer.get(r.customer_id) ?? (await readCustomerBasics(r.customer_id).catch(() => null))?.email;
    if (email) {
      // Para la campaña de lanzamiento y los flows: el código como propiedad
      // del perfil. Si falla, el código ya funciona; solo falta en el email.
      await klaviyo
        .upsertProfile(email, { referral_code: r.code })
        .catch((e) => console.warn(LOG, "upsertProfile referral_code falló", r.customer_id, errMsg(e)));
    }
  };

  // 3. Consultar cada bulk (unos segundos como mucho) y cerrar fila a fila.
  const byBulk = new Map<string, CodeRow[]>();
  for (const r of withBulk) {
    const list = byBulk.get(r.bulk_creation_id!) ?? [];
    list.push(r);
    byBulk.set(r.bulk_creation_id!, list);
  }
  for (const [bulkId, list] of byBulk) {
    let result: Awaited<ReturnType<typeof readBulkCreation>> | null = null;
    let lost = false;
    for (let i = 0; i < 6; i++) {
      try {
        result = await readBulkCreation(bulkId);
      } catch (e) {
        if (/no existe/.test(errMsg(e))) {
          lost = true;
          break;
        }
        result = null;
      }
      if (result?.done || pastDeadline()) break;
      await sleep(800);
    }
    if (lost) {
      // Shopify no conoce la bulk: se suelta y la siguiente pasada vuelve a dar de
      // alta el mismo código (si ya existiera, abajo se mira de quién es).
      await sb
        .from("referral_codes")
        .update({ bulk_creation_id: null, updated_at: nowIso() })
        .in("customer_id", list.map((r) => r.customer_id))
        .eq("status", "pending")
        .eq("bulk_creation_id", bulkId);
      summary.stillPending += list.length;
      continue;
    }
    if (!result?.done) {
      summary.stillPending += list.length;
      continue;
    }
    const byCode = new Map(result.codes.map((c) => [c.code, c]));
    for (const r of list) {
      const outcome = byCode.get(normalizeCode(r.code));
      if (outcome?.ok) {
        await activate(r);
        continue;
      }
      // Casi siempre: el código ya existe en la tienda. Si existe DENTRO de nuestro
      // padre es nuestro (una bulk anterior que se dio por perdida sí entró) y se
      // activa: regenerarlo dejaría ese código vivo en el padre, dando 10 € al
      // amigo de alguien sin que nadie cobrara su premio. Si es de otro descuento
      // (otro cupón, otro cliente), otras cifras.
      const owner = await findCodeDiscountNodeId(r.code).catch(() => undefined);
      if (owner === undefined) {
        // No se sabe de quién es: se suelta la bulk y se vuelve a intentar.
        summary.stillPending++;
        await patchPending(r, { bulk_creation_id: null, last_error: "owner_unreadable" });
        continue;
      }
      if (owner && sameDiscountId(owner, parentId)) {
        await activate(r);
        continue;
      }
      const basics = await readCustomerBasics(r.customer_id).catch(() => null);
      const next = generateReferralCode(basics?.firstName ?? null, { digits: r.attempts >= 2 ? 3 : 2 });
      const giveUp = r.attempts + 1 >= 8;
      await patchPending(r, {
        code: next,
        bulk_creation_id: null,
        attempts: r.attempts + 1,
        last_error: (outcome?.error ?? (owner ? "ya existe en otro descuento" : "no aparece en la bulk")).slice(0, 300),
        ...(giveUp ? { status: "failed" } : {}),
      });
      if (giveUp) summary.failed++;
      else summary.regenerated++;
    }
  }
  return summary;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Conversiones
// ═══════════════════════════════════════════════════════════════════════════

/** Lo que el webhook `orders/paid` necesita del cuerpo. */
export interface OrderPaidPayload {
  id?: number;
  name?: string;
  source_name?: string | null;
  total_discounts?: string | null;
  discount_codes?: Array<{ code?: string | null }> | null;
  customer?: { id?: number; first_name?: string | null } | null;
}

export interface OrderPaidFollowUp {
  /** Si hay algo que hacer después de responder. La mayoría de pedidos: no. */
  needsFollowUp: boolean;
  /** Conversión registrada que hay que cualificar fuera de la respuesta. */
  conversionId: string | null;
  orderId: string | null;
  isRenewal: boolean;
  customerId: string | null;
  firstName: string | null;
}

/**
 * La parte EN LÍNEA del webhook: barata, sin Seal y sin Shopify. Registra la
 * conversión si el pedido trae un código de amigo, y decide si hace falta un
 * seguimiento ({@link processOrderPaidFollowUp}, que el webhook corre con
 * `after()`): solo si hay conversión, si es una renovación con descuento (puede
 * ser una recompensa consumiéndose) o si el cliente aún no tiene código.
 */
export async function recordOrderPaid(payload: OrderPaidPayload): Promise<OrderPaidFollowUp> {
  const orderId = payload.id ? String(payload.id) : null;
  const isRenewal = isRenewalSource(payload.source_name);
  const codes = [...new Set((payload.discount_codes ?? []).map((d) => normalizeCode(d.code)).filter(Boolean))];
  const followUp: OrderPaidFollowUp = {
    needsFollowUp: false,
    conversionId: null,
    orderId,
    isRenewal,
    customerId: payload.customer?.id ? String(payload.customer.id) : null,
    firstName: payload.customer?.first_name ?? null,
  };
  if (!orderId) return followUp;

  if (isRenewal) {
    // Seal aplica sus códigos como descuento manual: puede que el cuerpo no traiga
    // `discount_codes` pero sí `total_discounts`. Se relee en el seguimiento.
    followUp.needsFollowUp = codes.length > 0 || Number(payload.total_discounts ?? 0) > 0;
    return followUp;
  }

  const sb = supabaseAdmin();
  if (followUp.customerId) {
    const { data: own } = await sb
      .from("referral_codes")
      .select("customer_id")
      .eq("customer_id", followUp.customerId)
      .maybeSingle();
    // Sin fila: puede ser su primera suscripción y hay que reservarle un código.
    if (!own) followUp.needsFollowUp = true;
  }
  if (!codes.length) return followUp;

  const { data: match, error } = await sb
    .from("referral_codes")
    .select("customer_id, code")
    .in("code", codes)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`referral_codes lookup: ${error.message}`);
  if (!match) return followUp;

  // `converted_order_id` único es la idempotencia: un reintento del webhook no
  // registra dos veces el mismo pedido.
  const { data: inserted, error: insErr } = await sb
    .from("referral_conversions")
    .upsert(
      {
        referrer_customer_id: match.customer_id,
        converted_order_id: orderId,
        code: match.code,
        friend_customer_id: followUp.customerId,
        friend_order_name: payload.name ?? null,
        status: "pending",
        drops_awarded: 0,
      },
      { onConflict: "converted_order_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();
  if (insErr) throw new Error(`referral_conversions insert: ${insErr.message}`);
  if (inserted?.id) {
    followUp.conversionId = inserted.id as string;
  } else {
    // Reintento del webhook: la fila ya existía. Se cualifica igual si sigue pendiente.
    const { data: prev } = await sb
      .from("referral_conversions")
      .select("id, status")
      .eq("converted_order_id", orderId)
      .maybeSingle();
    if (prev?.status === "pending") followUp.conversionId = prev.id as string;
  }
  if (followUp.conversionId) followUp.needsFollowUp = true;
  return followUp;
}

/**
 * La parte que corre DESPUÉS de responder a Shopify (`after()`): cualificar la
 * conversión, procesar una renovación que trae un código nuestro, y reservar el
 * código de un suscriptor nuevo. Nunca lanza.
 */
export async function processOrderPaidFollowUp(f: OrderPaidFollowUp): Promise<void> {
  // Por separado: si la cualificación falla, el amigo que acaba de suscribirse
  // tiene que recibir igualmente SU código (abajo). La conversión la recoge el cron.
  if (f.conversionId) await qualifyPendingConversionSafe(f.conversionId);
  try {
    if (!f.orderId) return;
    const order = await readOrderForReferral(f.orderId).catch(() => null);
    if (!order) return;
    if (f.isRenewal) {
      await handleRenewalOrder(order);
      return;
    }
    // Primer pedido con suscripción de alguien sin código: se le reserva uno. El
    // cron lo dará de alta en Shopify (si el flag lo permite para él).
    if (f.customerId && (order.purchaseType === "subscription" || order.purchaseType === "mixed")) {
      await ensurePendingCode(f.customerId, f.firstName);
    }
  } catch (err) {
    console.error(LOG, "seguimiento de orders/paid falló (el cron lo recoge)", f.orderId, errMsg(err));
  }
}

/**
 * Una renovación de Seal con códigos.
 *
 *  - Un LITREF de una recompensa viva (applied, applying o en cola tras una
 *    retirada que llegó tarde) es la prueba de su consumo: se consume y se
 *    quitan todas las copias.
 *  - Un LITREF de una recompensa ya consumida en OTRO pedido, o fallida,
 *    revocada o caducada, es una FUGA: alerta y se intenta quitar.
 *  - Un código de AMIGO en una renovación es otra fuga (alguien lo ha puesto en
 *    una sub): alerta y se intenta quitar.
 */
async function handleRenewalOrder(order: ReferralOrderFacts): Promise<void> {
  if (!order.discountCodes.length) return;
  const sb = supabaseAdmin();
  for (const code of order.discountCodes) {
    if (isRewardCode(code)) {
      const { data: reward, error } = await sb
        .from("referral_rewards")
        .select(REWARD_COLUMNS)
        .eq("reward_code", code)
        .maybeSingle();
      if (error) {
        await moneyAlert("referral_renewal_read_failed", code, `No se pudo leer la recompensa de ${code} (renovación ${order.name}): ${error.message}`);
        continue;
      }
      if (!reward) {
        await moneyAlert("referral_reward_unknown_code", code, `La renovación ${order.name} lleva ${code}, que no es de ninguna recompensa. Revisar en Seal.`);
        continue;
      }
      const r = reward as RewardRow;
      if (r.status === "applied" || r.status === "applying" || r.status === "queued") {
        await consumeReward(r, order.orderId, r.status, order.email);
      } else if (r.status === "failed" && !r.consumed_order_id) {
        // Una fallida (aplicación ambigua, código invisible…) cuyo código SÍ salió
        // en un cobro: este pedido es la prueba. Se cierra como consumida, porque
        // si se quedara en failed alguien podría reencolarla a mano y serían otros
        // 10 €. Se avisa igual: hay que saber por qué falló.
        const out = await consumeReward(r, order.orderId, "failed", order.email);
        await moneyAlert(
          "referral_failed_reward_charged",
          r.id,
          `La recompensa fallida ${r.id} (${code}, motivo ${r.status_reason ?? "-"}) se ha cobrado en la renovación ${order.name}. Resultado: ${out}. Ya no se puede reencolar. Revisar por qué había fallado.`,
          r.referrer_customer_id,
        );
      } else if (r.consumed_order_id === order.orderId) {
        // El mismo cobro que ya la cerró (un reintento del webhook): nada nuevo.
      } else {
        await leakAlertAndDetach(
          r,
          code,
          `la renovación ${order.name} lleva ${code} con la recompensa en «${r.status}»${r.consumed_order_id ? ` (consumida en ${r.consumed_order_id})` : ""}`,
          order.email,
        );
      }
      continue;
    }
    const { data: friendCode } = await sb.from("referral_codes").select("customer_id").eq("code", code).maybeSingle();
    if (friendCode) {
      const removed = order.email ? await detachFromCustomerSubs(order.email, code) : "sin email";
      await moneyAlert(
        "referral_friend_code_on_renewal",
        order.orderId,
        `FUGA: la renovación ${order.name} lleva el código de amigo ${code} (puesto en una suscripción). Retirada automática: ${removed}.`,
        order.customerId ?? undefined,
      );
    }
  }
}

/** Quita un código de todas las subs de un email donde se vea. Devuelve un resumen para la alerta. */
async function detachFromCustomerSubs(email: string, code: string): Promise<string> {
  const subs = await seal.getSubscriptionsByEmail(email).catch(() => null);
  if (!subs) return "no se pudo leer Seal";
  const withCode = subs.filter((s) => findAllAppliedDiscountCodeIds(s, code).length);
  if (!withCode.length) return "no se ve en ninguna sub";
  const out: string[] = [];
  for (const s of withCode) {
    try {
      out.push(`${s.id}: ${await detachCode(s.id, code)}`);
    } catch (e) {
      out.push(`${s.id}: ERROR ${errMsg(e)}`);
    }
  }
  return out.join("; ");
}

/**
 * Subs donde se ve el código, para cuando la fila ya no tiene sub. `emailHint`:
 * el email del pedido de renovación que llevó el código, que es el de la sub que
 * lo tiene (más fiable que el email actual de quien invita, que puede haber
 * cambiado). `null` si algo no se pudo leer: nunca «ninguna» a ciegas.
 */
async function subsWithCodeVisible(referrerId: string, code: string, emailHint?: string | null): Promise<number[] | null> {
  const email = emailHint || (await readCustomerBasics(referrerId).catch(() => null))?.email || null;
  if (!email) return null;
  const subs = await seal.getSubscriptionsByEmail(email).catch(() => null);
  if (!subs) return null;
  return subs.filter((s) => findAllAppliedDiscountCodeIds(s, code).length).map((s) => s.id);
}

async function leakAlertAndDetach(r: RewardRow, code: string, what: string, emailHint?: string | null): Promise<void> {
  const subIds = r.seal_subscription_id
    ? [Number(r.seal_subscription_id)]
    : (await subsWithCodeVisible(r.referrer_customer_id, code, emailHint)) ?? [];
  const results: string[] = [];
  for (const subId of subIds) {
    try {
      results.push(`${subId}: ${await detachCode(subId, code)}`);
    } catch (e) {
      results.push(`${subId}: ERROR ${errMsg(e)}`);
    }
  }
  await moneyAlert(
    "referral_reward_leak",
    r.id,
    `FUGA: ${what}. Retirada automática: ${results.join("; ") || "no se encontró la sub"}. Revisar en Seal.`,
    r.referrer_customer_id,
  );
}

/**
 * Seguro para el cron y el webhook: cualifica una conversión pendiente y nunca
 * lanza. Si la cualificación LANZA (no un `retry` limpio: un fallo de Supabase,
 * un bug) durante más de `QUALIFY_RETRY_MS`, pasa a revisión con aviso, igual
 * que un `retry` que no se resuelve: si no, se quedaría pendiente para siempre
 * y quien invitó no sabría nunca nada de su premio.
 */
export async function qualifyPendingConversionSafe(conversionId: string): Promise<string> {
  try {
    return await qualifyPendingConversion(conversionId);
  } catch (err) {
    console.error(LOG, "cualificación falló", conversionId, errMsg(err));
    try {
      const sb = supabaseAdmin();
      const { data } = await sb
        .from("referral_conversions")
        .select("attempts, converted_at, converted_order_id")
        .eq("id", conversionId)
        .maybeSingle();
      const tooOld = !!data && Date.now() - Date.parse(data.converted_at as string) > QUALIFY_RETRY_MS;
      const { data: moved } = await sb
        .from("referral_conversions")
        .update({
          attempts: (data?.attempts ?? 0) + 1,
          last_error: errMsg(err).slice(0, 500),
          updated_at: nowIso(),
          ...(tooOld ? { status: "review", reason: "qualify_error" } : {}),
        })
        .eq("id", conversionId)
        .eq("status", "pending")
        .select("id");
      if (tooOld && moved?.length) {
        await alertSlackNoticeAwaited({
          title: "Referido para revisar a mano",
          icon: ":mag:",
          fields: {
            conversion: conversionId,
            pedido: (data?.converted_order_id as string | undefined) ?? "-",
            motivo: `qualify_error: ${errMsg(err).slice(0, 120)}`,
          },
        });
        return "review";
      }
    } catch (e) {
      console.error(LOG, "no se pudo apuntar el fallo de la cualificación", conversionId, errMsg(e));
    }
    return "error";
  }
}

/**
 * ¿Gana su premio quien invita? Lee los hechos, decide con `qualifyConversion` y
 * lo deja escrito. Si cualifica: crea la recompensa en cola y avisa a quien
 * invita (sin datos del amigo). Cualquier lectura que falle (Shopify, Seal o
 * Supabase) es un `retry`, nunca un rechazo.
 */
export async function qualifyPendingConversion(conversionId: string): Promise<string> {
  const sb = supabaseAdmin();
  const { data: convData, error: convErr } = await sb
    .from("referral_conversions")
    .select("id, referrer_customer_id, converted_order_id, converted_at, code, status, attempts")
    .eq("id", conversionId)
    .maybeSingle();
  if (convErr) throw new Error(`referral_conversions read: ${convErr.message}`);
  const conv = convData as ConversionRow | null;
  if (!conv || conv.status !== "pending") return "not_pending";

  const pendingForMs = Date.now() - Date.parse(conv.converted_at);
  const retryOrReview = async (reason: string, order: ReferralOrderFacts | null) => {
    if (pendingForMs > QUALIFY_RETRY_MS) return finalize(conv, "review", reason, order, null);
    await sb
      .from("referral_conversions")
      .update({ attempts: conv.attempts + 1, last_error: reason, updated_at: nowIso() })
      .eq("id", conv.id)
      .eq("status", "pending");
    return "retry";
  };

  const [order, codeRow, referrer] = await Promise.all([
    readOrderForReferral(conv.converted_order_id).catch(() => null),
    sb.from("referral_codes").select("customer_id, code, status").eq("code", normalizeCode(conv.code)).maybeSingle(),
    readCustomerBasics(conv.referrer_customer_id).catch(() => null),
  ]);
  if (!order) return retryOrReview("order_unreadable", null);
  if (!referrer?.email) return retryOrReview("referrer_unreadable", order);
  if (codeRow.error) return retryOrReview("code_unreadable", order);

  // Las subs de quien invita: sus direcciones y teléfonos (mismo domicilio).
  const referrerSubs = await seal.getSubscriptionsByEmail(referrer.email).catch(() => null);
  if (!referrerSubs) return retryOrReview("referrer_subs_unreadable", order);

  const friendId = order.customerId;
  const friendEmail = normalizeEmail(order.email);
  const friendPhones = [normalizePhone(order.phone), normalizePhone(order.shippingPhone)].filter(Boolean) as string[];
  const friendAddress = normalizeAddress(order.shippingAddress1, order.shippingZip);

  const referrerEmails = new Set(
    [referrer.email, ...referrerSubs.map((s) => s.email)].map(normalizeEmail).filter(Boolean) as string[],
  );
  const referrerPhones = new Set(
    [referrer.phone, ...referrerSubs.map((s) => s.s_phone)].map(normalizePhone).filter(Boolean) as string[],
  );
  const referrerAddresses = new Set(
    referrerSubs.map((s) => normalizeAddress(s.s_address1, s.s_zip)).filter(Boolean) as string[],
  );

  const sameEmail = !!friendEmail && referrerEmails.has(friendEmail);
  const samePhone = friendPhones.some((p) => referrerPhones.has(p));
  const sameAddress = !!friendAddress && referrerAddresses.has(friendAddress);

  // ¿Cliente nuevo? Shopify (pedidos ANTERIORES) y Seal (subs ANTERIORES, también
  // canceladas). Por fecha: un pedido posterior del amigo no le quita el premio a
  // quien le invitó. Un fallo de lectura da null y se reintenta, nunca rechaza.
  // Una sub sin fecha legible cuenta como ANTERIOR: ante la duda, no se paga.
  const orderAtMs = Date.parse(order.createdAt);
  const friendPriorBoxOrders = friendId ? await countPriorLitOrders(friendId, order.orderId, order.createdAt) : 0;
  let friendOtherSealSubs: number | null = null;
  if (order.email) {
    const subs = await seal.getSubscriptionsByEmail(order.email).catch(() => null);
    friendOtherSealSubs = subs
      ? subs.filter((s) => String(s.order_id ?? "") !== order.orderId && !(Date.parse(s.order_placed) >= orderAtMs))
          .length
      : null;
  }

  const [alreadyRes, recentRes] = await Promise.all([
    friendId
      ? sb
          .from("referral_conversions")
          .select("id", { count: "exact", head: true })
          .eq("friend_customer_id", friendId)
          .eq("status", "qualified")
          .neq("id", conv.id)
      : Promise.resolve({ count: 0, error: null }),
    sb
      .from("referral_conversions")
      .select("id", { count: "exact", head: true })
      .eq("referrer_customer_id", conv.referrer_customer_id)
      .eq("status", "qualified")
      .gte("qualified_at", new Date(Date.now() - VELOCITY_WINDOW_MS).toISOString()),
  ]);
  if (alreadyRes.error || recentRes.error) return retryOrReview("counts_unreadable", order);

  const result = qualifyConversion({
    isRenewal: order.isRenewal,
    orderVoided: order.voided,
    hasLitBox: order.hasLitBox,
    codeActive: codeRow.data?.status === "active" && codeRow.data?.customer_id === conv.referrer_customer_id,
    referrerIsB2B: hasB2BTag(referrer.tags),
    referrerCustomerId: conv.referrer_customer_id,
    friendCustomerId: friendId,
    sameEmail,
    samePhone,
    sameAddress,
    friendPriorBoxOrders,
    friendOtherSealSubs,
    friendAlreadyQualified: (alreadyRes.count ?? 0) > 0,
    referrerQualifiedInWindow: recentRes.count ?? 0,
    pendingForMs,
  });

  const signals = {
    same_email: sameEmail,
    same_phone: samePhone,
    same_address: sameAddress,
    friend_prior_lit_orders: friendPriorBoxOrders,
    friend_other_seal_subs: friendOtherSealSubs,
    fp: {
      email: fingerprint(friendEmail),
      phone: fingerprint(friendPhones[0] ?? null),
      address: fingerprint(friendAddress),
    },
  };

  if (result.outcome === "retry") return retryOrReview(result.reason, order);
  return finalize(conv, result.outcome, result.reason, order, signals);
}

/** Cierra una conversión. Si cualifica, crea su recompensa y avisa a quien invita. */
async function finalize(
  conv: ConversionRow,
  outcome: "qualified" | "rejected" | "review",
  reason: string,
  order: ReferralOrderFacts | null,
  signals: Record<string, unknown> | null,
): Promise<string> {
  const sb = supabaseAdmin();
  const base = {
    reason,
    signals,
    friend_customer_id: order?.customerId ?? undefined,
    friend_order_name: order?.name ?? undefined,
    purchase_type: order?.purchaseType ?? undefined,
    updated_at: nowIso(),
  };
  const { data: closed, error: upErr } = await sb
    .from("referral_conversions")
    .update({ ...base, status: outcome, qualified_at: outcome === "qualified" ? nowIso() : null })
    .eq("id", conv.id)
    .eq("status", "pending")
    .select("id");
  if (upErr) {
    // 23505 en uq_referral_conversions_friend_once: otra conversión del mismo
    // amigo cualificó a la vez. Esta no.
    if (upErr.code === "23505") {
      await sb
        .from("referral_conversions")
        .update({ ...base, status: "rejected", reason: "friend_already_referred" })
        .eq("id", conv.id)
        .eq("status", "pending");
      return "rejected";
    }
    throw new Error(`referral_conversions finalize: ${upErr.message}`);
  }
  // Nadie más la cerró a la vez (p. ej. un rechazo a mano): si no, ni recompensa ni email.
  if (!closed?.length) return "not_pending";

  if (outcome === "review") {
    await alertSlackNoticeAwaited({
      title: "Referido para revisar a mano",
      icon: ":mag:",
      fields: { conversion: conv.id, pedido: order?.name ?? conv.converted_order_id, motivo: reason },
    });
    return outcome;
  }
  if (outcome !== "qualified") return outcome;
  // Si esto falla, la conversión queda `qualified` sin recompensa:
  // `repairQualifiedWithoutReward` (cron) la crea en la siguiente pasada.
  await createRewardAndNotify(conv);
  return outcome;
}

/**
 * La recompensa en cola y el aviso a quien invita. La usan la cualificación
 * automática, la aprobación a mano y la reparación del cron.
 */
async function createRewardAndNotify(conv: Pick<ConversionRow, "id" | "referrer_customer_id" | "code">): Promise<void> {
  const sb = supabaseAdmin();
  // `conversion_id` único: un reintento no crea dos. Nace «para mirar ya»: la
  // cola se recorre por `next_check_at` y una fila sin fecha no entraría.
  const { error: rewErr } = await sb.from("referral_rewards").upsert(
    {
      conversion_id: conv.id,
      referrer_customer_id: conv.referrer_customer_id,
      amount_cents: REFERRAL_REWARD_CENTS,
      status: "queued",
      next_check_at: nowIso(),
    },
    { onConflict: "conversion_id", ignoreDuplicates: true },
  );
  if (rewErr) throw new Error(`referral_rewards insert: ${rewErr.message}`);

  // Aviso a quien invita. SIN datos del amigo. Se guarda antes de avisar (arriba)
  // y el uniqueId evita un segundo email si esto se repite.
  const email = await readCustomerBasics(conv.referrer_customer_id)
    .then((b) => b?.email ?? null)
    .catch(() => null);
  if (email) {
    const { count: joined } = await sb
      .from("referral_conversions")
      .select("id", { count: "exact", head: true })
      .eq("referrer_customer_id", conv.referrer_customer_id)
      .eq("status", "qualified");
    await klaviyo
      .trackEvent(
        "referral_friend_joined",
        email,
        {
          reward_amount: REFERRAL_REWARD_CENTS / 100,
          reward_amount_label: "10 €",
          friends_joined: joined ?? 1,
          referral_code: conv.code,
        },
        { uniqueId: `referral-joined-${conv.id}`, externalId: conv.referrer_customer_id },
      )
      .catch((e) => console.warn(LOG, "referral_friend_joined falló", conv.id, errMsg(e)));
  }
}

/**
 * Una conversión cualificada sin recompensa (falló su alta): se crea. Lo corre el
 * cron. El «sin recompensa» va EN LA CONSULTA (anti-join de PostgREST) y no
 * después del límite: si no, con más de `limit` cualificadas, las sanas llenarían
 * el lote y las rotas no se verían nunca.
 */
export async function repairQualifiedWithoutReward(limit = 50): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from("referral_conversions")
    .select("id, referrer_customer_id, code, reward:referral_rewards(id)")
    .eq("status", "qualified")
    .is("reward", null)
    .order("qualified_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`repair qualified: ${error.message}`);
  let repaired = 0;
  for (const c of (data ?? []) as Array<{ id: string; referrer_customer_id: string; code: string | null; reward: unknown }>) {
    // Doble comprobación por si el anti-join no se aplicara: nunca dos avisos.
    const hasReward = Array.isArray(c.reward) ? c.reward.length > 0 : !!c.reward;
    if (hasReward) continue;
    await createRewardAndNotify(c);
    repaired++;
  }
  return repaired;
}

/** Revocar una recompensa revoca su conversión: deja de contar y libera al amigo. */
async function markConversionRevoked(conversionId: string): Promise<void> {
  await supabaseAdmin()
    .from("referral_conversions")
    .update({ status: "revoked", revoked_at: nowIso(), updated_at: nowIso() })
    .eq("id", conversionId)
    .eq("status", "qualified");
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Recompensas
// ═══════════════════════════════════════════════════════════════════════════

/** Todos los códigos que lleva una sub, en mayúsculas. */
function codesOnSub(s: SealSubscription): string[] {
  return (s.items ?? []).flatMap((it) => (it.discount_codes ?? []).map((dc) => normalizeCode(dc.code)));
}

/** Lleva un código de un solo cobro que no es `ownCode` (LITSTAY15 u otro LITREF). */
function hasBlockingCode(s: SealSubscription, ownCode: string | null): boolean {
  const own = ownCode ? normalizeCode(ownCode) : null;
  return codesOnSub(s).some((c) => c !== own && (c === RETENTION_CODE || isRewardCode(c)));
}

function nextChargeMs(s: SealSubscription): number | null {
  const next = getNextBillingAttempt(s);
  const ms = next?.date ? Date.parse(next.date) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * La sub donde se aplicaría: la activa que cobra antes entre las que no llevan
 * otro código de un solo cobro ni otra recompensa viva.
 */
function pickCandidate(subs: SealSubscription[], liveSubIds: Set<string>): SubCandidate | null {
  const eligible = subs
    .filter((s) => mapStatus(s) === "active")
    .map((s) => ({ s, at: nextChargeMs(s) }))
    .filter((x): x is { s: SealSubscription; at: number } => x.at !== null)
    .filter((x) => !liveSubIds.has(String(x.s.id)) && !hasBlockingCode(x.s, null))
    .sort((a, b) => a.at - b.at);
  const best = eligible[0];
  if (!best) return null;
  return {
    sealSubscriptionId: String(best.s.id),
    nextChargeAtMs: best.at,
    hasBlockingCode: false,
    hasLiveReward: false,
  };
}

/** Pedidos ya leídos en esta pasada, para no releer el mismo dos veces. */
type OrderCache = Map<string, ReferralOrderFacts | null>;

/** `undefined` = fallo transitorio; `null` = el pedido no existe. */
async function readOrderCached(orderId: string, cache: OrderCache): Promise<ReferralOrderFacts | null | undefined> {
  if (cache.has(orderId)) return cache.get(orderId);
  try {
    const o = await readOrderForReferral(orderId);
    cache.set(orderId, o);
    return o;
  } catch {
    return undefined;
  }
}

/**
 * El estado en Seal de una recompensa aplicada (o aplicándose), con la prueba de
 * consumo: un cobro POSTERIOR a la orden de aplicar cuyo pedido lleva el código.
 * Se cuenta desde `apply_sent_at` (el primer momento en que el código pudo
 * afectar a un cobro), no desde que se apuntó como aplicada. `null` si algo no se
 * pudo leer (se reintenta en la siguiente pasada).
 */
async function appliedState(
  r: RewardRow,
  sub: SealSubscription | null,
  cache: OrderCache,
): Promise<AppliedSubState | null> {
  if (!sub) {
    return {
      exists: false,
      chargeable: false,
      nextChargeAtMs: null,
      codeVisible: false,
      consumedOrderId: null,
      chargedWithoutCode: false,
      chargeEvidenceUnknown: false,
    };
  }
  const code = normalizeCode(r.reward_code);
  const sinceIso = r.apply_sent_at ?? r.applied_at ?? r.updated_at;
  const sinceMs = Date.parse(sinceIso);
  const charges = (sub.billing_attempts ?? [])
    .filter((ba) => ba.completed_at && Date.parse(ba.completed_at) >= sinceMs)
    .sort((a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at));
  let consumedOrderId: string | null = null;
  let chargedWithoutCode = false;
  let evidenceUnknown = false;
  for (const ba of charges) {
    if (!ba.order_id) {
      evidenceUnknown = true;
      continue;
    }
    const order = await readOrderCached(String(ba.order_id), cache);
    if (order === undefined) return null;
    if (order === null) {
      evidenceUnknown = true;
      continue;
    }
    if (code && order.discountCodes.includes(code)) {
      consumedOrderId = order.orderId;
      break;
    }
    chargedWithoutCode = true;
  }
  return {
    exists: true,
    chargeable: mapStatus(sub) === "active",
    nextChargeAtMs: nextChargeMs(sub),
    codeVisible: code ? findAllAppliedDiscountCodeIds(sub, code).length > 0 : false,
    consumedOrderId,
    chargedWithoutCode: consumedOrderId ? false : chargedWithoutCode,
    chargeEvidenceUnknown: consumedOrderId ? false : evidenceUnknown,
  };
}

/**
 * Retira TODOS los UUID de un código de una sub y comprueba que no queda
 * ninguno. Lanza si queda alguno. Un UUID por línea en subs multi-línea: quitar
 * solo el primero dejaría el descuento en las demás (la fuga de LITSTAY15).
 */
async function detachCode(subId: number, code: string): Promise<"removed" | "not_visible"> {
  const fresh = await seal.getSubscriptionById(subId, undefined, { throwTransient: true });
  if (!fresh) throw new Error(`Seal no devuelve la sub ${subId}`);
  const ids = findAllAppliedDiscountCodeIds(fresh, code);
  if (!ids.length) return "not_visible";
  for (const id of ids) {
    try {
      await seal.removeDiscountCode(subId, id);
    } catch (e) {
      console.warn(LOG, "removeDiscountCode falló, se relee", subId, id, errMsg(e));
    }
  }
  const after = await seal.getSubscriptionById(subId, undefined, { throwTransient: true });
  const left = after ? findAllAppliedDiscountCodeIds(after, code) : ids;
  if (left.length) throw new Error(`quedan ${left.length} UUID de ${code} en la sub ${subId}`);
  return "removed";
}

async function deleteRewardDiscountBestEffort(r: RewardRow): Promise<void> {
  if (!r.shopify_discount_id) return;
  try {
    await deleteCodeDiscount(r.shopify_discount_id);
    await supabaseAdmin()
      .from("referral_rewards")
      .update({ shopify_discount_id: null, shopify_discount_deleted_at: nowIso(), updated_at: nowIso() })
      .eq("id", r.id);
  } catch (e) {
    console.warn(LOG, "no se pudo borrar el descuento de la recompensa", r.id, errMsg(e));
  }
}

async function setStatus(r: RewardRow, from: RewardStatus, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("referral_rewards")
    .update({ ...patch, updated_at: nowIso() })
    .eq("id", r.id)
    .eq("status", from)
    .select("id");
  if (error) throw new Error(`referral_rewards ${from}→${String(patch.status ?? "?")}: ${error.message}`);
  return !!data?.length;
}

/**
 * Vuelta a la cola: sin sub, sin UUID, sin rastro de una orden de aplicar, y
 * «para mirar ya» (la cola se recorre por `next_check_at`; nunca sin fecha).
 */
function requeuePatch(): Record<string, unknown> {
  return {
    status: "queued",
    seal_subscription_id: null,
    seal_discount_ids: [],
    charge_due_at: null,
    apply_sent_at: null,
    applied_at: null,
    next_check_at: nowIso(),
  };
}

/**
 * → consumed: retira el código de donde se vea y lo cierra. Si no lo puede
 * retirar, NO cierra (el próximo cobro llevaría otros 10 €): se queda como está y
 * se avisa. `from` es el estado desde el que se cierra (CAS). `emailHint`: el
 * email del pedido de renovación, para encontrar la sub si la fila ya no la tiene.
 */
async function consumeReward(
  r: RewardRow,
  orderId: string,
  from: RewardStatus = r.status,
  emailHint?: string | null,
): Promise<string> {
  const code = normalizeCode(r.reward_code);
  let removedSomewhere = false;
  let subIds: number[] = [];
  if (r.seal_subscription_id) {
    subIds = [Number(r.seal_subscription_id)];
  } else if (code) {
    const found = await subsWithCodeVisible(r.referrer_customer_id, code, emailHint);
    if (found === null) {
      // Cobrada (el pedido está delante) pero no se puede mirar en qué sub sigue el
      // código. Ni se cierra como consumida (el código podría seguir puesto y
      // descontar otra vez) ni se deja como estaba (desde la cola, el cron la
      // volvería a aplicar: otros 10 €). → failed con el pedido apuntado: la pasada
      // de las fallidas busca el código y lo quita, y nadie puede reencolarla.
      await setStatus(r, from, {
        status: "failed",
        status_reason: "consumed_detach_unconfirmed",
        consumed_order_id: orderId,
        next_check_at: null,
      });
      await moneyAlert(
        "referral_reward_consume_unreadable",
        r.id,
        `Recompensa ${r.id} cobrada en el pedido ${orderId}, pero no se pudo leer Seal para quitar ${code}. Pasa a failed (no se reaplica); la pasada de las fallidas lo quitará si se ve. Comprobar en Seal.`,
        r.referrer_customer_id,
      );
      return "consume_unreadable";
    }
    subIds = found;
  }
  for (const subId of subIds) {
    try {
      if ((await detachCode(subId, code)) === "removed") removedSomewhere = true;
    } catch (e) {
      await moneyAlert(
        "referral_reward_consume_detach_failed",
        r.id,
        `Recompensa ${r.id} consumida en el pedido ${orderId} pero ${code} no se pudo quitar de la sub ${subId} (${errMsg(e)}). Si no se quita, el próximo cobro lleva otros 10 €.`,
        r.referrer_customer_id,
      );
      return "consume_detach_failed";
    }
  }
  const { data: closed, error } = await supabaseAdmin()
    .from("referral_rewards")
    .update({
      status: "consumed",
      consumed_at: nowIso(),
      consumed_order_id: orderId,
      seal_discount_ids: [],
      next_check_at: null,
      updated_at: nowIso(),
    })
    .eq("id", r.id)
    .eq("status", from)
    .select("id");
  if (error) {
    if (error.code === "23505") {
      // `consumed_order_id` es único: ese pedido ya cerró OTRA recompensa. Dos
      // LITREF en un mismo cobro son 20 € donde tocaban 10: una persona.
      await moneyAlert(
        "referral_reward_consume_conflict",
        r.id,
        `El pedido ${orderId} ya cerró otra recompensa y también lleva ${code} (recompensa ${r.id}, que se queda en «${from}»). Dos recompensas en un mismo cobro: revisar en Shopify y en Seal.`,
        r.referrer_customer_id,
      );
      return "consume_conflict";
    }
    throw new Error(`referral_rewards consume: ${error.message}`);
  }
  if (!closed?.length) return "already_closed";
  if (!removedSomewhere && from === "applied") {
    // Consumida con su pedido delante, pero el código ya no se veía en Seal: o lo
    // quitó alguien a mano, o se ha quedado invisible tras un cambio de líneas.
    await moneyAlert(
      "referral_reward_consumed_not_visible",
      r.id,
      `Recompensa ${r.id} consumida en el pedido ${orderId}; ${code} ya no se veía en la sub ${r.seal_subscription_id}. Comprobar en Seal que no sigue descontando.`,
      r.referrer_customer_id,
    );
  }
  await deleteRewardDiscountBestEffort(r);
  return "consumed";
}

export interface SweepOptions {
  dryRun?: boolean;
  /** Solo las recompensas de esta sub (o en cola de quien la tiene). Para el E2E. */
  onlySubId?: string;
  maxApplies?: number;
  /** Corte de la FASE: a partir de aquí no se empieza ninguna recompensa más. */
  deadlineMs?: number;
  /**
   * Final REAL de la función (Vercel la mata a los 60 s). El presupuesto de una
   * aplicación se mide contra esto y no contra el corte de la fase: medido contra
   * un corte de 30 s con un umbral de 35 s, no se aplicaba nunca nada.
   */
  hardDeadlineMs?: number;
}

export type SweepTally = Record<string, number>;

/**
 * La pasada del cron sobre las recompensas (cada 4 h). En este orden:
 *
 *   1. Las vivas (applying, applied): consumir, retirar, adoptar. Siempre, con
 *      el flag como esté: un código puesto en Seal hay que poder quitarlo.
 *   2. Las fallidas que aún pueden tener su código en Seal. También siempre, y
 *      antes que la cola: quitar un código que sobra pesa más que poner uno.
 *   3. La cola: solo las que tocan (`next_check_at`) y solo las del alcance de
 *      `REFERRAL_REWARDS`, filtradas EN LA CONSULTA. Con `off` ni se lee (no hay
 *      nada que aplicar; revocar o caducar una en cola es solo un estado, y lo
 *      hará la primera pasada con el flag abierto). Es el ÚNICO sitio que aplica.
 *
 * Una espera nunca deja la fila sin fecha: `nextCheckAt` siempre da una, y la
 * cola se recorre de la más vencida a la menos.
 */
export async function runRewardSweep(
  opts: SweepOptions = {},
): Promise<{ tally: SweepTally; decisions: Array<{ id: string; action: RewardAction }> }> {
  const sb = supabaseAdmin();
  const tally: SweepTally = {};
  const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);
  const decisions: Array<{ id: string; action: RewardAction }> = [];
  const phaseLeft = () => (opts.deadlineMs === undefined ? Infinity : opts.deadlineMs - Date.now());
  const functionLeft = () => (opts.hardDeadlineMs === undefined ? Infinity : opts.hardDeadlineMs - Date.now());

  // Con `only_sub` (E2E), la cola se filtra por el dueño de esa sub EN LA CONSULTA:
  // filtrarla después obligaría a leer en Seal las subs de cada persona en cola.
  let onlyOwner: string | null = null;
  if (opts.onlySubId) {
    const s = await seal.getSubscriptionById(Number(opts.onlySubId), undefined, { throwTransient: true });
    if (!s?.customer_id) throw new Error(`no se pudo leer el dueño de la sub ${opts.onlySubId}`);
    onlyOwner = String(s.customer_id);
  }

  const scope = referralRewardsScope();
  const queueOpen = scope.mode === "on" || (scope.mode === "allowlist" && scope.ids.length > 0);
  let queuedQuery = queueOpen
    ? sb
        .from("referral_rewards")
        .select(REWARD_WITH_CONV)
        .eq("status", "queued")
        .or(`next_check_at.is.null,next_check_at.lte."${nowIso()}"`)
    : null;
  if (queuedQuery && scope.mode === "allowlist") queuedQuery = queuedQuery.in("referrer_customer_id", scope.ids);
  if (queuedQuery && onlyOwner) queuedQuery = queuedQuery.eq("referrer_customer_id", onlyOwner);

  const [liveRes, queuedRes] = await Promise.all([
    sb.from("referral_rewards").select(REWARD_WITH_CONV).in("status", ["applying", "applied"]).order("updated_at").limit(300),
    queuedQuery
      ? queuedQuery.order("next_check_at", { ascending: true }).limit(300)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  if (liveRes.error) throw new Error(`referral_rewards vivas: ${liveRes.error.message}`);
  if (queuedRes.error) throw new Error(`referral_rewards en cola: ${queuedRes.error.message}`);
  const live = (liveRes.data ?? []) as unknown as RewardRow[];
  const queued = (queuedRes.data ?? []) as unknown as RewardRow[];

  // Las subs de cada quien invita: una lectura por persona, bajo demanda (así el
  // presupuesto de tiempo de la pasada también cuenta estas lecturas).
  const subsByReferrer = new Map<string, SealSubscription[] | null>();
  const subsOf = async (referrerId: string): Promise<SealSubscription[] | null> => {
    if (subsByReferrer.has(referrerId)) return subsByReferrer.get(referrerId) ?? null;
    const basics = await readCustomerBasics(referrerId).catch(() => null);
    const subs = basics?.email ? await seal.getSubscriptionsByEmail(basics.email).catch(() => null) : null;
    subsByReferrer.set(referrerId, subs);
    return subs;
  };

  // Las vivas cuentan SIEMPRE, también con `onlySubId`: el filtro del E2E no puede
  // hacer que se aplique encima de otra.
  const liveSubIds = new Set(live.map((r) => String(r.seal_subscription_id)));
  const orderCache: OrderCache = new Map();
  let applies = 0;

  const processOne = async (r: RewardRow): Promise<void> => {
    if (opts.onlySubId && r.status !== "queued" && r.seal_subscription_id !== opts.onlySubId) return;
    const subs = await subsOf(r.referrer_customer_id);

    const friendOrderId = r.conv?.converted_order_id;
    const friendOrder = friendOrderId ? await readOrderCached(friendOrderId, orderCache) : undefined;
    const friendOrderVoided = friendOrder === undefined ? null : friendOrder ? friendOrder.voided : null;
    const friendOrderAtMs = friendOrder
      ? Date.parse(friendOrder.createdAt)
      : r.conv?.converted_at
        ? Date.parse(r.conv.converted_at)
        : null;

    let candidate: SubCandidate | null = null;
    let applied: AppliedSubState | null = null;
    if (r.status === "queued") {
      let pool = subs ?? [];
      if (opts.onlySubId) pool = pool.filter((s) => String(s.id) === opts.onlySubId);
      candidate = subs ? pickCandidate(pool, liveSubIds) : null;
    } else if (r.seal_subscription_id) {
      const sub =
        (subs ?? []).find((s) => String(s.id) === r.seal_subscription_id) ??
        (await seal
          .getSubscriptionById(Number(r.seal_subscription_id), undefined, { throwTransient: true })
          .catch(() => undefined));
      applied = sub === undefined ? null : await appliedState(r, sub, orderCache);
    }

    const now = Date.now();
    const action = decideRewardAction(
      {
        status: r.status,
        expiresAtMs: Date.parse(r.expires_at),
        updatedAtMs: Date.parse(r.updated_at),
        applySentAtMs: r.apply_sent_at ? Date.parse(r.apply_sent_at) : null,
      },
      {
        now,
        rewardsEnabled: referralRewardsEnabledFor(r.referrer_customer_id),
        friendOrderVoided,
        // `null` es «Shopify dice que no existe»; `undefined`, un fallo de lectura.
        friendOrderMissing: !!friendOrderId && friendOrder === null,
        friendOrderAtMs,
        candidate,
        candidateUnknown: r.status === "queued" && subs === null,
        applied,
      },
    );
    decisions.push({ id: r.id, action });

    if (action.kind === "apply") {
      if (applies >= (opts.maxApplies ?? 15)) {
        bump("apply_deferred_cap");
        return;
      }
      if (!canStartApply(functionLeft())) {
        bump("apply_deferred_time");
        return;
      }
    }
    if (opts.dryRun) {
      bump(`dry:${action.kind}`);
      return;
    }
    if (opts.onlySubId && r.status === "queued" && (action.kind === "wait" || action.kind === "expire")) {
      // Con `only_sub` el abanico de subs está recortado a una: ni la fecha de la
      // próxima mirada (otra sub suya puede cobrar antes) ni la caducidad (puede
      // tener otra activa) se deciden sobre lo que no se ha mirado entero.
      bump(`only_sub:${action.kind === "wait" ? `wait:${action.reason}` : "expire_skipped"}`);
      return;
    }
    if (action.kind === "wait" && r.status === "queued") {
      // Cuándo volver (siempre con fecha) y, con una sub cobrable, alargar el plazo:
      // quien tiene sub activa no pierde su recompensa por esperar su turno.
      const nextAt = nextCheckAt(action.reason, candidate?.nextChargeAtMs ?? null, friendOrderAtMs, now);
      await sb
        .from("referral_rewards")
        .update({
          next_check_at: new Date(nextAt).toISOString(),
          ...(candidate ? { expires_at: new Date(now + REWARD_EXPIRY_MS).toISOString() } : {}),
        })
        .eq("id", r.id)
        .eq("status", "queued");
      bump(`wait:${action.reason}`);
      return;
    }
    let outcome: string;
    if (action.kind === "apply") {
      // El cerrojo se toma con la clave del DUEÑO de la sub, la misma que usa
      // /api/subscription/plan con el cliente que ha iniciado sesión.
      const sub = (subs ?? []).find((s) => String(s.id) === action.sealSubscriptionId);
      const owner = sub?.customer_id ? String(sub.customer_id) : r.referrer_customer_id;
      outcome = await applyReward(r, Number(action.sealSubscriptionId), action.chargeDueAtMs, owner);
      if (outcome === "applied") applies++;
      if (outcome === "applied" || outcome === "adopted") liveSubIds.add(action.sealSubscriptionId);
    } else {
      outcome = await executeRewardAction(r, action);
    }
    bump(outcome);
  };

  const runList = async (list: RewardRow[]) => {
    for (const r of list) {
      if (phaseLeft() <= 0) {
        bump("deadline_left");
        continue;
      }
      try {
        await processOne(r);
      } catch (e) {
        bump("error");
        console.error(LOG, "recompensa falló en la pasada", r.id, errMsg(e));
      }
    }
  };

  await runList(live);
  if (!opts.dryRun && !opts.onlySubId && phaseLeft() > 0) {
    for (const [k, v] of Object.entries(await sweepFailedRewards(opts.deadlineMs))) tally[k] = (tally[k] ?? 0) + v;
  }
  await runList(queued);
  return { tally, decisions };
}

/**
 * Recompensas `failed` que aún pueden tener su código puesto en Seal (aplicación
 * ambigua, descuento de más que no se pudo quitar, código invisible…): si se ve,
 * se quita y se avisa. Cuando ya no se ve en ninguna sub, se borra el descuento
 * de Shopify y deja de mirarse. Una persona decide después si se reencola
 * (`scripts/referral-admin.ts requeue`).
 */
async function sweepFailedRewards(deadlineMs?: number): Promise<SweepTally> {
  const tally: SweepTally = {};
  const { data, error } = await supabaseAdmin()
    .from("referral_rewards")
    .select(REWARD_COLUMNS)
    .eq("status", "failed")
    .not("reward_code", "is", null)
    .not("shopify_discount_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(30);
  if (error) {
    tally["failed_sweep_error"] = 1;
    return tally;
  }
  for (const r of (data ?? []) as RewardRow[]) {
    if (deadlineMs !== undefined && Date.now() > deadlineMs) break;
    const code = normalizeCode(r.reward_code);
    const subIds = r.seal_subscription_id
      ? [Number(r.seal_subscription_id)]
      : await subsWithCodeVisible(r.referrer_customer_id, code);
    if (subIds === null) {
      tally["failed_unreadable"] = (tally["failed_unreadable"] ?? 0) + 1;
      continue;
    }
    let stillOn = false;
    for (const subId of subIds) {
      try {
        if ((await detachCode(subId, code)) === "removed") {
          await moneyAlert(
            "referral_failed_reward_code_removed",
            r.id,
            `La recompensa fallida ${r.id} seguía con ${code} puesto en la sub ${subId}: retirado. Si le correspondía, reencolarla a mano (referral-admin requeue).`,
            r.referrer_customer_id,
          );
        }
      } catch (e) {
        stillOn = true;
        await moneyAlert(
          "referral_failed_reward_code_stuck",
          r.id,
          `La recompensa fallida ${r.id} tiene ${code} en la sub ${subId} y NO se pudo quitar (${errMsg(e)}). Quitarlo a mano en Seal.`,
          r.referrer_customer_id,
        );
      }
    }
    if (!stillOn) {
      await deleteRewardDiscountBestEffort(r);
      tally["failed_cleaned"] = (tally["failed_cleaned"] ?? 0) + 1;
    }
  }
  return tally;
}

async function executeRewardAction(r: RewardRow, action: RewardAction): Promise<string> {
  switch (action.kind) {
    case "noop":
      return "noop";
    case "wait":
      return `wait:${action.reason}`;
    case "apply":
      // Aplicar necesita al dueño de la sub (la clave del cerrojo): lo hace runRewardSweep.
      throw new Error("apply se ejecuta desde runRewardSweep, con el dueño de la sub");
    case "consume":
      return consumeReward(r, action.orderId, r.status);
    case "revoke":
      if (await setStatus(r, "queued", { status: "revoked", revoked_at: nowIso(), status_reason: "friend_order_voided" })) {
        await markConversionRevoked(r.conversion_id);
        await deleteRewardDiscountBestEffort(r);
      }
      return "revoked";
    case "expire":
      if (await setStatus(r, "queued", { status: "expired", status_reason: "no_chargeable_sub_in_time" })) {
        await deleteRewardDiscountBestEffort(r);
      }
      return "expired";
    case "requeue":
      await setStatus(r, "applying", { ...requeuePatch(), status_reason: action.reason });
      return "requeued";
    case "adopt": {
      // `applied_at` = cuándo SALIÓ la orden, nunca «ahora»: un cobro entre medias
      // tiene que seguir contando como consumo.
      const sub = await seal.getSubscriptionById(Number(r.seal_subscription_id), undefined, { throwTransient: true });
      const ids = sub ? findAllAppliedDiscountCodeIds(sub, normalizeCode(r.reward_code)) : [];
      await setStatus(r, "applying", {
        status: "applied",
        seal_discount_ids: ids,
        applied_at: r.apply_sent_at ?? r.updated_at,
      });
      return "adopted";
    }
    case "detach_revoke":
    case "detach_requeue": {
      const subId = Number(r.seal_subscription_id);
      let res: "removed" | "not_visible";
      try {
        res = await detachCode(subId, normalizeCode(r.reward_code));
      } catch (e) {
        await moneyAlert(
          `referral_reward_${action.kind}_failed`,
          r.id,
          `No se pudo quitar ${r.reward_code} de la sub ${subId} (${errMsg(e)}). La recompensa ${r.id} sigue aplicada.`,
          r.referrer_customer_id,
        );
        return `${action.kind}_failed`;
      }
      if (res === "not_visible") {
        // No se puede confirmar la retirada de lo que no se ve: reencolar pondría
        // una copia visible encima de una posible invisible. Una persona.
        await setStatus(r, "applied", { status: "failed", status_reason: `not_visible_on_${action.kind}` });
        await moneyAlert(
          "referral_reward_not_visible",
          r.id,
          `Recompensa ${r.id} (${r.reward_code}) aplicada pero invisible en la sub ${subId} al intentar retirarla. Comprobar en Seal.`,
          r.referrer_customer_id,
        );
        return "failed";
      }
      if (action.kind === "detach_revoke") {
        if (
          await setStatus(r, "applied", {
            status: "revoked",
            revoked_at: nowIso(),
            seal_discount_ids: [],
            status_reason: "friend_order_voided",
          })
        ) {
          await markConversionRevoked(r.conversion_id);
          await deleteRewardDiscountBestEffort(r);
        }
        return "revoked";
      }
      await setStatus(r, "applied", { ...requeuePatch(), status_reason: action.reason });
      if (action.reason === "charged_without_code") {
        await moneyAlert(
          "referral_reward_charged_without_code",
          r.id,
          `La sub ${subId} cobró con la recompensa ${r.id} (${r.reward_code}) aplicada, pero el pedido no lleva el descuento. Retirada y de vuelta a la cola para el siguiente cobro. Revisar por qué Seal no lo aplicó.`,
          r.referrer_customer_id,
        );
      }
      return "requeued";
    }
    case "fail": {
      if (!(await setStatus(r, r.status, { status: "failed", status_reason: action.reason }))) return "skip:changed";
      const what =
        action.reason === "friend_order_missing"
          ? `Shopify no encuentra el pedido del amigo (${r.conv?.converted_order_id ?? "-"}). Si se borró tras cancelarlo, no le corresponde; si existe, reencolarla (referral-admin requeue).`
          : "La pasada del cron quitará el código si se ve; después, decidir si se reencola.";
      await moneyAlert(
        `referral_reward_failed_${action.reason}`,
        r.id,
        `Recompensa ${r.id} (${r.reward_code ?? "sin código"}, sub ${r.seal_subscription_id ?? "-"}) pasa a FAILED: ${action.reason}. ${what}`,
        r.referrer_customer_id,
      );
      return "failed";
    }
    case "keep_alert":
      await moneyAlert(
        `referral_reward_check_${action.reason}`,
        r.id,
        `Recompensa ${r.id} (${r.reward_code}, sub ${r.seal_subscription_id}) necesita una revisión: ${action.reason}.`,
        r.referrer_customer_id,
      );
      return `alert:${action.reason}`;
  }
}

/**
 * queued → applying → applied. El único camino que pone un código en Seal.
 *
 * Orden y por qué:
 *   1. El cerrojo del cambio de plan de ESA sub, con la clave de su dueño (la
 *      misma que usa /api/subscription/plan) y ANTES de reclamar: así una fila en
 *      `applying` siempre tiene el cerrojo detrás, y un swap del cliente no puede
 *      cruzarse con la aplicación. Vive 120 s, más que la función: no caduca
 *      mientras aplica. Si no se puede tomar, no se aplica (sigue en cola).
 *   2. Reclamo condicional (solo una pasada puede aplicarla; el índice único por
 *      sub impide dos vivas en la misma) y ninguna reparación de líneas abierta:
 *      una sub a medias de reparar no es sitio para un descuento.
 *   3. Lectura fresca: sigue activa, sin otro código de un solo cobro, y el
 *      nuestro NO está ya (si está, se adopta, no se aplica encima).
 *   4. El descuento de Shopify existe ANTES de aplicar, y queda apuntado.
 *   5. `apply_sent_at` y apply. Si Seal lo rechaza limpio, vuelve a la cola. Si no
 *      contesta, NO se reintenta: se relee, y si no se ve, `failed`.
 *   6. Releer y comprobar que el total bajó EXACTAMENTE 10 €. Si bajó más (el
 *      importe repartido por línea, por ejemplo), se quita todo y `failed`.
 *
 * Los avisos que no son de dinero (Klaviyo a quien invita, el «no cuadra» de
 * Slack) van DESPUÉS de soltar el cerrojo: mientras está tomado, el cliente no
 * puede cambiar su plan.
 */
async function applyReward(r: RewardRow, subId: number, chargeDueAtMs: number, ownerCustomerId: string): Promise<string> {
  let lock: PlanLock;
  try {
    lock = await acquirePlanLock(ownerCustomerId, subId, "referral-sweep", {
      ttlSeconds: APPLY_LOCK_TTL_SECONDS,
      strict: true,
    });
  } catch (e) {
    // El cliente está cambiando su plan ahora mismo (409) o el cerrojo no se pudo
    // tomar. Sin cerrojo no se aplica: la fila sigue en cola y vencida, y la pasada
    // siguiente lo reintenta (hay una docena de pasadas dentro de la ventana).
    return e instanceof ApiHttpError ? "skip:plan_change_in_progress" : "skip:lock_unavailable";
  }
  let result: { outcome: string; notice?: Record<string, string | number> };
  try {
    result = await applyRewardLocked(r, subId, chargeDueAtMs);
  } finally {
    await lock.release();
  }
  if (result.notice) {
    await alertSlackNoticeAwaited({
      title: "Recompensa de referido aplicada, pero el total no cuadra",
      icon: ":warning:",
      fields: result.notice,
    });
  }
  if (result.outcome === "applied") await notifyRewardApplied(r, chargeDueAtMs);
  return result.outcome;
}

async function applyRewardLocked(
  r: RewardRow,
  subId: number,
  chargeDueAtMs: number,
): Promise<{ outcome: string; notice?: Record<string, string | number> }> {
  const sb = supabaseAdmin();
  const { data: claimed, error: claimErr } = await sb
    .from("referral_rewards")
    .update({
      status: "applying",
      seal_subscription_id: String(subId),
      charge_due_at: new Date(chargeDueAtMs).toISOString(),
      apply_sent_at: null,
      attempts: r.attempts + 1,
      updated_at: nowIso(),
    })
    .eq("id", r.id)
    .eq("status", "queued")
    .select("id");
  if (claimErr) {
    if (claimErr.code === "23505") return { outcome: "skip:sub_has_live_reward" };
    throw new Error(`referral_rewards claim: ${claimErr.message}`);
  }
  if (!claimed?.length) return { outcome: "skip:not_queued" };

  // Solo válido mientras la orden de aplicar NO haya salido.
  const backToQueue = async (reason: string) => {
    await sb
      .from("referral_rewards")
      .update({ ...requeuePatch(), last_error: reason.slice(0, 300), updated_at: nowIso() })
      .eq("id", r.id)
      .eq("status", "applying");
    return { outcome: `requeued:${reason.split(":")[0]}` };
  };
  const fail = async (reason: string, detail: string) => {
    await sb
      .from("referral_rewards")
      .update({ status: "failed", status_reason: reason, last_error: detail.slice(0, 500), updated_at: nowIso() })
      .eq("id", r.id)
      .in("status", ["applying", "applied"]);
    await moneyAlert(`referral_reward_apply_${reason}`, r.id, `Recompensa ${r.id} en la sub ${subId}: ${detail}`, r.referrer_customer_id);
    return { outcome: `failed:${reason}` };
  };

  // 2. Reparaciones de líneas abiertas.
  const { data: repair, error: repairErr } = await sb
    .from("subscription_line_repairs")
    .select("status")
    .eq("seal_subscription_id", String(subId))
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (repairErr) return backToQueue("repairs_unreadable");
  if (repair) return backToQueue("sub_under_repair");

  // 3. Lectura fresca.
  const before = await seal.getSubscriptionById(subId, undefined, { throwTransient: true }).catch(() => null);
  if (!before) return backToQueue("seal_unreadable");
  if (mapStatus(before) !== "active") return backToQueue("sub_not_active");
  if (hasBlockingCode(before, r.reward_code)) return backToQueue("sub_has_other_code");
  if (r.reward_code && findAllAppliedDiscountCodeIds(before, r.reward_code).length) {
    // Ya está puesto (una pasada anterior que murió tras aplicar): se adopta.
    await sb
      .from("referral_rewards")
      .update({
        status: "applied",
        seal_discount_ids: findAllAppliedDiscountCodeIds(before, r.reward_code),
        applied_at: r.apply_sent_at ?? nowIso(),
        updated_at: nowIso(),
      })
      .eq("id", r.id)
      .eq("status", "applying");
    return { outcome: "adopted" };
  }

  // 4. El descuento de Shopify, una vez por recompensa (se reutiliza al reaplicar).
  let code = r.reward_code ? normalizeCode(r.reward_code) : null;
  let discountId = r.shopify_discount_id;
  if (!code || !discountId) {
    code = code ?? generateRewardCode();
    // Se apunta el código ANTES de crearlo: si la creación entra pero no contesta,
    // la siguiente pasada lo encuentra por el código en vez de crear otro.
    const { error: codeErr } = await sb
      .from("referral_rewards")
      .update({ reward_code: code, updated_at: nowIso() })
      .eq("id", r.id)
      .eq("status", "applying");
    if (codeErr) return backToQueue(`code_mark_failed: ${codeErr.message}`);
    try {
      discountId = (await findCodeDiscountNodeId(code)) ?? (await createRewardDiscount(code, r.referrer_customer_id));
    } catch (e) {
      const recovered = await findCodeDiscountNodeId(code).catch(() => null);
      if (!recovered) return backToQueue(`shopify_create_failed: ${errMsg(e)}`);
      discountId = recovered;
    }
    const { error: idErr } = await sb
      .from("referral_rewards")
      .update({ shopify_discount_id: discountId, updated_at: nowIso() })
      .eq("id", r.id)
      .eq("status", "applying");
    if (idErr) return backToQueue(`discount_mark_failed: ${idErr.message}`);
  }

  // 5. La marca de que la orden sale, y aplicar. Sin la marca no se aplica.
  const { data: marked, error: markErr } = await sb
    .from("referral_rewards")
    .update({ apply_sent_at: nowIso(), updated_at: nowIso() })
    .eq("id", r.id)
    .eq("status", "applying")
    .select("id");
  if (markErr || !marked?.length) return backToQueue(`apply_mark_failed: ${markErr?.message ?? "fila cambiada"}`);

  const beforeCents = eurosToCents(before.total_value);
  try {
    await seal.applyDiscountCode(subId, code);
  } catch (e) {
    const check = await seal.getSubscriptionById(subId, undefined, { throwTransient: true }).catch(() => null);
    const visible = check ? findAllAppliedDiscountCodeIds(check, code).length > 0 : false;
    if (!visible) {
      const cleanReject =
        e instanceof SealApiError &&
        (e.status === 200 || (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429));
      if (cleanReject && check) {
        // Seal dijo que no (success:false o un 4xx) y el código no está: no se
        // aplicó nada. Vuelve a la cola; si se repite, se ve en el resumen.
        return backToQueue(`seal_rejected: ${errMsg(e)}`);
      }
      return fail("apply_ambiguous", `apply de ${code} sin respuesta clara y el código no se ve (${errMsg(e)}). No se reintenta solo.`);
    }
    // Entró pese al error: se sigue como aplicada.
  }

  // 6. Releer y comprobar.
  let after = await seal.getSubscriptionById(subId, undefined, { throwTransient: true }).catch(() => null);
  let ids = after ? findAllAppliedDiscountCodeIds(after, code) : [];
  if (!after || !ids.length) {
    return fail("applied_not_visible", `se aplicó ${code} pero no aparece en la sub. Comprobar en Seal.`);
  }
  let post = checkApplyPostcondition(beforeCents, eurosToCents(after.total_value), r.amount_cents);
  if (post === "not_reflected") {
    await sleep(1500);
    const again = await seal.getSubscriptionById(subId, undefined, { throwTransient: true }).catch(() => null);
    if (again) {
      after = again;
      ids = findAllAppliedDiscountCodeIds(again, code);
      post = checkApplyPostcondition(beforeCents, eurosToCents(again.total_value), r.amount_cents);
    }
  }
  if (post === "over_discount") {
    const drop = (beforeCents - eurosToCents(after.total_value)) / 100;
    try {
      await detachCode(subId, code);
    } catch (e) {
      return fail("over_discount_detach_failed", `el total bajó ${drop} € (más de 10) y NO se pudo quitar ${code} (${errMsg(e)}). QUITARLO A MANO YA.`);
    }
    return fail("over_discount", `el total bajó ${drop} € (más de 10); código retirado.`);
  }

  const { data: done, error: doneErr } = await sb
    .from("referral_rewards")
    .update({
      status: "applied",
      reward_code: code,
      shopify_discount_id: discountId,
      seal_discount_ids: ids,
      applied_at: nowIso(),
      last_error: null,
      updated_at: nowIso(),
    })
    .eq("id", r.id)
    .eq("status", "applying")
    .select("id");
  if (doneErr || !done?.length) {
    return { outcome: await handleUnrecordedApply(r, subId, code, doneErr?.message ?? "fila cambiada") };
  }

  return {
    outcome: "applied",
    notice:
      post === "ok"
        ? undefined
        : {
            recompensa: r.id,
            sub: subId,
            comprobacion: post,
            antes: beforeCents / 100,
            despues: eurosToCents(after.total_value) / 100,
          },
  };
}

/**
 * El código ESTÁ puesto en Seal pero la fila no se pudo pasar a `applied`. Si la
 * fila sigue viva (el apunte falló, o alguien la adoptó), la siguiente pasada la
 * adopta con su `apply_sent_at`. Si se movió mientras se aplicaba (un detach-all,
 * una revisión a mano), el código que se acaba de poner ya no es de ninguna
 * recompensa viva: se quita, porque se cobraría en cada renovación.
 */
async function handleUnrecordedApply(r: RewardRow, subId: number, code: string, why: string): Promise<string> {
  const { data: row, error } = await supabaseAdmin().from("referral_rewards").select("status").eq("id", r.id).maybeSingle();
  const status = error ? null : ((row?.status as RewardStatus | undefined) ?? null);
  if (status === null || status === "applying" || status === "applied") {
    await moneyAlert(
      "referral_reward_apply_unrecorded",
      r.id,
      `${code} aplicado en la sub ${subId} pero no se pudo apuntar como aplicado (${why}). La siguiente pasada lo adopta.`,
      r.referrer_customer_id,
    );
    return "apply_unrecorded";
  }
  try {
    const res = await detachCode(subId, code);
    await moneyAlert(
      "referral_reward_apply_orphan_removed",
      r.id,
      `La recompensa ${r.id} pasó a «${status}» mientras se aplicaba en la sub ${subId}: ${code} retirado (${res}). Comprobar en Seal.`,
      r.referrer_customer_id,
    );
    return "apply_orphan_removed";
  } catch (e) {
    await moneyAlert(
      "referral_reward_apply_orphan_stuck",
      r.id,
      `La recompensa ${r.id} pasó a «${status}» mientras se aplicaba y ${code} se quedó puesto en la sub ${subId} sin poder quitarlo (${errMsg(e)}). QUITARLO A MANO YA.`,
      r.referrer_customer_id,
    );
    return "apply_orphan_stuck";
  }
}

/** «Tus 10 € van en tu envío del …». Fuera del cerrojo. Nunca lanza. */
async function notifyRewardApplied(r: RewardRow, chargeDueAtMs: number): Promise<void> {
  const email = await readCustomerBasics(r.referrer_customer_id)
    .then((b) => b?.email ?? null)
    .catch(() => null);
  if (!email) return;
  const chargeIso = new Date(chargeDueAtMs).toISOString();
  await klaviyo
    .trackEvent(
      "referral_reward_applied",
      email,
      {
        reward_amount: r.amount_cents / 100,
        reward_amount_label: "10 €",
        charge_date: chargeIso,
        charge_date_label: formatShipDateEs(chargeIso),
      },
      { uniqueId: `referral-applied-${r.id}-${chargeIso.slice(0, 10)}`, externalId: r.referrer_customer_id },
    )
    .catch((e) => console.warn(LOG, "referral_reward_applied falló", r.id, errMsg(e)));
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Ganchos desde Seal y desde el cambio de plan
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Desde el webhook de Seal (`billing_attempt/succeeded`, `subscription/updated`,
 * `resumed`, `reactivated`): consume las recompensas aplicadas en esta sub si ya
 * hay pedido con el código, y adelanta a «ahora» la siguiente mirada de las
 * recompensas en cola de su dueño (su calendario puede haber cambiado: un salto,
 * un «adelantar pedido», una sub que vuelve). NUNCA aplica nada. Nunca lanza.
 */
export async function consumeReferralRewardsForSub(sub: SealSubscription | null | undefined): Promise<void> {
  if (!sub?.id) return;
  try {
    const sb = supabaseAdmin();
    if (sub.customer_id) {
      const now = nowIso();
      await sb
        .from("referral_rewards")
        .update({ next_check_at: now })
        .eq("referrer_customer_id", String(sub.customer_id))
        .eq("status", "queued")
        .gt("next_check_at", now);
    }
    const { data } = await sb
      .from("referral_rewards")
      .select(REWARD_COLUMNS)
      .eq("seal_subscription_id", String(sub.id))
      .in("status", ["applied", "applying"]);
    for (const r of (data ?? []) as RewardRow[]) {
      const fresh = await seal.getSubscriptionById(sub.id, undefined, { throwTransient: true }).catch(() => null);
      const state = fresh ? await appliedState(r, fresh, new Map()) : null;
      if (state?.consumedOrderId) await consumeReward(r, state.consumedOrderId, r.status);
    }
  } catch (e) {
    console.error(LOG, "consumo desde el webhook de Seal falló (el cron lo recoge)", sub.id, errMsg(e));
  }
}

/**
 * Antes de un alta + baja de líneas en Seal (`/api/subscription/plan`, que tiene
 * el cerrojo del cambio de plan tomado): retira la recompensa aplicada en la sub
 * y la devuelve a la cola. El cron la repondrá a tiempo si el cobro sigue dentro
 * de la ventana. Con `preMutationSub` (la sub que leyó la ruta), además quita
 * cualquier LITREF que la sub lleve sin recompensa viva en ella: el swap también
 * lo arrastraría.
 *
 * LANZA si no puede dejarla limpia: el llamante aborta el cambio (409
 * reintentable) ANTES de tocar nada. Un swap con el código puesto lo arrastraría
 * a la línea nueva de forma invisible y se cobraría en todos los cobros
 * siguientes. Un `applying` atascado (una pasada que murió) se resuelve aquí
 * mismo en vez de bloquear al cliente hasta la pasada siguiente.
 */
export async function detachReferralRewardsForSwap(
  sealSubscriptionId: number,
  preMutationSub?: SealSubscription | null,
): Promise<number> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("referral_rewards")
    .select(REWARD_COLUMNS)
    .eq("seal_subscription_id", String(sealSubscriptionId))
    .in("status", ["applying", "applied"]);
  if (error) throw new Error(`referral_rewards (guarda del swap): ${error.message}`);
  const rewards = (data ?? []) as RewardRow[];

  let detached = 0;
  for (const r of rewards) {
    // El cron aplica con este mismo cerrojo tomado (120 s), así que un `applying`
    // reciente solo puede estar vivo si esta ruta entró sin cerrojo (la RPC falló
    // y deja pasar). Pasado ese tiempo, la pasada que lo dejó así está muerta.
    if (r.status === "applying" && Date.now() - Date.parse(r.updated_at) < APPLY_LOCK_TTL_SECONDS * 1000) {
      throw new Error(`recompensa ${r.id} aplicándose ahora mismo en la sub ${sealSubscriptionId}`);
    }
    const fresh = await seal.getSubscriptionById(sealSubscriptionId, undefined, { throwTransient: true });
    const state = fresh ? await appliedState(r, fresh, new Map()) : null;
    if (state === null) throw new Error(`no se pudo leer la sub ${sealSubscriptionId}`);
    if (state.consumedOrderId) {
      const out = await consumeReward(r, state.consumedOrderId, r.status);
      if (out === "consume_detach_failed") throw new Error(`no se pudo quitar ${r.reward_code} tras su cobro`);
      continue;
    }
    if (r.status === "applying" && !state.codeVisible) {
      // Atascada sin código: si la orden nunca salió, a la cola; si salió y no se
      // ve, una persona (y el cambio sigue: no hay nada visible que arrastrar).
      if (!r.apply_sent_at) {
        await setStatus(r, "applying", { ...requeuePatch(), status_reason: "apply_never_sent" });
      } else {
        await setStatus(r, "applying", { status: "failed", status_reason: "applying_stuck_before_swap" });
        await moneyAlert(
          "referral_reward_stuck_before_swap",
          r.id,
          `Recompensa ${r.id} atascada aplicándose en la sub ${sealSubscriptionId} sin código visible antes de un cambio de plan. Comprobar en Seal.`,
          r.referrer_customer_id,
        );
      }
      continue;
    }
    const res = await detachCode(sealSubscriptionId, normalizeCode(r.reward_code));
    if (res === "not_visible") {
      // Aplicada en BD pero sin código visible: no se puede quitar lo que no se ve.
      // Se marca para una persona y se deja seguir el cambio (bloquearlo para
      // siempre por algo que quizá ya no existe sería peor).
      await setStatus(r, r.status, { status: "failed", status_reason: "not_visible_before_swap" });
      await moneyAlert(
        "referral_reward_not_visible_before_swap",
        r.id,
        `Recompensa ${r.id} (${r.reward_code}) aplicada pero invisible en la sub ${sealSubscriptionId} antes de un cambio de plan. Comprobar en Seal.`,
        r.referrer_customer_id,
      );
      continue;
    }
    if (state.chargeEvidenceUnknown) {
      // Retirado (había que hacerlo antes del swap), pero hubo un cobro cuyo pedido
      // no se puede leer: si llevó el descuento, reencolar daría el premio dos veces.
      await setStatus(r, r.status, { status: "failed", status_reason: "charge_evidence_unknown_before_swap", seal_discount_ids: [] });
      await moneyAlert(
        "referral_reward_unknown_charge_before_swap",
        r.id,
        `Recompensa ${r.id} retirada de la sub ${sealSubscriptionId} antes de un cambio de plan, pero hubo un cobro cuyo pedido no se pudo leer. Comprobar si ese cobro llevó los 10 € y, si no, reencolarla (referral-admin requeue --force).`,
        r.referrer_customer_id,
      );
      continue;
    }
    await setStatus(r, r.status, { ...requeuePatch(), status_reason: "plan_change" });
    detached++;
  }

  // Un LITREF en la sub que no es de ninguna recompensa viva EN ELLA (una retirada
  // que Seal confirmó antes de tiempo, uno puesto a mano): el swap lo arrastraría
  // igual. Se quita aquí (detachCode relee la sub, así que vale aunque la lectura
  // de la ruta sea de hace un momento). Si no se puede, lanza y el cambio se aborta.
  if (preMutationSub) {
    const tracked = new Set(rewards.map((r) => normalizeCode(r.reward_code)).filter(Boolean));
    const stray = [...new Set(codesOnSub(preMutationSub).filter((c) => isRewardCode(c) && !tracked.has(c)))];
    for (const code of stray) {
      const res = await detachCode(sealSubscriptionId, code);
      if (res === "removed") detached++;
      await moneyAlert(
        "referral_reward_stray_before_swap",
        `${sealSubscriptionId}-${code}`,
        `La sub ${sealSubscriptionId} llevaba ${code} sin ninguna recompensa viva en ella; ${res === "removed" ? "retirado" : "ya no se veía"} antes de un cambio de plan. Revisar de qué recompensa es (referral-admin status).`,
      );
    }
  }
  return detached;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Para la tarjeta de Mi LIT y el cron
// ═══════════════════════════════════════════════════════════════════════════

export interface ReferralStats {
  friendsJoined: number;
  queued: number;
  applied: number;
  consumed: number;
  nextDiscountedChargeAt: string | null;
}

export async function readReferralStats(customerId: string): Promise<ReferralStats> {
  const sb = supabaseAdmin();
  const [{ count: joined }, { data: rewards }] = await Promise.all([
    sb
      .from("referral_conversions")
      .select("id", { count: "exact", head: true })
      .eq("referrer_customer_id", customerId)
      .eq("status", "qualified"),
    sb
      .from("referral_rewards")
      .select("status, charge_due_at")
      .eq("referrer_customer_id", customerId)
      .in("status", ["queued", "applying", "applied", "consumed"]),
  ]);
  const list = (rewards ?? []) as Array<{ status: RewardStatus; charge_due_at: string | null }>;
  const applied = list.filter((r) => r.status === "applied" || r.status === "applying");
  return {
    friendsJoined: joined ?? 0,
    queued: list.filter((r) => r.status === "queued").length,
    applied: applied.length,
    consumed: list.filter((r) => r.status === "consumed").length,
    nextDiscountedChargeAt:
      applied
        .map((r) => r.charge_due_at)
        .filter((d): d is string => !!d)
        .sort()[0] ?? null,
  };
}

/**
 * Cualifica las conversiones que se quedaron pendientes (Seal caído, `after()`
 * perdido…) y repara las cualificadas que se quedaron sin recompensa.
 */
export async function qualifyPendingBacklog(max: number, deadlineMs?: number): Promise<SweepTally> {
  const tally: SweepTally = {};
  const { data } = await supabaseAdmin()
    .from("referral_conversions")
    .select("id")
    .eq("status", "pending")
    .order("converted_at", { ascending: true })
    .limit(max);
  for (const c of data ?? []) {
    if (deadlineMs !== undefined && Date.now() > deadlineMs) break;
    const out = await qualifyPendingConversionSafe(c.id as string);
    tally[out] = (tally[out] ?? 0) + 1;
  }
  if (deadlineMs === undefined || Date.now() < deadlineMs) {
    try {
      const repaired = await repairQualifiedWithoutReward();
      if (repaired) tally["reward_repaired"] = repaired;
    } catch (e) {
      console.error(LOG, "reparación de recompensas falló", errMsg(e));
      tally["repair_error"] = 1;
    }
  }
  return tally;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Operación a mano (scripts/referral-admin.ts)
// ═══════════════════════════════════════════════════════════════════════════

/** review → qualified, con su recompensa y su aviso. Para lo que marcó la velocidad o la verificación. */
export async function approveReviewedConversion(conversionId: string): Promise<void> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("referral_conversions")
    .update({ status: "qualified", qualified_at: nowIso(), reason: "approved_by_hand", updated_at: nowIso() })
    .eq("id", conversionId)
    .eq("status", "review")
    .select("id, referrer_customer_id, code");
  if (error) {
    if (error.code === "23505") throw new Error("ese amigo ya tiene otra conversión cualificada");
    throw new Error(`approve: ${error.message}`);
  }
  const conv = data?.[0] as Pick<ConversionRow, "id" | "referrer_customer_id" | "code"> | undefined;
  if (!conv) throw new Error(`la conversión ${conversionId} no está en review`);
  await createRewardAndNotify(conv);
}

/** pending | review → rejected. */
export async function rejectConversion(conversionId: string, reason: string): Promise<void> {
  const { data, error } = await supabaseAdmin()
    .from("referral_conversions")
    .update({ status: "rejected", reason: `by_hand:${reason}`.slice(0, 200), updated_at: nowIso() })
    .eq("id", conversionId)
    .in("status", ["pending", "review"])
    .select("id");
  if (error) throw new Error(`reject: ${error.message}`);
  if (!data?.length) throw new Error(`la conversión ${conversionId} no está en pending ni en review`);
}

/**
 * Motivos de `failed` en los que el código pudo quedarse puesto SIN verse, o un
 * cobro pudo llevarlo sin que se pueda leer: reencolar pondría una copia visible
 * encima (20 € en un cobro). Solo con `--force`, tras mirarlo a mano en Seal.
 */
const UNSAFE_REQUEUE_REASON = /not_visible|ambiguous|stuck|unknown/;

/**
 * failed → queued, para cuando una persona ha comprobado que la recompensa sí le
 * corresponde. Antes de reencolar:
 *   - si ya se cobró (pedido apuntado, o un cobro con el código desde que salió
 *     la orden de aplicar), NO se reencola: se cierra como consumida;
 *   - los motivos de `UNSAFE_REQUEUE_REASON` y un cobro que no se puede leer
 *     exigen `force`;
 *   - se quita el código de cualquier sub donde se vea (si no se puede, no
 *     reencola).
 */
export async function requeueFailedReward(rewardId: string, opts: { force?: boolean } = {}): Promise<string> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.from("referral_rewards").select(REWARD_COLUMNS).eq("id", rewardId).maybeSingle();
  if (error) throw new Error(error.message);
  const r = data as RewardRow | null;
  if (!r) throw new Error(`no existe la recompensa ${rewardId}`);
  if (r.status !== "failed") throw new Error(`la recompensa ${rewardId} está en «${r.status}», no en failed`);
  if (r.consumed_order_id) {
    throw new Error(`la recompensa ${rewardId} ya se cobró en el pedido ${r.consumed_order_id}: no se reencola`);
  }
  if (UNSAFE_REQUEUE_REASON.test(r.status_reason ?? "") && !opts.force) {
    throw new Error(
      `motivo «${r.status_reason}»: el código pudo quedarse puesto sin verse, o un cobro pudo llevarlo. Comprobarlo a mano en Seal y repetir con --force.`,
    );
  }
  if (r.seal_subscription_id && r.apply_sent_at) {
    const sub = await seal.getSubscriptionById(Number(r.seal_subscription_id), undefined, { throwTransient: true });
    const state = await appliedState(r, sub, new Map());
    if (state === null) throw new Error("no se pudo leer Seal o Shopify para comprobar si ya se cobró");
    if (state.consumedOrderId) {
      const out = await consumeReward(r, state.consumedOrderId, "failed");
      return `ya se había cobrado en el pedido ${state.consumedOrderId} → ${out} (no se reencola)`;
    }
    if (state.chargeEvidenceUnknown && !opts.force) {
      throw new Error(
        "hubo un cobro cuyo pedido no se puede leer: comprobar a mano si llevó los 10 € y, si no, repetir con --force",
      );
    }
  }
  if (r.reward_code) {
    const code = normalizeCode(r.reward_code);
    const subIds = r.seal_subscription_id
      ? [Number(r.seal_subscription_id)]
      : await subsWithCodeVisible(r.referrer_customer_id, code);
    if (subIds === null) throw new Error("no se pudo leer Seal para comprobar el código");
    for (const subId of subIds) await detachCode(subId, code);
  }
  if (!(await setStatus(r, "failed", { ...requeuePatch(), status_reason: "requeued_by_hand" }))) {
    throw new Error(`la recompensa ${rewardId} cambió mientras se reencolaba`);
  }
  return "requeued";
}

/**
 * La palanca de emergencia: quita de Seal TODOS los LITREF aplicados y devuelve
 * sus recompensas a la cola (nadie pierde nada). APAGAR ANTES `REFERRAL_REWARDS`
 * (y Redeploy), o la pasada siguiente del cron (cada 4 h) los vuelve a aplicar. Hay que
 * correrla también ANTES de volver a un deploy anterior a la fase 0, porque ese
 * código no sabe retirar un LITREF.
 */
export async function detachAllRewards(opts: { dryRun: boolean }): Promise<Array<{ id: string; sub: string | null; result: string }>> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.from("referral_rewards").select(REWARD_COLUMNS).in("status", ["applying", "applied"]);
  if (error) throw new Error(`detach-all: ${error.message}`);
  const out: Array<{ id: string; sub: string | null; result: string }> = [];
  for (const r of (data ?? []) as RewardRow[]) {
    if (opts.dryRun || !r.seal_subscription_id || !r.reward_code) {
      out.push({ id: r.id, sub: r.seal_subscription_id, result: opts.dryRun ? "dry_run" : "sin sub o sin código" });
      continue;
    }
    try {
      const res = await detachCode(Number(r.seal_subscription_id), normalizeCode(r.reward_code));
      if (res === "not_visible") {
        // No se puede confirmar la retirada: reencolar pondría una copia visible
        // encima de una posible invisible.
        await setStatus(r, r.status, { status: "failed", status_reason: "not_visible_on_detach_all" });
        out.push({ id: r.id, sub: r.seal_subscription_id, result: "NO VISIBLE → failed (revisar en Seal)" });
        continue;
      }
      await setStatus(r, r.status, { ...requeuePatch(), status_reason: "detach_all" });
      out.push({ id: r.id, sub: r.seal_subscription_id, result: "retirado → en cola" });
    } catch (e) {
      out.push({ id: r.id, sub: r.seal_subscription_id, result: `ERROR ${errMsg(e)}` });
    }
  }
  return out;
}

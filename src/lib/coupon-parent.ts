/**
 * Cupones de campaña (perfilado y Discovery Set) DENTRO de un descuento padre
 * por campaña, como «Referidos · Amigo 10 €» (Juan 2026-10-14: «esto está súper
 * ordenado… me gustaría ordenar igual los de perfilado y los de Discovery Set» y
 * «que todos los nuevos ya se generen dentro de esos descuentos padre»).
 *
 * Antes cada cupón era un descuento suelto (`Perfilado LIT-… (cliente)`), y en
 * un mes ya eran 140 líneas en el admin de Shopify. Ahora hay dos descuentos,
 * «Cupón perfilado · 5€» y «Cupón Discovery Set · 4,99€», con un código por
 * cliente DENTRO. Para el cliente no cambia nada: el mismo `LIT-XXXXXXXX`, el
 * mismo importe y las mismas condiciones.
 *
 * ── Lo que Shopify no deja poner por código, y llevamos nosotros ──
 *
 * La caducidad y el límite de usos son del DESCUENTO, no de cada código:
 *
 *   - Caducidad (30 días): la fecha de cada código ya vive en Supabase
 *     (`discount_expires_at` de `profile_survey_answers` y de
 *     `discovery_set_coupons`). El cron `survey-discount-cleanup` BORRA del padre
 *     los códigos cuya fecha ya ha pasado. Nunca antes: como mucho un día
 *     después de lo prometido, nunca un día antes.
 *   - Un solo uso: `orders/paid` borra del padre el código en cuanto entra un
 *     pedido pagado que lo lleva ({@link consumeCampaignCouponsSafe}), y el cron
 *     repasa los usados (`asyncUsageCount`) por si el webhook falló. Además el
 *     padre es `appliesOncePerCustomer`: cada cliente usa UN código de cada
 *     campaña en su vida, que es lo mismo que daba un cupón por cliente.
 *   - El código de renovación del Discovery (lo aplica el portal en Seal y no
 *     caduca) se borra cuando se ha cobrado esa renovación (fila `removed`) o se
 *     ha anulado (`void`).
 *
 * Sin `usageLimit` en el padre: en un descuento con varios códigos cuenta el
 * total de todos, y `1` lo dejaría muerto tras el primer canje.
 */

import { alertSlackErrorAwaited } from "@/lib/alert";
import {
  bulkAddFriendCodes,
  deleteFriendRedeemCode,
  findCodeDiscountNodeId,
  readBulkCreation,
} from "@/lib/referral-shopify";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

/** «Cupón perfilado · 5€»: los códigos de la encuesta de perfilado. Creado el
 *  2026-10-14 con `scripts/coupons-create-parents.ts` (5 €, cajas LIT,
 *  suscripción y compra única, primer cobro, una vez por cliente). */
export const SURVEY_COUPON_PARENT_GID = "gid://shopify/DiscountCodeNode/2511102247302";

/** «Cupón Discovery Set · 4,99€»: los del Discovery Set, los del email y los de
 *  renovación. Creado el 2026-10-14 (4,99 €, cajas LIT, SOLO suscripción, primer
 *  cobro, una vez por cliente). */
export const DISCOVERY_COUPON_PARENT_GID = "gid://shopify/DiscountCodeNode/2511102280070";

const PARENT_GIDS = [SURVEY_COUPON_PARENT_GID, DISCOVERY_COUPON_PARENT_GID];

/**
 * Colección «Cupones - solo cajas LIT (tecnica, no publicar)», la de siempre.
 *
 * Automática por título (contiene "Daily Hydration" o "Hydration Pack"): las
 * cajas de cada sabor en suscripción y en compra única, más los packs de 4.
 * Deja fuera el propio Discovery Set (el cupón no puede gastarse en otro Set),
 * botella, calcetines, hoodie y wholesale. Un sabor nuevo entra solo. En el
 * Discovery los «compra única» están dentro pero no cuentan, porque su padre no
 * aplica en compra única. Verificado contra Shopify el 2026-09-22 y el 09-24.
 */
const COUPON_COLLECTION_GID = "gid://shopify/Collection/726625812829";

/**
 * Prefijo del código semilla de cada padre. Shopify exige un código para crear
 * el descuento; este es aleatorio y no lo conoce nadie, y el cron no lo borra
 * nunca (si el padre se quedara sin códigos seguiría existiendo, pero así no
 * hay sorpresas).
 */
export const COUPON_SEED_PREFIX = "CUPONSEED";

/** El formato de nuestros códigos de campaña: `LIT-` + 8 sin O/0, I/1/L. */
const CAMPAIGN_CODE_RE = /^LIT-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/;

export function isCampaignCouponCode(code: string | null | undefined): code is string {
  return CAMPAIGN_CODE_RE.test((code ?? "").trim().toUpperCase());
}

type UserError = { field: string[] | null; message: string; code: string | null };

export interface CouponParentDef {
  title: string;
  /** Decimal en euros, como lo toma la mutación. */
  amountEur: string;
  /** Perfilado: sí. Discovery: NO (la promesa es devolver los 4,99 € al suscribirse). */
  appliesOnOneTimePurchase: boolean;
}

/**
 * Crea un descuento padre. Lo usa SOLO `scripts/coupons-create-parents.ts`, una
 * vez, con OK explícito. La configuración es la de los cupones sueltos de
 * antes, menos lo que pasa a llevar el portal (caducidad y un solo uso).
 */
export async function createCouponParent(def: CouponParentDef, seedCode: string): Promise<string> {
  const data = await shopifyAdmin.graphql<{
    discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: UserError[] };
  }>(
    `mutation createCouponParent($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }`,
    {
      basicCodeDiscount: {
        title: def.title,
        code: seedCode,
        startsAt: new Date().toISOString(),
        // Sin `endsAt`: cada código caduca por su cuenta (ver el docstring).
        // NUNCA un segmento de clientes: es lo que dejó los cupones de GoAffPro
        // con cero canjes (Shopify rechaza el código a quien paga sin sesión).
        customerSelection: { all: true },
        customerGets: {
          value: { discountAmount: { amount: def.amountEur, appliesOnEachItem: false } },
          items: { collections: { add: [COUPON_COLLECTION_GID] } },
          appliesOnOneTimePurchase: def.appliesOnOneTimePurchase,
          // FALSE por defecto en Shopify: omitirlo hizo rebotar los primeros
          // cupones del perfilado en carritos de suscripción.
          appliesOnSubscription: true,
        },
        // Solo el primer cobro de la suscripción, no un descuento para siempre.
        recurringCycleLimit: 1,
        // Para el padre ENTERO: un cliente, un código de esta campaña.
        appliesOncePerCustomer: true,
        // Sin `usageLimit`: en un padre cuenta el total de todos los códigos.
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
      },
    },
  );
  const res = data.discountCodeBasicCreate;
  if (res.userErrors?.length) {
    throw new Error(`discountCodeBasicCreate (padre): ${res.userErrors.map((e) => e.message).join("; ")}`);
  }
  if (!res.codeDiscountNode) throw new Error("discountCodeBasicCreate (padre): codeDiscountNode null sin userErrors");
  return res.codeDiscountNode.id;
}

/**
 * Da de alta UN código en su padre y espera a que Shopify confirme. El alta es
 * asíncrona (una «bulk» de un solo código): se consulta cada 700 ms hasta
 * `timeoutMs`. Si la bulk no ha terminado a tiempo, se mira directamente si el
 * código ya resuelve a ese padre.
 *
 * Lanza si Shopify rechaza el código o no lo confirma: los llamantes ya tratan
 * un fallo de emisión (la encuesta libera la reserva y avisa, el webhook avisa
 * por Slack y no manda el email con un código que no funciona).
 */
export async function addCouponCode(
  parentId: string,
  code: string,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const bulkId = await bulkAddFriendCodes(parentId, [code]);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 700));
    const bulk = await readBulkCreation(bulkId);
    if (!bulk.done) continue;
    const mine = bulk.codes.find((c) => c.code === code.trim().toUpperCase());
    if (mine?.ok) return;
    throw new Error(`Shopify no aceptó ${code} en ${parentId}: ${mine?.error ?? "sin detalle"}`);
  }
  if ((await findCodeDiscountNodeId(code)) === parentId) return;
  throw new Error(`Shopify no confirmó ${code} en ${parentId} en ${Math.round(timeoutMs / 1000)} s`);
}

/** Quita un código de su padre. `false` si ya no estaba. */
export async function removeCouponCode(parentId: string, code: string): Promise<boolean> {
  return deleteFriendRedeemCode(parentId, code);
}

/**
 * Un solo uso: borra del padre los códigos de campaña de un pedido pagado. Lo
 * llama `orders/paid` en segundo plano. Nunca lanza: si algo falla, avisa, y el
 * cron borra el código igualmente por su uso (`asyncUsageCount`).
 */
export async function consumeCampaignCouponsSafe(codes: string[], orderLabel: string): Promise<void> {
  for (const raw of codes) {
    const code = raw.trim().toUpperCase();
    if (!isCampaignCouponCode(code)) continue;
    try {
      const owner = await findCodeDiscountNodeId(code);
      // Solo los de NUESTROS padres. Un `LIT-…` que siga siendo un descuento
      // suelto de antes lo limita su propio `usageLimit: 1`.
      if (!owner || !PARENT_GIDS.includes(owner)) continue;
      await removeCouponCode(owner, code);
    } catch (err) {
      console.error(`[coupon-parent] no se pudo retirar ${code} (pedido ${orderLabel}):`, err);
      await alertSlackErrorAwaited({
        path: "/api/webhooks/shopify",
        code: `coupon_consume_failed:${code}`,
        msg: `El pedido ${orderLabel} usó el cupón ${code} y no se pudo retirar de su descuento padre: ${
          err instanceof Error ? err.message : String(err)
        }. El cron de limpieza lo retira por su uso; si no, borrarlo a mano.`,
      }).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// El barrido del cron: caducados, usados y renovaciones ya cobradas
// ═══════════════════════════════════════════════════════════════════════════

interface ParentCode {
  id: string;
  code: string;
  used: number;
}

async function listParentCodes(parentId: string): Promise<ParentCode[]> {
  const out: ParentCode[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data: {
      codeDiscountNode: {
        codeDiscount: {
          codes?: {
            nodes: Array<{ id: string; code: string; asyncUsageCount: number }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      } | null;
    } = await shopifyAdmin.graphql(
      `query couponParentCodes($id: ID!, $cursor: String) {
        codeDiscountNode(id: $id) {
          codeDiscount { ... on DiscountCodeBasic {
            codes(first: 250, after: $cursor) { nodes { id code asyncUsageCount } pageInfo { hasNextPage endCursor } }
          } }
        }
      }`,
      { id: parentId, cursor },
    );
    const conn = data.codeDiscountNode?.codeDiscount?.codes;
    if (!conn) throw new Error(`el descuento ${parentId} no existe o no es de códigos`);
    for (const n of conn.nodes) out.push({ id: n.id, code: n.code.trim().toUpperCase(), used: n.asyncUsageCount ?? 0 });
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

export interface CouponRow {
  expiresAt: string | null;
  /** Solo Discovery: 'checkout' | 'renewal'. */
  mode?: string | null;
  /** Solo Discovery renovación: pending_apply, applying, pending_charge, removed, void… */
  status?: string | null;
}

export type CouponVerdict = "keep" | "expired" | "used" | "settled" | "unknown";

/**
 * Qué hacer con un código de un padre. Pura, para poder probarla.
 *
 *   - El semilla, siempre se queda.
 *   - Sin fila en Supabase: se queda y se cuenta como «unknown» (nunca se borra
 *     un código que no sabemos de dónde ha salido).
 *   - Renovación del Discovery: se va cuando su fila está `removed` o `void`
 *     (la renovación ya se cobró o se anuló) o si Shopify ya le cuenta un uso.
 *     No caduca.
 *   - El resto: se va si se ha usado o si su fecha de caducidad ya ha pasado.
 */
export function couponVerdict(
  code: string,
  used: number,
  row: CouponRow | null,
  now: Date = new Date(),
): CouponVerdict {
  if (code.startsWith(COUPON_SEED_PREFIX)) return "keep";
  if (!row) return "unknown";
  if (row.mode === "renewal") {
    if (row.status === "removed" || row.status === "void") return "settled";
    return used > 0 ? "used" : "keep";
  }
  if (used > 0) return "used";
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now.getTime()) return "expired";
  return "keep";
}

export interface ParentSweepTally {
  parent: string;
  codes: number;
  removed: number;
  expired: number;
  used: number;
  settled: number;
  unknown: number;
  failed: number;
}

/**
 * Borra de los padres los códigos que ya no deben funcionar. Lo llama el cron
 * `survey-discount-cleanup` cada día. El borrado va por lotes de 100 con
 * `discountCodeRedeemCodeBulkDelete` (asíncrono en Shopify; si un lote falla,
 * mañana se reintenta porque los códigos siguen ahí).
 */
export async function sweepCouponParents({
  dryRun = false,
  now = new Date(),
}: { dryRun?: boolean; now?: Date } = {}): Promise<ParentSweepTally[]> {
  const sb = supabaseAdmin();
  const tallies: ParentSweepTally[] = [];
  for (const parentId of PARENT_GIDS) {
    const tally: ParentSweepTally = { parent: parentId, codes: 0, removed: 0, expired: 0, used: 0, settled: 0, unknown: 0, failed: 0 };
    tallies.push(tally);
    const codes = await listParentCodes(parentId);
    tally.codes = codes.length;
    if (!codes.length) continue;

    // Las filas de esos códigos, de las dos tablas, en lotes de 200.
    const rows = new Map<string, CouponRow>();
    const list = codes.map((c) => c.code).filter(isCampaignCouponCode);
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      const [survey, discovery] = await Promise.all([
        sb.from("profile_survey_answers").select("discount_code, discount_expires_at").in("discount_code", chunk),
        sb.from("discovery_set_coupons").select("discount_code, discount_expires_at, mode, status").in("discount_code", chunk),
      ]);
      if (survey.error) throw new Error(`profile_survey_answers: ${survey.error.message}`);
      if (discovery.error) throw new Error(`discovery_set_coupons: ${discovery.error.message}`);
      for (const r of survey.data ?? []) {
        rows.set(String(r.discount_code).toUpperCase(), { expiresAt: r.discount_expires_at ?? null });
      }
      for (const r of discovery.data ?? []) {
        rows.set(String(r.discount_code).toUpperCase(), {
          expiresAt: r.discount_expires_at ?? null,
          mode: r.mode ?? "checkout",
          status: r.status ?? null,
        });
      }
    }

    const toRemove: string[] = [];
    for (const c of codes) {
      const v = couponVerdict(c.code, c.used, rows.get(c.code) ?? null, now);
      if (v === "keep") continue;
      if (v === "unknown") {
        tally.unknown++;
        continue;
      }
      tally[v]++;
      toRemove.push(c.id);
    }
    if (dryRun || !toRemove.length) continue;

    for (let i = 0; i < toRemove.length; i += 100) {
      const ids = toRemove.slice(i, i + 100);
      try {
        const del = await shopifyAdmin.graphql<{
          discountCodeRedeemCodeBulkDelete: { job: { id: string } | null; userErrors: UserError[] };
        }>(
          `mutation sweepCouponCodes($discountId: ID!, $ids: [ID!]) {
            discountCodeRedeemCodeBulkDelete(discountId: $discountId, ids: $ids) {
              job { id }
              userErrors { field message code }
            }
          }`,
          { discountId: parentId, ids },
        );
        const errs = del.discountCodeRedeemCodeBulkDelete.userErrors;
        if (errs?.length) {
          tally.failed += ids.length;
          console.warn(`[coupon-parent] borrado en ${parentId}: ${errs.map((e) => e.message).join("; ")}`);
        } else {
          tally.removed += ids.length;
        }
      } catch (err) {
        tally.failed += ids.length;
        console.warn(`[coupon-parent] borrado en ${parentId} falló:`, err);
      }
    }
  }
  return tallies;
}

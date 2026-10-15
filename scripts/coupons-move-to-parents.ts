/**
 * Mueve los cupones sueltos de antes (un descuento por cliente) DENTRO de su
 * descuento padre (Juan 2026-10-14, opción B: «adelante con B»).
 *
 *   npx tsx scripts/coupons-move-to-parents.ts                  # simula, no toca nada
 *   npx tsx scripts/coupons-move-to-parents.ts --apply          # lo hace
 *   npx tsx scripts/coupons-move-to-parents.ts --apply --only=LIT-XXXXXXXX
 *   npx tsx scripts/coupons-move-to-parents.ts --apply --limit=5
 *
 * Solo toca descuentos cuyo título es EXACTAMENTE el de nuestras campañas,
 * `Perfilado LIT-XXXXXXXX (cliente)`, `Discovery LIT-XXXXXXXX (cliente)` o
 * `Discovery renovación LIT-XXXXXXXX (cliente)`: la búsqueda de Shopify por
 * título no es fiable como filtro, así que se revalida aquí con una regex. Los
 * de compensación hechos a mano (`Perfilado compensacion …`) no encajan y se
 * quedan como están.
 *
 * Qué hace con cada uno:
 *   - USADO o CADUCADO: lo borra. Ya no sirve para nada y los pedidos que lo
 *     usaron conservan su código.
 *   - Renovación del Discovery ya cobrada o anulada (fila `removed`/`void`): lo borra.
 *   - Vivo: copia su configuración, borra el descuento suelto, da de alta el
 *     MISMO código en el padre y comprueba que resuelve al padre. Si algo falla
 *     después de borrarlo, lo vuelve a crear tal como estaba. Entre el borrado y
 *     el alta el código no funciona ~1 s.
 *   - Sin fila en Supabase o con una configuración que no es la esperada: no lo
 *     toca y lo apunta (sin fila, el cron no sabría cuándo caduca).
 *   - Renovación a medio aplicar (`applying`): no lo toca esta vez.
 */

import {
  addCouponCode,
  DISCOVERY_COUPON_PARENT_GID,
  SURVEY_COUPON_PARENT_GID,
} from "../src/lib/coupon-parent";
import { deleteCodeDiscount, findCodeDiscountNodeId } from "../src/lib/referral-shopify";
import { shopifyAdmin } from "../src/lib/shopify-admin";
import { supabaseAdmin } from "../src/lib/supabase";

const apply = process.argv.includes("--apply");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).toUpperCase() ?? null;
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice(8)) : Infinity;

const TITLE_RE = /^(Perfilado|Discovery|Discovery renovación) (LIT-[A-Z0-9]{8}) \((\d+)\)$/;
const COLLECTION = "gid://shopify/Collection/726625812829";

interface Legacy {
  id: string;
  title: string;
  kind: "Perfilado" | "Discovery" | "Discovery renovación";
  code: string;
  customerId: string;
  status: string;
  used: number;
  startsAt: string;
  endsAt: string | null;
  codes: string[];
  amount: string | null;
  oneTime: boolean;
  sub: boolean;
  recurringCycleLimit: number | null;
  collections: string[];
}

async function listLegacy(): Promise<Legacy[]> {
  const out: Legacy[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data: {
      codeDiscountNodes: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          codeDiscount: {
            title?: string;
            status?: string;
            asyncUsageCount?: number;
            startsAt?: string;
            endsAt?: string | null;
            recurringCycleLimit?: number | null;
            codes?: { nodes: Array<{ code: string }> };
            customerGets?: {
              appliesOnOneTimePurchase: boolean;
              appliesOnSubscription: boolean;
              value: { amount?: { amount: string } };
              items: { collections?: { nodes: Array<{ id: string }> } };
            };
          };
        }>;
      };
    } = await shopifyAdmin.graphql(
      `query legacyCoupons($cursor: String) {
        codeDiscountNodes(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title status asyncUsageCount startsAt endsAt recurringCycleLimit
                codes(first: 3) { nodes { code } }
                customerGets {
                  appliesOnOneTimePurchase appliesOnSubscription
                  value { ... on DiscountAmount { amount { amount } } }
                  items { ... on DiscountCollections { collections(first: 3) { nodes { id } } } }
                }
              }
            }
          }
        }
      }`,
      { cursor },
    );
    for (const n of data.codeDiscountNodes.nodes) {
      const d = n.codeDiscount ?? {};
      const m = TITLE_RE.exec(d.title ?? "");
      if (!m) continue;
      out.push({
        id: n.id,
        title: d.title ?? "",
        kind: m[1] as Legacy["kind"],
        code: m[2],
        customerId: m[3],
        status: d.status ?? "",
        used: d.asyncUsageCount ?? 0,
        startsAt: d.startsAt ?? new Date().toISOString(),
        endsAt: d.endsAt ?? null,
        codes: (d.codes?.nodes ?? []).map((c) => c.code.trim().toUpperCase()),
        amount: d.customerGets?.value?.amount?.amount ?? null,
        oneTime: !!d.customerGets?.appliesOnOneTimePurchase,
        sub: !!d.customerGets?.appliesOnSubscription,
        recurringCycleLimit: d.recurringCycleLimit ?? null,
        collections: (d.customerGets?.items?.collections?.nodes ?? []).map((c) => c.id),
      });
    }
    if (!data.codeDiscountNodes.pageInfo.hasNextPage) break;
    cursor = data.codeDiscountNodes.pageInfo.endCursor;
  }
  return out;
}

/** Vuelve a crear el descuento suelto tal como estaba (marcha atrás). */
async function recreate(l: Legacy): Promise<void> {
  const data = await shopifyAdmin.graphql<{
    discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: Array<{ message: string }> };
  }>(
    `mutation recreateLegacyCoupon($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }`,
    {
      basicCodeDiscount: {
        title: l.title,
        code: l.code,
        startsAt: l.startsAt,
        ...(l.endsAt ? { endsAt: l.endsAt } : {}),
        customerSelection: { all: true },
        customerGets: {
          value: { discountAmount: { amount: l.amount, appliesOnEachItem: false } },
          items: { collections: { add: l.collections } },
          appliesOnOneTimePurchase: l.oneTime,
          appliesOnSubscription: l.sub,
        },
        recurringCycleLimit: l.recurringCycleLimit ?? 1,
        appliesOncePerCustomer: true,
        usageLimit: 1,
      },
    },
  );
  const errs = data.discountCodeBasicCreate.userErrors;
  if (errs?.length) throw new Error(errs.map((e) => e.message).join("; "));
}

type Plan = { l: Legacy; action: "move" | "delete" | "skip"; why: string; parent: string };

async function main() {
  const sb = supabaseAdmin();
  let legacy = await listLegacy();
  if (only) legacy = legacy.filter((l) => l.code === only);
  console.log(`Cupones sueltos de campaña encontrados: ${legacy.length}${only ? ` (solo ${only})` : ""}\n`);

  const plans: Plan[] = [];
  for (const l of legacy) {
    const isSurvey = l.kind === "Perfilado";
    const parent = isSurvey ? SURVEY_COUPON_PARENT_GID : DISCOVERY_COUPON_PARENT_GID;
    const expectAmount = isSurvey ? 5 : 4.99;
    const sane =
      l.codes.length === 1 &&
      l.codes[0] === l.code &&
      Number(l.amount) === expectAmount &&
      l.oneTime === isSurvey &&
      l.sub &&
      l.collections.length === 1 &&
      l.collections[0] === COLLECTION;

    let row: { mode?: string | null; status?: string | null; expires?: string | null } | null = null;
    if (isSurvey) {
      const { data, error } = await sb
        .from("profile_survey_answers")
        .select("discount_expires_at")
        .eq("discount_code", l.code)
        .maybeSingle();
      if (error) throw new Error(`profile_survey_answers: ${error.message}`);
      row = data ? { expires: data.discount_expires_at } : null;
    } else {
      const { data, error } = await sb
        .from("discovery_set_coupons")
        .select("discount_expires_at, mode, status")
        .eq("discount_code", l.code)
        .maybeSingle();
      if (error) throw new Error(`discovery_set_coupons: ${error.message}`);
      row = data ? { expires: data.discount_expires_at, mode: data.mode, status: data.status } : null;
    }

    if (l.status === "EXPIRED") plans.push({ l, action: "delete", why: "caducado", parent });
    else if (l.used > 0) plans.push({ l, action: "delete", why: `usado (${l.used})`, parent });
    else if (row?.mode === "renewal" && (row.status === "removed" || row.status === "void"))
      plans.push({ l, action: "delete", why: `renovación ${row.status}`, parent });
    else if (!row) plans.push({ l, action: "skip", why: "sin fila en Supabase", parent });
    else if (!sane) plans.push({ l, action: "skip", why: "configuración inesperada", parent });
    else if (row.mode === "renewal" && row.status === "applying")
      plans.push({ l, action: "skip", why: "renovación aplicándose ahora", parent });
    else plans.push({ l, action: "move", why: row.mode === "renewal" ? `renovación ${row.status}` : "vivo", parent });
  }

  const count = (a: Plan["action"]) => plans.filter((p) => p.action === a).length;
  console.log(`Plan: mover ${count("move")} · borrar ${count("delete")} · no tocar ${count("skip")}`);
  for (const p of plans.filter((x) => x.action === "skip")) console.log(`  no se toca ${p.l.code} (${p.l.kind}): ${p.why}`);
  if (!apply) {
    for (const p of plans.filter((x) => x.action !== "skip")) console.log(`  ${p.action === "move" ? "movería" : "borraría"} ${p.l.code} (${p.l.kind}, ${p.why})`);
    console.log("\nSimulación: no se ha tocado nada. Para hacerlo: --apply");
    return;
  }

  let moved = 0;
  let deleted = 0;
  let rolledBack = 0;
  let errors = 0;
  let done = 0;
  for (const p of plans) {
    if (p.action === "skip") continue;
    if (done >= limit) break;
    done++;
    const { l } = p;
    try {
      if (p.action === "delete") {
        await deleteCodeDiscount(l.id);
        deleted++;
        console.log(`✓ borrado ${l.code} (${p.why})`);
      } else {
        await deleteCodeDiscount(l.id);
        try {
          await addCouponCode(p.parent, l.code);
          const owner = await findCodeDiscountNodeId(l.code);
          if (owner !== p.parent) throw new Error(`tras el alta resuelve a ${owner ?? "nada"}`);
          moved++;
          console.log(`✓ movido ${l.code} (${l.kind}, ${p.why})`);
        } catch (err) {
          console.error(`✗ ${l.code}: falló el alta en el padre (${err instanceof Error ? err.message : err}); vuelvo a crear el suelto`);
          await recreate(l);
          const back = await findCodeDiscountNodeId(l.code);
          if (!back) throw new Error("la marcha atrás no ha dejado el código vivo: REVISAR A MANO");
          rolledBack++;
        }
      }
    } catch (err) {
      errors++;
      console.error(`✗ ${l.code}: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`\nHecho: movidos ${moved} · borrados ${deleted} · marcha atrás ${rolledBack} · errores ${errors}`);
  if (errors || rolledBack) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Comprobaciones previas de los referidos (fase 0). SOLO LECTURA.
 *
 * Uso (con el entorno de producción cargado: set -a; . ./.env.local; set +a):
 *   npx tsx scripts/referral-preflight.ts            # entorno, tablas y descuento padre
 *   npx tsx scripts/referral-preflight.ts --seal     # además: códigos puestos hoy en subs activas (lento: todo el libro)
 *
 * Lo que NO puede comprobar este script, y hay que mirar a mano:
 *   - En el admin de Seal, que el portal de cliente de Seal NO deja meter códigos de
 *     descuento. Seal aplica cualquier código puesto en una sub en cada cobro; si un
 *     cliente pudiera ponerse un código de amigo, sería un descuento permanente.
 */

import { runAsBackgroundJob } from "../src/lib/http-timeout";
import { isRewardCode, normalizeCode } from "../src/lib/referral-core";
import { FRIEND_DISCOUNT_TITLE } from "../src/lib/referral-shopify";
import { mapStatus, seal } from "../src/lib/seal";
import { shopifyAdmin } from "../src/lib/shopify-admin";
import { supabaseAdmin } from "../src/lib/supabase";

const withSeal = process.argv.includes("--seal");

function line(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  (${detail})` : ""}`);
}

async function main() {
  console.log("\n── Entorno (solo nombres, nunca valores) ──");
  for (const name of [
    "REFERRALS",
    "REFERRALS_ALLOWLIST",
    "REFERRAL_REWARDS",
    "REFERRAL_REWARDS_ALLOWLIST",
    "REFERRAL_FRIEND_DISCOUNT_ID",
    "REFERRAL_FINGERPRINT_SECRET",
    "REFERRAL_TERMS_URL",
    "CRON_SECRET",
  ]) {
    line(!!process.env[name], name, process.env[name] ? "definida" : "falta");
  }

  console.log("\n── Supabase ──");
  const sb = supabaseAdmin();
  for (const table of ["referral_codes", "referral_conversions", "referral_rewards"]) {
    const { data, error } = await sb.from(table).select("status").limit(5000);
    if (error) {
      line(false, table, error.message);
      continue;
    }
    const tally: Record<string, number> = {};
    for (const r of data ?? []) tally[r.status as string] = (tally[r.status as string] ?? 0) + 1;
    line(true, table, JSON.stringify(tally));
  }

  console.log("\n── Shopify: descuento padre ──");
  const parentId = process.env.REFERRAL_FRIEND_DISCOUNT_ID;
  if (!parentId) {
    line(false, "REFERRAL_FRIEND_DISCOUNT_ID", "sin definir: crear con scripts/referral-create-parent-discount.ts");
  } else {
    const data = await shopifyAdmin.graphql<{
      codeDiscountNode: {
        id: string;
        codeDiscount: {
          title?: string;
          status?: string;
          appliesOncePerCustomer?: boolean;
          usageLimit?: number | null;
          recurringCycleLimit?: number | null;
          codesCount?: { count: number } | null;
          customerGets?: { appliesOnOneTimePurchase: boolean; appliesOnSubscription: boolean };
        };
      } | null;
    }>(
      `query referralParent($id: ID!) {
        codeDiscountNode(id: $id) {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title status appliesOncePerCustomer usageLimit recurringCycleLimit
              codesCount { count }
              customerGets { appliesOnOneTimePurchase appliesOnSubscription }
            }
          }
        }
      }`,
      { id: parentId },
    );
    const d = data.codeDiscountNode?.codeDiscount;
    line(!!d, "existe", d ? `${d.title} · ${d.status}` : "no encontrado");
    if (d) {
      line(d.title === FRIEND_DISCOUNT_TITLE, "título");
      line(d.customerGets?.appliesOnOneTimePurchase === true, "vale en compra única");
      line(d.customerGets?.appliesOnSubscription === true, "vale en suscripción");
      line(d.appliesOncePerCustomer === true, "un uso por cliente");
      line(d.usageLimit === null || d.usageLimit === undefined, "sin tope total", String(d.usageLimit ?? "null"));
      line(d.recurringCycleLimit === 1, "solo el primer cobro de una suscripción", String(d.recurringCycleLimit));
      console.log(`  códigos colgados: ${d.codesCount?.count ?? "?"}`);
    }
  }

  if (withSeal) {
    console.log("\n── Seal: códigos puestos en subs activas (todo el libro) ──");
    const subs = await runAsBackgroundJob(() => seal.listAllSubscriptions());
    const active = subs.filter((s) => mapStatus(s) === "active");
    const byCode: Record<string, number> = {};
    for (const s of active) {
      const codes = new Set((s.items ?? []).flatMap((it) => (it.discount_codes ?? []).map((dc) => normalizeCode(dc.code))));
      for (const c of codes) {
        const key = isRewardCode(c) ? "LITREF-*" : c;
        byCode[key] = (byCode[key] ?? 0) + 1;
      }
    }
    console.log(`  subs activas: ${active.length}`);
    console.table(Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([code, subs]) => ({ code, subs })));
    console.log("  Un código de AMIGO (nombre + cifras) puesto en una sub sería una fuga: revisar.");
  }

  console.log("\n── A mano ──");
  console.log("  · Admin de Seal: el portal de cliente NO debe dejar meter códigos de descuento.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

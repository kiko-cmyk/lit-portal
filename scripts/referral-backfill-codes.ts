/**
 * Backfill de códigos personales para los suscriptores activos (referidos, fase 0).
 *
 * Dos pasos separados, cada uno con su OK:
 *   1. --reserve  reserva un código (fila `pending` en referral_codes) para cada
 *                 cliente con una suscripción ACTIVA en Seal que aún no tiene.
 *   2. --issue    da de alta en Shopify los `pending` (bulks de 250, en bucle
 *                 hasta que no quede ninguno) y sube `referral_code` al perfil
 *                 de Klaviyo de cada uno.
 *
 * Sin flags: cuenta y no toca nada.
 *
 * Uso (con el entorno de producción cargado: set -a; . ./.env.local; set +a):
 *   npx tsx scripts/referral-backfill-codes.ts
 *   npx tsx scripts/referral-backfill-codes.ts --reserve
 *   npx tsx scripts/referral-backfill-codes.ts --issue
 *   ... --only=123,456     solo esos clientes (la allowlist del E2E)
 *
 * Requiere REFERRAL_FRIEND_DISCOUNT_ID para --issue. Ignora el flag REFERRALS a
 * propósito: el alcance lo decide quien corre el script (con --only o sin él).
 */

import { runAsBackgroundJob } from "../src/lib/http-timeout";
import { ensurePendingCode, issuePendingCodes } from "../src/lib/referral-reward";
import { mapStatus, seal } from "../src/lib/seal";
import { shopifyAdmin } from "../src/lib/shopify-admin";
import { supabaseAdmin } from "../src/lib/supabase";

const args = process.argv.slice(2);
const reserve = args.includes("--reserve");
const issue = args.includes("--issue");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean) : null;

/**
 * Clientes de Shopify con al menos una sub ACTIVA en Seal, con su nombre de pila.
 *
 * OJO: el LISTADO de Seal (`/subscriptions`) NO trae `customer_id`; solo lo trae la
 * lectura de una sub suelta (medido el 2026-10-09: 0 de 3.533 en el listado). La
 * primera versión filtraba por ese campo y no encontraba a nadie. El cliente sale
 * del pedido de origen de cada sub (`order_id`), en tandas de 250 contra Shopify, y
 * si el pedido no lo da, de la sub suelta en Seal.
 */
async function activeCustomers(): Promise<Map<string, string | null>> {
  const subs = (await runAsBackgroundJob(() => seal.listAllSubscriptions())).filter((s) => mapStatus(s) === "active");
  const tail = (gid: string) => gid.split("/").pop() ?? gid;

  const byOrder = new Map<string, { customerId: string; firstName: string | null }>();
  const orderIds = [...new Set(subs.map((s) => String(s.order_id ?? "")).filter((id) => /^\d+$/.test(id)))];
  for (let i = 0; i < orderIds.length; i += 250) {
    const chunk = orderIds.slice(i, i + 250);
    const data = await runAsBackgroundJob(() =>
      shopifyAdmin.graphql<{ nodes: Array<{ id: string; customer: { id: string; firstName: string | null } | null } | null> }>(
        `query referralBackfillOrders($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id customer { id firstName } } } }`,
        { ids: chunk.map((id) => `gid://shopify/Order/${id}`) },
      ),
    );
    for (const n of data.nodes) {
      if (n?.id && n.customer?.id) byOrder.set(tail(n.id), { customerId: tail(n.customer.id), firstName: n.customer.firstName });
    }
  }

  const out = new Map<string, string | null>();
  let viaOrder = 0;
  let viaSeal = 0;
  let missing = 0;
  for (const s of subs) {
    const fromOrder = byOrder.get(String(s.order_id ?? ""));
    let customerId = fromOrder?.customerId ?? null;
    if (customerId) viaOrder++;
    else {
      const one = await runAsBackgroundJob(() => seal.getSubscriptionById(s.id, undefined, { throwTransient: true })).catch(
        () => null,
      );
      customerId = one?.customer_id ? String(one.customer_id) : null;
      if (customerId) viaSeal++;
      else missing++;
    }
    if (!customerId) continue;
    if (only && !only.includes(customerId)) continue;
    if (!out.has(customerId)) out.set(customerId, s.first_name || fromOrder?.firstName || null);
  }
  console.log(
    `Subs activas: ${subs.length} (cliente por su pedido: ${viaOrder}, por Seal: ${viaSeal}, sin cliente: ${missing})`,
  );
  return out;
}

async function main() {
  const sb = supabaseAdmin();

  if (!issue) {
    const customers = await activeCustomers();
    const { data: rows, error } = await sb.from("referral_codes").select("customer_id, status");
    if (error) throw new Error(error.message);
    const withRow = new Map((rows ?? []).map((r) => [r.customer_id as string, r.status as string]));
    const missing = [...customers.keys()].filter((id) => !withRow.has(id) || withRow.get(id) === "retired");
    console.log(`Clientes con suscripción activa: ${customers.size}`);
    console.log(`Sin código (o con el de prueba retirado): ${missing.length}`);
    if (!reserve) {
      console.log("\nNada tocado. Para reservarles código: --reserve");
      return;
    }
    let done = 0;
    for (const id of missing) {
      await ensurePendingCode(id, customers.get(id) ?? null);
      if (++done % 100 === 0) console.log(`  reservados ${done}/${missing.length}`);
    }
    console.log(`Reservados: ${done}. Siguiente paso: --issue`);
    return;
  }

  // --issue: en bucle hasta que no quede nada pendiente. Una bulk que Shopify aún
  // no ha terminado deja filas `pending` sin activar ni regenerar: eso NO es «ya
  // está», es «espera y vuelve a mirar». Solo se para cuando no queda nada, o tras
  // varias rondas seguidas sin avanzar (lo que quede lo recoge el cron).
  let round = 0;
  let stalled = 0;
  for (;;) {
    round++;
    const s = await runAsBackgroundJob(() =>
      issuePendingCodes({ max: 250, ignoreFlag: true, onlyCustomerIds: only ?? undefined }),
    );
    console.log(`ronda ${round}:`, s);
    const moved = s.activated + s.regenerated + s.disabled + s.failed;
    if (s.stillPending === 0 && moved === 0) break;
    stalled = moved === 0 ? stalled + 1 : 0;
    if (stalled >= 10) {
      console.log(`Diez rondas seguidas sin avanzar con ${s.stillPending} pendientes: se para (el cron las recoge).`);
      break;
    }
    if (round >= 200) {
      console.log("Corte de seguridad tras 200 rondas.");
      break;
    }
    if (moved === 0) await new Promise((r) => setTimeout(r, 3000));
  }
  const { data: stats } = await sb.from("referral_codes").select("status");
  const tally: Record<string, number> = {};
  for (const r of stats ?? []) tally[r.status as string] = (tally[r.status as string] ?? 0) + 1;
  console.log("referral_codes por estado:", tally);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Backfill `box_shipped` Drops for historical subscription fulfilments.
 *
 * WHY: the fulfillments/create webhook read the fulfilment off the wrong payload
 * key from launch until PR #22, so NO `box_shipped` Drops were ever awarded
 * (prod: thousands of fulfilments processed, 0 box_shipped). PR #22 fixed it
 * going forward. This one-off credits the past.
 *
 * PHASE 2 — DORMANT. Running this is a PRODUCT decision (do we retroactively
 * credit historical boxes when Drops launches in September?). It is NOT run
 * automatically and is NOT wired to anything.
 *
 * SAFETY / IDEMPOTENCY
 *  - Dry-run by DEFAULT. Pass `--apply` to actually write.
 *  - Every award is keyed `box_shipped:<numericFulfillmentId>:<boxIndex>`, the
 *    EXACT scheme the live webhook uses (lib/drops.awardDrops + webhooks/shopify).
 *    Writes are UPSERT ON CONFLICT (dedup_key) DO NOTHING, so re-running is safe
 *    and it will never double-credit a fulfilment the live webhook already did.
 *  - Same gating as the webhook: only ORDER line items WITH a selling plan count
 *    as boxes (skips B2B / one-time / extras). 0 subscription lines → skip.
 *
 * ⚠️ TOKEN SCOPE: the Portal Admin token does NOT return orders older than 60
 * days (no read_all_orders). For a FULL-history backfill set SHOPIFY_ADMIN_TOKEN
 * to the Theme App token (which has read_all_orders). See memory
 * feedback_read_all_orders_scope. With the Portal token you only backfill ~60d.
 *
 * ⚠️ Take a DB dump before `--apply` (Supabase portal is Free / no PITR — see
 * memory reference_supabase_portal_free_no_backups).
 *
 * USAGE
 *   node scripts/backfill-box-shipped-drops.mjs                 # dry-run, all pages
 *   node scripts/backfill-box-shipped-drops.mjs --max-pages 1   # dry-run, 1 page (smoke test)
 *   node scripts/backfill-box-shipped-drops.mjs --apply         # WRITE (after a dump + go)
 */
import { config } from "dotenv";
import { Client } from "pg";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const APPLY = process.argv.includes("--apply");
const MAX_PAGES = (() => {
  const i = process.argv.indexOf("--max-pages");
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : Infinity;
})();

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2026-04";
if (!STORE || !TOKEN) throw new Error("SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN required in .env.local");

const BOX_AMOUNT = 100; // DROPS_AMOUNTS.box_shipped

// ---- pg (session pooler, same parse as scripts/check-db.mjs) ----
const url = process.env.DATABASE_URL;
const stripped = url.replace(/^postgres(ql)?:\/\//, "");
const lastAt = stripped.lastIndexOf("@");
const userPass = stripped.slice(0, lastAt);
const firstColon = userPass.indexOf(":");
const pg = new Client({
  user: userPass.slice(0, firstColon),
  password: userPass.slice(firstColon + 1),
  host: "aws-0-eu-west-1.pooler.supabase.com",
  port: 5432,
  database: "postgres",
  ssl: { rejectUnauthorized: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shopify(query, variables) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const json = await res.json();
    if (json.errors) {
      const throttled = JSON.stringify(json.errors).includes("THROTTLED");
      if (throttled) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error("Shopify GraphQL errors: " + JSON.stringify(json.errors).slice(0, 500));
    }
    return json.data;
  }
  throw new Error("Shopify: giving up after repeated throttling");
}

const ORDERS_QUERY = `
  query backfillOrders($cursor: String) {
    orders(first: 50, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        createdAt
        customer { id }
        lineItems(first: 100) { nodes { quantity sellingPlan { name } } }
        fulfillments(first: 20) { id }
      }
    }
  }`;

async function main() {
  await pg.connect();
  console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}  maxPages=${MAX_PAGES}`);
  console.log(`Store: ${STORE}  api ${API_VERSION}`);

  let cursor = null, page = 0;
  let ordersSeen = 0, subOrders = 0, fulfilments = 0, plannedAwards = 0, plannedDrops = 0;
  let alreadyPresent = 0, written = 0;
  const customers = new Set();

  do {
    const data = await shopify(ORDERS_QUERY, { cursor });
    const conn = data.orders;
    page++;
    for (const o of conn.nodes) {
      ordersSeen++;
      const customerGid = o.customer?.id;
      if (!customerGid) continue;
      const customerId = customerGid.replace(/^gid:\/\/shopify\/Customer\//, "");
      const boxes = (o.lineItems?.nodes ?? [])
        .filter((li) => li.sellingPlan)
        .reduce((s, li) => s + (li.quantity ?? 0), 0);
      if (boxes === 0) continue; // B2B / one-time / extras-only
      subOrders++;
      for (const ful of o.fulfillments ?? []) {
        fulfilments++;
        const fid = String(ful.id).replace(/^gid:\/\/shopify\/Fulfillment\//, "");
        for (let i = 0; i < boxes; i++) {
          const dedupKey = `box_shipped:${fid}:${i}`;
          plannedAwards++;
          plannedDrops += BOX_AMOUNT;
          customers.add(customerId);
          if (APPLY) {
            const r = await pg.query(
              `insert into drops_events (customer_id, action, amount, metadata, dedup_key)
               values ($1,'box_shipped',$2,$3,$4)
               on conflict (dedup_key) do nothing`,
              [customerId, BOX_AMOUNT, JSON.stringify({ fulfillmentId: fid, boxIndex: i, backfill: true }), dedupKey],
            );
            if (r.rowCount === 1) written++; else alreadyPresent++;
          } else {
            const r = await pg.query("select 1 from drops_events where dedup_key=$1", [dedupKey]);
            if (r.rowCount) alreadyPresent++;
          }
        }
      }
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    console.log(`  page ${page}: orders=${ordersSeen} subOrders=${subOrders} fulfilments=${fulfilments} plannedAwards=${plannedAwards}`);
    await sleep(600); // be gentle on the Admin rate limit
  } while (cursor && page < MAX_PAGES);

  console.log("\n==== SUMMARY ====");
  console.log(`Orders scanned:          ${ordersSeen}`);
  console.log(`Subscription orders:     ${subOrders}`);
  console.log(`Fulfilments (sub):       ${fulfilments}`);
  console.log(`Distinct customers:      ${customers.size}`);
  console.log(`Box awards planned:      ${plannedAwards}  (= ${plannedDrops} drops @${BOX_AMOUNT})`);
  console.log(`Already in drops_events: ${alreadyPresent}`);
  if (APPLY) console.log(`Newly written:           ${written}`);
  else console.log(`Would newly write:       ${plannedAwards - alreadyPresent}`);
  if (cursor) console.log(`\n(stopped at page limit — more pages remain)`);
  await pg.end();
}

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

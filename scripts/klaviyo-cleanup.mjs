/**
 * List + dedupe LIT confirmation templates.
 *
 * Lists all confirmation-related templates; keeps the most recently updated
 * pair (EN + ES); deletes the rest.
 *
 * Usage:
 *   node scripts/klaviyo-cleanup.mjs        # list only
 *   node scripts/klaviyo-cleanup.mjs --delete # delete obsolete duplicates
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
const REVISION = "2024-10-15";
const SHOULD_DELETE = process.argv.includes("--delete");

const all = [];
let cursor = null;
do {
  const url = new URL("https://a.klaviyo.com/api/templates/");
  url.searchParams.set("page[size]", "10");
  if (cursor) url.searchParams.set("page[cursor]", cursor);
  const r = await fetch(url, {
    headers: {
      Authorization: `Klaviyo-API-Key ${KEY}`,
      revision: REVISION,
      accept: "application/vnd.api+json",
    },
  });
  if (!r.ok) {
    console.error("HTTP", r.status, await r.text());
    process.exit(1);
  }
  const data = await r.json();
  all.push(...(data.data || []));
  cursor = data.links?.next ? new URL(data.links.next).searchParams.get("page[cursor]") : null;
} while (cursor);

console.log(`Total: ${all.length} templates\n`);

const lit = all
  .filter((t) => (t.attributes?.name || "").startsWith("LIT — Confirmation Email"))
  .sort((a, b) => (b.attributes?.updated || "").localeCompare(a.attributes?.updated || ""));

console.log("LIT confirmation templates (sorted by most recent):");
for (const t of lit) {
  console.log(`  id=${t.id.padEnd(8)} updated=${(t.attributes?.updated || "?").slice(0, 19)}  name='${t.attributes?.name}'`);
}

// Identify keepers: most recent EN + most recent ES
const keepEn = lit.find((t) => t.attributes?.name?.endsWith("EN"));
const keepEs = lit.find((t) => t.attributes?.name?.endsWith("ES"));
const keepers = new Set([keepEn, keepEs].filter(Boolean).map((t) => t.id));
const toDelete = lit.filter((t) => !keepers.has(t.id));

console.log(`\nKeeping: ${[...keepers].join(", ")}`);
console.log(`Would delete: ${toDelete.length} duplicate(s)`);

if (!SHOULD_DELETE) {
  console.log("\n(dry run — pass --delete to actually delete duplicates)");
  process.exit(0);
}

for (const t of toDelete) {
  const r = await fetch(`https://a.klaviyo.com/api/templates/${t.id}/`, {
    method: "DELETE",
    headers: {
      Authorization: `Klaviyo-API-Key ${KEY}`,
      revision: REVISION,
      accept: "application/vnd.api+json",
    },
  });
  if (r.ok || r.status === 204) {
    console.log(`✓ Deleted ${t.id} (${t.attributes?.name})`);
  } else {
    console.error(`✗ Failed to delete ${t.id}: ${r.status} ${await r.text()}`);
  }
}

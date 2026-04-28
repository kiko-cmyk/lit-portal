/**
 * One-shot: wipe legacy tables (from prior plan) and apply fresh schema.
 * Safe because the Supabase project never received real customer data.
 */
import { config } from "dotenv";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const url = process.env.DATABASE_URL;
const stripped = url.replace(/^postgres(ql)?:\/\//, "");
const lastAt = stripped.lastIndexOf("@");
const userPass = stripped.slice(0, lastAt);
const firstColon = userPass.indexOf(":");
const user = userPass.slice(0, firstColon);
const password = userPass.slice(firstColon + 1);

const cfg = {
  user,
  password,
  host: "aws-0-eu-west-1.pooler.supabase.com",
  port: 5432, // session pooler — full DDL transaction support
  database: "postgres",
  ssl: { rejectUnauthorized: false },
};

const c = new Client(cfg);
await c.connect();
console.log("Connected.");

console.log("\n=== Step 1: drop legacy tables from previous plan ===");
const legacyTables = [
  "auth_tokens",
  "content_access_log",
  "content_items",
  "rewards_balances",
  "rewards_events",
  "rewards_tiers",
  "referral_codes",
  "referral_conversions",
];
for (const t of legacyTables) {
  await c.query(`drop table if exists "${t}" cascade`);
  console.log(`  dropped: ${t}`);
}

console.log("\n=== Step 2: apply fresh schema ===");
const sql = readFileSync(resolve(process.cwd(), "database/schema.sql"), "utf-8");
await c.query(sql);
console.log("✓ Schema applied");

console.log("\n=== Step 3: list tables present ===");
const r = await c.query(
  "select tablename from pg_tables where schemaname='public' order by tablename",
);
console.log(`${r.rows.length} tables:`);
r.rows.forEach((row) => console.log(`  - ${row.tablename}`));

await c.end();
console.log("\nDone.");

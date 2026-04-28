/**
 * Apply database/seed.sql with placeholder content for events / moments / stories.
 * Idempotent? NO — re-running duplicates rows. Run once on a fresh DB.
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

const c = new Client({
  user,
  password,
  host: "aws-0-eu-west-1.pooler.supabase.com",
  port: 5432,
  database: "postgres",
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const sql = readFileSync(resolve(process.cwd(), "database/seed.sql"), "utf-8");
await c.query(sql);

const counts = await c.query(`
  select 'events' as t, count(*)::int as c from events
  union all select 'moments', count(*)::int from moments
  union all select 'stories', count(*)::int from stories
`);
console.log("Seed applied:");
counts.rows.forEach((r) => console.log(`  - ${r.t}: ${r.c}`));

await c.end();

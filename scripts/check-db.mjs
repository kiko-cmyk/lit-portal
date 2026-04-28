import { config } from "dotenv";
import { Client } from "pg";
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
const r = await c.query("select tablename from pg_tables where schemaname='public' order by tablename");
console.log(`Tables present: ${r.rows.length}`);
r.rows.forEach((row) => console.log("  -", row.tablename));
if (r.rows.find((x) => x.tablename === "referral_conversions")) {
  const cols = await c.query(
    "select column_name from information_schema.columns where table_name='referral_conversions' and table_schema='public'"
  );
  console.log("referral_conversions columns:", cols.rows.map((x) => x.column_name));
}
await c.end();

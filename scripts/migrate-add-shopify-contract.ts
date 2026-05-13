/**
 * Adds shopify_contract_id column to subscriptions table.
 * One-off migration for Phase B.2 of the 2026-05-13 cleanup plan.
 */

import { resolve } from "node:path";
import { config } from "dotenv";
import { Client, type ClientConfig } from "pg";

config({ path: resolve(process.cwd(), ".env.local") });

function parseConnectionUrl(url: string): ClientConfig {
  const stripped = url.replace(/^postgres(ql)?:\/\//, "");
  const lastAt = stripped.lastIndexOf("@");
  const userPass = stripped.slice(0, lastAt);
  const hostPart = stripped.slice(lastAt + 1);
  const firstColon = userPass.indexOf(":");
  const user = userPass.slice(0, firstColon);
  const password = userPass.slice(firstColon + 1);
  const slashIdx = hostPart.indexOf("/");
  const hostPort = slashIdx === -1 ? hostPart : hostPart.slice(0, slashIdx);
  const dbWithParams = slashIdx === -1 ? "" : hostPart.slice(slashIdx + 1);
  const [database] = dbWithParams.split("?");
  const [host, portStr] = hostPort.split(":");
  return {
    host,
    port: portStr ? parseInt(portStr, 10) : 5432,
    user: decodeURIComponent(user),
    password,
    database: database || "postgres",
    ssl: host.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
  };
}

const SQL = `
  alter table subscriptions
    add column if not exists shopify_contract_id text;
  create index if not exists idx_subscriptions_contract
    on subscriptions(shopify_contract_id);
`;

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const cfg = parseConnectionUrl(dbUrl);
  if (cfg.port === 6543) cfg.port = 5432; // session pooler for DDL

  const client = new Client(cfg);
  console.log(`Connecting to ${cfg.host}:${cfg.port}/${cfg.database}...`);
  await client.connect();
  try {
    await client.query(SQL);
    console.log("✓ Migration applied");
    const { rows } = await client.query(
      `select column_name from information_schema.columns
       where table_name = 'subscriptions' order by ordinal_position;`,
    );
    console.log("subscriptions columns:");
    rows.forEach((r) => console.log(`  - ${r.column_name}`));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

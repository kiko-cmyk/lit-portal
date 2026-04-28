/**
 * Run database/schema.sql against the Supabase Postgres instance.
 *
 * Usage:
 *   npm run migrate         # uses DATABASE_URL from .env.local
 *   npm run migrate -- --dry  # prints SQL without executing
 *
 * Requires DATABASE_URL in .env.local. Get it from Supabase dashboard:
 *   Project Settings → Database → Connection string → URI mode
 *   (use the pooled "Transaction" string for IPv4 compatibility)
 *
 * The DATABASE_URL parser is tolerant — it accepts passwords with special
 * characters (*, %, +, !, &, etc.) without requiring URL-encoding.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { Client, type ClientConfig } from "pg";

config({ path: resolve(process.cwd(), ".env.local") });

const SCHEMA_PATH = resolve(process.cwd(), "database/schema.sql");
const DRY_RUN = process.argv.includes("--dry");

/**
 * Tolerant parser for `postgres://user:password@host:port/database`.
 * The password may contain *, %, +, !, &, etc. without URL-encoding.
 *
 * Strategy: split on the LAST `@` (host part can never contain `@`),
 * then on the FIRST `:` of the user:password portion (username can't have `:`).
 */
function parseConnectionUrl(url: string): ClientConfig {
  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) {
    throw new Error(`Not a postgres URL: ${url.slice(0, 40)}...`);
  }
  const stripped = url.replace(/^postgres(ql)?:\/\//, "");
  const lastAt = stripped.lastIndexOf("@");
  if (lastAt === -1) throw new Error("DATABASE_URL missing @host");

  const userPass = stripped.slice(0, lastAt);
  const hostPart = stripped.slice(lastAt + 1);

  const firstColon = userPass.indexOf(":");
  if (firstColon === -1) throw new Error("DATABASE_URL missing user:password");
  const user = userPass.slice(0, firstColon);
  const password = userPass.slice(firstColon + 1);

  // host:port/database[?params]
  const slashIdx = hostPart.indexOf("/");
  const hostPort = slashIdx === -1 ? hostPart : hostPart.slice(0, slashIdx);
  const dbWithParams = slashIdx === -1 ? "" : hostPart.slice(slashIdx + 1);
  const [database] = dbWithParams.split("?");

  const [host, portStr] = hostPort.split(":");
  const port = portStr ? parseInt(portStr, 10) : 5432;

  return {
    host,
    port,
    user: decodeURIComponent(user), // user is usually safe, but decode for safety
    password,                        // raw — already extracted, no decode needed
    database: database || "postgres",
    ssl: host.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
  };
}

function redactConfig(cfg: ClientConfig): string {
  return `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database} (password ****)`;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: DATABASE_URL not set in .env.local");
    console.error("Get it from Supabase: Project Settings → Database → Connection string → Transaction pooler");
    process.exit(1);
  }

  const cfg = parseConnectionUrl(dbUrl);

  // For schema migrations, force port 5432 (session pooler / direct).
  // The transaction pooler on 6543 splits multi-statement queries across
  // pooled connections, which breaks DDL scripts that depend on prior CREATE
  // TABLE within the same script (e.g. CREATE INDEX referencing the new table).
  if (cfg.port === 6543 && cfg.host?.includes("pooler.supabase.com")) {
    console.log(`Switching from transaction pooler (6543) to session pooler (5432) for DDL safety`);
    cfg.port = 5432;
  }

  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  console.log(`Loaded schema: ${sql.split("\n").length} lines, ${sql.length} bytes`);

  if (DRY_RUN) {
    console.log("--- DRY RUN — SQL would be executed against:");
    console.log(redactConfig(cfg));
    process.exit(0);
  }

  const client = new Client(cfg);

  console.log(`Connecting to ${redactConfig(cfg)}...`);
  await client.connect();

  try {
    console.log("Executing schema...");
    await client.query(sql);
    console.log("✓ Schema applied successfully");

    const { rows } = await client.query(`
      select tablename from pg_tables
       where schemaname = 'public'
       order by tablename;
    `);
    console.log(`\n✓ ${rows.length} tables in public schema:`);
    rows.forEach((r) => console.log(`  - ${r.tablename}`));
  } catch (err) {
    console.error("✗ Migration failed:");
    console.error(err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

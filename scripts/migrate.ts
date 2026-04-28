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
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { Client } from "pg";

config({ path: resolve(process.cwd(), ".env.local") });

const SCHEMA_PATH = resolve(process.cwd(), "database/schema.sql");
const DRY_RUN = process.argv.includes("--dry");

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: DATABASE_URL not set in .env.local");
    console.error("Get it from Supabase: Project Settings → Database → Connection string → URI");
    process.exit(1);
  }

  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  console.log(`Loaded schema: ${sql.split("\n").length} lines, ${sql.length} bytes`);

  if (DRY_RUN) {
    console.log("--- DRY RUN — SQL would be executed against:");
    console.log(redactDbUrl(dbUrl));
    process.exit(0);
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
  });

  console.log(`Connecting to ${redactDbUrl(dbUrl)}...`);
  await client.connect();

  try {
    console.log("Executing schema...");
    await client.query(sql);
    console.log("✓ Schema applied successfully");

    // Verify a few key tables exist
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

function redactDbUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":****@");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

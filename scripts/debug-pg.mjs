import { config } from "dotenv";
import { Client } from "pg";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const url = process.env.DATABASE_URL;
console.log("URL length:", url.length);

const stripped = url.replace(/^postgres(ql)?:\/\//, "");
const lastAt = stripped.lastIndexOf("@");
const userPass = stripped.slice(0, lastAt);
const hostPart = stripped.slice(lastAt + 1);
const firstColon = userPass.indexOf(":");
const user = userPass.slice(0, firstColon);
const password = userPass.slice(firstColon + 1);
const slashIdx = hostPart.indexOf("/");
const hostPort = slashIdx === -1 ? hostPart : hostPart.slice(0, slashIdx);
const dbName = (slashIdx === -1 ? "" : hostPart.slice(slashIdx + 1)).split("?")[0] || "postgres";
const [host, portStr] = hostPort.split(":");
const port = portStr ? parseInt(portStr, 10) : 5432;

console.log({ user, host, port, dbName, passLen: password.length });

async function tryConn(name, cfg) {
  const c = new Client(cfg);
  try {
    await c.connect();
    const r = await c.query("select current_user, current_database()");
    console.log(`✅ ${name}:`, r.rows[0]);
    await c.end();
    return true;
  } catch (e) {
    console.log(`❌ ${name}:`, e.message);
    try { await c.end(); } catch {}
    return false;
  }
}

console.log("\n=== Test 1: my parser, ssl rejectUnauthorized=false ===");
await tryConn("parsed-config", { user, password, host, port, database: dbName, ssl: { rejectUnauthorized: false } });

console.log("\n=== Test 2: raw connectionString ===");
await tryConn("connstr", { connectionString: url, ssl: { rejectUnauthorized: false } });

console.log("\n=== Test 3: SESSION pooler (port 5432) ===");
await tryConn("session-pooler", { user, password, host, port: 5432, database: dbName, ssl: { rejectUnauthorized: false } });

console.log("\n=== Test 4: just user 'postgres' (no projectref suffix) ===");
await tryConn("user-postgres-only", { user: "postgres", password, host, port, database: dbName, ssl: { rejectUnauthorized: false } });

console.log("\n=== Test 5: REST API check (proves project+key valid) ===");
const restUrl = process.env.SUPABASE_URL + "/rest/v1/";
const r = await fetch(restUrl, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY } });
console.log("REST API HTTP:", r.status);
if (r.status !== 200) console.log("body:", (await r.text()).slice(0, 200));

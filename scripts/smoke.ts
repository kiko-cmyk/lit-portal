/**
 * Read-only smoke test for the LIT Portal.
 *
 * Purpose: a fast "did I white-screen the área personal?" canary, NOT a full
 * test suite. It only ever issues GETs and never touches a mutation route, so
 * it is safe to run against a Vercel preview (which uses PRODUCTION data).
 *
 * Usage:
 *   SMOKE_API_BASE=http://localhost:3000/api npm run smoke
 *   SMOKE_API_BASE=https://lit-portal-drab.vercel.app/api \
 *     HEALTH_READY_TOKEN=... npm run smoke
 *
 * Env:
 *   SMOKE_API_BASE        API base incl. proxy prefix. Default http://localhost:3000/api
 *                         (prod via App Proxy: https://litsalt.com/apps/portal/api)
 *   HEALTH_READY_TOKEN    if set, also probes /health/ready (deep deps check)
 *   SMOKE_DEV_CUSTOMER    Shopify customer GID — enables the local __dev flow checks
 *   SMOKE_DEV_EMAIL       email for the same test customer (e.g. juan@litsalt.com)
 *   SMOKE_EXPECT_SEAL_SUB optional — asserts /subscription returns this sealSubscriptionId
 *
 * The __dev_* flow checks only work where the bypass is enabled
 * (NODE_ENV==="development" AND, after Lote 2, ALLOW_DEV_BYPASS=1), i.e. local dev.
 */

const API_BASE = process.env.SMOKE_API_BASE ?? "http://localhost:3000/api";
const READY_TOKEN = process.env.HEALTH_READY_TOKEN;
const DEV_CUSTOMER = process.env.SMOKE_DEV_CUSTOMER;
const DEV_EMAIL = process.env.SMOKE_DEV_EMAIL;
const EXPECT_SEAL_SUB = process.env.SMOKE_EXPECT_SEAL_SUB;

let failures = 0;
const results: string[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function getJson(
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "user-agent": "lit-portal-smoke" },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log(`Smoke test against ${API_BASE}\n`);

  // 1. Shallow health — must always be 200/ok.
  try {
    const { status, body } = await getJson("/health");
    const ok = status === 200 && (body as { ok?: boolean })?.ok === true;
    record("GET /health → 200 ok", ok, `status=${status}`);
  } catch (e) {
    record("GET /health", false, (e as Error).message);
  }

  // 2. Deep readiness (only if a token is provided).
  if (READY_TOKEN) {
    try {
      const { status, body } = await getJson(
        `/health/ready?token=${encodeURIComponent(READY_TOKEN)}`,
      );
      const checks = (body as { checks?: Record<string, { ok: boolean }> })?.checks ?? {};
      const allOk = status === 200 && Object.values(checks).every((c) => c.ok);
      const summary = Object.entries(checks)
        .map(([k, v]) => `${k}:${v.ok ? "ok" : "FAIL"}`)
        .join(" ");
      record("GET /health/ready → 200 all deps ok", allOk, `status=${status} ${summary}`);
    } catch (e) {
      record("GET /health/ready", false, (e as Error).message);
    }
  } else {
    results.push("• /health/ready skipped (no HEALTH_READY_TOKEN)");
  }

  // 3. Negative auth — a customer-scoped GET with no auth must be 401.
  try {
    const { status } = await getJson("/subscription");
    record("GET /subscription (no auth) → 401", status === 401, `status=${status}`);
  } catch (e) {
    record("GET /subscription (no auth)", false, (e as Error).message);
  }

  // 4. Local __dev flow checks (read-only): subscription + hub dashboard.
  if (DEV_CUSTOMER && DEV_EMAIL) {
    const devQs = `__dev_customer=${encodeURIComponent(DEV_CUSTOMER)}&__dev_email=${encodeURIComponent(DEV_EMAIL)}`;
    try {
      const { status, body } = await getJson(`/subscription?${devQs}`);
      const sealId = (body as { sealSubscriptionId?: string })?.sealSubscriptionId;
      let ok = status === 200 && !!sealId;
      let detail = `status=${status} sealSubscriptionId=${sealId ?? "—"}`;
      if (ok && EXPECT_SEAL_SUB) {
        ok = String(sealId) === String(EXPECT_SEAL_SUB);
        detail += ` (expected ${EXPECT_SEAL_SUB})`;
      }
      record("GET /subscription (dev) → 200 + sub", ok, detail);
    } catch (e) {
      record("GET /subscription (dev)", false, (e as Error).message);
    }

    try {
      const { status, body } = await getJson(`/hub/dashboard?${devQs}`);
      const hasSub = !!(body as { subscription?: unknown })?.subscription;
      record("GET /hub/dashboard (dev) → 200 + subscription", status === 200 && hasSub, `status=${status}`);
    } catch (e) {
      record("GET /hub/dashboard (dev)", false, (e as Error).message);
    }
  } else {
    results.push("• __dev flow checks skipped (set SMOKE_DEV_CUSTOMER + SMOKE_DEV_EMAIL, local only)");
  }

  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Fire-and-forget Slack alert for unexpected server errors (5xx).
 *
 * Wired into the single exception chokepoint in `withCustomer`
 * (`api-helpers.ts`). Before this, a bad deploy surfaced only via
 * customer complaints hours later; now Slack pings within seconds.
 *
 * Design constraints (audit/safety-net 2026-06-30):
 *  - No-op when no webhook env var is set → local dev / preview never post.
 *  - Never throw / never block the customer response (own try/catch, not awaited).
 *  - Crons must use {@link alertSlackErrorAwaited}: fire-and-forget only survives
 *    because a request handler stays alive after responding. A cron that alerts and
 *    then throws hands control straight back to the runtime, which can freeze the
 *    invocation with the POST still pending — the alert never leaves the box.
 *  - In-memory dedupe: identical (path, code) posts at most once / 60s so a
 *    broken deploy can't spam thousands of messages. Resets on cold start
 *    (acceptable — a cold start is itself a low-frequency event).
 *  - PII discipline: only `customerId` (needed for tracing), never email/stack.
 */

const DEDUPE_MS = 60_000;
const lastSent = new Map<string, number>();

export interface ErrorAlert {
  path: string;
  code: string;
  msg: string;
  customerId?: string;
}

export function alertSlackError(alert: ErrorAlert): void {
  // Fire-and-forget. A Slack outage must never affect the customer response.
  void postAlert(alert);
}

/**
 * Same alert, but awaited — for callers with nothing after them keeping the
 * invocation alive (crons, and any path that alerts and then throws).
 * Still never throws: a Slack failure is swallowed like in the void variant.
 */
export async function alertSlackErrorAwaited(alert: ErrorAlert): Promise<void> {
  await postAlert(alert);
}

async function postAlert(alert: ErrorAlert): Promise<void> {
  const url =
    process.env.SLACK_ALERTS_WEBHOOK_URL || process.env.SLACK_SECURITY_WEBHOOK_URL;
  if (!url) return;

  const key = `${alert.path}|${alert.code}`;
  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < DEDUPE_MS) return;
  lastSent.set(key, now);

  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "?";
  const region = process.env.VERCEL_REGION ?? "?";
  const text =
    `:rotating_light: *lit-portal* \`${alert.code}\` on \`${alert.path}\`` +
    (alert.customerId ? ` · customer ${alert.customerId}` : "") +
    `\n> ${alert.msg.slice(0, 300)}` +
    `\ncommit \`${commit}\` · region \`${region}\``;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.warn("[alert] slack post failed:", e);
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { alertSlackError } from "@/lib/alert";
import { enforceRateLimit } from "@/lib/rate-limit";

/**
 * POST /apps/portal/api/client-error
 *
 * Best-effort sink for CLIENT-side React render crashes. The error boundaries
 * ([locale]/error.tsx, global-error.tsx) POST here when they catch, so a crash
 * that only happens in the customer's browser — which the server otherwise
 * never sees — surfaces in the same Slack channel as server 5xx (via
 * alertSlackError). Purely observability; it never affects the customer.
 *
 * Public on purpose: a crash can happen pre-login (e.g. on the login screen),
 * so we can't gate on withCustomer. Abuse is contained by (a) an IP rate limit
 * and (b) alertSlackError's own 60s (path|code) dedupe, plus hard truncation.
 * Always returns 202 and never throws — a telemetry endpoint must not become a
 * new source of errors.
 */
export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  try {
    await enforceRateLimit(`ip:${ip}`, "client-error", { limit: 20, windowMs: 60_000 });
  } catch {
    // Over the limit (429): drop silently. The limiter fails open on infra
    // blips, so a throw here means genuine flooding.
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    message?: unknown;
    digest?: unknown;
    path?: unknown;
    userAgent?: unknown;
  };
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

  const message = str(body.message, 300) || "(no message)";
  const digest = str(body.digest, 40);
  const path = str(body.path, 200) || "(unknown path)";
  const ua = str(body.userAgent, 200);

  // Reuses the same Slack webhook + dedupe + PII discipline as server 5xx.
  alertSlackError({
    path,
    code: "client_error",
    msg: `${message}${digest ? ` [digest ${digest}]` : ""}${ua ? ` · UA: ${ua}` : ""}`,
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}

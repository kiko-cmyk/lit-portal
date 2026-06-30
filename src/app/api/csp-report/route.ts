import { NextResponse, type NextRequest } from "next/server";

/**
 * CSP violation report collector.
 *
 * The CSP ships **Report-Only** first (see next.config.ts). Without somewhere
 * to send violations, the reports only land in each visitor's console and we
 * can't observe real traffic before enforcing. This endpoint receives them,
 * logs one compact line to the server logs (Vercel), and always returns 204.
 *
 * Accepts both report formats:
 *   - legacy `application/csp-report` → `{ "csp-report": { ... } }`
 *   - Reporting-API `application/reports+json` → `[{ type, body: { ... } }]`
 *
 * Public + unauthenticated by necessity: the browser posts these on its own,
 * with no session, and the `report-uri` points at the Vercel origin directly
 * (not through the App Proxy) so reports arrive even on cross-origin pages.
 * It ONLY logs — no DB writes, no side effects. An in-memory dedupe keeps a
 * broken policy from flooding the logs, and oversized bodies are dropped.
 */
export const runtime = "nodejs";

const MAX_BODY = 16 * 1024; // drop oversized payloads (abuse / junk)
const DEDUPE_MS = 60_000;
const lastSeen = new Map<string, number>();

function shouldLog(key: string, now: number): boolean {
  const prev = lastSeen.get(key);
  if (prev && now - prev < DEDUPE_MS) return false;
  lastSeen.set(key, now);
  if (lastSeen.size > 200) {
    for (const [k, t] of lastSeen) if (now - t > DEDUPE_MS) lastSeen.delete(k);
  }
  return true;
}

function logViolation(
  d: { directive?: string; blocked?: string; doc?: string },
  now: number,
): void {
  const directive = d.directive ?? "?";
  const blocked = (d.blocked ?? "?").slice(0, 200);
  if (!shouldLog(`${directive}|${blocked}`, now)) return;
  console.warn(
    "[csp-report]",
    JSON.stringify({ directive, blocked, doc: (d.doc ?? "?").slice(0, 200) }),
  );
}

interface LegacyCspReport {
  "violated-directive"?: string;
  "effective-directive"?: string;
  "blocked-uri"?: string;
  "document-uri"?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const raw = await req.text();
    if (!raw || raw.length > MAX_BODY) return new NextResponse(null, { status: 204 });
    const now = Date.now();
    const parsed: unknown = JSON.parse(raw);

    if (parsed && typeof parsed === "object" && "csp-report" in parsed) {
      // legacy application/csp-report
      const r = ((parsed as Record<string, unknown>)["csp-report"] ?? {}) as LegacyCspReport;
      logViolation(
        {
          directive: r["effective-directive"] ?? r["violated-directive"],
          blocked: r["blocked-uri"],
          doc: r["document-uri"],
        },
        now,
      );
    } else if (Array.isArray(parsed)) {
      // modern application/reports+json
      for (const item of parsed) {
        const b = (item?.body ?? {}) as Record<string, string>;
        logViolation(
          {
            directive: b.effectiveDirective ?? b.violatedDirective,
            blocked: b.blockedURL ?? b.blockedUri,
            doc: b.documentURL ?? b.documentUri,
          },
          now,
        );
      }
    }
  } catch {
    // Malformed report — ignore. A report endpoint must never error.
  }
  return new NextResponse(null, { status: 204 });
}

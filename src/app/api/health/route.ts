import { NextResponse } from "next/server";

// GET /apps/portal/api/health  — public, unauthenticated. For uptime probes.
export function GET() {
  return NextResponse.json({
    ok: true,
    service: "lit-portal",
    timestamp: new Date().toISOString(),
  });
}

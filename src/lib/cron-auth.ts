/**
 * Cron endpoint auth — Vercel Cron sets `Authorization: Bearer <CRON_SECRET>`
 * automatically. Endpoints check this to reject external callers.
 *
 * Set `CRON_SECRET` env var in Vercel project settings; same value is
 * automatically passed by Vercel Cron when it invokes the endpoint.
 */

import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export class CronAuthError extends Error {
  constructor() {
    super("Unauthorized cron call");
    this.name = "CronAuthError";
  }
}

export function requireCron(req: NextRequest): void {
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // In dev, allow without secret. In production, refuse.
    if (process.env.NODE_ENV === "production") throw new CronAuthError();
    return;
  }
  const presented = authHeader ?? "";
  const want = `Bearer ${expected}`;
  // Constant-time compare so the secret can't be recovered byte-by-byte via
  // response timing. Length guard first (timingSafeEqual throws on mismatch).
  const a = Buffer.from(presented);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CronAuthError();
}

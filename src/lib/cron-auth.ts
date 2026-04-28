/**
 * Cron endpoint auth — Vercel Cron sets `Authorization: Bearer <CRON_SECRET>`
 * automatically. Endpoints check this to reject external callers.
 *
 * Set `CRON_SECRET` env var in Vercel project settings; same value is
 * automatically passed by Vercel Cron when it invokes the endpoint.
 */

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
  if (authHeader !== `Bearer ${expected}`) throw new CronAuthError();
}

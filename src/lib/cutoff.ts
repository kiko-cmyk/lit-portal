/**
 * Cutoff window enforcement (72h before next ship).
 * Applies to: skip, plan, flavor, address, extras.
 */

export const CUTOFF_HOURS = 72;

export function isWithinCutoff(nextShipDate: Date | string, now = new Date()): boolean {
  const ship = typeof nextShipDate === "string" ? new Date(nextShipDate) : nextShipDate;
  const cutoff = ship.getTime() - CUTOFF_HOURS * 60 * 60 * 1000;
  return now.getTime() >= cutoff;
}

export function cutoffEndsAt(nextShipDate: Date | string): Date {
  const ship = typeof nextShipDate === "string" ? new Date(nextShipDate) : nextShipDate;
  return new Date(ship.getTime() - CUTOFF_HOURS * 60 * 60 * 1000);
}

export class CutoffPassedError extends Error {
  constructor() {
    super("Cutoff window has passed");
    this.name = "CutoffPassedError";
  }
}

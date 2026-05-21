/**
 * Cutoff window enforcement (24h before next ship).
 * Applies to: skip, plan, flavor, address, extras.
 *
 * Bajado de 72h a 24h el 2026-05-21 por Juan: el operador tiene tiempo
 * de procesar cambios hasta el día antes del envío. Antes 72h era
 * demasiado restrictivo y bloqueaba cambios que sí se podían atender.
 */

export const CUTOFF_HOURS = 24;

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

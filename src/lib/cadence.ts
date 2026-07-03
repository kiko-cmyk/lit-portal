/**
 * Pure cadence date math, shared by the FE (skip/plan previews) and the
 * backend (plan route's natural re-anchor). Frequency strings are the portal's
 * canonical short codes ("15d", "1mo", "45d", "2mo"…): a number + unit where
 * `mo` adds calendar months and `d` adds days. This mirrors how Seal regenerates
 * the schedule (calendar-month vs day intervals), so a date computed here lines
 * up with what Seal lands on after a frequency change.
 *
 * Extracted from SkipOverlay's local `addCycle` (2026-06-19) so the skip
 * retention flow and the backend can agree on the same arithmetic.
 */

/** Add one cadence cycle to `date` (e.g. +1 month for "1mo", +45 days for "45d"). */
export function addCycle(date: Date, frequency: string): Date {
  const d = new Date(date);
  const n = parseInt(frequency, 10);
  if (frequency.endsWith("mo")) d.setMonth(d.getMonth() + n);
  else if (frequency.endsWith("d")) d.setDate(d.getDate() + n);
  return d;
}

/** Subtract one cadence cycle from `date`. Inverse of `addCycle`. */
export function subCycle(date: Date, frequency: string): Date {
  const d = new Date(date);
  const n = parseInt(frequency, 10);
  if (frequency.endsWith("mo")) d.setMonth(d.getMonth() - n);
  else if (frequency.endsWith("d")) d.setDate(d.getDate() - n);
  return d;
}

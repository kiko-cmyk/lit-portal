/**
 * Pure cadence date math, shared by the FE (skip/plan previews) and the
 * backend (the fromNext re-anchor of the plan route and the WhatsApp bot route,
 * via `spacedFromNext`). Frequency strings are the portal's
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

/**
 * The next delivery when a customer SPACES their cadence (moves to a longer
 * frequency): the one they have, minus one current cycle, plus one new cycle.
 * 2mo → 3mo with the next one on 4-Oct lands on 4-Nov.
 *
 * The ONE implementation of that sum. The SkipOverlay and CancelTakeover previews
 * and the backend that writes the re-anchor intent (`frequency-core`, for the plan
 * route and the bot route) all call this, so what the customer is shown and what
 * gets saved cannot drift apart. They did until 2026-10-02: the screens added it
 * up this way while the plan route anchored on the last completed charge, and for
 * anyone who had skipped the saved date landed in the past (PR #122).
 */
export function spacedFromNext(next: Date, current: string, target: string): Date {
  return addCycle(subCycle(next, current), target);
}

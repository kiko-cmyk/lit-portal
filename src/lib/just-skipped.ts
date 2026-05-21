/**
 * "Just-skipped" client flag. Persisted in localStorage with the new
 * next-ship date as expiry — the Hub renders the "Saltada" hero variant
 * and the undo banner while this is set.
 *
 * Why localStorage (not server state): Seal regenerates billing_attempts
 * on later plan/address changes and wipes the `skipped_on` flag. The
 * authoritative "is there an undoable skip?" state lives in the client
 * for the brief window between skip and next ship.
 *
 * Juan 2026-05-21: extracted from my-lit/page.tsx so PlanOverlay can
 * detect an active skip and warn before a plan change wipes it.
 */

const KEY = "lit:just-skipped";

export interface JustSkippedRecord {
  until: string; // ISO ship date — banner auto-clears past this
}

export function readJustSkipped(): JustSkippedRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as JustSkippedRecord;
    if (!rec.until || Date.now() > new Date(rec.until).getTime()) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

export function writeJustSkipped(until: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify({ until } satisfies JustSkippedRecord));
}

export function clearJustSkipped(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

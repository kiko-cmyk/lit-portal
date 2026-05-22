/**
 * "Just-skipped" client flag. Persisted in localStorage with a short
 * window — the Hub renders the "Saltada" hero variant and the undo
 * banner while this is set.
 *
 * Why localStorage (not server state): Seal regenerates billing_attempts
 * on later plan/address changes and wipes the `skipped_on` flag. The
 * authoritative "is there an undoable skip?" state lives in the client
 * for the brief window after skip.
 *
 * Window: 5 minutes (Juan 2026-05-22). Pre-fix this stayed until the
 * new next-ship date, i.e. WEEKS, which was visual clutter long after
 * any human "oh I clicked wrong" moment. Standard undo-toast pattern
 * is seconds-to-minutes (Gmail send is ~30s); 5 min is generous.
 */

const KEY = "lit:just-skipped";
const UNDO_WINDOW_MS = 5 * 60 * 1000;

export interface JustSkippedRecord {
  /** ISO timestamp at which the banner auto-clears. */
  until: string;
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

/**
 * Open the undo window. The `_newShipDate` arg is ignored now (used to
 * be the expiry) — kept in the signature so existing callers don't break.
 * Banner expires `UNDO_WINDOW_MS` from now.
 */
export function writeJustSkipped(_newShipDate?: string): void {
  if (typeof window === "undefined") return;
  const until = new Date(Date.now() + UNDO_WINDOW_MS).toISOString();
  window.localStorage.setItem(KEY, JSON.stringify({ until } satisfies JustSkippedRecord));
}

export function clearJustSkipped(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

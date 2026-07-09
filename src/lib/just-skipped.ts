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
 *
 * Scoped PER SUBSCRIPTION (audit 2026-07-08): the flag used to be global,
 * so a multi-sub customer who skipped sub A and switched to sub B within
 * the window saw B painted as "Saltada" — and the Undo button (scoped to
 * the selected sub by api-client) would un-skip B's own legitimate skip
 * instead of A's. Records now carry the sub they were written under and
 * only read back under the same selection. Single-sub customers (no
 * selection) use the "single" scope — identical behaviour to before.
 */

import { getSelectedSubscription } from "@/lib/api-client";

const KEY = "lit:just-skipped";
const UNDO_WINDOW_MS = 5 * 60 * 1000;

/**
 * The subscription context the portal is currently scoped to: the multi-sub
 * selection api-client injects into every call, or "single" when none is set.
 */
function currentScope(): string {
  return getSelectedSubscription() ?? "single";
}

export interface JustSkippedRecord {
  /** ISO timestamp at which the banner auto-clears. */
  until: string;
  /** Sub the skip belongs to ("single" when no multi-sub selection). */
  subId?: string;
}

export function readJustSkipped(): JustSkippedRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as JustSkippedRecord;
    const untilMs = new Date(rec.until).getTime();
    if (!rec.until || isNaN(untilMs)) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    // Self-heal old records: pre-2026-05-22 the TTL was the new ship
    // date (could be WEEKS away). Cap at the current 5-min window — if
    // until is more than UNDO_WINDOW_MS in the future, treat as stale
    // and purge. New writes are always within the cap.
    if (untilMs > Date.now() + UNDO_WINDOW_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    if (Date.now() > untilMs) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    // Per-sub scoping: a record written under another selection (or a legacy
    // record with no subId) is not "this sub just skipped". Don't purge — the
    // customer may switch back to the skipped sub within the window, and
    // legacy/mismatched records expire on their own via the checks above.
    if (rec.subId !== currentScope()) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Open the undo window for the currently-selected subscription. Banner
 * expires `UNDO_WINDOW_MS` from now. (The new-ship-date arg the old
 * signature took was already ignored; dropped 2026-07-08 with the
 * per-sub scoping.)
 */
export function writeJustSkipped(): void {
  if (typeof window === "undefined") return;
  const until = new Date(Date.now() + UNDO_WINDOW_MS).toISOString();
  window.localStorage.setItem(
    KEY,
    JSON.stringify({ until, subId: currentScope() } satisfies JustSkippedRecord),
  );
}

export function clearJustSkipped(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

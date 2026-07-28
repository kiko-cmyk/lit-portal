/**
 * Long-form Spanish label for a ship date: "30 de julio", "5 de agosto".
 *
 * Emitted as `nextShipDateLabel` on `subscription_renewal_reminder` so the email
 * never has to format a date itself. Klaviyo types `nextShipDate` as TEXT (it
 * arrives as an ISO string), and Django's `|date:"j M"` filter over a string
 * returns '' silently — that is exactly how the 7d email shipped with a blank
 * date from 2026-07-15 to 2026-07-28 (524 recipients). Formatting here kills
 * that class of bug: the template just prints the string.
 *
 * Built from the FIRST TEN CHARACTERS of the Seal date, never from a `Date`:
 * Seal charges at 09:00 UTC (`2026-07-30T09:00:00+00:00`) and
 * `new Date(iso).toLocaleDateString()` renders in the RUNTIME's timezone, so any
 * region west of UTC would print the previous day. Slicing keeps the label
 * identical to the `shipDate` dedup key and to Klaviyo's own |slice fallback.
 */

const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/**
 * `2026-07-30T09:00:00+00:00` → `"30 de julio"` (no leading zero on the day).
 *
 * Returns "" for anything that isn't an ISO date, so the template's
 * `{% if event.nextShipDateLabel %}` falls back to its own slice recipe instead
 * of printing garbage.
 */
export function formatShipDateEs(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return "";
  const month = MONTHS_ES[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || !day) return "";
  return `${day} de ${month}`;
}

/**
 * Locale-aware frequency labels.
 *
 * The API returns `subscription.frequencyLabel` as the raw Seal value
 * (`"1 month"`, `"45 day"` etc.) — English-only because the backend has no
 * locale context. UI rendering should call these helpers off the
 * `subscription.frequency` enum so each language gets the right copy
 * (`"cada 1 mes"` / `"every 1 month"`).
 */

import type { Frequency } from "./types";
import type { Lang } from "./portal-link";

const LABELS: Record<Frequency, { en: string; es: string }> = {
  "15d": { en: "Every 15 days", es: "Cada 15 días" },
  "1mo": { en: "Every 1 month", es: "Cada 1 mes" },
  "45d": { en: "Every 45 days", es: "Cada 45 días" },
  "2mo": { en: "Every 2 months", es: "Cada 2 meses" },
  "3mo": { en: "Every 3 months", es: "Cada 3 meses" },
  "4mo": { en: "Every 4 months", es: "Cada 4 meses" },
  "5mo": { en: "Every 5 months", es: "Cada 5 meses" },
  "6mo": { en: "Every 6 months", es: "Cada 6 meses" },
};

const SHORT: Record<Frequency, { en: string; es: string }> = {
  "15d": { en: "15 days", es: "15 días" },
  "1mo": { en: "1 month", es: "1 mes" },
  "45d": { en: "45 days", es: "45 días" },
  "2mo": { en: "2 months", es: "2 meses" },
  "3mo": { en: "3 months", es: "3 meses" },
  "4mo": { en: "4 months", es: "4 meses" },
  "5mo": { en: "5 months", es: "5 meses" },
  "6mo": { en: "6 months", es: "6 meses" },
};

const COMPACT: Record<Frequency, { en: string; es: string }> = {
  "15d": { en: "15 D", es: "15 D" },
  "1mo": { en: "1 MO", es: "1 MES" },
  "45d": { en: "45 D", es: "45 D" },
  "2mo": { en: "2 MO", es: "2 MES" },
  "3mo": { en: "3 MO", es: "3 MES" },
  "4mo": { en: "4 MO", es: "4 MES" },
  "5mo": { en: "5 MO", es: "5 MES" },
  "6mo": { en: "6 MO", es: "6 MES" },
};

export type FrequencyLabelOptions = {
  /**
   * - `"long"` → "Cada 1 mes" / "Every 1 month"
   * - `"short"` → "1 mes" / "1 month"
   * - `"compact"` → "1 MES" / "1 MO" (4-col subsumm cells)
   */
  format?: "long" | "short" | "compact";
};

export function frequencyLabel(
  freq: Frequency,
  lang: Lang,
  opts: FrequencyLabelOptions = {},
): string {
  const map =
    opts.format === "short" ? SHORT : opts.format === "compact" ? COMPACT : LABELS;
  return map[freq][lang];
}

export const FREQUENCY_OPTIONS: { value: Frequency; en: string; es: string }[] = (
  Object.entries(LABELS) as [Frequency, { en: string; es: string }][]
).map(([value, labels]) => ({ value, ...labels }));

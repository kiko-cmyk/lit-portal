/**
 * Shared plan option lists (box counts + frequencies) so PlanOverlay and the
 * skip retention offer render the same choices without duplicating the labels.
 * Extracted from PlanOverlay (2026-06-19).
 */

import type { Frequency } from "@/lib/types";

export const FREQUENCIES: { value: Frequency; en: string; es: string }[] = [
  { value: "15d", en: "Every 15 days", es: "Cada 15 días" },
  { value: "1mo", en: "Every 1 month", es: "Cada 1 mes" },
  { value: "45d", en: "Every 45 days", es: "Cada 45 días" },
  { value: "2mo", en: "Every 2 months", es: "Cada 2 meses" },
  { value: "3mo", en: "Every 3 months", es: "Cada 3 meses" },
  { value: "4mo", en: "Every 4 months", es: "Cada 4 meses" },
  { value: "5mo", en: "Every 5 months", es: "Cada 5 meses" },
  { value: "6mo", en: "Every 6 months", es: "Cada 6 meses" },
];

export const BOX_OPTIONS = [1, 2, 3, 4, 5, 6] as const;

/**
 * Approximate length of each cadence in days. Used only to ORDER frequencies
 * (e.g. "offer me something longer than my current one") — not for exact date
 * math, which uses lib/cadence's calendar-aware add/subCycle.
 */
export const FREQUENCY_DAYS: Record<Frequency, number> = {
  "15d": 15,
  "1mo": 30,
  "45d": 45,
  "2mo": 60,
  "3mo": 90,
  "4mo": 120,
  "5mo": 150,
  "6mo": 180,
};

/** Frequencies strictly longer than `current`, in ascending order. */
export function longerFrequencies(current: Frequency): Frequency[] {
  const cur = FREQUENCY_DAYS[current];
  return FREQUENCIES.map((f) => f.value).filter((f) => FREQUENCY_DAYS[f] > cur);
}

/**
 * La cadencia vendible más larga que CABE en `days`, o null si no hay ninguna
 * (o sea, si `days` es menor que 15).
 *
 * Redondea SIEMPRE hacia abajo, y eso no es una preferencia estética. La
 * escalera no es uniforme (15·30·45·60·90·120·150·180: pasos de 15 hasta los 60
 * días y de 30 a partir de ahí), así que hay combinaciones que caen justo entre
 * dos escalones — 3 cajas que duran mes y medio son 135 días, empatados a 15 de
 * `4mo` y de `5mo`. Hacia abajo el cliente recibe un poco antes de agotarse y le
 * sobra algo, que es el statu quo y se arregla saltándose un envío. Hacia arriba
 * se queda SIN producto entre entregas, y encima justo después de habernos
 * pedido ayuda. Ese error no se recupera.
 */
export function longestFrequencyWithin(days: number): Frequency | null {
  let best: Frequency | null = null;
  for (const { value } of FREQUENCIES) {
    if (FREQUENCY_DAYS[value] <= days) best = value;
  }
  return best;
}

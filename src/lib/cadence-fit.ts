/**
 * ¿Le estamos mandando LIT más rápido de lo que se lo bebe?
 *
 * Función PURA: sin red, sin base, sin fechas del sistema. Todo lo que necesita
 * entra por parámetro, para que las 2.016 combinaciones posibles se puedan
 * recorrer en un test sin levantar nada.
 *
 * ── Por qué hace falta preguntarlo ──
 *
 * Lo que sabemos hoy es la cadencia CONTRATADA, y eso es geometría del catálogo,
 * no consumo: el 70,3% de las suscripciones activas está clavado en un sobre al
 * día POR CONSTRUCCIÓN de los formatos, no porque hayamos medido a nadie. El
 * desajuste entre lo que recibe y lo que bebe no existe en ninguna fuente, y
 * tiene nombre propio entre las bajas medidas: "se me acumulaba".
 *
 * ── El diseño en una frase: dispara la TASA, veta el NIVEL ──
 *
 * `caja_dura` (cuánto le dura una caja) es independiente de en qué punto del
 * ciclo esté, así que es lo único que puede DISPARAR. `stock_dura` (cuánto le
 * queda hoy) depende del día: el mismo cliente contesta "más de dos meses" el
 * día después de recibir y "se me ha acabado" la víspera de la siguiente
 * entrega. Por eso el nivel solo VETA, nunca propone.
 *
 * Y si los dos se contradicen, gana el stock y nos callamos. Decirle "te sobra
 * LIT" a alguien que acaba de quedarse sin producto es el mensaje más caro que
 * podemos mandar: le demuestra que no le conocemos, justo en la pantalla desde
 * la que se cancela.
 */

import { FREQUENCY_DAYS, longestFrequencyWithin } from "@/lib/plan-options";
import type { Frequency } from "@/lib/types";

/** Días que representa cada opción de `caja_dura`. null → no se puede calcular. */
export const DURATION_DAYS: Record<string, number | null> = {
  // Sin suelo: puede ser 1 día o 14, así que no hay tasa que multiplicar. Y la
  // palanca de este cliente no es espaciar, es MÁS cajas, que es un cambio de
  // composición y reprecia. No entra en el motor.
  lt15: null,
  "15d": 15,
  "1mo": 30,
  "45d": 45,
  "2mo": 60,
  // 61 y no 90: es el SUELO honesto del cubo, no su mediana. Con 61 días y una
  // caja, el motor propone `2mo`, que para alguien de "más de dos meses" aún se
  // queda corto; con 90 propondría `3mo` y podría pasarse. Sub-servir la
  // propuesta es el error seguro. Recalibrable cuando haya distribución real.
  gt2mo: 61,
  ns: null,
};

/** Niveles de stock que CONTRADICEN cualquier señal de sobre-servicio. */
const STOCK_VETA = new Set(["none", "lt2w"]);

/** El tope de la escalera. Por encima no hay nada que vender. */
const MAX_CADENCE_DAYS = 180;

/**
 * Cuánto más larga tiene que ser la propuesta para que merezca la pena.
 *
 * Un RATIO y no "N escalones", porque la escalera no es uniforme: desde `1mo` un
 * paso son +15 días y desde `3mo` son +30, así que contar pasos daría un umbral
 * distinto según dónde esté cada cliente. Con 1,5×: `1mo → 45d` sí dispara,
 * `3mo → 4mo` no, que a esa altura es ruido de estimación.
 */
const UMBRAL_NUM = 3;
const UMBRAL_DEN = 2;

export interface CadenceFitInput {
  currentFrequency: Frequency;
  /**
   * Cajas REALES por entrega: `mixBoxCount(composition)`, nunca
   * `subscription.boxCount`. Ese último lo clampa `getBoxCount` a 6, así que una
   * sub de 12 cajas se lee como 6 y la aritmética mentiría por la mitad.
   */
  realBoxes: number;
  /** Valor canónico de `caja_dura`. */
  boxDuration: string | undefined;
  /** Valor canónico de `stock_dura`. */
  stockLeft: string | undefined;
}

export type CadenceFitVeto =
  | "no_rate"           // no contestó la duración, o dijo "no lo sé" / "menos de 15 días"
  | "stock_contradice"  // dice que le sobra pero se ha quedado sin producto
  | "sin_cadencia"      // el cálculo no llega ni a la más corta
  | "no_mejora"         // la que tocaría no es más larga que la suya
  | "bajo_umbral";      // es más larga, pero no lo bastante

export interface CadenceFitResult {
  /** La cadencia a proponer, o null si no se propone nada. */
  target: Frequency | null;
  /** Por qué no se propone. Se registra: es lo único que dice si el motor es
   *  demasiado tímido o si el veto nos estaba salvando de verdad. */
  veto: CadenceFitVeto | null;
  /** El cálculo llegaba más allá del tope de 6 meses. La propuesta sigue siendo
   *  una mejora, pero incompleta: NO se le dice en pantalla (decirle a alguien
   *  que el producto no le encaja invita a la baja), se saca por una lista. */
  cappedAtSixMonths: boolean;
}

const NO: Omit<CadenceFitResult, "veto"> = { target: null, cappedAtSixMonths: false };

export function suggestLongerCadence(input: CadenceFitInput): CadenceFitResult {
  const days = input.boxDuration ? DURATION_DAYS[input.boxDuration] : null;
  if (days == null) return { ...NO, veto: "no_rate" };

  if (input.stockLeft !== undefined && STOCK_VETA.has(input.stockLeft)) {
    return { ...NO, veto: "stock_contradice" };
  }

  const boxes = Math.max(1, Math.floor(input.realBoxes));
  const supply = days * boxes;
  const capped = supply > MAX_CADENCE_DAYS;
  const target = longestFrequencyWithin(Math.min(supply, MAX_CADENCE_DAYS));
  if (!target) return { ...NO, veto: "sin_cadencia" };

  const cur = FREQUENCY_DAYS[input.currentFrequency];
  const tgt = FREQUENCY_DAYS[target];
  if (tgt <= cur) return { ...NO, veto: "no_mejora" };
  // tgt >= 1,5 × cur, en enteros para no arrastrar coma flotante.
  if (tgt * UMBRAL_DEN < cur * UMBRAL_NUM) return { ...NO, veto: "bajo_umbral" };

  return { target, veto: null, cappedAtSixMonths: capped };
}

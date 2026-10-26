/**
 * Lo propio del cambio de SABOR que pide el bot de WhatsApp (LIT-625), sin Seal ni red:
 * qué sabores hay, qué composición quedaría y si lo que se lee de vuelta es lo pedido.
 *
 * La escritura NO vive aquí: va por `changePlan` (`@/lib/plan-core`), el mismo núcleo que
 * el área personal, con todas sus guardas de dinero. Esto solo traduce la petición del bot
 * a la forma que ese núcleo entiende y pone las reglas que el bot no se puede saltar:
 *
 *   - Solo sabor o mezcla, con el MISMO número de cajas. Cambiar las cajas reprecia a
 *     catálogo, y eso se hace en el área personal, viendo el precio.
 *   - Los sabores son los de `FLAVORS`: un sabor nuevo entra solo cuando el portal lo
 *     conoce, sin tocar esto.
 */

import { ApiHttpError } from "@/lib/api-helpers";
import {
  type FlavorComposition,
  isMixed,
  MAX_BOXES,
  mixBoxCount,
  sameComposition,
  validateMix,
} from "@/lib/mix";
import { ALL_FLAVORS, type FlavorKey, isFlavorKey } from "@/lib/seal-plans";

export interface FlavorOption {
  flavor: FlavorKey;
  label: string;
}

/** Los sabores que se pueden pedir hoy, en el orden del registro. */
export function flavorOptions(): FlavorOption[] {
  return ALL_FLAVORS.map((f) => ({ flavor: f.key, label: f.label }));
}

export interface FlavorRequest {
  flavor?: unknown;
  mix?: unknown;
}

export interface FlavorTarget {
  /** La composición que quedaría. */
  target: FlavorComposition[];
  /** `false` si ya es la que tiene: no hay nada que escribir. */
  changed: boolean;
  /**
   * Lo que se le manda a `changePlan`. Un sabor solo sobre una sub de un solo sabor va
   * como `flavor`, igual que FlavorOverlay; todo lo demás como `mix`, porque el núcleo
   * rechaza `flavor` sobre una mezcla (`mix_requires_explicit_intent`) y una mezcla de
   * una sola entrada es «todo de este sabor» dicho sin ambigüedad.
   */
  intent: { flavor: FlavorKey } | { mix: FlavorComposition[] };
}

/**
 * De la petición del bot a la composición objetivo. Lanza `ApiHttpError` con un código
 * que el bot sabe explicar; ninguno de estos rechazos es un portal roto.
 */
export function resolveFlavorTarget(current: FlavorComposition[], req: FlavorRequest): FlavorTarget {
  const hasFlavor = req.flavor !== undefined && req.flavor !== null && req.flavor !== "";
  const hasMix = req.mix !== undefined && req.mix !== null;
  if (hasFlavor && hasMix) {
    throw new ApiHttpError(400, "conflicting_flavor_intent", "Send `mix` or `flavor`, not both");
  }
  if (!hasFlavor && !hasMix) {
    throw new ApiHttpError(400, "no_changes", "Provide flavor or mix");
  }

  const boxes = mixBoxCount(current);
  if (!current.length || boxes < 1) {
    throw new ApiHttpError(409, "box_count_unknown", "The current composition could not be read");
  }
  if (boxes > MAX_BOXES) {
    // Las dos subs de más de 6 cajas (13007758 y 12752359) no caben en el constructor
    // de mezclas ni en la escalera: a mano.
    throw new ApiHttpError(409, "box_count_out_of_range", `This subscription has ${boxes} boxes`);
  }

  let target: FlavorComposition[];
  if (hasFlavor) {
    if (!isFlavorKey(req.flavor)) {
      throw new ApiHttpError(400, "invalid_flavor", `Unknown flavor: ${String(req.flavor)}`);
    }
    target = [{ flavor: req.flavor, boxes }];
  } else {
    const parsed = validateMix(req.mix);
    if (!parsed.ok) {
      throw new ApiHttpError(400, "invalid_mix", parsed.code);
    }
    const asked = mixBoxCount(parsed.mix);
    if (parsed.mix.length > boxes) {
      // Con una caja no hay mezcla: cada sabor de una mezcla es al menos una caja entera.
      throw new ApiHttpError(409, "mix_needs_more_boxes", `${parsed.mix.length} flavors need at least ${parsed.mix.length} boxes; this subscription has ${boxes}`);
    }
    if (asked !== boxes) {
      throw new ApiHttpError(
        409,
        "box_count_change_not_allowed",
        `The mix adds up to ${asked} boxes and the subscription has ${boxes}; only the flavors can change here`,
      );
    }
    target = parsed.mix;
  }

  const changed = !sameComposition(current, target);
  // Mezcla = más de un sabor en la composición, también dentro de un PACK4 (3L+1W).
  const intent =
    target.length === 1 && !isMixed(current) ? { flavor: target[0].flavor } : { mix: target };
  return { target, changed, intent };
}

export type FlavorWriteCheck = "ok" | "composition_mismatch" | "charge_changed";

/**
 * ¿Lo que se lee de Seal después de escribir es lo pedido, al importe que se escribió?
 *
 * La composición agregada por sabor ya delata la escritura a medias que más duele (Seal
 * añade lo nuevo y no quita lo viejo: salen las cajas dobladas), y el importe delata un
 * reprecio. Las dos cosas se miran porque `changePlan` puede devolver 200 sin haber
 * podido releer Seal, y el bot no puede decir «hecho» sin haberlo visto.
 *
 * `expectedChargeCents` es lo que el núcleo dice haber escrito, que puede ser un céntimo
 * MENOS que el contrato: la SL90 a 67,93 pasada a un solo sabor es una línea de 3 cajas,
 * y 67,93 no se reparte en tres precios iguales (sale 67,92). Que nunca sea MÁS que el
 * contrato lo comprueba la ruta, no esto.
 */
export function checkFlavorWrite(
  live: { composition: FlavorComposition[]; chargeCents: number },
  target: FlavorComposition[],
  expectedChargeCents: number,
): FlavorWriteCheck {
  if (!sameComposition(live.composition, target)) return "composition_mismatch";
  if (live.chargeCents !== expectedChargeCents) return "charge_changed";
  return "ok";
}

/**
 * Los códigos de descuento que un cambio de sabor NO puede perder: todos los de las líneas
 * recurrentes menos los `LITREF-` de recomendación, que el núcleo retira a propósito en
 * cada cambio de líneas y repone el cron antes del cobro (`detachReferralRewardsForSwap`).
 * El 15 % de retención (`LITSTAY15`) y el crédito del Discovery Set (`LIT-XXXXXXXX`) los
 * repone el propio núcleo en la misma petición; si uno falta después, el cliente pagaría
 * más y el bot no puede decir que el precio no cambia.
 */
export function discountCodesThatMustSurvive(
  items: ReadonlyArray<{ is_one_time_item?: unknown; discount_codes?: ReadonlyArray<{ code?: string | null }> | null }>,
): string[] {
  const codes = new Set<string>();
  for (const it of items) {
    if (it.is_one_time_item && it.is_one_time_item !== "0") continue;
    for (const dc of it.discount_codes ?? []) {
      const code = (dc.code ?? "").trim().toUpperCase();
      if (code && !code.startsWith("LITREF-")) codes.add(code);
    }
  }
  return [...codes].sort();
}

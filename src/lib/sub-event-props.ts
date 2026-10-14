/**
 * Lo que un email de suscripción necesita saber de la sub, en un solo sitio
 * (2026-10-14).
 *
 * Los avisos de reanudar, reactivar, cobro adelantado fallido y bajas fuera del
 * portal mandan a Klaviyo la misma foto de la sub que ya manda el recordatorio
 * de renovación, con los mismos nombres de campo, para que LIT-CRM pueda reusar
 * bloques entre plantillas:
 *
 *   - `nextShipDate` en ISO CRUDO, nunca formateado (el flow de 48 h lo reenvía
 *     a Permut y un formato rompe el emparejamiento con el cobro de Seal);
 *   - `nextShipDateLabel` para pintar («30 de julio»), que existe porque el filtro
 *     `|date` de Klaviyo sobre un texto devuelve vacío sin avisar.
 *
 * Sin precio a propósito: ~533 contratos pagan por debajo del catálogo y un
 * email no puede contradecir al cobro (mismo criterio que renewal-reminder.ts).
 */

import { shortLabel } from "@/lib/mix";
import {
  extractFlavorSummary,
  getBoxCount,
  getComposition,
  getNextBillingAttempt,
  normalizeFrequency,
  type SealSubscription,
} from "@/lib/seal";
import { formatShipDateEs } from "@/lib/ship-date-label";
import { supabaseAdmin } from "@/lib/supabase";

export function subscriptionSnapshotProps(s: SealSubscription): Record<string, unknown> {
  const next = getNextBillingAttempt(s);
  const composition = getComposition(s);
  return {
    sealSubscriptionId: String(s.id),
    nextShipDate: next?.date ?? null,
    nextShipDateLabel: next?.date ? formatShipDateEs(next.date) : null,
    boxCount: getBoxCount(s),
    frequency: normalizeFrequency(s.delivery_interval),
    flavor: extractFlavorSummary(s),
    is_mix: composition.length > 1,
    flavor_mix: composition.map((x) => ({ flavor: shortLabel(x.flavor), boxes: x.boxes })),
  };
}

/** Idioma guardado del cliente; «es» si no hay o si falla la lectura. */
export async function customerLocale(customerId: string | null | undefined): Promise<"es" | "en"> {
  if (!customerId) return "es";
  try {
    const { data } = await supabaseAdmin()
      .from("customer_preferences")
      .select("language")
      .eq("customer_id", customerId)
      .maybeSingle();
    return data?.language === "en" ? "en" : "es";
  } catch {
    return "es";
  }
}

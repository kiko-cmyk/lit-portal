import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Marca una fila del perfilado como sincronizada con Klaviyo, pero SOLO si
 * sigue siendo la fila que el cron leyó.
 *
 * ── La carrera que cierra (2026-09-23) ──
 *
 * El cron lee de una vez hasta 100 filas pendientes y luego las procesa una a
 * una: email en Shopify, escritura en Klaviyo, marca. Si entre la lectura y la
 * marca el cliente pide el BORRADO, la ruta de borrado deja la lápida
 * (`answers: {}`, `deleted_at`, `klaviyo_synced_at: null`) y el cron, que va con
 * la copia vieja, sube las `cs_*` viejas y luego marcaba por `customer_id` a
 * secas. La lápida quedaba "sincronizada", la siguiente pasada no la veía y
 * Klaviyo guardaba los datos PARA SIEMPRE, sin ningún error: Postgres decía
 * "borrado" y Klaviyo no. Con una edición de respuestas pasaba lo mismo, en
 * versión menos grave (Klaviyo con las respuestas viejas).
 *
 * El arreglo es comparar al escribir: se marca solo si `updated_at` sigue siendo
 * el que se leyó y la fila sigue pendiente. Funciona porque LAS DOS rutas que
 * escriben la fila (envío y borrado) ponen `klaviyo_synced_at: null` y
 * `updated_at: now()` en la MISMA escritura. Si la fila cambió, no se marca, se
 * queda en la cola y la pasada siguiente procesa el estado nuevo: en un borrado,
 * entra por la rama que vacía.
 *
 * El `is("klaviyo_synced_at", null)` cubre además dos tiradas del cron
 * solapadas: la segunda no re-marca lo que la primera ya cerró.
 *
 * Devuelve si ha marcado. `false` no es un error: es la carrera, y la cuenta el
 * cron para que se vea.
 */
export async function markSyncedIfUnchanged(
  sb: SupabaseClient,
  customerId: string,
  readUpdatedAt: string | null,
): Promise<boolean> {
  let q = sb
    .from("profile_survey_answers")
    .update({ klaviyo_synced_at: new Date().toISOString() })
    .eq("customer_id", customerId)
    .is("klaviyo_synced_at", null);
  q = readUpdatedAt === null ? q.is("updated_at", null) : q.eq("updated_at", readUpdatedAt);
  const { data, error } = await q.select("customer_id");
  if (error) throw new Error(`profile_survey_answers mark: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

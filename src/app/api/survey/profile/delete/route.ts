import { withCustomer } from "@/lib/api-helpers";
import { enforceRateLimit } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /apps/portal/api/survey/profile/delete — retira las respuestas.
 *
 * Va como POST y no como DELETE por una razón práctica: `api-client` y el App
 * Proxy tratan mejor el POST, y el resto del portal no usa DELETE en ninguna
 * ruta. Coherencia antes que purismo REST.
 *
 * ── Qué se borra y qué NO ──
 *
 * Se borra la fila. NO se retiran los 50 drops: se le pagó por contestar, y
 * quitárselos después convertiría el ejercicio de un derecho en un castigo.
 * El `dedup_key` también se queda, así que volver a rellenarlo tampoco vuelve a
 * pagar. Se retira el dato, no el premio.
 *
 * ── Klaviyo ──
 *
 * Medido contra la API en vivo el 2026-09-01: `/profile-import/` **no puede
 * eliminar una propiedad**, solo vaciarla; la clave sigue existiendo con cadena
 * vacía. Así que "borrar" allí es escribir "" en cada `cs_*`, y eso lo hace el
 * mismo cron que sincroniza, leyendo esta marca. Por eso aquí se deja una
 * lápida (`deleted_at`) en vez de un DELETE a secas: si la fila desapareciera,
 * el cron no tendría forma de saber que hay propiedades que vaciar y el dato
 * seguiría vivo en Klaviyo para siempre, que es el peor final posible para una
 * petición de borrado.
 *
 * Consecuencia para los segmentos: uno definido como "la propiedad está puesta"
 * SEGUIRÍA capturando a quien pidió el borrado. Tienen que filtrar por valor
 * distinto de vacío.
 */
export const POST = withCustomer<{ deleted: boolean }>(async (_req, ctx) => {
  await enforceRateLimit(ctx.customerId, "survey-profile-delete", {
    limit: 5,
    windowMs: 60_000,
  });

  const sb = supabaseAdmin();
  const { error } = await sb
    .from("profile_survey_answers")
    .update({
      answers: {},
      consent: false,
      consent_at: null,
      consent_version: null,
      deleted_at: new Date().toISOString(),
      // Vuelve a la cola del cron, que es quien vaciará las cs_* en Klaviyo.
      klaviyo_synced_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("customer_id", ctx.customerId);

  if (error) throw new Error(`profile_survey_answers delete: ${error.message}`);
  return { deleted: true };
});

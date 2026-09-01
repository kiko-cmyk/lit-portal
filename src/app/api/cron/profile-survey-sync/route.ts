import { NextResponse, type NextRequest } from "next/server";
import { CronAuthError, requireCron } from "@/lib/cron-auth";
import { klaviyo } from "@/lib/klaviyo";
import { klaviyoProps } from "@/lib/profile-questions";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /apps/portal/api/cron/profile-survey-sync
 *
 * Empuja a Klaviyo las respuestas del formulario de perfilado. Diario.
 *
 * ── Por qué existe este cron y no se escribe en la ruta de submit ──
 *
 * `klaviyo.ts` no pasa `signal` a `fetch` — es un hueco que el propio repo
 * documenta en `http-timeout.ts`. Un socket colgado se comería el `maxDuration`
 * entero y moriría en silencio, y en la ruta de submit eso pasaría DESPUÉS de
 * haber guardado la respuesta: el cliente vería una rueda girando un minuto tras
 * haber contestado nueve preguntas. Aquí un cuelgue no lo ve nadie y la marca de
 * agua hace que se reintente mañana.
 *
 * ── La marca de agua ──
 *
 * `klaviyo_synced_at is null` = pendiente. Se pone a NULL en CADA escritura de la
 * ruta, así que una respuesta corregida vuelve a la cola sola. Es el bug LIT-397
 * del CS Platform (una corrección que no volvía nunca) naciendo cerrado.
 *
 * ── Consentimiento y borrado ──
 *
 * Sin consentimiento NO se escribe el perfil: la respuesta se guarda y cuenta en
 * el agregado, pero Klaviyo no se toca. Es exactamente lo que concede la casilla.
 * Y con `deleted_at` puesto se escriben las propiedades en BLANCO, porque medido
 * contra la API el 2026-09-01 `/profile-import/` **no puede eliminar** una
 * propiedad: solo vaciarla. Vaciar ES el borrado, y por eso la fila sobrevive al
 * borrado con una lápida en vez de desaparecer.
 */

const BATCH = 100;

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireCron(req);
  } catch (err) {
    if (err instanceof CronAuthError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const sb = supabaseAdmin();
  const { data: rows, error } = await sb
    .from("profile_survey_answers")
    .select("customer_id, answers, consent, deleted_at")
    .is("klaviyo_synced_at", null)
    .limit(BATCH);
  if (error) throw new Error(`profile-survey-sync: ${error.message}`);

  let pushed = 0;
  let cleared = 0;
  let skippedNoConsent = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    const customerId = row.customer_id as string;
    const deleted = !!row.deleted_at;
    const consent = row.consent === true;

    // Sin consentimiento y sin borrado no hay nada que hacer en Klaviyo, pero SÍ
    // hay que marcar la fila: si no, se relee eternamente y el índice parcial de
    // pendientes crece para siempre. Es el mismo defecto que hoy tiene
    // `crm_answers` en el dashboard, con 42 filas que no van a sincronizar nunca.
    if (!consent && !deleted) {
      await mark(customerId);
      skippedNoConsent++;
      continue;
    }

    try {
      const email = await shopifyAdmin.getCustomerEmail(customerId);
      if (!email) {
        // Sin email no hay perfil que tocar. Se marca igual, por lo mismo de
        // arriba: una fila que no puede avanzar no debe quedarse en la cola.
        await mark(customerId);
        continue;
      }

      const answers = (row.answers as Record<string, string>) ?? {};
      const props = klaviyoProps(answers);

      if (deleted) {
        // Vaciar TODAS las claves que este formulario haya podido escribir, no
        // solo las que queden en la fila: si el cliente borró, `answers` está
        // vacío y no habría nada que vaciar.
        const blanks: Record<string, string> = {};
        for (const key of ALL_PROPS) blanks[key] = "";
        await klaviyo.upsertProfile(email, blanks);
        cleared++;
      } else {
        await klaviyo.upsertProfile(email, {
          ...props,
          cs_perfil_fuente: "portal",
          cs_perfil_fecha: new Date().toISOString().slice(0, 10),
        });
        pushed++;
      }
      await mark(customerId);
    } catch (err) {
      // No se marca: se reintenta mañana. Un fallo aquí es invisible para el
      // cliente, que es justo el motivo de haberlo sacado de la ruta de submit.
      console.warn(`[profile-survey-sync] ${customerId} failed:`, err);
      failed++;
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: rows?.length ?? 0,
    pushed,
    cleared,
    skippedNoConsent,
    failed,
  });
}

async function mark(customerId: string): Promise<void> {
  await supabaseAdmin()
    .from("profile_survey_answers")
    .update({ klaviyo_synced_at: new Date().toISOString() })
    .eq("customer_id", customerId);
}

/**
 * Todas las propiedades que este formulario puede escribir. Se enumera aquí y no
 * se deriva del banco de preguntas a propósito: si mañana se retira una pregunta,
 * su propiedad sigue existiendo en los perfiles de quien ya contestó, y una
 * petición de borrado tiene que poder vaciarla igual.
 */
const ALL_PROPS = [
  "cs_situacion",
  "cs_uso",
  "cs_sabor_pref",
  "cs_caja_dura",
  "cs_stock_nivel",
  "cs_hogar",
  "cs_deporte_frecuencia",
  "cs_hace_deporte",
  "cs_deporte",
  "cs_edad",
  "cs_perfil_fuente",
  "cs_perfil_fecha",
] as const;

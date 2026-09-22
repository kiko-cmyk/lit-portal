import { alertSlackError } from "@/lib/alert";
import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { suggestLongerCadence } from "@/lib/cadence-fit";
import { awardDrops, DROPS_AMOUNTS, TIER_THRESHOLD } from "@/lib/drops";
import { profileSurveyEnabledFor } from "@/lib/flags";
import { mixBoxCount } from "@/lib/mix";
import { SURVEY_CONSENT } from "@/lib/survey-consent-copy";
import { validateAnswers } from "@/lib/profile-questions";
import { langFromRequest } from "@/lib/request-lang";
import { enforceRateLimit } from "@/lib/rate-limit";
import { mapToSubscription } from "@/lib/seal";
import { issueSurveyDiscount, type IssuedDiscount } from "@/lib/survey-discount";
import { resolveActiveSubFast } from "@/lib/sub-resolve";
import { shopifyAdmin } from "@/lib/shopify-admin";
import { supabaseAdmin } from "@/lib/supabase";
import type { Frequency } from "@/lib/types";

/**
 * Formulario de perfilado del área personal ("Conoce a tus clientes").
 *
 *   GET  /apps/portal/api/survey/profile  → estado + respuestas previas
 *   POST /apps/portal/api/survey/profile  → guarda, paga 50 drops, propone cadencia
 *
 * ── Tres decisiones de esta ruta, con su motivo ──
 *
 * 1. NO habla con Klaviyo. Escribe Postgres y responde; un cron empuja las `cs_*`
 *    leyendo `klaviyo_synced_at is null`. Motivo: `klaviyo.ts` no pasa `signal` a
 *    `fetch` (lo dice `http-timeout.ts` como hueco conocido), así que un socket
 *    colgado se comería el `maxDuration` entero y moriría en silencio DESPUÉS de
 *    haber guardado. Y `upsertProfile` no tenía ni un call site en el repo, o sea
 *    que es un camino que se estrena. Estrenarlo en un job de fondo reintentable
 *    es gratis; estrenarlo delante de un cliente que acaba de contestar nueve
 *    preguntas, no. (Tampoco vale mandarlo fire-and-forget después de responder:
 *    el repo ya se quemó con eso, ver el comentario de `subscription/cancel`.)
 *
 * 2. El guardado va ANTES que el pago, y el pago en su propio try/catch. Si la
 *    migración del CHECK de `drops_events.action` no llegó a producción, el
 *    INSERT de los drops revienta — y en ese caso queremos perder el premio, que
 *    se puede reconciliar después, y NO la respuesta del cliente, que no la va a
 *    escribir dos veces.
 *
 * 3. La propuesta de cadencia se calcula AQUÍ, releyendo la suscripción viva, y
 *    no en el cliente con el objeto que ya tenía en memoria. Una pestaña puede
 *    llevar media hora abierta, y en ese rato el cliente ha podido pausar, saltar
 *    una entrega o entrar en la ventana de corte.
 */

export const maxDuration = 20;

const DEDUP_PREFIX = "survey:profile_v1:";

interface SurveyBody {
  answers?: unknown;
  consent?: unknown;
}

export interface CadenceOffer {
  from: Frequency;
  to: Frequency;
  /** El suministro daba para más de 6 meses. La propuesta mejora igual, pero es
   *  incompleta. NO se le dice al cliente: sale por una lista. */
  cappedAtSixMonths: boolean;
}

export interface SurveyState {
  answered: boolean;
  answers: Record<string, string>;
  consent: boolean;
  /** Ya cobró alguna vez. Un reenvío no vuelve a pagar. */
  alreadyPaid: boolean;
}

export interface SurveySubmitResult {
  dropsAwarded: number;
  balance: number;
  /** Ha cruzado los 300 CON este envío. Solo entonces se celebra el tier. */
  tierCrossed: boolean;
  cadenceOffer: CadenceOffer | null;
  /**
   * El cupón de 5 €, o null. Null significa DOS cosas distintas y la pantalla
   * final las trata distinto:
   *   - `hadLiveSubscription: true`  → no le tocaba (es suscriptor). Cierre
   *     normal, sin mencionar ningún descuento.
   *   - `hadLiveSubscription: false` → le tocaba pero Shopify falló. Se le dice
   *     que se lo mandamos por correo, nunca un error en crudo.
   */
  discount: { code: string; expiresAt: string } | null;
  hadLiveSubscription: boolean;
}

// ── GET: estado ──────────────────────────────────────────────────────────────

export const GET = withCustomer<SurveyState>(async (_req, ctx) => {
  const sb = supabaseAdmin();
  // `is("deleted_at", null)`: la fila SOBREVIVE al borrado con una lápida (el cron
  // la necesita para saber a quién vaciarle las cs_*), así que sin este filtro
  // quien pidió el borrado vería `answered: true` con `answers: {}` — el
  // formulario dado por contestado y en blanco, sin poder rellenarlo. Para quien
  // ha ejercido el borrado, el estado correcto es "sin contestar".
  const { data } = await sb
    .from("profile_survey_answers")
    .select("answers, consent")
    .eq("customer_id", ctx.customerId)
    .is("deleted_at", null)
    .maybeSingle();

  const { data: paid } = await sb
    .from("drops_events")
    .select("id")
    .eq("dedup_key", `${DEDUP_PREFIX}${ctx.customerId}`)
    .maybeSingle();

  return {
    answered: !!data,
    answers: (data?.answers as Record<string, string> | undefined) ?? {},
    consent: data?.consent === true,
    alreadyPaid: !!paid,
  };
});

// ── POST: guardar ────────────────────────────────────────────────────────────

export const POST = withCustomer<SurveySubmitResult>(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "survey-profile", { limit: 10, windowMs: 60_000 });

  // El flag tiene que cerrar la ESCRITURA, no solo esconder la tarjeta.
  //
  // Antes solo gateaba la tarjeta del Hub, y eso dejaba el flag inútil justo el
  // día que se necesita: es la palanca de marcha atrás. Si algo sale torcido
  // después de lanzar y se pone en `off`, el enlace directo sigue funcionando
  // para cualquiera que lo tenga, y lo va a tener toda la base porque el email
  // de la campaña lo lleva dentro. Un interruptor de apagado que no apaga es
  // peor que no tenerlo, porque se cuenta con él.
  //
  // Se gatea SOLO el POST. El GET sigue abierto (leer tus propias respuestas no
  // es un favor que se pueda retirar) y el borrado TAMBIÉN, siempre: una
  // petición de supresión no puede depender de una variable de entorno.
  if (!profileSurveyEnabledFor(ctx.customerId)) {
    throw new ApiHttpError(403, "survey_closed", "profile survey is not open for this customer");
  }

  const body = (await req.json().catch(() => ({}))) as SurveyBody;
  if (typeof body.consent !== "boolean") {
    throw new ApiHttpError(400, "missing_consent", "consent (boolean) required");
  }

  // El tipo de TypeScript es solo de compilación: un cliente puede postear
  // cualquier cosa. Se valida contra el banco de preguntas y se guarda lo
  // validado, nunca lo que llegó.
  const v = validateAnswers(body.answers ?? {});
  if (!v.ok) {
    throw new ApiHttpError(
      400,
      v.unknown.length ? "unknown_question" : v.invalid.length ? "invalid_option" : "not_asked",
      `unknown=${v.unknown.join(",")} invalid=${v.invalid.join(",")} notAsked=${v.notAsked.join(",")}`,
    );
  }

  const sb = supabaseAdmin();

  // ── 0. El cupón: ¿le toca, y no lo tiene ya? ───────────────────────────────
  //
  // Se resuelve ANTES del upsert para que el código viaje DENTRO de la misma
  // escritura que las respuestas. Si fueran dos escrituras y la segunda
  // fallara, tendríamos un cupón emitido en Shopify que el cliente nunca ve, y
  // al recargar le emitiríamos otro.
  //
  // Tres reglas, en este orden:
  //
  //  1. IDEMPOTENCIA. Si ya tiene código, se le devuelve EL SUYO. Un cliente
  //     genera cupón una sola vez en la vida, aunque vuelva a rellenar el
  //     formulario para corregir una respuesta semanas después.
  //  2. QUIÉN LO RECIBE. Solo quien NO tiene suscripción viva. Se evalúa aquí
  //     contra el estado real del cliente, nunca contra el origen del clic:
  //     ese dato se pierde al pasar por el login de Shopify.
  //  3. SI SHOPIFY FALLA, se sigue. Las respuestas se guardan igual y
  //     `answered` queda a true. Perder un cupón se arregla a mano; dejar al
  //     cliente en bucle repitiendo nueve preguntas, no.
  const { data: priorRow } = await sb
    .from("profile_survey_answers")
    .select("discount_code, discount_issued_at, discount_expires_at")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();

  let discount: IssuedDiscount | null = priorRow?.discount_code
    ? {
        code: priorRow.discount_code as string,
        issuedAt: priorRow.discount_issued_at as string,
        expiresAt: priorRow.discount_expires_at as string,
      }
    : null;

  // Fuera del `if` porque la pantalla final lo necesita para distinguir "no le
  // tocaba" de "le tocaba y Shopify falló". Para quien YA tenía código, es
  // false: se lo llevó en su día, luego no era suscriptor.
  let hadLiveSubscription = false;

  if (!discount) {
    // `paused` y `reactivating` CUENTAN como viva: una suscripción pausada
    // sigue siendo cliente de suscripción y no le toca el cupón de
    // recuperación. Mismos tres estados que trata la página de Cuenta.
    try {
      const email = await shopifyAdmin.getCustomerEmail(ctx.customerId);
      const live = email ? await resolveActiveSubFast(ctx.customerId, email, null) : null;
      const status = live ? mapToSubscription(live, ctx.customerId).status : null;
      hadLiveSubscription =
        status === "active" || status === "paused" || status === "reactivating";
    } catch (err) {
      // Si Seal no contesta NO se emite cupón. Es la dirección segura: como
      // mucho un one-shot se queda sin él y lo reclama por soporte. Al revés
      // (asumir que no tiene suscripción) le daríamos un cupón de recuperación
      // a un suscriptor activo, que es dinero regalado y un agravio para el
      // resto.
      console.warn("[survey/profile] no se pudo resolver la suscripción, sin cupón:", err);
      hadLiveSubscription = true;
    }

    if (!hadLiveSubscription) {
      try {
        discount = await issueSurveyDiscount(ctx.customerId);
      } catch (err) {
        // El cliente verá "te lo mandamos por correo en unos minutos" en vez de
        // un error en crudo, pero alguien tiene que emitírselo a mano: por eso
        // esto AVISA, no solo loguea.
        //
        // El fallo más probable el día del despliegue es que la app del portal
        // no tenga el scope `write_discounts`, y ese se manifestaría en TODOS
        // los clientes a la vez y en silencio. Con la alerta se ve en el
        // primero; sin ella, se descubriría por reclamaciones.
        console.error("[survey/profile] EMISIÓN DE CUPÓN FALLIDA:", ctx.customerId, err);
        alertSlackError({
          path: "/api/survey/profile",
          code: "survey_discount_failed",
          msg: `No se pudo emitir el cupón de perfilado: ${err instanceof Error ? err.message : String(err)}`,
          customerId: ctx.customerId,
        });
      }
    }
  }

  // ── 1. La respuesta, primero y confirmada ──────────────────────────────────
  // `klaviyo_synced_at: null` en CADA escritura, no solo en la primera. Sin eso,
  // corregir una respuesta ya sincronizada la dejaría congelada en Klaviyo con
  // el valor viejo, que es el bug LIT-397 del CS Platform. Aquí nace cerrado.
  const { error: saveErr } = await sb.from("profile_survey_answers").upsert(
    {
      customer_id: ctx.customerId,
      answers: v.clean,
      consent: body.consent,
      consent_at: body.consent ? new Date().toISOString() : null,
      consent_version: body.consent ? SURVEY_CONSENT.version : null,
      // El idioma en el que LEYÓ el consentimiento, y aquí no se adivina. El
      // api-client reenvía `?lang=` en cada llamada desde el segmento [locale]
      // de la URL, así que normalmente viene. Si no viniera se guarda
      // "unknown" en vez de caer a `customer_preferences.language`, que está a
      // 'en' por DEFECTO del esquema y no es una medición: registraría "en"
      // para alguien que lo leyó en español. Un registro de consentimiento no
      // puede contener una conjetura.
      locale_shown: langFromRequest(req) ?? "unknown",
      klaviyo_synced_at: null,
      // LEVANTAR LA LÁPIDA. Contestar de nuevo después de haber pedido el borrado
      // es una alta, no la continuación de la baja. Sin esto la fila conserva
      // `deleted_at` y el cron entra por su rama de borrado (mira `deleted_at`
      // antes que nada), así que escribe "" en las doce cs_* y VACÍA en Klaviyo
      // las respuestas que el cliente acaba de dar con consentimiento. Y como
      // marca la fila al terminar, no se reintenta nunca: Postgres con datos,
      // Klaviyo vacío, y ni un error en ningún lado.
      deleted_at: null,
      // El cupón viaja en el MISMO upsert que las respuestas: una sola
      // escritura, así que no existe el estado intermedio "código emitido pero
      // encuesta sin marcar". Si `discount` es null se escribe null, que es lo
      // que ya había para quien no le toca.
      discount_code: discount?.code ?? null,
      discount_issued_at: discount?.issuedAt ?? null,
      discount_expires_at: discount?.expiresAt ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "customer_id" },
  );

  if (saveErr) {
    // 42P01 = la tabla no existe: la migración no llegó a producción. Se dice
    // con ese nombre en vez de un 500 genérico, porque es el fallo que más
    // probablemente veremos el día del despliegue y hay que reconocerlo rápido.
    if ((saveErr as { code?: string }).code === "42P01") {
      throw new ApiHttpError(503, "survey_storage_unavailable", "profile_survey_answers missing");
    }
    throw new Error(`profile_survey_answers upsert: ${saveErr.message}`);
  }

  // ── 2. Los drops, en su propio try/catch ───────────────────────────────────
  // Si el CHECK de `drops_events.action` no acepta todavía 'profile_survey', el
  // INSERT revienta. Preferimos perder el premio (reconciliable a posteriori)
  // antes que la respuesta, que el cliente no va a volver a escribir.
  const amount = DROPS_AMOUNTS.profile_survey ?? 50;
  let dropsAwarded = 0;
  try {
    const before = await readBalance(ctx.customerId);
    await awardDrops(
      ctx.customerId,
      "profile_survey",
      amount,
      { source: "portal", answered: Object.keys(v.clean).length },
      `${DEDUP_PREFIX}${ctx.customerId}`,
    );
    const after = await readBalance(ctx.customerId);
    // Se mide el saldo, no se asume: `awardDrops` con dedupKey hace
    // ON CONFLICT DO NOTHING, así que un reenvío no paga y tiene que decir +0.
    dropsAwarded = Math.max(0, after.balance - before.balance);
  } catch (err) {
    console.error("[survey/profile] drops award failed:", err);
  }

  const { balance } = await readBalance(ctx.customerId);
  // Solo se celebra si ha cruzado CON este envío. Se compara el saldo contra el
  // que tenía antes de pagar, no `tier_earned_at`: quien ya era INNER CIRCLE
  // también tiene esa fecha puesta, y decirle "acabas de entrar" a alguien que
  // lleva dentro tres meses es peor que no decirle nada.
  const tierCrossed =
    dropsAwarded > 0 && balance >= TIER_THRESHOLD && balance - dropsAwarded < TIER_THRESHOLD;

  // ── 3. La propuesta de cadencia ────────────────────────────────────────────
  const cadenceOffer = await buildCadenceOffer(ctx.customerId, v.clean);

  return {
    dropsAwarded,
    balance,
    tierCrossed,
    cadenceOffer,
    discount: discount ? { code: discount.code, expiresAt: discount.expiresAt } : null,
    hadLiveSubscription,
  };
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function readBalance(
  customerId: string,
): Promise<{ balance: number; tierEarnedAt: string | null }> {
  const { data } = await supabaseAdmin()
    .from("drops_balances")
    .select("balance, tier_earned_at")
    .eq("customer_id", customerId)
    .maybeSingle();
  return {
    balance: (data?.balance as number | undefined) ?? 0,
    tierEarnedAt: (data?.tier_earned_at as string | null | undefined) ?? null,
  };
}

/**
 * Lee la suscripción VIVA y decide si se propone espaciar.
 *
 * Best-effort de punta a punta: si Seal no contesta, no hay oferta y el cliente
 * ve su pantalla de gracias igual. Una propuesta es un extra; perder el acuse de
 * los 50 drops por un timeout de Seal no lo es.
 */
async function buildCadenceOffer(
  customerId: string,
  answers: Record<string, string>,
): Promise<CadenceOffer | null> {
  try {
    const email = await shopifyAdmin.getCustomerEmail(customerId);
    if (!email) return null;

    const live = await resolveActiveSubFast(customerId, email, null);
    if (!live) return null;
    const sub = mapToSubscription(live, customerId);

    // Exclusiones que NO son de la regla, sino del estado de la suscripción.
    // Cada una con su motivo, porque todas se descubrieron leyendo el código:
    //  - no activa: un post_cancel no tiene cadencia futura que cambiar.
    //  - dentro de la ventana de corte: el cambio fallaría con `cutoff_passed`, y
    //    enseñar un botón con fallo garantizado es peor que no enseñar nada.
    //  - sin próxima entrega: Seal está regenerando el calendario; no se apila
    //    una mutación encima.
    //  - las cajas leídas no cuadran con la composición: son las dos subs de más
    //    de 6 cajas, que `getBoxCount` clampa. Ahí la aritmética miente por la
    //    mitad y un cambio les partiría el envío.
    if (sub.status !== "active") return null;
    if (sub.withinCutoff) return null;
    if (!sub.nextShipDate) return null;

    const realBoxes = mixBoxCount(sub.composition ?? []);
    if (realBoxes === 0) return null;
    if (realBoxes !== sub.boxCount) return null;

    const fit = suggestLongerCadence({
      currentFrequency: sub.frequency,
      realBoxes,
      boxDuration: answers["caja_dura"],
      stockLeft: answers["stock_dura"],
    });
    if (!fit.target) return null;

    return { from: sub.frequency, to: fit.target, cappedAtSixMonths: fit.cappedAtSixMonths };
  } catch (err) {
    console.warn("[survey/profile] cadence offer skipped:", err);
    return null;
  }
}

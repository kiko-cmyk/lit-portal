import { after } from "next/server";

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
import { mapToSubscription, seal } from "@/lib/seal";
import { klaviyo } from "@/lib/klaviyo";
import { runWithoutRequestDeadline } from "@/lib/http-timeout";
import { formatShipDateEs } from "@/lib/ship-date-label";
import {
  DISCOUNT_VALUE_EUR,
  generateCode,
  issueSurveyDiscount,
  type IssuedDiscount,
} from "@/lib/survey-discount";
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
  await enforceRateLimit(ctx.customerId, "survey-profile", {
    limit: 10,
    windowMs: 60_000,
  });

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
    throw new ApiHttpError(
      403,
      "survey_closed",
      "profile survey is not open for this customer",
    );
  }

  const body = (await req.json().catch(() => ({}))) as SurveyBody;
  if (typeof body.consent !== "boolean") {
    throw new ApiHttpError(
      400,
      "missing_consent",
      "consent (boolean) required",
    );
  }
  // La casilla es OBLIGATORIA para enviar (Juan 2026-09-22). Antes se aceptaba
  // `false` y la respuesta se guardaba para el agregado sin escribir en
  // Klaviyo; ahora sin permiso no se guarda nada.
  //
  // Se comprueba AQUÍ además de deshabilitar el botón: el `disabled` es del
  // navegador y esta ruta es pública para cualquiera con sesión.
  //
  // OJO, esto NO convierte el consentimiento en obligatorio para el cliente:
  // sigue siendo libre porque puede no contestar el formulario, que no le
  // quita nada (los drops del formulario no son un derecho adquirido y el
  // cupón tampoco se promete sin contestar). Lo que ya no existe es el estado
  // intermedio "te guardo los datos pero no los uso", que es el que costaba
  // explicar y el que nadie miraba.
  if (body.consent !== true) {
    throw new ApiHttpError(
      400,
      "consent_required",
      "the consent checkbox must be ticked to submit",
    );
  }

  // El tipo de TypeScript es solo de compilación: un cliente puede postear
  // cualquier cosa. Se valida contra el banco de preguntas y se guarda lo
  // validado, nunca lo que llegó.
  const v = validateAnswers(body.answers ?? {});
  if (!v.ok) {
    throw new ApiHttpError(
      400,
      v.unknown.length
        ? "unknown_question"
        : v.invalid.length
          ? "invalid_option"
          : "not_asked",
      `unknown=${v.unknown.join(",")} invalid=${v.invalid.join(",")} notAsked=${v.notAsked.join(",")}`,
    );
  }

  // Al menos UNA respuesta. Enviar el formulario en blanco cobraba los 50 drops
  // y, a un no suscriptor, el cupón de 5 €, a cambio de cero información. Y
  // encima el banner le seguía saliendo, porque con `answers` vacío la tarjeta
  // lo cuenta como no contestado: el cliente veía que "no le había servido" y
  // podía repetirlo. Se comprueba en servidor y no solo deshabilitando el botón,
  // porque esta ruta la alcanza cualquiera con sesión. (Kiko, 2026-09-24.)
  if (Object.keys(v.clean).length === 0) {
    throw new ApiHttpError(
      400,
      "no_answers",
      "at least one answer is required to submit the survey",
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
    .select(
      "discount_code, discount_issued_at, discount_expires_at, was_subscriber_at_answer",
    )
    .eq("customer_id", ctx.customerId)
    .maybeSingle();

  // Si YA tenía cupón de una respuesta anterior. Se guarda aparte porque
  // `discount` se reasigna al emitir uno nuevo, y entonces deja de poder
  // distinguir "venía de antes" de "acabo de emitirlo".
  const hadPriorDiscount = Boolean(priorRow?.discount_code);

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

  // Distingue "he medido y NO tenía suscripción" de "no pude medir". Sin esta
  // bandera las dos cosas valen `false` en la variable de arriba y acaban
  // guardadas igual, que es como un fallo de Seal se convierte en un dato de
  // negocio falso.
  let subscriptionCheckFailed = false;

  // El email se resuelve UNA vez y fuera del `if`: lo necesitan el cupón (para
  // preguntar a Seal) y el evento de Klaviyo (para identificar el perfil), y
  // pedirlo dos veces a Shopify sería una llamada de más en una ruta que ya
  // habla con Seal, Supabase y Shopify.
  const customerEmail = await shopifyAdmin
    .getCustomerEmail(ctx.customerId)
    .catch(() => null);

  if (!discount) {
    // `paused` y `reactivating` CUENTAN como viva: una suscripción pausada
    // sigue siendo cliente de suscripción y no le toca el cupón de
    // recuperación. Mismos tres estados que trata la página de Cuenta.
    //
    // ── Por qué se pregunta a Seal por EMAIL y no por la caché (2026-09-23) ──
    //
    // Aquí vivía `resolveActiveSubFast`, y regaló 3 cupones de 5 € a
    // suscriptores activos el día del lanzamiento. Esa función es un ATAJO que
    // mira solo la caché de Supabase y devuelve `null` en cuanto no encuentra
    // la fila; su propio docstring dice que es seguro "porque el llamante cae
    // al escaneo por email". El portal hace ese fallback. ESTA RUTA NO LO
    // HACÍA, así que un cache miss se leía como "no tiene suscripción".
    //
    // Maria Nicolau lo demostró: sub ACTIVE en Seal desde julio, CERO filas en
    // la caché porque nunca entró al portal. Cupón emitido.
    //
    // Y lo que es peor: `resolveActiveSubFast` termina en `catch { return null }`,
    // así que un fallo de Seal o de Supabase llegaba aquí disfrazado de "no
    // tiene suscripción" en vez de como excepción. El `catch` de abajo, que
    // existe justamente para NO emitir cupón cuando Seal no contesta, era
    // inalcanzable: la protección estaba escrita y no se ejecutaba nunca.
    //
    // `getSubscriptionsByEmail` es la fuente de verdad (Seal lo es, la tabla
    // `subscriptions` es solo una caché parcial poblada por webhooks) y además
    // PROPAGA los fallos en vez de tragárselos, que es lo que devuelve el
    // sentido al `catch`. Cuesta una llamada extra en una ruta que se ejecuta
    // una vez por cliente y no está en ningún camino crítico: el atajo no
    // compraba nada aquí y costaba 5 € por error.
    try {
      const email = customerEmail;
      if (!email) {
        // Sin email no se puede preguntar a Seal. Misma dirección segura que el
        // catch: no emitir antes que emitir a ciegas.
        throw new Error("sin email de cliente para resolver la suscripción");
      }
      const subs = await seal.getSubscriptionsByEmail(email);
      hadLiveSubscription = subs.some((s) => {
        const status = mapToSubscription(s, ctx.customerId).status;
        return (
          status === "active" ||
          status === "paused" ||
          status === "reactivating"
        );
      });
    } catch (err) {
      // Si Seal no contesta NO se emite cupón. Es la dirección segura: como
      // mucho un one-shot se queda sin él y lo reclama por soporte. Al revés
      // (asumir que no tiene suscripción) le daríamos un cupón de recuperación
      // a un suscriptor activo, que es dinero regalado y un agravio para el
      // resto.
      console.warn(
        "[survey/profile] no se pudo resolver la suscripción, sin cupón:",
        err,
      );
      hadLiveSubscription = true;
      // Marca el camino de fallo para NO grabar `was_subscriber_at_answer`.
      // `hadLiveSubscription = true` es una decisión operativa ("ante la duda,
      // no emitas"), no una medición: guardarla dejaría a un one-shot anotado
      // como suscriptor PARA SIEMPRE, sin cupón, sin poder reintentarlo y
      // ensuciando la conversión. NULL es lo honesto: no se midió. (Kiko,
      // 2026-09-24.)
      subscriptionCheckFailed = true;
      // Y avisa, porque si no esto es invisible: el cliente ve su pantalla de
      // gracias tan normal y nadie se entera de que Seal no contestó.
      alertSlackError({
        path: "/api/survey/profile",
        code: "survey_subscription_check_failed",
        msg: `No se pudo comprobar la suscripción, cupón NO emitido: ${err instanceof Error ? err.message : String(err)}`,
        customerId: ctx.customerId,
      });
    }

    if (!hadLiveSubscription) {
      // ── La reserva, ANTES de tocar Shopify ──────────────────────────────
      //
      // Un UPDATE condicional sobre la fila: solo escribe si `discount_code`
      // sigue a NULL. Postgres serializa los UPDATE de una misma fila, así que
      // de dos peticiones simultáneas exactamente UNA recibe fila de vuelta; la
      // otra recibe cero y no crea nada.
      //
      // El índice único NO cubría esto, aunque el comentario de la migración
      // del 22-sep dijera lo contrario: es un índice sobre `discount_code`, o
      // sea que impide repartir el MISMO código dos veces, pero dos códigos
      // aleatorios distintos para el mismo cliente entran sin chocar. El caso
      // real no es el doble clic (ya lo tapa `busy` en el front) sino el
      // timeout de ~10 s del App Proxy contra el `maxDuration` de 20: el
      // cliente ve el error y reenvía mientras el servidor sigue trabajando.
      // (Kiko, 2026-09-24.)
      //
      // Si la reserva falla, se sigue SIN cupón en vez de emitir a ciegas:
      // duplicar un descuento cuesta dinero, quedarse sin él se arregla a mano.
      const reservedCode = generateCode();
      const { data: reserved, error: reserveErr } = await sb
        .from("profile_survey_answers")
        .update({ discount_code: reservedCode })
        .eq("customer_id", ctx.customerId)
        .is("discount_code", null)
        .select("discount_code")
        .maybeSingle();

      if (reserveErr) {
        console.error(
          "[survey/profile] reserva de cupón fallida:",
          ctx.customerId,
          reserveErr,
        );
        alertSlackError({
          path: "/api/survey/profile",
          code: "survey_discount_reserve_failed",
          msg: `No se pudo reservar el código del cupón: ${reserveErr.message}`,
          customerId: ctx.customerId,
        });
      }

      // Sin fila de vuelta: o la ganó otra petición en paralelo, o el cliente
      // aún no tiene fila (primera respuesta). Se distinguen releyendo: si ya
      // hay código es que ganó la otra y se le devuelve EL SUYO, que es la misma
      // idempotencia de siempre.
      let codeToIssue: string | null = reserved?.discount_code ?? null;
      if (!codeToIssue && !reserveErr) {
        const { data: raced } = await sb
          .from("profile_survey_answers")
          .select("discount_code, discount_issued_at, discount_expires_at")
          .eq("customer_id", ctx.customerId)
          .maybeSingle();
        if (raced?.discount_code) {
          // Otra petición ya lo emitió mientras tanto.
          discount = {
            code: raced.discount_code as string,
            issuedAt: raced.discount_issued_at as string,
            expiresAt: raced.discount_expires_at as string,
          };
        } else {
          // No hay fila todavía: el upsert de más abajo la crea con el código,
          // y es esa escritura la que queda protegida por la PK de customer_id.
          codeToIssue = reservedCode;
        }
      }

      if (codeToIssue) {
        try {
          discount = await issueSurveyDiscount(ctx.customerId, codeToIssue);
        } catch (err) {
          // El cliente verá "te lo mandamos por correo en unos minutos" en vez de
          // un error en crudo, pero alguien tiene que emitírselo a mano: por eso
          // esto AVISA, no solo loguea.
          //
          // El fallo más probable el día del despliegue es que la app del portal
          // no tenga el scope `write_discounts`, y ese se manifestaría en TODOS
          // los clientes a la vez y en silencio. Con la alerta se ve en el
          // primero; sin ella, se descubriría por reclamaciones.
          console.error(
            "[survey/profile] EMISIÓN DE CUPÓN FALLIDA:",
            ctx.customerId,
            err,
          );
          alertSlackError({
            path: "/api/survey/profile",
            code: "survey_discount_failed",
            msg: `No se pudo emitir el cupón de perfilado: ${err instanceof Error ? err.message : String(err)}`,
            customerId: ctx.customerId,
          });

          // LIBERAR LA RESERVA. Shopify no llegó a crear el descuento, así que
          // ese código no existe en ninguna parte: dejarlo puesto condenaría al
          // cliente a no recibir cupón NUNCA (la reserva ya no está a NULL y
          // ningún reintento la ganaría), con un código muerto en la fila. Se
          // devuelve a NULL solo si sigue siendo EL NUESTRO, para no pisar el de
          // una petición paralela que sí lo consiguió.
          await sb
            .from("profile_survey_answers")
            .update({ discount_code: null })
            .eq("customer_id", ctx.customerId)
            .eq("discount_code", codeToIssue)
            .then(
              () => undefined,
              (e: unknown) =>
                console.error(
                  "[survey/profile] no se pudo liberar la reserva:",
                  e,
                ),
            );
        }
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
      // CONGELADO en el instante de contestar, y por eso se guarda aquí en vez
      // de leerlo después del tag de Shopify. El tag dice lo que el cliente es
      // HOY: el 23-sep, tres personas contestaron siendo one-shot y se
      // suscribieron ese mismo día usando el cupón, así que la foto de hoy las
      // muestra como suscriptoras y borra justo el dato que importa (a quién le
      // tocaba cupón, y quién se convirtió DESPUÉS de contestar).
      //
      // Hasta hoy este valor solo viajaba a Klaviyo como
      // `has_active_subscription` y no se guardaba en ningún sitio nuestro.
      //
      // NO se pisa el valor de una respuesta anterior. Quien ya tenía cupón no
      // vuelve a pasar por la comprobación de Seal (el `if (!discount)` de
      // arriba), así que `hadLiveSubscription` sigue en su `false` inicial sin
      // haberse calculado: escribirlo tal cual convertiría a un suscriptor en
      // "no era suscriptor" la primera vez que corrigiese una respuesta. Se
      // conserva lo que ya hubiera, que es la medición buena.
      // Y si la fila vieja lo tiene a NULL (respuestas anteriores al 23-sep) se
      // deja en NULL en vez de caer a `hadLiveSubscription`: para quien ya
      // tenía cupón ese valor no se ha medido, y NULL significa exactamente eso
      // ("no registrado"). Escribir `false` convertiría un dato ausente en uno
      // incorrecto, que es peor porque no se distingue del medido de verdad.
      // La regla, en una línea: se escribe SOLO la primera vez. Si la fila ya
      // trae un valor medido (true o false), gana ese. `?? ` y no `||`, porque
      // `false` es una medición legítima y con `||` se perdería.
      was_subscriber_at_answer:
        priorRow?.was_subscriber_at_answer ??
        (hadPriorDiscount || subscriptionCheckFailed
          ? null
          : hadLiveSubscription),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "customer_id" },
  );

  if (saveErr) {
    // 42P01 = la tabla no existe: la migración no llegó a producción. Se dice
    // con ese nombre en vez de un 500 genérico, porque es el fallo que más
    // probablemente veremos el día del despliegue y hay que reconocerlo rápido.
    if ((saveErr as { code?: string }).code === "42P01") {
      throw new ApiHttpError(
        503,
        "survey_storage_unavailable",
        "profile_survey_answers missing",
      );
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
    dropsAwarded > 0 &&
    balance >= TIER_THRESHOLD &&
    balance - dropsAwarded < TIER_THRESHOLD;

  // ── 2.5. El evento de Klaviyo, que dispara el flow de los dos emails ───────
  //
  // SIEMPRE que las respuestas se hayan guardado, incluso si el cliente tiene
  // suscripción y no le toca cupón: así el flow puede filtrar por
  // `has_active_subscription` y de paso queda la analítica de quién completa la
  // encuesta, que se perdería emitiendo solo a los que reciben código.
  //
  // La ÚNICA excepción es el fallo de emisión, y es deliberada: si Shopify
  // falló, `discount_code` iría vacío y el email dice "aquí están tus 5 €"
  // desde el titular. Un email así es peor que ninguno. Ese caso ya avisa por
  // Slack para emitirlo a mano.
  const emisionFallida = !discount && !hadLiveSubscription;
  if (customerEmail && !emisionFallida) {
    // En `after()`, NO fire-and-forget con `void`.
    //
    // El cliente ya ha contestado y tiene su código en pantalla, así que esto no
    // puede sumarle latencia ni tumbarle la respuesta. Pero con `void` la
    // promesa quedaba huérfana: si la función se congela al responder, Vercel
    // corta la invocación y el evento se pierde, y con él el correo que lleva el
    // cupón. Sin un error en ningún lado. `after()` mantiene viva la invocación
    // hasta que termina, y `runWithoutRequestDeadline` porque a estas alturas el
    // presupuesto de la petición está gastado por definición (mismo patrón que
    // `subscription/address`). (Kiko, 2026-09-24.)
    after(() =>
      runWithoutRequestDeadline(() =>
        klaviyo
          .trackEvent(
            "Profile Survey Completed",
            customerEmail,
            {
              discount_code: discount?.code ?? null,
              discount_expires_at: discount?.expiresAt ?? null,
              // La fecha YA formateada ("22 de octubre"). El filtro |date de Django
              // devuelve '' en silencio sobre un string, que es como el recordatorio
              // de 7d salió con la fecha en blanco a 524 personas en julio. Se
              // reutiliza `formatShipDateEs`, que nació de aquel mismo bug.
              discount_expires_label: formatShipDateEs(discount?.expiresAt),
              discount_value: DISCOUNT_VALUE_EUR,
              has_active_subscription: hadLiveSubscription,
              survey_completed_at: new Date().toISOString(),
            },
            {
              // Klaviyo deduplica por aquí: un reintento del submit no dispara el
              // flow dos veces ni manda un segundo email con el código.
              uniqueId: `survey-${ctx.customerId}`,
              externalId: ctx.customerId,
            },
          )
          .catch((err) => {
            console.error(
              "[survey/profile] evento Klaviyo fallido:",
              ctx.customerId,
              err,
            );
            alertSlackError({
              path: "/api/survey/profile",
              code: "survey_event_failed",
              msg: `El evento Profile Survey Completed no salió: ${err instanceof Error ? err.message : String(err)}`,
              customerId: ctx.customerId,
            });
          }),
      ),
    );
  }

  // ── 3. La propuesta de cadencia ────────────────────────────────────────────
  const cadenceOffer = await buildCadenceOffer(ctx.customerId, v.clean);

  return {
    dropsAwarded,
    balance,
    tierCrossed,
    cadenceOffer,
    discount: discount
      ? { code: discount.code, expiresAt: discount.expiresAt }
      : null,
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

    return {
      from: sub.frequency,
      to: fit.target,
      cappedAtSixMonths: fit.cappedAtSixMonths,
    };
  } catch (err) {
    console.warn("[survey/profile] cadence offer skipped:", err);
    return null;
  }
}

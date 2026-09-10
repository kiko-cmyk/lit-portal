/**
 * El texto del consentimiento del formulario de perfilado, VERSIONADO.
 *
 * Vive aquí y no dentro del JSX por una razón que no es de estilo: hay que poder
 * demostrar QUÉ aceptó cada cliente. Con la frase suelta en la pantalla, editarla
 * reescribe en silencio lo que la gente ya había aceptado, y el registro de la
 * base apuntaría a una versión que ya no existe en ningún sitio.
 *
 * REGLA: si cambias el texto, SUBE la versión. Nunca lo edites en su sitio.
 * `profile_survey_answers.consent_version` guarda cuál leyó cada uno.
 *
 * Y dos cosas del diseño que dependen de este texto:
 *   - La casilla NO controla los 50 drops. Si el premio dependiera de consentir,
 *     el consentimiento no sería libre y quedaría inválido, y perderíamos las dos
 *     cosas: el dato y la base legal.
 *   - La casilla SÍ controla que se escriban las `cs_*` en Klaviyo. Sin marcar,
 *     la respuesta se guarda y cuenta en el agregado, pero el perfil no se toca.
 *     Es exactamente lo que la frase promete, y es un `if` en el cron de sync.
 */

export const SURVEY_CONSENT = {
  // v4 (2026-09-10, frase de Juan): "permito … para ajustar mis preferencias".
  //
  // Se CONSERVA la última frase, la de retirar el permiso: un consentimiento
  // tiene que decir cómo se retira, y sin ella la casilla dejaría de ser una
  // base válida. Es la única pieza que no se puede recortar por estilo. El
  // resto (quién y para qué) va tal cual.
  //
  // Se sube la versión en vez de editar en su sitio: quien aceptó la v3 aceptó
  // otra frase, y `consent_version` tiene que poder distinguirlas.
  version: 4,
  es:
    "Sí, permito que LIT Hydration España S.L. utilice mis respuestas para ajustar " +
    "mis preferencias. Nada más. Puedo retirar este permiso cuando quiera " +
    "escribiendo a hola@litsalt.com.",
  en:
    "Yes, I allow LIT Hydration España S.L. to use my answers to tune my " +
    "preferences. Nothing else. I can withdraw this permission any time by " +
    "writing to hola@litsalt.com.",
} as const;

/**
 * El aviso que va ENCIMA del formulario. No es el consentimiento (eso es la
 * casilla): es la información previa, y por eso no se versiona igual.
 *
 * La razón social sale de la política de privacidad de litsalt.com, leída el
 * 2026-09-01: LIT Hydration España S.L., en Madrid. El CIF no aparece publicado
 * ahí; si algún día hace falta en este aviso, se pide a finanzas.
 *
 * 🔴 AVISO QUE NO ES DE ESTE FORMULARIO PERO LO TOCA. La política de privacidad
 * dice hoy, literalmente: "Almacenamos los datos en servidores seguros ubicados
 * en la Unión Europea". Es FALSO: Klaviyo guarda los datos en Estados Unidos, y
 * lleva años haciéndolo. Este formulario no crea el problema, pero enlazar a esa
 * página desde aquí lo empeora, porque le estaríamos diciendo al cliente
 * "tus respuestas van a Estados Unidos" y a un clic "tus datos están en la UE".
 * Por eso el bullet de abajo dice dónde acaban DE VERDAD. Corregir la política
 * es una tarea aparte y de la web, no de aquí.
 *
 * REDACCIÓN (Juan 2026-09-10): el bullet ya no nombra a Klaviyo ni a Estados
 * Unidos por su nombre, dice "la herramienta con la que te escribimos, que
 * guarda los datos fuera de la UE". Sigue siendo cierto y sigue avisando de la
 * transferencia, que es la parte que no se puede omitir; lo que se quita es el
 * nombre del proveedor, que al cliente no le dice nada. Si algún día se deja de
 * escribir en Klaviyo, esta frase hay que revisarla: pasaría a sobrar.
 *
 * La viñeta de "todas son opcionales y te llevas los 50 drops" se quitó el
 * 2026-09-10: lo de opcionales lo dice ahora la propia pantalla, en grande, y
 * los drops no se anuncian mientras la función no esté visible para el cliente.
 * Que ninguna pregunta sea obligatoria no cambia, es el comportamiento real del
 * formulario.
 */
export const SURVEY_NOTICE = {
  es: {
    intro:
      "Cada cuerpo tiene su ritmo y el tuyo no lo conocemos todavía. Cuéntanoslo y " +
      "ajustamos lo que te mandamos: cuándo, cuánto y de qué sabor.",
    // Etiqueta + valor por separado, no una frase con dos puntos: así la
    // pantalla puede pintar la etiqueta como tal y el aviso se ESCANEA en vez
    // de leerse. Ver el bloque en ProfileSurveyOverlay.
    bullets: [
      { k: "Quién las trata", v: "LIT Hydration España S.L." },
      {
        k: "Dónde acaban",
        v:
          "En nuestra base de datos y en la herramienta con la que te escribimos, " +
          "que guarda los datos fuera de la UE. No los vendemos ni los cedemos a " +
          "nadie más.",
      },
      { k: "Cuánto las guardamos", v: "Mientras tengas cuenta activa con nosotros." },
      { k: "Y si cambias de idea", v: "Puedes cambiarlas o borrarlas volviendo aquí." },
    ],
  },
  en: {
    intro:
      "Every body has its own rhythm and we don't know yours yet. Tell us, and we'll " +
      "tune what we send you: when, how much and which flavour.",
    bullets: [
      { k: "Who handles them", v: "LIT Hydration España S.L." },
      {
        k: "Where they end up",
        v:
          "In our database and in the tool we email you with, which stores data " +
          "outside the EU. We don't sell them or pass them to anyone else.",
      },
      { k: "How long we keep them", v: "As long as your account with us is active." },
      { k: "If you change your mind", v: "You can change or delete them by coming back here." },
    ],
  },
} as const;

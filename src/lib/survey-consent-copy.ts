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
  // v2: la frase nombra al responsable del tratamiento por su razón social.
  // Se sube la versión en vez de editar en su sitio: quien ya hubiera aceptado
  // la v1 aceptó otra frase, y el registro tiene que poder distinguirlas.
  version: 2,
  es:
    "Doy permiso a LIT Hydration España S.L. para usar estas respuestas para personalizar lo que me manda: " +
    "emails, ofertas y recomendaciones de producto. Puedo retirarlo cuando quiera " +
    "escribiendo a hola@litsalt.com.",
  en:
    "I give LIT Hydration España S.L. permission to use these answers to personalise what it sends me: " +
    "emails, offers and product recommendations. I can withdraw it any time by " +
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
 */
export const SURVEY_NOTICE = {
  es: {
    intro:
      "Unas preguntas rápidas sobre cómo tomas LIT. Nos sirven para dejar de mandarte " +
      "lo mismo que a todo el mundo.",
    bullets: [
      "Todas son opcionales, y te llevas los 50 drops contestes lo que contestes.",
      "Quién las trata: LIT Hydration España S.L. No vendemos tus respuestas.",
      "Dónde acaban: en nuestra base de datos y en Klaviyo, la herramienta con la que " +
        "te escribimos, que guarda los datos en Estados Unidos.",
      "Cuánto las guardamos: mientras tengas cuenta con nosotros.",
      "Puedes cambiarlas cuando quieras volviendo a este formulario.",
    ],
  },
  en: {
    intro:
      "A few quick questions about how you drink LIT. They're what stops us sending " +
      "you the same as everyone else.",
    bullets: [
      "All of them are optional, and you get the 50 drops whatever you answer.",
      "Who handles them: LIT Hydration España S.L. We don't sell your answers.",
      "Where they end up: in our database and in Klaviyo, the tool we email you with, " +
        "which stores data in the United States.",
      "How long we keep them: as long as you have an account with us.",
      "You can change them any time by coming back to this form.",
    ],
  },
} as const;

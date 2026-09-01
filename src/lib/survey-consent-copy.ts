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
  version: 1,
  es:
    "Doy permiso a LIT para usar estas respuestas para personalizar lo que me manda: " +
    "emails, ofertas y recomendaciones de producto. Puedo retirarlo cuando quiera " +
    "escribiendo a hola@litsalt.com.",
  en:
    "I give LIT permission to use these answers to personalise what it sends me: " +
    "emails, offers and product recommendations. I can withdraw it any time by " +
    "writing to hola@litsalt.com.",
} as const;

/**
 * El aviso que va ENCIMA del formulario. No es el consentimiento (eso es la
 * casilla): es la información previa, y por eso no se versiona igual.
 *
 * PENDIENTE antes de lanzar: la razón social exacta. "El equipo de LIT" no basta
 * para el RGPD y no está en ninguno de los tres repos, así que tiene que salir de
 * la política de privacidad de la web o de finanzas.
 */
export const SURVEY_NOTICE = {
  es: {
    intro:
      "Unas preguntas rápidas sobre cómo tomas LIT. Nos sirven para dejar de mandarte " +
      "lo mismo que a todo el mundo.",
    bullets: [
      "Todas son opcionales, y te llevas los 50 drops contestes lo que contestes.",
      "Quién las ve: el equipo de LIT. No vendemos tus respuestas.",
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
      "Who sees them: the LIT team. We don't sell your answers.",
      "Where they end up: in our database and in Klaviyo, the tool we email you with, " +
        "which stores data in the United States.",
      "How long we keep them: as long as you have an account with us.",
      "You can change them any time by coming back to this form.",
    ],
  },
} as const;

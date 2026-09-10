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
  // v3 (2026-09-10): se reescribe para que se lea como una frase y no como un
  // pliego. Dice lo mismo con las mismas piezas obligatorias (quién, para qué,
  // y cómo se retira), en la voz del cliente y no en la del departamento
  // legal. Se sube la versión en vez de editar en su sitio: quien aceptó la v2
  // aceptó otra frase, y el registro tiene que poder distinguirlas.
  version: 3,
  es:
    "Sí, quiero que LIT Hydration España S.L. use lo que he contestado para afinar " +
    "lo que me manda. Nada más. Puedo cambiar de idea cuando quiera escribiendo a " +
    "hola@litsalt.com.",
  en:
    "Yes, I want LIT Hydration España S.L. to use my answers to fine-tune what it " +
    "sends me. Nothing else. I can change my mind any time by writing to " +
    "hola@litsalt.com.",
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
    bullets: [
      "Quién las trata: LIT Hydration España S.L. No vendemos tus respuestas.",
      "Dónde acaban: en nuestra base de datos y en Klaviyo, la herramienta con la que " +
        "te escribimos, que guarda los datos en Estados Unidos.",
      "Cuánto las guardamos: mientras tengas cuenta activa con nosotros.",
      "Puedes cambiarlas o borrarlas cuando quieras volviendo aquí.",
    ],
  },
  en: {
    intro:
      "Every body has its own rhythm and we don't know yours yet. Tell us, and we'll " +
      "tune what we send you: when, how much and which flavour.",
    bullets: [
      "Who handles them: LIT Hydration España S.L. We don't sell your answers.",
      "Where they end up: in our database and in Klaviyo, the tool we email you with, " +
        "which stores data in the United States.",
      "How long we keep them: as long as your account with us is active.",
      "You can change or delete them any time by coming back here.",
    ],
  },
} as const;

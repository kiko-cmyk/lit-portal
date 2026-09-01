/**
 * Banco de preguntas del formulario de perfilado ("Conoce a tus clientes").
 *
 * FUENTE ÚNICA. Lo importan la pantalla (para pintar las opciones) y la ruta
 * (para validar lo que llega). No es cosmético: el repo ya tiene documentado el
 * bug contrario en `api/subscription/cancel/route.ts`, donde un valor tiene que
 * existir en tres sitios sincronizados (el componente, el Set del servidor y el
 * CHECK de Postgres) y añadir uno solo en dos de ellos revienta como un 500.
 * Aquí las respuestas van en `jsonb` sin CHECK sobre los valores y la validación
 * sale de este mismo módulo, así que los tres sitios son uno.
 *
 * ── La regla de los valores, que es donde esto se rompe en SILENCIO ──
 *
 * Las preguntas HEREDADAS guardan la cadena castellana del CS Platform BYTE A
 * BYTE, acentos y espacios incluidos (`Gym / fuerza`, `Pádel / tenis`, `Sí`).
 * El origen es `_PERFILADO` en
 *   lit-dashboard/backend/app/services/crm_scripts.py
 * y esa cadena viaja cruda hasta la propiedad `cs_*` de Klaviyo
 * (`KLAVIYO_PROP_MAP` en lit-dashboard/backend/etl/crm_ingest.py). Un segmento
 * `cs_uso = "Deporte"` NO ve a nadie cuyo valor se guardara como `sport`, y eso
 * no produce ningún error: produce un segmento con la mitad de la gente, que se
 * lee como "hay pocos clientes así". Esta casa ya perdió el 48% de una ciudad
 * porque `valencia` y `valència` eran dos claves.
 *
 * Las preguntas NUEVAS guardan código máquina (`1mo`, `lt2w`), porque el motor
 * de cadencia hace aritmética con ellas y parsear "Mes y medio" es absurdo.
 *
 * Y en las dos: EL VALOR GUARDADO NO ES LA ETIQUETA MOSTRADA. Dos valores
 * heredados están en tercera persona porque los escribió un operador
 * ("No lo usa", "Tiene un problema"): se guardan así y se muestran en primera.
 * El portal es bilingüe, así que si el valor saliera de la etiqueta, un cliente
 * en español guardaría "Correr" y uno en inglés "Running" para el mismo deporte.
 */

/** Una opción: lo que se GUARDA (`value`) y lo que se MUESTRA (`en`/`es`). */
export interface ProfileOption {
  value: string;
  en: string;
  es: string;
}

export interface ProfileQuestion {
  key: string;
  /** Propiedad de Klaviyo, o null si la respuesta se queda solo en Postgres. */
  klaviyoProp: string | null;
  /** true → el valor es la cadena del CS y no se puede tocar nunca. */
  inherited: boolean;
  en: string;
  es: string;
  /** Microcopia bajo el enunciado. */
  helpEn?: string;
  helpEs?: string;
  /** Bloque/pantalla (1..3). */
  screen: 1 | 2 | 3;
  /** Solo se pregunta si la respuesta de `key` NO está en `unless`. */
  gatedBy?: { key: string; unless: string[] };
  options: ProfileOption[];
}

const o = (value: string, en: string, es: string): ProfileOption => ({ value, en, es });

export const PROFILE_QUESTIONS: ProfileQuestion[] = [
  // ── Pantalla 1 · ¿Cómo te va con LIT? ─────────────────────────────────────
  {
    key: "situacion",
    klaviyoProp: "cs_situacion",
    inherited: true,
    screen: 1,
    en: "How's LIT working out for you?",
    es: "¿Qué tal te va con LIT?",
    options: [
      o("Encantado", "Loving it", "Encantado"),
      o("Bien", "Good", "Bien"),
      o("Regular", "So-so", "Regular"),
      // Tercera persona en el valor porque lo escribió un operador. Se muestra
      // en primera. Este es el caso literal de "el valor no es la etiqueta".
      o("No lo usa", "I barely drink it", "Casi no lo tomo"),
      o("Tiene un problema", "I've got a problem", "Tengo un problema"),
    ],
  },
  {
    key: "uso",
    klaviyoProp: "cs_uso",
    inherited: true,
    screen: 1,
    en: "What do you drink it for?",
    es: "¿Para qué lo tomas?",
    options: [
      o("Deporte", "Sport", "Deporte"),
      o("Trabajo / foco", "Work or focus", "Trabajo o foco"),
      o("Resaca", "Hangovers", "Resaca"),
      o("Calor / verano", "Heat or summer", "Calor o verano"),
      o("Salud diaria", "My daily health", "Mi salud diaria"),
      o("Otro", "Something else", "Otro"),
    ],
  },

  // ── Pantalla 2 · Tu LIT en casa ───────────────────────────────────────────
  {
    key: "sabor_favorito",
    klaviyoProp: "cs_sabor_pref",
    inherited: false,
    screen: 2,
    en: "Which flavour is yours?",
    es: "¿Cuál es tu sabor?",
    options: [
      // Nombres de marca: NO se traducen (misma decisión que `FLAVORS` en
      // seal-plans.ts, Juan 2026-07-11). Salty Peach existe desde el 2026-09-02.
      o("salty-lemon", "Salty Lemon", "Salty Lemon"),
      o("salty-watermelon", "Salty Watermelon", "Salty Watermelon"),
      o("salty-peach", "Salty Peach", "Salty Peach"),
      o("todos", "I like all three", "Me gustan los tres"),
      // Bandera de churn que hoy solo se puede expresar cancelando, o sea tarde.
      o("ninguno", "None of them convince me", "Ninguno me convence"),
    ],
  },
  {
    key: "caja_dura",
    klaviyoProp: "cs_caja_dura",
    inherited: false,
    screen: 2,
    en: "How long does one box last you?",
    es: "¿Cuánto te dura una caja?",
    helpEn: "One box is 30 sachets.",
    helpEs: "Una caja son 30 sobres.",
    // Es la escalera de `Frequency` truncada en dos meses, más las dos colas.
    // Esa alineación es lo que hace que el motor de cadencia funcione sin
    // aritmética para el cliente de una caja: lo que le dura la caja ES su
    // cadencia. INVARIANTE: si algún día se añade una opción intermedia, tiene
    // que ser un punto de la escalera (ver DURATION_DAYS).
    options: [
      o("lt15", "Less than 15 days", "Menos de 15 días"),
      o("15d", "About 15 days", "Unos 15 días"),
      o("1mo", "About a month", "Un mes"),
      o("45d", "About six weeks", "Mes y medio"),
      o("2mo", "About two months", "Dos meses"),
      o("gt2mo", "More than two months", "Más de dos meses"),
      o("ns", "Not sure", "No lo sé"),
    ],
  },
  {
    key: "stock_dura",
    klaviyoProp: "cs_stock_nivel",
    inherited: false,
    screen: 2,
    en: "And right now, how much have you got left?",
    es: "Y ahora mismo, ¿para cuánto te queda?",
    // La microcopia es necesaria: va pegada a `caja_dura` y las dos hablan de
    // tiempo. La distinción es RITMO vs NIVEL y es lo que la hace legible.
    helpEn: "What's in your cupboard today.",
    helpEs: "Lo que tienes en casa hoy.",
    // En tiempo y no en cajas a propósito: el tiempo ya está normalizado por su
    // propio consumo, así que un cliente de 1 caja y uno del pack de 4 contestan
    // en la misma unidad. Contando cajas, el del pack acaba de recibir cuatro y
    // dice "más de dos" siendo eso lo normal.
    options: [
      // `none` va separada de `lt2w` porque no es "voy justo": es rotura, y es
      // una señal de soporte, no de sobre-servicio.
      o("none", "I've run out", "Se me ha acabado"),
      o("lt2w", "Less than two weeks", "Menos de dos semanas"),
      o("2w_1mo", "Two weeks to a month", "De dos semanas a un mes"),
      o("1_2mo", "One to two months", "De uno a dos meses"),
      o("gt2mo", "More than two months", "Más de dos meses"),
      o("ns", "Haven't checked", "No lo he mirado"),
    ],
  },
  {
    key: "hogar",
    klaviyoProp: "cs_hogar",
    inherited: false,
    screen: 2,
    en: "How many of you drink it at home?",
    es: "¿Cuántos lo tomáis en casa?",
    options: [
      o("1", "Just me", "Solo yo"),
      o("2", "Two of us", "Dos"),
      o("3plus", "Three or more", "Tres o más"),
    ],
  },

  // ── Pantalla 3 · Un poco sobre ti ─────────────────────────────────────────
  {
    key: "deporte_frecuencia",
    klaviyoProp: "cs_deporte_frecuencia",
    inherited: true,
    screen: 3,
    en: "Do you train?",
    es: "¿Entrenas?",
    // El vocabulario heredado no tenía el cero: no había forma de decir "no
    // entreno", que es justo la respuesta de la que depende la decisión de a
    // dónde apunta la creatividad. Se le mete dentro y `cs_hace_deporte` se
    // DERIVA (ver `derivedAnswers`), que es traducir lo que el cliente ha dicho,
    // no inferirlo. Se ahorra un toque y no se rompe ningún segmento existente.
    options: [
      o("No entreno", "I don't train", "No entreno"),
      o("1-2/sem", "1-2 times a week", "1-2 veces por semana"),
      o("3-4/sem", "3-4 times a week", "3-4 veces por semana"),
      o("5+/sem", "5 or more a week", "5 o más por semana"),
    ],
  },
  {
    key: "deporte_tipo",
    klaviyoProp: "cs_deporte",
    inherited: true,
    screen: 3,
    en: "Which one?",
    es: "¿Cuál?",
    gatedBy: { key: "deporte_frecuencia", unless: ["No entreno"] },
    options: [
      o("Running", "Running", "Running"),
      o("Gym / fuerza", "Gym / strength", "Gimnasio o fuerza"),
      o("Ciclismo", "Cycling", "Ciclismo"),
      o("Pádel / tenis", "Padel / tennis", "Pádel o tenis"),
      o("Crossfit", "Crossfit", "Crossfit"),
      o("Natación", "Swimming", "Natación"),
      o("Otro", "Something else", "Otro"),
    ],
  },
  {
    key: "edad",
    klaviyoProp: "cs_edad",
    inherited: true,
    screen: 3,
    en: "How old are you?",
    es: "¿Qué edad tienes?",
    options: [
      o("18-24", "18-24", "18-24"),
      o("25-34", "25-34", "25-34"),
      o("35-44", "35-44", "35-44"),
      o("45-54", "45-54", "45-54"),
      o("55-64", "55-64", "55-64"),
      o("65+", "65+", "65+"),
      // Solo en el portal, NO en `_PERFILADO`: en la consola del operador la
      // etiqueta es "¿Qué edad tiene? (aprox.)" y la marca él por estimación,
      // así que allí esta opción significaría "no lo pregunté", que es otro
      // hecho y contaminaría la misma distribución que queremos leer.
      o("Prefiero no decirlo", "Prefer not to say", "Prefiero no decirlo"),
    ],
  },
];

/** Enunciado + opciones por clave, para no recorrer el array en cada uso. */
export const QUESTIONS_BY_KEY: Record<string, ProfileQuestion> = Object.fromEntries(
  PROFILE_QUESTIONS.map((q) => [q.key, q]),
);

/**
 * Respuesta con la que el cliente ACTIVA la derivación a la página de ayuda.
 * No se le hace ninguna pregunta más: se le enseña un enlace a
 * litsalt.com/pages/ayuda, que ya lleva al formulario de incidencias → Zendesk.
 * Sin campo de texto libre a propósito: es donde alguien escribiría una
 * condición médica sin que nadie se la pida, y eso no puede acabar en un perfil
 * de marketing.
 */
export const SITUACION_CON_PROBLEMA = "Tiene un problema";
export const HELP_URL = "https://litsalt.com/pages/ayuda";

/** ¿Se le pregunta esto, dadas las respuestas que ya ha dado? */
export function isAsked(q: ProfileQuestion, answers: Record<string, string>): boolean {
  if (!q.gatedBy) return true;
  const gate = answers[q.gatedBy.key];
  // Sin respuesta en la pregunta que la gatea, la condicional no se enseña: no
  // se le puede preguntar con qué frecuencia hace algo que no sabemos si hace.
  if (gate === undefined) return false;
  return !q.gatedBy.unless.includes(gate);
}

/** Las preguntas que tocan, en orden, dadas las respuestas hasta ahora. */
export function visibleQuestions(answers: Record<string, string>): ProfileQuestion[] {
  return PROFILE_QUESTIONS.filter((q) => isAsked(q, answers));
}

export interface ValidationResult {
  ok: boolean;
  /** Claves que no existen en el banco. */
  unknown: string[];
  /** Claves cuyo valor no está entre las opciones. */
  invalid: string[];
  /** Claves que llegaron pero cuya condicional no estaba abierta. */
  notAsked: string[];
  /** Lo que se puede guardar: solo lo válido. */
  clean: Record<string, string>;
}

/**
 * Valida lo que manda el cliente contra el banco. PURA: sin red, sin base.
 *
 * El tipo de TypeScript es solo de compilación y un cliente puede postear
 * cualquier cosa, así que esto no es opcional. Devuelve además `clean` para que
 * la ruta guarde exactamente lo que ha validado y nunca lo que llegó.
 */
export function validateAnswers(raw: unknown): ValidationResult {
  const out: ValidationResult = { ok: true, unknown: [], invalid: [], notAsked: [], clean: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...out, ok: false };
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  const asStrings: Record<string, string> = {};
  for (const [k, v] of entries) {
    const q = QUESTIONS_BY_KEY[k];
    if (!q) {
      out.unknown.push(k);
      continue;
    }
    if (typeof v !== "string" || !q.options.some((opt) => opt.value === v)) {
      out.invalid.push(k);
      continue;
    }
    asStrings[k] = v;
  }

  // Las condicionales se comprueban DESPUÉS, contra el conjunto ya validado: si
  // se comprobara sobre la marcha, el orden de las claves del objeto decidiría
  // el resultado.
  for (const [k, v] of Object.entries(asStrings)) {
    if (isAsked(QUESTIONS_BY_KEY[k], asStrings)) out.clean[k] = v;
    else out.notAsked.push(k);
  }

  out.ok = out.unknown.length === 0 && out.invalid.length === 0 && out.notAsked.length === 0;
  return out;
}

/**
 * Campos que NO se preguntan y se derivan de los que sí.
 *
 * `cs_hace_deporte` existe en el CS como un booleano propio y hay 9 respuestas
 * históricas que lo usan. Aquí se fusionó con la frecuencia para ahorrar un
 * toque, así que se reconstruye para no partir el cruce. Los valores canónicos
 * son `"Sí"` y `"No"` — con tilde, y es byte-crítico.
 */
export function derivedAnswers(answers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const freq = answers["deporte_frecuencia"];
  if (freq !== undefined) out["deporte"] = freq === "No entreno" ? "No" : "Sí";
  return out;
}

/**
 * Lo que se escribe en el perfil de Klaviyo: `{ cs_*: valor }`.
 *
 * Ojo: solo se llama si el cliente marcó la casilla de consentimiento. Sin
 * marcar, la respuesta se guarda igual (estadística agregada) pero el perfil no
 * se toca, que es exactamente lo que concede la casilla.
 */
export const DERIVED_KLAVIYO_PROPS: Record<string, string> = { deporte: "cs_hace_deporte" };

export function klaviyoProps(answers: Record<string, string>): Record<string, string> {
  const all = { ...answers, ...derivedAnswers(answers) };
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    const prop = QUESTIONS_BY_KEY[k]?.klaviyoProp ?? DERIVED_KLAVIYO_PROPS[k] ?? null;
    if (prop) props[prop] = v;
  }
  return props;
}

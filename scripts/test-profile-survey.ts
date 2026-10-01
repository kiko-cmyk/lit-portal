/**
 * Tests del formulario de perfilado: el banco de preguntas y el motor de
 * cadencia. Sin framework, igual que el resto de los scripts del repo:
 * aserciones a mano.
 *
 *   npm test          (encadena los scripts de test del repo)
 *   npx tsx scripts/test-profile-survey.ts
 *
 * Qué protege.
 *
 * (1) EL VOCABULARIO. Las preguntas heredadas guardan la cadena castellana del
 *     CS Platform byte a byte, porque esa cadena viaja cruda hasta la propiedad
 *     `cs_*` de Klaviyo. Si alguien "mejora" un valor a snake_case o le quita un
 *     acento, no salta ningún error: el segmento `cs_uso = "Deporte"` deja de
 *     ver a media base y se lee como "hay pocos clientes así". Es exactamente
 *     cómo esta casa perdió el 48% de una ciudad con `valencia` / `valència`.
 *     Los dos repos no se importan entre sí, así que las listas del dashboard
 *     van copiadas AQUÍ a mano: esta comparación es la única defensa que existe.
 *
 * (2) EL MOTOR DE CADENCIA. Recorre las 2.016 combinaciones posibles
 *     (6 cajas × 7 duraciones × 6 stocks × 8 cadencias) y afirma las cuatro
 *     cosas que no pueden pasar nunca: proponer una cadencia MÁS CORTA, pasar
 *     del tope de 6 meses, disparar sin tasa o con el stock en contra, y colar
 *     una propuesta por debajo del umbral. Un fallo aquí no da un error: le
 *     manda a un cliente menos producto del que necesita, o le dice que le
 *     sobra justo cuando se ha quedado sin nada.
 */

import {
  DURATION_DAYS,
  suggestLongerCadence,
  type CadenceFitInput,
} from "@/lib/cadence-fit";
import { FREQUENCIES, FREQUENCY_DAYS, longestFrequencyWithin } from "@/lib/plan-options";
import {
  ALL_KLAVIYO_PROPS,
  MULTI_SEP,
  DERIVED_KLAVIYO_PROPS,
  PROFILE_QUESTIONS,
  QUESTIONS_BY_KEY,
  derivedAnswers,
  isAsked,
  klaviyoProps,
  validateAnswers,
  visibleQuestions,
} from "@/lib/profile-questions";
import { formatShipDateEs } from "@/lib/ship-date-label";
import { DISCOUNT_VALUE_EUR } from "@/lib/survey-discount";
import type { Frequency } from "@/lib/types";
import { readFileSync } from "node:fs";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. El vocabulario heredado, copiado A MANO del CS Platform ───────────────
// Fuente: lit-dashboard/backend/app/services/crm_scripts.py, bloque _PERFILADO.
// Si el guion cambia allí, este objeto tiene que cambiar aquí y el test avisa.
const CS_PERFILADO: Record<string, string[]> = {
  situacion: ["Encantado", "Bien", "Regular", "No lo usa", "Tiene un problema"],
  uso: ["Deporte", "Trabajo / foco", "Resaca", "Calor / verano", "Salud diaria", "Otro"],
  edad: ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"],
  deporte_frecuencia: ["1-2/sem", "3-4/sem", "5+/sem"],
  deporte_tipo: [
    "Running", "Gym / fuerza", "Ciclismo", "Pádel / tenis", "Crossfit", "Natación", "Otro",
  ],
  // Esta NO sale de _PERFILADO sino de SCRIPTS["fidelizacion"] del mismo fichero.
  // Existía allí desde el 2026-06-30 y ya escribía `cs_momento`: por eso el
  // portal la hereda en vez de inventarse códigos (ver la pregunta en el banco).
  momento: ["Mañana", "Pre-entreno", "Durante el entreno", "Post-entreno", "Tarde", "Noche"],
};

console.log("\n── vocabulario heredado ──");

for (const [key, csOptions] of Object.entries(CS_PERFILADO)) {
  const q = QUESTIONS_BY_KEY[key];
  check(`${key}: la pregunta existe y está marcada como heredada`, !!q && q.inherited);
  if (!q) continue;

  const ours = q.options.map((o) => o.value);
  // El portal PUEDE añadir opciones que el guion del operador no tiene (el cero
  // de deporte, el "prefiero no decirlo" de edad), pero NUNCA puede cambiar ni
  // perder una de las del guion.
  const missing = csOptions.filter((v) => !ours.includes(v));
  check(
    `${key}: no se pierde ningún valor del guion`,
    missing.length === 0,
    missing.length ? `faltan ${JSON.stringify(missing)}` : `${csOptions.length} valores`,
  );
}

// Las dos opciones que el portal añade a propósito, y que NO están en el guion.
check(
  "deporte_frecuencia añade el cero que el guion no tenía",
  QUESTIONS_BY_KEY["deporte_frecuencia"].options.some((o) => o.value === "No entreno"),
);
check(
  "edad añade 'Prefiero no decirlo' solo en el portal",
  QUESTIONS_BY_KEY["edad"].options.some((o) => o.value === "Prefiero no decirlo"),
);

// El acento es parte del valor. Se comprueba explícitamente porque es el fallo
// que no da error y no se ve leyendo el diff por encima.
check(
  "los acentos se conservan en los valores",
  QUESTIONS_BY_KEY["deporte_tipo"].options.some((o) => o.value === "Pádel / tenis") &&
    QUESTIONS_BY_KEY["deporte_tipo"].options.some((o) => o.value === "Natación"),
);
check(
  "el booleano derivado de deporte usa 'Sí' con tilde",
  derivedAnswers({ deporte_frecuencia: "3-4/sem" })["deporte"] === "Sí" &&
    derivedAnswers({ deporte_frecuencia: "No entreno" })["deporte"] === "No",
);

// ── 2. Estructura del banco ──────────────────────────────────────────────────

console.log("\n── estructura ──");

check("hay 10 preguntas", PROFILE_QUESTIONS.length === 10, `${PROFILE_QUESTIONS.length}`);

// ── La décima (Kiko, 2026-09-23): ¿en qué momento del día lo tomas? ──────────
{
  const m = QUESTIONS_BY_KEY["momento"];
  check("momento: existe, pantalla 1, multi, HEREDADA", !!m && m.screen === 1 && m.multi === true && m.inherited);
  check("momento: escribe cs_momento, la del guion", m?.klaviyoProp === "cs_momento");
  const idx = PROFILE_QUESTIONS.findIndex((q) => q.key === "momento");
  check("momento: va justo después de uso", idx > 0 && PROFILE_QUESTIONS[idx - 1].key === "uso");
  check(
    "momento: el vocabulario ES el del guion, en su orden",
    JSON.stringify(m?.options.map((o) => o.value)) === JSON.stringify(CS_PERFILADO.momento),
  );
  check("momento: cs_momento está en la lista de VACIADO", (ALL_KLAVIYO_PROPS as readonly string[]).includes("cs_momento"));
  const v = validateAnswers({ momento: "Post-entreno;Mañana" });
  check("momento: acepta varias y las ordena como el banco", v.ok && v.clean.momento === "Mañana;Post-entreno", JSON.stringify(v.clean));
  check("momento: rechaza una parte inventada", !validateAnswers({ momento: "Mañana;Siesta" }).ok);
  check("momento: llega a Klaviyo con la cadena del guion", klaviyoProps({ momento: "Noche" }).cs_momento === "Noche");
}

// Qué preguntas son multi, fijado EXACTO. El dashboard no puede saberlo (los
// repos no se importan) y una multi necesita "(varias)" en su etiqueta de allí,
// o su tarjeta en la hoja de Clientes suma más de 100% sin avisar. Si cambias
// esta lista, cambia la etiqueta en `_PORTAL` de lit-dashboard y luego aquí.
check(
  "las multi son exactamente estas (y el dashboard las lleva marcadas)",
  JSON.stringify(PROFILE_QUESTIONS.filter((q) => q.multi).map((q) => q.key)) ===
    JSON.stringify(["uso", "momento", "sabor_favorito", "deporte_tipo"]),
  "si añades una: '(varias)' en _PORTAL de lit-dashboard/backend/app/services/crm_scripts.py",
);

// El banner dice CUÁNTAS son con letra. Si se añade una pregunta y nadie toca
// el texto, el banner miente sin que falle nada: pasó al añadir la décima.
{
  const WORDS: Record<number, [string, string]> = {
    9: ["Nueve", "Nine"], 10: ["Diez", "Ten"], 11: ["Once", "Eleven"], 12: ["Doce", "Twelve"],
  };
  const n = PROFILE_QUESTIONS.length;
  const banner = readFileSync(`${process.cwd()}/src/components/ProfileSurveyBanner.tsx`, "utf8");
  const w = WORDS[n];
  check(
    `el banner dice las preguntas que hay (${n})`,
    !!w && banner.includes(`${w[0]} preguntas`) && banner.includes(`${w[1]} questions`),
    w ? `${w[0]} / ${w[1]}` : `añade ${n} a WORDS y cambia el banner`,
  );
}

const dupes = PROFILE_QUESTIONS.map((q) => q.key).filter((k, i, a) => a.indexOf(k) !== i);
check("no hay claves repetidas", dupes.length === 0, dupes.join(","));

const dupeProps = PROFILE_QUESTIONS.map((q) => q.klaviyoProp)
  .filter((p): p is string => !!p)
  .filter((p, i, a) => a.indexOf(p) !== i);
check("no hay dos preguntas escribiendo la misma propiedad", dupeProps.length === 0, dupeProps.join(","));

check(
  "toda opción tiene value, en y es",
  PROFILE_QUESTIONS.every((q) => q.options.every((o) => !!o.value && !!o.en && !!o.es)),
);

check(
  "ninguna pregunta tiene valores repetidos",
  PROFILE_QUESTIONS.every((q) => new Set(q.options.map((o) => o.value)).size === q.options.length),
);

// Las pantallas van en orden en el array: la 3 no puede aparecer antes que la 2.
const screens = PROFILE_QUESTIONS.map((q) => q.screen);
check(
  "las preguntas están ordenadas por pantalla",
  screens.every((s, i) => i === 0 || s >= screens[i - 1]),
  screens.join(""),
);

// Una condicional no puede depender de una pregunta POSTERIOR: si no, al
// cliente le gatearíamos algo con una respuesta que aún no ha dado.
for (const q of PROFILE_QUESTIONS) {
  if (!q.gatedBy) continue;
  const gateIdx = PROFILE_QUESTIONS.findIndex((x) => x.key === q.gatedBy!.key);
  const selfIdx = PROFILE_QUESTIONS.findIndex((x) => x.key === q.key);
  check(
    `${q.key}: su condicional viene ANTES que ella`,
    gateIdx >= 0 && gateIdx < selfIdx,
  );
}

// ── 3. Saltos condicionales ──────────────────────────────────────────────────

console.log("\n── condicionales ──");

check(
  "sin contestar la frecuencia, no se pregunta el deporte",
  !isAsked(QUESTIONS_BY_KEY["deporte_tipo"], {}),
);
check(
  "'No entreno' salta la pregunta del deporte",
  !isAsked(QUESTIONS_BY_KEY["deporte_tipo"], { deporte_frecuencia: "No entreno" }),
);
check(
  "entrenando sí se pregunta el deporte",
  isAsked(QUESTIONS_BY_KEY["deporte_tipo"], { deporte_frecuencia: "3-4/sem" }),
);
check(
  "quien no entrena ve 9 preguntas, no 10",
  visibleQuestions({ deporte_frecuencia: "No entreno" }).length === 9,
);

// ── 4. Validación ────────────────────────────────────────────────────────────

console.log("\n── validación ──");

const vOk = validateAnswers({ uso: "Deporte", edad: "25-34" });
check("acepta lo válido", vOk.ok && Object.keys(vOk.clean).length === 2);

const vUnknown = validateAnswers({ foo: "bar" });
check("rechaza una clave que no existe", !vUnknown.ok && vUnknown.unknown.includes("foo"));

const vBad = validateAnswers({ uso: "Astronauta" });
check("rechaza un valor fuera de la lista", !vBad.ok && vBad.invalid.includes("uso"));

const vCase = validateAnswers({ deporte_tipo: "gym / fuerza", deporte_frecuencia: "3-4/sem" });
check(
  "rechaza el mismo valor con otra caja (el byte a byte es literal)",
  !vCase.ok && vCase.invalid.includes("deporte_tipo"),
);

const vNoAcc = validateAnswers({ deporte_tipo: "Padel / tenis", deporte_frecuencia: "3-4/sem" });
check("rechaza el valor sin el acento", !vNoAcc.ok && vNoAcc.invalid.includes("deporte_tipo"));

const vGate = validateAnswers({ deporte_frecuencia: "No entreno", deporte_tipo: "Running" });
check(
  "rechaza una condicional que no tocaba",
  !vGate.ok && vGate.notAsked.includes("deporte_tipo"),
);
check("y no la deja en clean", vGate.clean["deporte_tipo"] === undefined);

// ── El contrato con Klaviyo (2026-09-22) ─────────────────────────────────────
//
// Los dos emails del flow (Vc3fhp y W7j57C) leen `event.discount_code` y
// `event.discount_expires_label` LITERALMENTE. Si el portal renombra una
// propiedad, el email sale con el hueco vacío y sin error en ningún log: es
// exactamente cómo el recordatorio de 7d se envió con la fecha en blanco a 524
// personas. Este bloque es la única defensa que existe contra eso.
console.log("\n── contrato del evento de Klaviyo ──");

check(
  "la fecha se formatea en español, sin año y con el mes en minúscula",
  formatShipDateEs("2026-10-22T09:17:29Z") === "22 de octubre",
  formatShipDateEs("2026-10-22T09:17:29Z"),
);
check(
  "sin caducidad devuelve cadena vacía, no 'Invalid Date'",
  formatShipDateEs(null) === "" && formatShipDateEs(undefined) === "",
);
// El label se construye del ISO CRUDO, no de un Date: `new Date(iso)` se
// renderiza en la zona del runtime y en Vercel eso puede imprimir el día
// anterior. Un cupón que dice caducar un día antes es una reclamación.
check(
  "el día sale del ISO y no de la zona horaria del servidor",
  formatShipDateEs("2026-10-01T00:30:00Z") === "1 de octubre",
  formatShipDateEs("2026-10-01T00:30:00Z"),
);
check("el importe del evento es 5", DISCOUNT_VALUE_EUR === 5, String(DISCOUNT_VALUE_EUR));

// ── Multi-respuesta (Juan 2026-09-22) ────────────────────────────────────────
console.log("\n── multi-respuesta ──");

// EL ANCLA MÁS IMPORTANTE: si un valor canónico llevara el separador dentro, al
// guardar "A;B" y volver a partir saldrían trozos que no son opciones, y la
// respuesta se rechazaría o se guardaría a medias. Silencioso en los dos casos.
const conSeparador = PROFILE_QUESTIONS.flatMap((q) =>
  q.options.filter((o) => o.value.includes(MULTI_SEP)).map((o) => `${q.key}:${o.value}`),
);
check(
  `ningún valor canónico contiene el separador "${MULTI_SEP}"`,
  conSeparador.length === 0,
  conSeparador.join(","),
);

check(
  "las tres preguntas pedidas son multi",
  QUESTIONS_BY_KEY["uso"]?.multi === true &&
    QUESTIONS_BY_KEY["sabor_favorito"]?.multi === true &&
    QUESTIONS_BY_KEY["deporte_tipo"]?.multi === true,
);

// `deporte_tipo` es la única multi que además está GATEADA. La puerta cuelga de
// `deporte_frecuencia`, que NO es multi, así que `isAsked` sigue comparando
// valores completos y funciona. Si algún día se gatea por una multi, este test
// es el que se caerá primero.
check(
  "la puerta de deporte_tipo cuelga de una pregunta que no es multi",
  QUESTIONS_BY_KEY[QUESTIONS_BY_KEY["deporte_tipo"]!.gatedBy!.key]?.multi !== true,
);
check(
  "deporte_tipo multi se valida bien cuando la puerta está abierta",
  validateAnswers({ deporte_frecuencia: "3-4/sem", deporte_tipo: "Running;Ciclismo" }).ok,
);

const vMulti = validateAnswers({ uso: "Deporte;Resaca" });
check("acepta dos valores válidos", vMulti.ok && vMulti.clean["uso"] === "Deporte;Resaca");

// El orden se NORMALIZA al del banco: si dependiera del orden de los toques,
// dos clientes que marcaron lo mismo generarían cadenas distintas y los
// segmentos de Klaviyo por igualdad se partirían en variantes.
const vOrden = validateAnswers({ uso: "Resaca;Deporte" });
check(
  "normaliza al orden del banco",
  vOrden.ok && vOrden.clean["uso"] === "Deporte;Resaca",
  vOrden.clean["uso"],
);

check("una sola opción sigue valiendo", validateAnswers({ uso: "Deporte" }).ok);
check(
  "si UNA parte es inválida se rechaza entera",
  !validateAnswers({ uso: "Deporte;Astronauta" }).ok,
);
check("la cadena vacía se rechaza", !validateAnswers({ uso: "" }).ok);
check(
  "una pregunta NO multi sigue rechazando el multi",
  !validateAnswers({ edad: "25-34;35-44" }).ok,
);

// La multi viaja a Klaviyo como la cadena entera: la propiedad `cs_*` es texto
// y allí se segmenta con "contiene".
const propsMulti = klaviyoProps({ uso: "Deporte;Resaca" });
check("cs_uso lleva la cadena completa", propsMulti["cs_uso"] === "Deporte;Resaca");

check("un tipo que no es objeto se rechaza entero", !validateAnswers("nope").ok);
check("un array se rechaza entero", !validateAnswers(["uso"]).ok);
check("un valor que no es string se rechaza", !validateAnswers({ uso: 3 }).ok);

// ── 5. Proyección a Klaviyo ──────────────────────────────────────────────────

console.log("\n── proyección a Klaviyo ──");

const props = klaviyoProps({ uso: "Deporte", deporte_frecuencia: "5+/sem", hogar: "2" });
check("uso va a cs_uso", props["cs_uso"] === "Deporte");
check("el booleano derivado va a cs_hace_deporte", props["cs_hace_deporte"] === "Sí");
check("hogar va a cs_hogar", props["cs_hogar"] === "2");
check(
  "una respuesta sin propiedad no inventa ninguna",
  Object.keys(klaviyoProps({})).length === 0,
);

// La lista de VACIADO de una petición de borrado. `/profile-import/` no puede
// eliminar una propiedad, solo escribirle "", así que una clave del banco que
// falte en ALL_KLAVIYO_PROPS es un dato personal que sobrevive a su propio
// borrado y nadie se enteraría. Se comprueba INCLUSIÓN y no igualdad a
// propósito: la lista conserva de más (propiedades de preguntas ya retiradas,
// que siguen vivas en los perfiles de quien contestó), nunca de menos.
const vaciado = new Set<string>(ALL_KLAVIYO_PROPS);
const delBanco = PROFILE_QUESTIONS.map((q) => q.klaviyoProp).filter(
  (p): p is string => !!p,
);
const sinVaciar = delBanco.filter((p) => !vaciado.has(p));
check(
  "toda propiedad del banco se puede vaciar en un borrado",
  sinVaciar.length === 0,
  sinVaciar.join(","),
);

const derivadasSinVaciar = Object.values(DERIVED_KLAVIYO_PROPS).filter(
  (p) => !vaciado.has(p),
);
check(
  "y también las derivadas",
  derivadasSinVaciar.length === 0,
  derivadasSinVaciar.join(","),
);

check(
  "los metadatos que escribe el cron también se vacían",
  vaciado.has("cs_perfil_fuente") && vaciado.has("cs_perfil_fecha"),
);

// ── 6. El motor de cadencia: las 2.016 combinaciones ─────────────────────────

console.log("\n── motor de cadencia (barrido completo) ──");

const DURATIONS = Object.keys(DURATION_DAYS);
const STOCKS = ["none", "lt2w", "2w_1mo", "1_2mo", "gt2mo", "ns"];
const BOXES = [1, 2, 3, 4, 5, 6];
const FREQS = FREQUENCIES.map((f) => f.value);

let combos = 0;
let propuestas = 0;
const errores: string[] = [];

for (const boxDuration of DURATIONS) {
  for (const stockLeft of STOCKS) {
    for (const realBoxes of BOXES) {
      for (const currentFrequency of FREQS) {
        combos++;
        const input: CadenceFitInput = { currentFrequency, realBoxes, boxDuration, stockLeft };
        const r = suggestLongerCadence(input);
        const ctx = `${boxDuration}/${stockLeft}/${realBoxes}cajas/${currentFrequency}`;

        if (r.target === null) {
          if (r.veto === null) errores.push(`${ctx}: sin propuesta y sin motivo`);
          continue;
        }
        propuestas++;

        if (r.veto !== null) errores.push(`${ctx}: propone y además veta`);
        // (a) nunca más corta
        if (FREQUENCY_DAYS[r.target] <= FREQUENCY_DAYS[currentFrequency]) {
          errores.push(`${ctx}: propone ${r.target}, que no es más larga`);
        }
        // (b) nunca por encima del tope
        if (FREQUENCY_DAYS[r.target] > 180) errores.push(`${ctx}: se pasa del tope`);
        // (c) nunca sin tasa ni con el stock en contra
        if (DURATION_DAYS[boxDuration] == null) errores.push(`${ctx}: propone sin tasa`);
        if (stockLeft === "none" || stockLeft === "lt2w") {
          errores.push(`${ctx}: propone con el stock en contra`);
        }
        // (d) nunca por debajo del umbral de 1,5×
        if (FREQUENCY_DAYS[r.target] * 2 < FREQUENCY_DAYS[currentFrequency] * 3) {
          errores.push(`${ctx}: ${r.target} está por debajo del umbral`);
        }
        // (e) nunca por encima de lo que da el suministro declarado
        const supply = (DURATION_DAYS[boxDuration] as number) * realBoxes;
        if (FREQUENCY_DAYS[r.target] > supply) {
          errores.push(`${ctx}: propone ${r.target} (${FREQUENCY_DAYS[r.target]}d) con solo ${supply}d de suministro`);
        }
      }
    }
  }
}

check("se han recorrido las 2.016 combinaciones", combos === 2016, `${combos}`);
check("ninguna invariante rota", errores.length === 0, errores.slice(0, 5).join(" · "));
check("y el motor propone en algún caso (no está muerto)", propuestas > 0, `${propuestas} propuestas`);

// ── 7. El motor, casos concretos ─────────────────────────────────────────────

console.log("\n── motor de cadencia (casos) ──");

const fit = (
  currentFrequency: Frequency,
  realBoxes: number,
  boxDuration: string,
  stockLeft = "1_2mo",
) => suggestLongerCadence({ currentFrequency, realBoxes, boxDuration, stockLeft });

// El caso arquetípico: una caja al mes que le dura dos. Es la persona que
// produce las bajas por "se me acumula".
check("1 caja mensual que dura 2 meses → 2mo", fit("1mo", 1, "2mo").target === "2mo");

// El pack de 4: cada caja le dura un mes → cuatro meses de suministro.
check("pack de 4 cajas que duran 1 mes → 4mo", fit("1mo", 4, "1mo").target === "4mo");

// El hueco de la escalera: 3 cajas × 45 días = 135, entre 4mo (120) y 5mo (150).
check("135 días redondea HACIA ABAJO, a 4mo", fit("1mo", 3, "45d").target === "4mo");

// El tope: 4 cajas × 2 meses = 240 días, no hay cadencia.
const capped = fit("1mo", 4, "2mo");
check("240 días se topan en 6mo", capped.target === "6mo");
check("y se marca como topado", capped.cappedAtSixMonths === true);

// El umbral: 4 cajas de un mes son 120 días → 4mo, pero desde 3mo (90) eso no
// llega a 1,5×, así que no se propone. A esa altura de la escalera un solo paso
// es ruido de estimación, no una señal.
check("3mo → 4mo NO dispara (bajo umbral)", fit("3mo", 4, "1mo").veto === "bajo_umbral");
// Y desde 3mo sí dispara cuando el salto es de verdad: 5 cajas de un mes son
// 150 días → 5mo, que sí es 1,5× de 90.
check("3mo → 5mo SÍ dispara", fit("3mo", 5, "1mo").target === "5mo");
// El caso que confundí al escribir esto: 3 cajas de un mes son exactamente los
// 90 días que ya tiene contratados, o sea que le encaja y no hay nada que decir.
check("3mo con 3 cajas de un mes ya encaja", fit("3mo", 3, "1mo").veto === "no_mejora");

// Los vetos.
check("'no lo sé' no propone nada", fit("1mo", 1, "ns").veto === "no_rate");
check("'menos de 15 días' no propone nada", fit("1mo", 1, "lt15").veto === "no_rate");
check(
  "se ha quedado sin producto → veto, aunque la tasa diga que le sobra",
  fit("1mo", 1, "2mo", "none").veto === "stock_contradice",
);
check(
  "le queda menos de dos semanas → veto",
  fit("1mo", 1, "2mo", "lt2w").veto === "stock_contradice",
);
check(
  "'no lo he mirado' NO veta: ausencia de evidencia no es contradicción",
  fit("1mo", 1, "2mo", "ns").target === "2mo",
);

// Ya está en el tope.
check("quien ya está en 6mo no recibe nada", fit("6mo", 1, "2mo").veto === "no_mejora");

// La suya ya le encaja.
check("una caja de 15 días con cadencia de 15 días no recibe nada", fit("15d", 1, "15d").veto === "no_mejora");

// ── 8. longestFrequencyWithin ────────────────────────────────────────────────

console.log("\n── longestFrequencyWithin ──");

check("por debajo de 15 días no hay cadencia", longestFrequencyWithin(14) === null);
check("15 días exactos → 15d", longestFrequencyWithin(15) === "15d");
check("59 días → 45d (hacia abajo)", longestFrequencyWithin(59) === "45d");
check("180 exactos → 6mo", longestFrequencyWithin(180) === "6mo");
check("500 días → 6mo, no revienta", longestFrequencyWithin(500) === "6mo");

// ── Resultado ────────────────────────────────────────────────────────────────

console.log("");
if (failures > 0) {
  console.error(`\n${failures} fallo(s)`);
  process.exit(1);
}
console.log("Todo en verde.");

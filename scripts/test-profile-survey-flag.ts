/**
 * Tests de la puerta del formulario de perfilado. Sin framework, aserciones a
 * mano, igual que el resto de los scripts del repo.
 *
 *   npm test
 *   npx tsx scripts/test-profile-survey-flag.ts
 *
 * Qué protege, y por qué no basta con el flag que ya existía.
 *
 * `PROFILE_SURVEY` nació gateando SOLO la tarjeta del Hub. El enlace directo
 * (`?action=survey`) y la ruta que guarda no lo miraban, así que el formulario
 * era accesible con la URL puesta el flag en `off`.
 *
 * Eso deja el flag inútil justo el día que se necesita, porque es la palanca de
 * marcha atrás: si algo sale torcido después de lanzar y se pone en `off`, el
 * enlace sigue funcionando para cualquiera que lo tenga, y lo va a tener toda la
 * base porque el email de la campaña lo lleva dentro. Un interruptor de apagado
 * que no apaga es peor que no tenerlo, porque se cuenta con él.
 *
 * Lo que este test fija:
 *
 *   (1) Ausente o vacío CIERRA. El default tiene que ser el estado seguro, no
 *       el cómodo: una variable que se borra por accidente no puede abrir un
 *       formulario a toda la base.
 *   (2) `allowlist` es literal. No hay coincidencia parcial ni por prefijo, que
 *       es cómo un id de 14 dígitos acabaría autorizando a otro que lo contiene.
 *   (3) `on` abre a todos, y eso es correcto AQUÍ (a diferencia de la puerta del
 *       dry-run, donde un "on" apagaría las escrituras de todos en silencio;
 *       ver scripts/test-dry-run-flag.ts). Este flag gatea una FUNCIÓN, así que
 *       "on" la abre y es lo que uno espera.
 */

import { profileSurveyEnabledFor } from "@/lib/flags";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

const YO = "26934368862557";
const OTRO = "27453541548381";

function con(mode: string | undefined, list: string | undefined) {
  if (mode === undefined) delete process.env.PROFILE_SURVEY;
  else process.env.PROFILE_SURVEY = mode;
  if (list === undefined) delete process.env.PROFILE_SURVEY_ALLOWLIST;
  else process.env.PROFILE_SURVEY_ALLOWLIST = list;
}

// ── (1) el default cierra ────────────────────────────────────────────────────
con(undefined, undefined);
check("variable ausente → CERRADO", profileSurveyEnabledFor(YO) === false);

con("", "");
check("variable vacía → CERRADO", profileSurveyEnabledFor(YO) === false);

con("off", `${YO},${OTRO}`);
check("off gana a la allowlist", profileSurveyEnabledFor(YO) === false);

// Un valor que nadie escribió a propósito tampoco puede abrir. OJO a lo que NO
// está en esta lista: "ON " con mayúsculas y un espacio sí abre, y debe abrir.
// El `.trim().toLowerCase()` es tolerancia DELIBERADA, calcada de `mixMode()`,
// para que un dedo torpe en el panel de Vercel no cierre una función. Eso es
// distinto de aceptar un sinónimo que nadie prometió: "true" o "yes" no son
// "on" mal escrito, son otra palabra, y darlas por buenas convertiría el enum
// en "cualquier cosa que suene afirmativa".
for (const basura of ["true", "yes", "1", "allow", "abierto"]) {
  con(basura, "");
  const abierto = profileSurveyEnabledFor(YO);
  check(`"${basura}" no abre por accidente`, abierto === false, abierto ? "ABRIÓ" : "cerrado");
}

// ── (2) allowlist literal ────────────────────────────────────────────────────
con("allowlist", `${YO},${OTRO}`);
check("en la lista → abierto", profileSurveyEnabledFor(YO) === true);
check("otro de la lista → abierto", profileSurveyEnabledFor(OTRO) === true);
check("fuera de la lista → cerrado", profileSurveyEnabledFor("99999999999999") === false);

con("allowlist", "");
check("allowlist vacía → cerrado para todos", profileSurveyEnabledFor(YO) === false);

con("allowlist", `  ${YO} , ${OTRO}  `);
check("tolera espacios alrededor de los ids", profileSurveyEnabledFor(YO) === true);

// El fallo que un `includes()` sobre la cadena entera habría dejado pasar: un id
// que es prefijo o sufijo de otro NO puede autorizarse por contención.
con("allowlist", "269343688625570");
check("un id que CONTIENE al mío no me autoriza", profileSurveyEnabledFor(YO) === false);
con("allowlist", "2693436886255");
check("un prefijo del mío tampoco", profileSurveyEnabledFor(YO) === false);

// ── (3) on abre, y aquí eso es lo correcto ───────────────────────────────────
con("ON ", "");
check("\"ON \" abre: el trim y las mayúsculas se toleran a propósito",
  profileSurveyEnabledFor(YO) === true);

con("on", "");
check("on abre aunque la lista esté vacía", profileSurveyEnabledFor(YO) === true);
check("on abre a cualquiera", profileSurveyEnabledFor("11111111111111") === true);

console.log("");
if (failures > 0) {
  console.error(`${failures} fallo(s)`);
  process.exit(1);
}
console.log("Todo en verde.");

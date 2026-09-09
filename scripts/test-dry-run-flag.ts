/**
 * Tests de la puerta del dry-run en producción. Sin framework, aserciones a
 * mano, igual que el resto de los scripts del repo.
 *
 *   npm test
 *   npx tsx scripts/test-dry-run-flag.ts
 *
 * Qué protege, y por qué merece un test propio.
 *
 * `?__dry_run=1` hace que una ruta de mutación calcule su resultado y NO llame a
 * Seal. Eso es exactamente lo que hay que poder hacer para recorrer el portal
 * real sin tocar el dinero de nadie, y exactamente lo que NO puede pasarle a un
 * cliente: sus cambios dejarían de aplicarse sin un solo error en pantalla.
 *
 * Los dos fallos posibles son opuestos y los dos son caros:
 *
 *   (1) Que se abra a todos. Sería un interruptor público que convierte cada
 *       cambio de cada cliente en un no-op silencioso. Por eso esta puerta NO
 *       tiene un valor que signifique "todos", y este test lo afirma probando
 *       los que alguien escribiría por inercia: "on", "true", "all", "*".
 *
 *   (2) Que se cierre sin avisar. Es lo que pasó el 7-sep-2026: colgaba de la
 *       allowlist de MEZCLAS, y con `MIX_FLAVORS=on` (su valor en producción)
 *       se ignoraba en silencio, así que el paseo de verificación escribía de
 *       verdad creyendo que simulaba. Ahora la lista es propia, y el test fija
 *       que MIX_FLAVORS ya no puede influir en ninguno de sus valores.
 */

import { dryRunAllowedInProdFor, mixEnabledForCustomer } from "@/lib/flags";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

/** Corre `fn` con un entorno concreto y restaura lo que había. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const YO = "27453541548381";
const OTRO = "99999999999999";

console.log("── la lista abre solo a quien está en ella ──");

withEnv({ DRY_RUN_ALLOWLIST: YO }, () => {
  check("quien está en la lista puede simular", dryRunAllowedInProdFor(YO) === true);
  check("quien no está, no", dryRunAllowedInProdFor(OTRO) === false);
});

withEnv({ DRY_RUN_ALLOWLIST: ` ${YO} , ${OTRO} ` }, () => {
  check("tolera espacios alrededor de las comas", dryRunAllowedInProdFor(YO) === true);
  check("y abre a los dos", dryRunAllowedInProdFor(OTRO) === true);
});

console.log("\n── cerrado por defecto: ausencia y vacío no abren ──");

withEnv({ DRY_RUN_ALLOWLIST: undefined }, () => {
  check("variable ausente = cerrado", dryRunAllowedInProdFor(YO) === false);
});
withEnv({ DRY_RUN_ALLOWLIST: "" }, () => {
  check("cadena vacía = cerrado", dryRunAllowedInProdFor(YO) === false);
});
withEnv({ DRY_RUN_ALLOWLIST: "   " }, () => {
  check("solo espacios = cerrado", dryRunAllowedInProdFor(YO) === false);
});
withEnv({ DRY_RUN_ALLOWLIST: ",,, ,," }, () => {
  check("solo separadores = cerrado", dryRunAllowedInProdFor(YO) === false);
});

console.log("\n── NO existe un valor que abra a todos ──");
// Lo que alguien escribiría por inercia esperando un interruptor global. Cada
// uno de estos tiene que tratarse como un id literal (que nadie tiene), nunca
// como "todos": un no-op silencioso para toda la base de clientes.
for (const abre of ["on", "true", "all", "*", "1", "yes", "ON"]) {
  withEnv({ DRY_RUN_ALLOWLIST: abre }, () => {
    check(
      `"${abre}" NO abre a un cliente cualquiera`,
      dryRunAllowedInProdFor(OTRO) === false,
    );
  });
}

console.log("\n── independencia de MIX_FLAVORS (el bug del 7-sep) ──");
// El motivo del cambio: antes esto exigía MIX_FLAVORS=allowlist, así que con la
// variable en "on" el dry-run moría en silencio. Ahora MIX_FLAVORS no puede
// mover ninguno de sus dos valores, ni para abrir ni para cerrar.
for (const mix of ["on", "allowlist", "off", undefined]) {
  withEnv({ MIX_FLAVORS: mix, MIX_FLAVORS_ALLOWLIST: "", DRY_RUN_ALLOWLIST: YO }, () => {
    check(
      `con MIX_FLAVORS=${mix ?? "(ausente)"} sigo pudiendo simular`,
      dryRunAllowedInProdFor(YO) === true,
    );
  });
}

withEnv({ MIX_FLAVORS: "allowlist", MIX_FLAVORS_ALLOWLIST: OTRO, DRY_RUN_ALLOWLIST: "" }, () => {
  check(
    "estar en la lista de MEZCLAS ya no concede dry-run",
    dryRunAllowedInProdFor(OTRO) === false,
    "antes esto daba true",
  );
});

console.log("\n── y la mezcla sigue funcionando como antes ──");
// El cambio no debe haber tocado la puerta de las mezclas, que es una función de
// negocio viva (unos 2 clientes al día).
withEnv({ MIX_FLAVORS: "on", MIX_FLAVORS_ALLOWLIST: "", DRY_RUN_ALLOWLIST: "" }, () => {
  check("MIX_FLAVORS=on sigue abriendo la mezcla a todos", mixEnabledForCustomer(OTRO) === true);
});
withEnv({ MIX_FLAVORS: "allowlist", MIX_FLAVORS_ALLOWLIST: YO }, () => {
  check("MIX_FLAVORS=allowlist sigue respetando su lista", mixEnabledForCustomer(YO) === true);
  check("y excluye a quien no está", mixEnabledForCustomer(OTRO) === false);
});
withEnv({ MIX_FLAVORS: "off", MIX_FLAVORS_ALLOWLIST: YO }, () => {
  check("MIX_FLAVORS=off cierra la mezcla incluso a la lista", mixEnabledForCustomer(YO) === false);
});

console.log(
  failures === 0 ? "\nTodo en verde." : `\n${failures} fallo(s).`,
);
if (failures > 0) process.exitCode = 1;

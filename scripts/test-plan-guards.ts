/**
 * Guardas de CÓDIGO FUENTE del cambio de plan que mueven (o sujetan) un cobro.
 *
 *   npx tsx scripts/test-plan-guards.ts
 *
 * Como test-referral-guards.ts y por el mismo motivo: el plan route habla con Seal,
 * Shopify y Supabase, y no tiene un test que lo ejecute. Lo que no puede volver a pasar
 * se ve leyendo los ficheros. Cada check nombra el cobro que protege. Si un fichero se
 * reestructura, ACTUALIZA el test, no lo borres. (PR #150, 16-oct-2026, revisión de Kiko:
 * «ninguno ejercita las tres correcciones».)
 */

import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
/** Solo código: sin líneas de comentario (los comentarios nombran a propósito lo prohibido). */
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

let failed = 0;
function check(name: string, cond: boolean, hint: string) {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}\n    ${hint}`);
    failed++;
  }
}

const plan = code(read("src/lib/plan-core.ts"));
const skip = code(read("src/components/SkipOverlay.tsx"));
const cancel = code(read("src/components/CancelTakeover.tsx"));
const survey = code(read("src/components/ProfileSurveyOverlay.tsx"));
const planOverlay = code(read("src/components/PlanOverlay.tsx"));

console.log("\n── plan route ──\n");

check(
  "pestaña vieja: si la frecuencia que vio la pantalla ya no es la viva, 409 subscription_changed",
  /body\.frequency !== undefined &&\s*body\.currentFrequency &&\s*body\.currentFrequency !== currentFrequency\s*\)\s*\{[\s\S]{0,260}?"subscription_changed"/.test(
    plan,
  ),
  "Sin esto, si el bot pasa a alguien de 2 a 3 meses y desde una pestaña vieja baja de cajas, llega frequency 2mo y se deshace lo acordado por WhatsApp.",
);
check(
  "Supabase caído: la guarda ciega frena también los cambios de frecuencia",
  /ledger\.guardBlind && \(compositionChanged \|\| frequencyChanging\)/.test(plan) &&
    /const frequencyChanging = body\.frequency !== undefined && body\.frequency !== currentFrequency;/.test(plan),
  "Sin esto, el intervalo cambia, la intención de re-anclaje no se escribe y Seal puede cobrar antes (así cobró 16 días antes la 5145913).",
);
check(
  "repair_net_unavailable nunca sale como 5xx",
  !/503,\s*\n?\s*(planChanged \? "variant_change_failed_after_interval" : )?"repair_net_unavailable"/.test(plan) &&
    (plan.match(/409,\s*\n\s*(planChanged \? "variant_change_failed_after_interval" : )?"repair_net_unavailable"/g) ?? []).length >= 2,
  "El App Proxy cambia los 5xx por la página de la tienda: el cliente vería «puede que tu cambio se haya aplicado» cuando no se ha tocado nada.",
);
check(
  "sin red después de cambiar el intervalo, se dice que la frecuencia sí cambió",
  /planChanged \? "variant_change_failed_after_interval" : "repair_net_unavailable"/.test(plan),
  "Con el intervalo ya escrito, «no hemos cambiado nada» es falso.",
);
check(
  "intervalo sin ver en fromNext: se arma como suelo la fecha que ya tenía",
  /if \(reanchorMode === "fromNext"\) await armFloorAfterUnseenInterval\(\);/.test(plan) &&
    /const armFloorAfterUnseenInterval = async \(\) => \{[\s\S]{0,400}?writeReanchorIntent\(ctx\.customerId, sealSubscriptionId, preserveYYYYMMDD\)/.test(
      plan,
    ),
  "Sin suelo, si Seal aplica el intervalo tarde, regenera desde el último intento pasado y puede cobrar antes de la fecha que tenía. Y el suelo es la fecha que TENÍA, nunca la espaciada.",
);
check(
  "sin intención armada, la salida verificada no promete fecha",
  /if \(armedDate\) \{[\s\S]{0,260}?\} else \{\s*finalNextShipDate = null;/.test(plan),
  "Lo que Seal enseña a mitad de regenerar no lo sujeta nada y puede caer antes de la fecha del cliente.",
);

console.log("\n── pantallas ──\n");

check(
  "«Ajustar mi plan» no rellena con la vista previa si el servidor no da fecha",
  /setAdjustedDate\(updated\.nextShipDate \?\? null\);/.test(skip) && !/updated\.nextShipDate \?\? offerNewShip/.test(skip),
  "Sin fecha sujeta, prometer la vista previa es prometer algo que nadie va a cumplir.",
);
check(
  "«Espaciar mis entregas» manda solo la frecuencia, sin el boxCount de la pestaña",
  /applyPlan\(\{ frequency: offerFreq, reanchorMode: "fromNext" \}\)/.test(cancel) &&
    !/applyPlan\(\{ frequency: offerFreq, boxCount/.test(cancel),
  "Con el boxCount de una pestaña vieja, espaciar le devolvía las cajas que el cliente ya había quitado.",
);
for (const [name, src] of [
  ["SkipOverlay", skip],
  ["CancelTakeover", cancel],
] as const) {
  check(
    `${name} tiene texto propio para los rechazos del cambio de ritmo`,
    ["subscription_changed", "no_pending_attempt", "repair_net_unavailable", "variant_change_failed_after_interval"].every((c) =>
      src.includes(`"${c}"`),
    ),
    "Sin ellos el cliente ve el genérico «no se pudo cambiar el plan» y no sabe si recargar, esperar o escribir.",
  );
}
check(
  "la encuesta distingue pestaña vieja y red caída",
  /code === "subscription_changed"\s*\?\s*"changed"/.test(survey) && /code === "repair_net_unavailable"\s*\?\s*"net"/.test(survey),
  "«busy» habla de un cambio anterior y «failed» manda a Mi plan, que en esa pestaña da otro 409.",
);
check(
  "PlanOverlay trata repair_net_unavailable",
  planOverlay.includes(`err.code === "repair_net_unavailable"`),
  "Desde el #150 un cambio de solo frecuencia también puede recibirlo.",
);

console.log("\n── avisos de una simulación ──\n");

const flavorRoute = code(read("src/app/api/internal/subscription/flavor/route.ts"));
const beforeDryRun = plan.slice(plan.indexOf("export async function changePlan("), plan.indexOf("if (dryRun) {"));
const preDryRunAlerts = beforeDryRun.match(/alertSlackError(Awaited)?\((preWrite\()?/g) ?? [];
check(
  "los avisos que saltan antes de la rama de simulación pasan por preWrite",
  preDryRunAlerts.length >= 5 && preDryRunAlerts.every((m) => m.endsWith("preWrite(")),
  `Encontrados: ${JSON.stringify(preDryRunAlerts)}. La propuesta del bot es un dryRun que llega hasta ahí: sin el prefijo, el aviso parece un cambio escrito.`,
);
check(
  "la guarda de escritura a medias, que corre antes de simular, también",
  /assertNoUnfinishedLineWrite\([^)]*\bpreWrite\)\)/.test(plan) &&
    /async function assertNoUnfinishedLineWrite\([\s\S]*?alertSlackErrorAwaited\(preWrite\(\{/.test(plan),
  "Es la sexta que puede saltar en la propuesta del bot.",
);
check(
  "la puerta del bot se identifica como whatsapp_bot",
  /dryRun: body\.dryRun === true, eventSource: "whatsapp_bot"/.test(flavorRoute),
  "Sin eventSource el prefijo dice «Simulación» a secas.",
);

async function dryRunAlerts() {
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "KLAVIYO_PRIVATE_API_KEY", "SLACK_ALERTS_WEBHOOK_URL", "SLACK_SECURITY_WEBHOOK_URL", "SLACK_INCIDENTS_WEBHOOK_URL", "SEAL_API_TOKEN"]) {
    delete process.env[k];
  }
  const { markDryRunAlert } = await import("../src/lib/plan-core");
  const alert = { path: "/api/subscription/plan", code: "price_preserve_unavailable", msg: "sub 1: rechazado", customerId: "9" };
  const bot = markDryRunAlert(alert, true, "whatsapp_bot");
  check(
    "simulación del bot: el aviso lo dice delante",
    bot.msg === "Simulación del bot (no se ha escrito nada): sub 1: rechazado",
    bot.msg,
  );
  check(
    "y conserva path y code, que son la clave del dedupe de 60 s",
    bot.path === alert.path && bot.code === alert.code && bot.customerId === alert.customerId,
    JSON.stringify(bot),
  );
  check(
    "simulación del área personal: «Simulación» sin «del bot»",
    markDryRunAlert(alert, true, undefined).msg.startsWith("Simulación (no se ha escrito nada): "),
    "El dryRun del área personal (que no pasa eventSource) no es el bot.",
  );
  check(
    "sin dryRun, el aviso sale tal cual",
    markDryRunAlert(alert, false, "whatsapp_bot") === alert,
    "Una escritura real no es una simulación.",
  );
}

dryRunAlerts()
  .catch((e) => {
    console.error("✗ no se pudo cargar plan-core", e);
    failed++;
  })
  .finally(() => {
    console.log(failed ? `\n${failed} FALLO(S)\n` : "\nTodo bien.\n");
    process.exit(failed ? 1 : 0);
  });

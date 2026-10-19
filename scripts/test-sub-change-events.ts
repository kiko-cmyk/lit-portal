/**
 * Avisos de Klaviyo de los cambios que el cliente guarda en su suscripción
 * (2026-10-19): dirección (SUB-03), sabor (SUB-04) y plan (SUB-05), más el nombre
 * reservado de SUB-08 (punto de recogida).
 *
 *   npx tsx scripts/test-sub-change-events.ts
 *
 * Las reglas puras («plan», «sabor» o nada; dirección cambiada o no; las propiedades
 * con los nombres y tipos que leen los emails), el aviso de dirección con Klaviyo y
 * Seal sustituidos en memoria, y guardas de código fuente de que cada ruta emite
 * DESPUÉS de escribir y nunca en dry run ni sin cambios.
 *
 * Ningún camino de este test llega a una API real: antes de cargar los módulos se
 * vacían las variables de Supabase, Klaviyo y Slack, y `klaviyo.trackEvent` y
 * `seal.getSubscriptionById` se sustituyen por funciones que solo apuntan la llamada.
 */
import { readFileSync } from "node:fs";

for (const k of [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "KLAVIYO_PRIVATE_API_KEY",
  "SLACK_ALERTS_WEBHOOK_URL",
  "SLACK_SECURITY_WEBHOOK_URL",
  "SLACK_INCIDENTS_WEBHOOK_URL",
  "SEAL_API_TOKEN",
]) {
  delete process.env[k];
}

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

async function main() {
  const ev = await import("../src/lib/sub-change-events");
  const { klaviyo } = await import("../src/lib/klaviyo");
  const { seal } = await import("../src/lib/seal");

  type Call = { event: string; email: string; props: Record<string, unknown>; opts: Record<string, unknown> };
  const calls: Call[] = [];
  klaviyo.trackEvent = async (event, email, props = {}, opts = {}) => {
    calls.push({ event, email, props, opts });
  };
  let sealReads = 0;
  let sealAnswer: unknown = null;
  seal.getSubscriptionById = (async () => {
    sealReads++;
    return sealAnswer;
  }) as typeof seal.getSubscriptionById;

  // ── «plan», «sabor» o nada ───────────────────────────────────────────────────
  console.log("\n── qué evento toca ──\n");

  const L = (boxes: number) => [{ flavor: "salty-lemon" as const, boxes }];
  const W = (boxes: number) => [{ flavor: "salty-watermelon" as const, boxes }];
  const MIX = (lemon: number, wm: number) => [
    { flavor: "salty-lemon" as const, boxes: lemon },
    { flavor: "salty-watermelon" as const, boxes: wm },
  ];
  const s = (frequency: "1mo" | "2mo" | "15d", composition: ReturnType<typeof L> | ReturnType<typeof MIX>) => ({
    frequency,
    composition,
  });
  const cases: Array<[string, ReturnType<typeof s>, ReturnType<typeof s>, "plan" | "flavor" | null]> = [
    ["nada cambia", s("1mo", L(2)), s("1mo", L(2)), null],
    ["la misma mezcla en otro orden", s("1mo", MIX(2, 1)), s("1mo", [...MIX(2, 1)].reverse()), null],
    ["más cajas", s("1mo", L(1)), s("1mo", L(2)), "plan"],
    ["otra frecuencia", s("1mo", L(2)), s("2mo", L(2)), "plan"],
    ["frecuencia y sabor a la vez: plan", s("1mo", L(2)), s("2mo", W(2)), "plan"],
    ["cajas y sabor a la vez: plan", s("1mo", L(1)), s("1mo", W(3)), "plan"],
    ["mezcla con una caja más: plan", s("1mo", MIX(2, 1)), s("1mo", MIX(2, 2)), "plan"],
    ["solo el sabor", s("1mo", L(2)), s("1mo", W(2)), "flavor"],
    ["de un sabor a una mezcla con las mismas cajas", s("1mo", L(3)), s("1mo", MIX(2, 1)), "flavor"],
    ["otro reparto con las mismas cajas", s("1mo", MIX(2, 1)), s("1mo", MIX(1, 2)), "flavor"],
  ];
  for (const [name, before, after, want] of cases) {
    const got = ev.classifyPlanChange(before, after);
    check(name, got === want, `classifyPlanChange devolvió ${got}, se esperaba ${want}`);
  }
  check(
    "plan → subscription_plan_updated, sabor → subscription_flavor_updated",
    ev.planChangeEventName("plan") === "subscription_plan_updated" &&
      ev.planChangeEventName("flavor") === "subscription_flavor_updated",
    "Son los nombres EXACTOS de las métricas TuFAWF y SjgL4P de Klaviyo.",
  );

  // ── propiedades que leen los emails ──────────────────────────────────────────
  console.log("\n── propiedades ──\n");

  const SEAL_DATE = "2026-11-12T09:00:00+00:00";
  const planProps = ev.planChangeProps("plan", s("1mo", L(1)), s("2mo", L(2)), {
    nextShipDate: SEAL_DATE,
    sealSubscriptionId: 16923672,
    source: "portal_plan",
  });
  check(
    "plan: boxes y previousBoxes son NÚMEROS",
    planProps.boxes === 2 && planProps.previousBoxes === 1,
    `boxes=${JSON.stringify(planProps.boxes)} previousBoxes=${JSON.stringify(planProps.previousBoxes)}`,
  );
  check(
    "plan: frequency y previousFrequency en código",
    planProps.frequency === "2mo" && planProps.previousFrequency === "1mo",
    "El email traduce el código («cada 2 meses»): nada de «2 months».",
  );
  check(
    "plan: más cajas del mismo sabor NO es cambio de sabor",
    ev.planChangeProps("plan", s("1mo", W(1)), s("1mo", W(2)), {
      nextShipDate: SEAL_DATE,
      sealSubscriptionId: 1,
      source: "portal_plan",
    }).flavourChanged === false,
    "Prueba real del 19-oct: de 1 a 2 cajas de Watermelon salía con flavourChanged: true.",
  );
  check(
    "flavourChanged: los sabores y su reparto, no las cajas",
    ev.flavourChanged(MIX(2, 1), MIX(4, 2)) === false &&
      ev.flavourChanged(L(2), W(2)) === true &&
      ev.flavourChanged(MIX(2, 1), MIX(1, 2)) === true &&
      ev.flavourChanged(L(3), MIX(2, 1)) === true &&
      ev.flavourChanged(L(1), L(3)) === false,
    "Una mezcla 2+1 que pasa a 4+2 sigue siendo el mismo reparto; 2+1 → 1+2 no.",
  );
  check(
    "fecha: ISO de Seal tal cual y su etiqueta",
    planProps.nextShipDate === SEAL_DATE && planProps.nextShipDateLabel === "12 de noviembre",
    `nextShipDate=${planProps.nextShipDate} label=${planProps.nextShipDateLabel}`,
  );
  check(
    "sealSubscriptionId como texto y source",
    planProps.sealSubscriptionId === "16923672" && planProps.source === "portal_plan",
    "String(sub.id), como en el resto de eventos de suscripción.",
  );
  const optimistic = ev.planChangeProps("plan", s("1mo", L(1)), s("2mo", L(1)), {
    nextShipDate: "2026-12-04T13:00:00Z",
    sealSubscriptionId: 1,
    source: "skip_overlay",
  });
  check(
    "la fecha optimista de la ruta (T13:00:00Z) da el mismo día en sus 10 primeros caracteres",
    String(optimistic.nextShipDate).slice(0, 10) === "2026-12-04" && optimistic.nextShipDateLabel === "4 de diciembre",
    "Los emails sacan el día de los 10 primeros caracteres de nextShipDate.",
  );
  const noDate = ev.planChangeProps("plan", s("1mo", L(1)), s("2mo", L(1)), {
    nextShipDate: null,
    sealSubscriptionId: 1,
    source: "portal_plan",
  });
  check(
    "sin fecha, nextShipDate y su etiqueta a null (nunca la medianoche de hoy)",
    noDate.nextShipDate === null && noDate.nextShipDateLabel === null,
    "La ruta no promete fecha cuando no pudo guardar la intención de re-anclaje.",
  );
  const flavorProps = ev.planChangeProps("flavor", s("1mo", L(2)), s("1mo", W(2)), {
    nextShipDate: SEAL_DATE,
    sealSubscriptionId: 1,
    source: "portal_plan",
  });
  check(
    "sabor: nombre completo de un sabor",
    flavorProps.newFlavour === "Salty Watermelon" && flavorProps.previousFlavour === "Salty Lemon",
    `newFlavour=${flavorProps.newFlavour} previousFlavour=${flavorProps.previousFlavour}`,
  );
  check(
    "sabor: una mezcla se lee «2× Lemon · 1× Watermelon»",
    ev.planChangeProps("flavor", s("1mo", L(3)), s("1mo", MIX(2, 1)), {
      nextShipDate: SEAL_DATE,
      sealSubscriptionId: 1,
      source: "portal_plan",
    }).newFlavour === "2× Lemon · 1× Watermelon",
    "compositionLabel() de lib/mix.",
  );
  check(
    "sabor: no lleva boxes (no es su email)",
    !("boxes" in flavorProps),
    "Solo el de plan lleva cajas y frecuencia.",
  );

  check(
    "source: sin valor o «portal» → portal_plan",
    ev.planEventSource(undefined) === "portal_plan" && ev.planEventSource("portal") === "portal_plan",
    "PlanOverlay y FlavorOverlay no mandan source; en el ledger siguen siendo «portal».",
  );
  check(
    "source: las pantallas conocidas pasan tal cual",
    ["skip_overlay", "cancel_takeover", "profile_survey"].every((v) => ev.planEventSource(v) === v),
    "Son los valores para filtrar en Klaviyo.",
  );
  check(
    "source: un valor desconocido del cuerpo no llega a Klaviyo",
    ev.planEventSource("<script>") === "portal_plan",
    "El source viene del cliente: solo pasa la lista conocida.",
  );

  // ── dirección ────────────────────────────────────────────────────────────────
  console.log("\n── dirección ──\n");

  const base = { address1: "Calle Mayor 5", address2: "2º B", postalCode: "28013", city: "Madrid" };
  check(
    "misma dirección con mayúsculas y espacios distintos: sin cambio",
    !ev.addressChanged(base, { address1: " calle mayor  5", address2: "2º b", postalCode: "28013 ", city: "MADRID" }),
    "Guardar sin tocar nada no puede mandar «Dirección actualizada».",
  );
  check(
    "solo la provincia (derivada del CP): sin cambio",
    !ev.addressChanged({ ...base }, { ...base, province: "Madrid" } as typeof base),
    "Una sub vieja sin provincia daría un aviso por guardar la misma dirección.",
  );
  check("otro piso: cambio", ev.addressChanged(base, { ...base, address2: "3º A" }), "address2 lo pinta el email.");
  check("otro CP: cambio", ev.addressChanged(base, { ...base, postalCode: "28014" }), "zip lo pinta el email.");
  check("quitar el piso: cambio", ev.addressChanged(base, { ...base, address2: "" }), "address2 vacío también cambia.");

  const addr = {
    address1: "Calle Nueva 7",
    address2: undefined,
    city: "Barcelona",
    postalCode: "08001",
    country: "España",
    countryCode: "es",
    province: "Barcelona",
    provinceCode: "B",
    firstName: "Juan",
    lastName: "Prueba",
  };
  const props = ev.addressUpdatedProps(addr, {
    nextShipDate: SEAL_DATE,
    sealSubscriptionId: 123456,
    source: "whatsapp_bot",
  });
  check(
    "dirección: address2 vacío es \"\", no undefined",
    props.address2 === "" && props.zip === "08001" && props.city === "Barcelona" && props.address1 === "Calle Nueva 7",
    JSON.stringify(props),
  );
  check(
    "dirección: destinatario, país, fecha, id y source",
    props.firstName === "Juan" &&
      props.lastName === "Prueba" &&
      props.country === "España" &&
      props.province === "Barcelona" &&
      props.nextShipDateLabel === "12 de noviembre" &&
      props.sealSubscriptionId === "123456" &&
      props.source === "whatsapp_bot",
    JSON.stringify(props),
  );

  // notifyAddressUpdated con Seal y Klaviyo en memoria.
  const sealSubWith = (a: { address1: string; address2?: string; zip: string; city: string }) =>
    ({
      id: 123456,
      email: "prueba@example.test",
      status: "ACTIVE",
      delivery_interval: "1 month",
      s_address1: a.address1,
      s_address2: a.address2 ?? "",
      s_zip: a.zip,
      s_city: a.city,
      items: [],
      billing_attempts: [{ id: 1, date: SEAL_DATE, completed_at: "", status: "", skipped_on: "" }],
    }) as unknown as Parameters<typeof ev.notifyAddressUpdated>[0]["before"];
  const oldSub = sealSubWith({ address1: "Calle Mayor 5", address2: "2º B", zip: "28013", city: "Madrid" });
  const newSub = sealSubWith({ address1: "Calle Nueva 7", zip: "08001", city: "Barcelona" });
  const notify = (over: Partial<Parameters<typeof ev.notifyAddressUpdated>[0]>) =>
    ev.notifyAddressUpdated({
      before: oldSub,
      addr,
      refreshed: newSub,
      email: "prueba@example.test",
      customerId: "999",
      source: "portal",
      uniqueId: "address-change-test",
      path: "/test",
      delaysMs: [],
      ...over,
    });

  calls.length = 0;
  await notify({});
  check(
    "dirección nueva y Seal la enseña: UN evento con sus propiedades",
    calls.length === 1 &&
      calls[0].event === "subscription_address_updated" &&
      calls[0].props.zip === "08001" &&
      calls[0].props.source === "portal" &&
      calls[0].props.nextShipDate === SEAL_DATE &&
      calls[0].opts.uniqueId === "address-change-test" &&
      calls[0].opts.externalId === "999",
    JSON.stringify(calls),
  );
  check(
    "con la foto de la sub y el idioma",
    calls[0]?.props.boxCount !== undefined && calls[0]?.props.locale === "es",
    "subscriptionSnapshotProps(sub) + customerLocale().",
  );

  calls.length = 0;
  await notify({ before: newSub });
  check("guardar la misma dirección: ningún evento", calls.length === 0, JSON.stringify(calls));

  calls.length = 0;
  sealReads = 0;
  sealAnswer = oldSub;
  await notify({ refreshed: oldSub, delaysMs: [0, 0] });
  check(
    "Seal contesta OK pero sigue con la vieja: ningún evento",
    calls.length === 0 && sealReads === 2,
    `eventos=${calls.length} relecturas=${sealReads}. El edit de Seal puede no guardar nada con un 200.`,
  );

  calls.length = 0;
  await notify({
    addr: { ...addr, address2: "2º B" },
    refreshed: sealSubWith({ address1: "Calle Nueva 7", address2: "2B", zip: "08001", city: "Barcelona" }),
  });
  check(
    "Seal guarda el piso a su manera («2B» por «2º B»): el aviso sale igual",
    calls.length === 1 && calls[0].props.address2 === "2º B",
    "Se confirma por calle, CP y ciudad, como writeAddress; el email pinta lo que escribió el cliente.",
  );

  calls.length = 0;
  sealAnswer = newSub;
  await notify({ refreshed: null, delaysMs: [0] });
  check(
    "sin relectura inmediata, la de detrás la confirma: un evento",
    calls.length === 1,
    "Seal tarda ~1 s en enseñar la dirección escrita.",
  );

  // ── nombres de evento y documentación ────────────────────────────────────────
  console.log("\n── KlaviyoEvent y docs ──\n");

  const KLAVIYO = read("src/lib/klaviyo.ts");
  const DOCS = read("docs/KLAVIYO_SETUP.md");
  for (const name of [
    "subscription_address_updated",
    "subscription_flavor_updated",
    "subscription_plan_updated",
    "pickup_point_reminder",
  ]) {
    check(`«${name}» está en KlaviyoEvent`, KLAVIYO.includes(`| "${name}"`), "Añadirlo al tipo unión.");
    check(`«${name}» está en docs/KLAVIYO_SETUP.md`, DOCS.includes(`\`${name}\``), "Añadirlo a la tabla de eventos.");
  }

  // ── guardas de código: dónde se emite ────────────────────────────────────────
  console.log("\n── dónde se emite ──\n");

  const ADDRESS = code(read("src/app/api/subscription/address/route.ts"));
  check(
    "portal/dirección: el aviso va DESPUÉS de writeAddress y en after()",
    ADDRESS.indexOf("notifyAddressUpdated(") > ADDRESS.indexOf("await writeAddress(") &&
      ADDRESS.indexOf("await writeAddress(") > 0 &&
      /after\(\(\) =>\s*runWithoutRequestDeadline\(\(\) =>\s*notifyAddressUpdated\(/.test(ADDRESS),
    "Si Seal rechaza la escritura, writeAddress lanza antes y no hay evento.",
  );
  check(
    "portal/dirección: source portal",
    /notifyAddressUpdated\(\{[\s\S]*?source: "portal"/.test(ADDRESS),
    "El email y el filtro de Klaviyo distinguen portal y bot.",
  );

  const INTERNAL_ADDRESS = code(read("src/app/api/internal/subscription/address/route.ts"));
  const dryReturn = INTERNAL_ADDRESS.indexOf('mode: "dry_run" as const');
  const readReturn = INTERNAL_ADDRESS.indexOf('mode: "read" as const');
  const verifiedWrite = INTERNAL_ADDRESS.indexOf("await writeAddress(sealSub, addr, { verify: true })");
  const botNotify = INTERNAL_ADDRESS.indexOf("notifyAddressUpdated(");
  check(
    "bot/dirección: solo en modo write, después de la escritura verificada",
    readReturn > 0 && dryReturn > readReturn && verifiedWrite > dryReturn && botNotify > verifiedWrite,
    "Nunca en read ni en dry_run: esos modos devuelven antes de escribir.",
  );
  check(
    "bot/dirección: source whatsapp_bot",
    /notifyAddressUpdated\(\{[\s\S]*?source: "whatsapp_bot"/.test(INTERNAL_ADDRESS),
    "El email y el filtro de Klaviyo distinguen portal y bot.",
  );

  const EVENTS = code(read("src/lib/sub-change-events.ts"));
  const notifyBody = EVENTS.slice(EVENTS.indexOf("export async function notifyAddressUpdated"));
  check(
    "notifyAddressUpdated: sin cambio sale antes de nada",
    /if \(!addressChanged\(sealAddressOf\(input\.before\), input\.addr\)\) return;/.test(notifyBody) &&
      notifyBody.indexOf("addressChanged(sealAddressOf(input.before)") < notifyBody.indexOf("sendSubChangeEvent("),
    "Guardar la misma dirección no avisa.",
  );

  const PLAN = code(read("src/app/api/subscription/plan/route.ts"));
  const dryRunAt = PLAN.indexOf("if (dryRun) {");
  const verifiedAt = PLAN.indexOf('await writeAudit("verified")');
  const verifiedSend = PLAN.indexOf("sendPlanEvent(confirmed, promised)");
  const verifiedReturn = PLAN.indexOf("return { ...mapToSubscription(verified, ctx.customerId), nextShipDate: finalNextShipDate }");
  check(
    "plan: la salida verificada emite tras writeAudit(\"verified\") y antes del return",
    verifiedAt > 0 && verifiedSend > verifiedAt && verifiedReturn > verifiedSend,
    "Es lo que pide el brief: el evento sale con el cambio confirmado en Seal.",
  );
  const sendSites = [...PLAN.matchAll(/sendPlanEvent\(/g)].map((m) => m.index ?? 0);
  check(
    "plan: ningún envío antes del cortocircuito del dry run",
    dryRunAt > 0 && sendSites.length >= 2 && sendSites.filter((i) => i < dryRunAt).length === 0,
    "Lo de antes del dry run solo puede ser la definición, que va después de writeAudit.",
  );
  check(
    "plan: el aviso solo existe si el cambio es plan o sabor",
    /const planEventKind = currentComposition\.length \? classifyPlanChange\(planEventBefore, planEventAfter\) : null;/.test(PLAN) &&
      /planEventKind\s*\?\s*sendSubChangeEvent\(planChangeEventName\(planEventKind\)/.test(PLAN),
    "Sin cambios (o con la misma composición y frecuencia), ningún evento.",
  );
  check(
    "plan: el uniqueId es el requestId de la petición",
    PLAN.includes("uniqueId: planChangeUniqueId(ledger.requestId)"),
    "El mismo id que las filas del ledger: si dos caminos lo confirman, Klaviyo se queda con uno.",
  );
  check(
    "plan: el source de la pantalla pasa por la lista conocida",
    PLAN.includes("source: planEventSource(body.source)"),
    "portal_plan, skip_overlay, cancel_takeover o profile_survey.",
  );
  check(
    "plan: la comprobación de detrás de una verificación sin respuesta exige ver lo pedido",
    /if \(confirmed && sealShowsTarget\(confirmed\)\) await sendPlanEvent\(confirmed, promised\);/.test(PLAN),
    "Sin ver el intervalo y las líneas pedidas en Seal no hay aviso.",
  );

  const RUNNER = code(read("src/lib/line-repair-runner.ts"));
  const runnerSends = [...RUNNER.matchAll(/notifyConfirmedRepair\(/g)].length;
  check(
    "reparación: avisa solo al cerrar hacia el objetivo (applied), nunca al volver a la foto",
    runnerSends === 2 &&
      /if \(closed && atTarget\) \{[\s\S]{0,200}notifyConfirmedRepair\(intent, sub, path\)/.test(RUNNER) &&
      /if \(closed && plan\.towards === "target"\) \{[\s\S]{0,200}notifyConfirmedRepair\(intent, after, path\)/.test(RUNNER),
    "Un cambio que no entró (rolled_back) o una sub inactiva no pueden mandar «actualizado».",
  );
  check(
    "reparación: solo emite si Seal enseña lo que pidió esa petición",
    /live\.frequency !== target\.frequency \|\| !sameComposition\(live\.composition, target\.composition\)/.test(EVENTS),
    "notifyConfirmedRepair compara lo vivo con el `to` de la fila intent.",
  );

  const FREQ = code(read("src/app/api/internal/subscription/frequency/route.ts"));
  check(
    "bot/frecuencia: subscription_plan_updated solo con result.changed y después del dry run",
    FREQ.indexOf("if (result.changed) {") > FREQ.indexOf('mode: "dry_run" as const') &&
      /if \(result\.changed\) \{[\s\S]*?sendSubChangeEvent\(planChangeEventName\(kind\)[\s\S]*?source: "whatsapp_bot"/.test(FREQ),
    "Una consulta, una propuesta o un cambio que ya estaba hecho no avisan.",
  );

  // ── las pantallas mandan su source ───────────────────────────────────────────
  console.log("\n── source de cada pantalla ──\n");
  check(
    "SkipOverlay manda skip_overlay",
    /reanchorMode: "fromNext",\s*[\s\S]{0,120}source: "skip_overlay"/.test(read("src/components/SkipOverlay.tsx")),
    "El ajuste desde el aviso de skip.",
  );
  check(
    "CancelTakeover manda cancel_takeover en todas sus ofertas",
    /currentFrequency: freq,[\s\S]{0,160}source: "cancel_takeover",\s*\.\.\.body/.test(read("src/components/CancelTakeover.tsx")),
    "applyPlan es el único camino de sus ofertas a la ruta de plan.",
  );
  check(
    "la encuesta de perfil sigue mandando profile_survey",
    read("src/components/ProfileSurveyOverlay.tsx").includes('source: "profile_survey"'),
    "Ya lo mandaba; el evento lo reutiliza.",
  );
  check(
    "PlanOverlay y FlavorOverlay no cambian el source del ledger",
    !/source:/.test(code(read("src/components/PlanOverlay.tsx"))) &&
      !/source:/.test(code(read("src/components/FlavorOverlay.tsx"))),
    "scripts/demix-subscription.ts busca `payload.source = 'portal'` para saber qué mezclas creó el portal.",
  );

  console.log(failed === 0 ? "\nTodo OK" : `\n${failed} fallo(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

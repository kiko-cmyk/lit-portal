/**
 * Guardas de CÓDIGO FUENTE de los referidos (fase 0).
 *
 *   npx tsx scripts/test-referral-guards.ts
 *
 * Como test-discovery-discount-guard.ts y por el mismo motivo: esto habla con
 * Seal, Shopify, Klaviyo y Supabase, y lo que no puede volver a pasar se ve
 * leyendo los ficheros. Cada check nombra la regla de dinero que protege. Si un
 * fichero se reestructura, ACTUALIZA el test, no lo borres.
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

const shopifyHook = read("src/app/api/webhooks/shopify/route.ts");
const sealHook = read("src/app/api/webhooks/seal/route.ts");
const reward = read("src/lib/referral-reward.ts");
const shop = read("src/lib/referral-shopify.ts");
const plan = read("src/app/api/subscription/plan/route.ts");
const retention = read("src/lib/retention-discount.ts");
const cleanup = read("src/app/api/cron/survey-discount-cleanup/route.ts");
const migration = read("database/migrations/2026-10-10_referrals_fase0.sql");
const vercel = read("vercel.json");
const card = read("src/components/ReferralCard.tsx");
const codeRoute = read("src/app/api/referral/code/route.ts");
const cron = read("src/app/api/cron/referral-sweep/route.ts");
const surfaces = {
  PlanOverlay: read("src/components/PlanOverlay.tsx"),
  FlavorOverlay: read("src/components/FlavorOverlay.tsx"),
  CancelTakeover: read("src/components/CancelTakeover.tsx"),
  SkipOverlay: read("src/components/SkipOverlay.tsx"),
};
/** El cuerpo de una función de nivel superior: desde su firma hasta la siguiente. */
const fnBody = (src: string, signature: string) => {
  const start = src.indexOf(signature);
  if (start < 0) return "";
  const next = src.slice(start + signature.length).search(/\n(export )?(async )?function /);
  return next < 0 ? src.slice(start) : src.slice(start, start + signature.length + next);
};

console.log("\n── webhook de Shopify ──\n");

check(
  "no queda la atribución muerta por note_attributes.ref",
  !/note_attributes\?\.find\([^)]*"ref"/.test(code(shopifyHook)) && !/referral_converted/.test(code(shopifyHook)),
  "La vía de abril (?ref= de GoAffPro, 250 Drops sin guardas) no debe volver.",
);
{
  const body = code(shopifyHook);
  const iConfirmation = body.indexOf('trackEvent("confirmation_sent"');
  const iReferral = body.indexOf("recordOrderPaid(");
  check(
    "el paso de referidos va DESPUÉS de confirmation_sent",
    iConfirmation > 0 && iReferral > iConfirmation,
    "Si el paso de referidos lanzara antes, Shopify reintentaría el webhook y el cliente recibiría dos confirmaciones.",
  );
  const around = body.slice(Math.max(0, iReferral - 200), iReferral + 400);
  check(
    "y dentro de su propio try/catch",
    /try\s*\{[\s\S]*recordOrderPaid\([\s\S]*\}\s*catch/.test(around),
    "recordOrderPaid tiene que ir envuelto: un throw borraría la reserva de webhook_log.",
  );
  check(
    "lo caro va en after()",
    /after\(\(\)\s*=>\s*runAsBackgroundJob\(\(\)\s*=>\s*processOrderPaidFollowUp/.test(body),
    "Cualificar contra Seal/Shopify dentro de la respuesta acerca el webhook a los 5 s de Shopify.",
  );
  check(
    "si falla el REGISTRO, avisa (no queda fila que el cron recoja)",
    /referral_record_failed/.test(body) && /await alertSlackErrorAwaited\(/.test(body.slice(iReferral)),
    "Un registro perdido es un premio perdido sin que nadie lo sepa.",
  );
}

console.log("\n── webhook de Seal: solo consume ──\n");

check(
  "importa solo consumeReferralRewardsForSub",
  /import \{ consumeReferralRewardsForSub \} from "@\/lib\/referral-reward"/.test(sealHook) &&
    !/runRewardSweep|applyReward|detachAllRewards/.test(code(sealHook)),
  "Aplicar es cosa SOLO del cron: apply de Seal no es idempotente y dos aplicadores serían 20 € en un cobro.",
);

{
  const body = code(sealHook);
  const i = body.indexOf('case "subscription.reactivated":');
  const block = body.slice(i, body.indexOf("break;", i));
  check(
    "una sub que vuelve (resumed, reactivated) adelanta la cola de su dueño",
    i > 0 && /consumeReferralRewardsForSub\(sub\)/.test(block),
    "Si no, sus 10 € esperarían días a la siguiente mirada programada.",
  );
}

console.log("\n── lib/referral-reward.ts ──\n");
{
  const body = code(reward);
  check(
    "verifica al amigo con seal.getSubscriptionsByEmail",
    /seal\.getSubscriptionsByEmail\(order\.email\)/.test(body),
    "Seal es la fuente de verdad: también cuentan las subs canceladas.",
  );
  check(
    "NUNCA usa la caché resolveActiveSubFast",
    !/resolveActiveSubFast/.test(body),
    "La caché da null en un cache miss y se traga los fallos (incidente del 23-sep con los cupones del perfilado).",
  );
  check(
    "retira TODOS los UUID (findAllAppliedDiscountCodeIds)",
    /findAllAppliedDiscountCodeIds/.test(body) && !/findAppliedDiscountCodeId\(/.test(body),
    "Quitar solo el primero deja el descuento en las demás líneas (la fuga de LITSTAY15).",
  );
  const applies = body.match(/seal\.applyDiscountCode\(/g) ?? [];
  check(
    "seal.applyDiscountCode aparece UNA vez (en applyReward)",
    applies.length === 1 && body.indexOf("seal.applyDiscountCode(") > body.indexOf("async function applyReward"),
    "Un único aplicador.",
  );
  const fn = body.slice(body.indexOf("async function applyReward"));
  check(
    "applyReward relee la sub ANTES de aplicar",
    fn.indexOf("seal.getSubscriptionById(") > 0 && fn.indexOf("seal.getSubscriptionById(") < fn.indexOf("seal.applyDiscountCode("),
    "Sin lectura fresca se aplicaría encima de un código ya puesto (descuento doble, incidente BONUS5).",
  );
  check(
    "applyReward comprueba el total después (checkApplyPostcondition)",
    fn.indexOf("checkApplyPostcondition(") > fn.indexOf("seal.applyDiscountCode("),
    "Hay que verificar que bajó EXACTAMENTE 10 €: en multi-línea podría repartirse por línea.",
  );
  check(
    "applyReward toma el cerrojo del cambio de plan ANTES de aplicar",
    fn.indexOf("acquirePlanLock(") > 0 && fn.indexOf("acquirePlanLock(") < fn.indexOf("seal.applyDiscountCode(") &&
      /lock\.release\(\)/.test(fn),
    "Sin cerrojo, un swap del cliente a la vez arrastraría el código de forma invisible.",
  );
  {
    const outer = fnBody(body, "async function applyReward(");
    const locked = fnBody(body, "async function applyRewardLocked(");
    check(
      "el cerrojo se toma ANTES de reclamar la recompensa (queued → applying)",
      outer.indexOf("acquirePlanLock(") > 0 && outer.indexOf("acquirePlanLock(") < outer.indexOf("applyRewardLocked(") &&
        locked.indexOf('status: "applying"') > 0 && !/acquirePlanLock\(/.test(locked),
      "Una fila en applying tiene que tener siempre el cerrojo detrás; si no, un swap del cliente se cruza con la aplicación.",
    );
    const ttl = Number(/const APPLY_LOCK_TTL_SECONDS = (\d+)/.exec(body)?.[1] ?? 0);
    check(
      "el cerrojo del cron es estricto y vive más que la función (60 s)",
      /ttlSeconds: APPLY_LOCK_TTL_SECONDS/.test(outer) && /strict: true/.test(outer) && ttl > 60,
      `TTL ${ttl}: con 30 s caducaba a mitad de una aplicación y su release() podía borrar el cerrojo de otra petición.`,
    );
    check(
      "Klaviyo y el aviso de Slack van DESPUÉS de soltar el cerrojo",
      outer.indexOf("lock.release()") > 0 &&
        outer.indexOf("lock.release()") < outer.indexOf("notifyRewardApplied(") &&
        outer.indexOf("lock.release()") < outer.indexOf("alertSlackNoticeAwaited(") &&
        !/trackEvent\(|alertSlackNoticeAwaited\(/.test(locked),
      "Mientras el cerrojo está tomado el cliente no puede cambiar su plan: nada lento dentro.",
    );
    check(
      "si el apunte final falla y la fila se movió, se quita el código huérfano",
      /handleUnrecordedApply\(/.test(locked) && /referral_reward_apply_orphan_removed/.test(body),
      "Un código puesto sin recompensa viva detrás se cobraría en cada renovación.",
    );
  }
  {
    const sweep = fnBody(body, "export async function runRewardSweep(");
    check(
      "el presupuesto de una aplicación se mide contra el FINAL de la función",
      /canStartApply\(functionLeft\(\)\)/.test(sweep) && /opts\.hardDeadlineMs/.test(sweep) &&
        !/const APPLY_MIN_BUDGET_MS/.test(body),
      "Medido contra el corte de la fase (30 s) con un umbral de 35 s, el cron no aplicaba nunca nada (2.ª revisión).",
    );
    check(
      "la cola se filtra por REFERRAL_REWARDS en la consulta",
      /referralRewardsScope\(\)/.test(sweep) && /\.in\("referrer_customer_id", scope\.ids\)/.test(sweep),
      "Filtrada después, con allowlist las de fuera llenarían el lote y las de dentro no llegarían.",
    );
    check(
      "la cola se recorre por next_check_at, sin poner las vacías delante",
      /\.order\("next_check_at"/.test(sweep) && !/nullsFirst/.test(body),
      "Una fila sin fecha delante de las vencidas es una cola que no avanza.",
    );
    check(
      "una espera siempre deja fecha (nextCheckAt de la lógica pura)",
      /nextCheckAt\(action\.reason/.test(sweep) && !/function nextCheckFor/.test(body),
      "",
    );
    check(
      "las fallidas se limpian ANTES de la cola",
      sweep.indexOf("sweepFailedRewards(") > 0 && sweep.indexOf("sweepFailedRewards(") < sweep.indexOf("runList(queued)"),
      "Quitar un código que sobra pesa más que poner uno nuevo.",
    );
    check(
      "volver a la cola y nacer en cola dejan next_check_at con fecha",
      /next_check_at: nowIso\(\)/.test(fnBody(body, "function requeuePatch(")) &&
        /next_check_at: nowIso\(\)/.test(fnBody(body, "async function createRewardAndNotify(")),
      "",
    );
  }
  {
    const consume = fnBody(body, "async function consumeReward(");
    check(
      "consumir: un pedido que ya cerró otra recompensa (23505) avisa",
      /23505/.test(consume) && /referral_reward_consume_conflict/.test(consume),
      "Dos LITREF en un mismo cobro son 20 € donde tocaban 10.",
    );
    check(
      "consumir sin poder leer Seal NO cierra ni deja en cola",
      /found === null/.test(consume) && /consumed_detach_unconfirmed/.test(consume),
      "Cerrarla dejaría el código puesto; dejarla en cola haría que el cron la reaplicara.",
    );
    check(
      "reencolar a mano exige --force en los motivos de código invisible, y mira antes si ya se cobró",
      /UNSAFE_REQUEUE_REASON\.test/.test(body) && /opts\.force/.test(fnBody(body, "export async function requeueFailedReward(")) &&
        /appliedState\(/.test(fnBody(body, "export async function requeueFailedReward(")),
      "Reencolar encima de un código invisible es el descuento doble del incidente BONUS5.",
    );
  }
  check(
    "applyReward apunta apply_sent_at ANTES de llamar a Seal",
    fn.indexOf("apply_sent_at: nowIso()") > 0 && fn.indexOf("apply_sent_at: nowIso()") < fn.indexOf("seal.applyDiscountCode("),
    "Si la pasada muere a mitad, la siguiente tiene que saber si la orden salió (premio doble si adopta con «ahora»).",
  );
  check(
    "adoptar usa la fecha en que SALIÓ la orden, nunca «ahora»",
    /applied_at: r\.apply_sent_at \?\? r\.updated_at/.test(body),
    "Adoptar con la fecha de hoy deja fuera un cobro que ya llevó el código y lo reaplica.",
  );
  {
    const renewal = body.slice(body.indexOf("async function handleRenewalOrder"), body.indexOf("async function detachFromCustomerSubs"));
    check(
      "una renovación con LITREF consume la recompensa también en applying y en cola",
      /r\.status === "applied" \|\| r\.status === "applying" \|\| r\.status === "queued"/.test(renewal),
      "Si solo se atiende «applied», una recompensa reencolada a destiempo se reaplica: 20 €.",
    );
    check(
      "y avisa de FUGA en cualquier otro estado",
      /leakAlertAndDetach\(/.test(renewal),
      "Un LITREF en una renovación con la recompensa consumida, fallida, revocada o caducada es una fuga.",
    );
    check(
      "una FALLIDA cuyo código sale en una renovación se cierra como consumida",
      /r\.status === "failed" && !r\.consumed_order_id/.test(renewal) && /consumeReward\(r, order\.orderId, "failed"/.test(renewal),
      "Si se quedara en failed, reencolarla a mano serían otros 10 €.",
    );
  }
  check(
    "las alertas de dinero llevan el id (el dedupe de 60 s no funde dos casos)",
    /code: `\$\{code\}:\$\{id\}`/.test(body),
    "alertSlackError deduplica por (path, code) durante 60 s.",
  );
  check(
    "el consumo exige el pedido con el código delante",
    /discountCodes\.includes\(code\)/.test(body),
    "Un completed_at no basta: lo que importa es que el descuento salió en un pedido de verdad.",
  );
  check(
    "la cualificación no rechaza por un fallo de lectura (retry)",
    /if \(result\.outcome === "retry"\) return retryOrReview\(/.test(body),
    "Rechazar por un Seal caído le quitaría el premio a alguien por un problema nuestro.",
  );
}

console.log("\n── cambio de plan ──\n");
{
  const body = code(plan);
  const iDetach = body.indexOf("detachReferralRewardsForSwap(");
  const iIntent = body.indexOf('writeAudit("intent")');
  const iStep1 = body.indexOf("seal.editSubscription(");
  const iAdd = body.indexOf("seal.addItems(");
  const iRemove = body.indexOf("seal.removeItems(");
  check(
    "retira la recompensa ANTES de cualquier escritura en Seal",
    iDetach > 0 && iDetach < iIntent && iDetach < iStep1 && iDetach < iAdd && iDetach < iRemove,
    "Un alta + baja de líneas arrastra el código de forma invisible; si se retira después, ya es tarde.",
  );
  check(
    "la guarda recibe la sub que leyó la ruta (para los LITREF sin recompensa detrás)",
    /detachReferralRewardsForSwap\(sealSubscriptionId, preMutationSub\)/.test(body),
    "Un LITREF suelto en la sub también lo arrastraría el swap.",
  );
  const around = body.slice(iDetach - 400, iDetach + 700);
  check(
    "y si no puede, aborta con 409 (sin tocar nada; un 5xx lo taparía el App Proxy)",
    /referral_reward_busy/.test(around) && /throw new ApiHttpError\(\s*409/.test(around),
    "Seguir con el swap con el código puesto es la fuga que esto evita.",
  );
}

console.log("\n── configuración de los descuentos ──\n");
{
  const parent = shop.slice(shop.indexOf("export async function createFriendParentDiscount"), shop.indexOf("export async function bulkAddFriendCodes"));
  const pc = code(parent);
  check("amigo: vale en compra única", /appliesOnOneTimePurchase: true/.test(pc), "Decisión del 9-oct: no se frena a quien no quiere suscribirse.");
  check("amigo: vale en suscripción (explícito)", /appliesOnSubscription: true/.test(pc), "Shopify lo pone a false por defecto.");
  check("amigo: solo el primer cobro de una suscripción", /recurringCycleLimit: 1/.test(pc), "");
  check("amigo: un uso por cliente para TODO el padre", /appliesOncePerCustomer: true/.test(pc), "");
  check("amigo: sin usageLimit (cuenta el total del padre)", !/usageLimit:/.test(pc), "Con varios códigos, usageLimit cuenta el total del descuento padre.");
  check("amigo: customerSelection all, nunca un segmento", /customerSelection: \{ all: true \}/.test(pc), "Restringir por cliente dejó los cupones de GoAffPro con cero canjes.");
  check("amigo: no combinable", /combinesWith: \{ orderDiscounts: false, productDiscounts: false, shippingDiscounts: false \}/.test(pc), "");

  const rew = code(shop.slice(shop.indexOf("export async function createRewardDiscount"), shop.indexOf("export async function findCodeDiscountNodeId")));
  check("recompensa: solo suscripción", /appliesOnOneTimePurchase: false/.test(rew) && /appliesOnSubscription: true/.test(rew), "");
  check("recompensa: un solo uso", /usageLimit: 1/.test(rew), "");

  const prefixes = [...cleanup.matchAll(/"([^"]+ )"/g)].map((m) => m[1]);
  const title = /REWARD_DISCOUNT_TITLE_PREFIX = "([^"]+)"/.exec(shop)?.[1] ?? "";
  check(
    "el título de las recompensas NO lo barre el cron de limpieza",
    !!title && prefixes.length > 0 && !prefixes.some((p) => title.startsWith(p.trim())),
    `Título "${title}" frente a CAMPAIGN_PREFIXES ${JSON.stringify(prefixes)}: un LITREF borrado mientras está aplicado no se podría reaplicar.`,
  );
}

console.log("\n── LITSTAY15 ──\n");
check(
  "el consumidor retira todas las copias",
  /findAllAppliedDiscountCodeIds\(fresh/.test(code(retention)) && !/findAppliedDiscountCodeId\(fresh/.test(code(retention)),
  "En una sub de varias líneas, quitar solo la primera copia deja el 15% en las demás.",
);

console.log("\n── migración y despliegue ──\n");
check(
  "índice del dinero: una recompensa viva por sub",
  /create unique index if not exists uq_referral_rewards_live_per_sub\s+on referral_rewards \(seal_subscription_id\) where status in \('applying', 'applied'\)/.test(migration),
  "",
);
check("un amigo cualifica una vez", /uq_referral_conversions_friend_once/.test(migration), "");
check(
  "RLS en las tres tablas",
  ["referral_codes", "referral_conversions", "referral_rewards"].every((t) =>
    new RegExp(`alter table ${t}\\s+enable row level security`).test(migration),
  ),
  "Patrón de toda tabla del portal: RLS ON y cero policies.",
);
check("el cron está en vercel.json", /"\/api\/cron\/referral-sweep"/.test(vercel), "");
{
  const crons = (JSON.parse(vercel).crons ?? []) as Array<{ path: string; schedule: string }>;
  const sweep = crons.find((c) => c.path === "/api/cron/referral-sweep");
  check(
    "y corre cada 4 h (la ventana de 48 h tiene una docena de pasadas)",
    sweep?.schedule === "50 */4 * * *",
    `schedule = ${sweep?.schedule}: una vez al día deja cobros con una sola oportunidad de aplicar.`,
  );
  const hard = Number(/hardDeadlineMs: started \+ (\d+)_?(\d*)/.exec(cron)?.slice(1).join("") ?? 0);
  const phase = Number(/runRewardSweep\(\{[\s\S]*?deadlineMs: started \+ (\d+)_?(\d*)/.exec(cron)?.slice(1).join("") ?? 0);
  check(
    "el cron pasa el final real de la función, por encima del corte de la fase y por debajo de 60 s",
    hard > phase && hard <= 58_000 && phase > 0,
    `fase ${phase} ms, función ${hard} ms.`,
  );
}
check(
  "next_check_at nace con fecha y su ALTER va antes de los índices",
  /next_check_at\s+timestamptz default now\(\)/.test(migration) &&
    migration.indexOf("add column if not exists next_check_at") > 0 &&
    migration.indexOf("add column if not exists next_check_at") < migration.indexOf("create index if not exists idx_referral_rewards_next_check"),
  "Si la tabla existiera sin la columna, el índice fallaría antes de llegar al ALTER.",
);

console.log("\n── superficies ──\n");
check("la tarjeta no usa ?ref= (es de GoAffPro)", !/\?ref=/.test(card), "");
check("sin guiones largos en la tarjeta", !/[—–]/.test(card.replace(/^\s*(\/\/|\*).*$/gm, "")), "Guía de copy de LIT.");
for (const [name, src] of Object.entries(surfaces)) {
  check(
    `${name} explica plan_change_in_progress y referral_reward_busy`,
    /plan_change_in_progress/.test(src) && /referral_reward_busy/.test(src),
    "Con el cron aplicando bajo el cerrojo, un cliente puede encontrárselo tomado: mejor un «espera un momento» que un error genérico.",
  );
}
check(
  "GET /api/referral/code no crea nada en Shopify",
  !/createFriendParentDiscount|bulkAddFriendCodes|createRewardDiscount/.test(code(codeRoute)),
  "El portal solo lee; el alta en Shopify es del cron.",
);

console.log(failed ? `\n${failed} FALLO(S)\n` : "\nTodo bien.\n");
process.exit(failed ? 1 : 0);

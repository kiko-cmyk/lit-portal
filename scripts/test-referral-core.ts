/**
 * Tests de la lógica pura de los referidos (src/lib/referral-core.ts).
 *
 *   npx tsx scripts/test-referral-core.ts
 *
 * Cubren las reglas de dinero de la fase 0: quién gana su premio, cuándo se
 * aplica en Seal, cuándo se da por consumido y qué pasa en cada caso raro. Sin
 * red: la orquestación (referral-reward.ts) solo reúne hechos y obedece a esto.
 */

import {
  APPLY_MIN_BUDGET_MS,
  APPLY_MIN_LEAD_MS,
  APPLY_WINDOW_MS,
  APPLYING_STUCK_MS,
  buildShareText,
  canStartApply,
  MAX_NEXT_CHECK_MS,
  nextCheckAt,
  SWEEP_INTERVAL_MS,
  CHARGE_MOVED_AWAY_MS,
  checkApplyPostcondition,
  decideRewardAction,
  eurosToCents,
  generateReferralCode,
  generateRewardCode,
  hasB2BTag,
  isRenewalSource,
  isRewardCode,
  normalizeAddress,
  normalizeEmail,
  normalizeFirstName,
  normalizePhone,
  purchaseTypeOf,
  QUALIFY_RETRY_MS,
  qualifyConversion,
  VELOCITY_LIMIT,
  whatsappShareUrl,
  type AppliedSubState,
  type QualifyFacts,
  type RewardFacts,
  type RewardSnapshot,
} from "../src/lib/referral-core";

let failed = 0;
function check(name: string, cond: boolean, hint = "") {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}${hint ? `\n    ${hint}` : ""}`);
    failed++;
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── el código personal ──\n");

check("José María → JOSE", normalizeFirstName("José María") === "JOSE");
check("Ñandú → NANDU", normalizeFirstName("Ñandú") === "NANDU");
check("Jean-Pierre → JEANPIERRE", normalizeFirstName("Jean-Pierre") === "JEANPIERRE");
check("inicial suelta → null", normalizeFirstName("M.") === null);
check("vacío → null", normalizeFirstName("   ") === null && normalizeFirstName(null) === null);
check("alfabeto no latino → null", normalizeFirstName("李") === null);
check("demasiado largo → null", normalizeFirstName("Maximilianoooo") === null);
check("nombres reservados → null", normalizeFirstName("Lit") === null && normalizeFirstName("Amigo") === null);

const fixed = (n: number) => () => n;
check("nombre + 2 cifras", generateReferralCode("María", { randomInt: fixed(17) }) === "MARIA27");
check("nombre + 3 cifras", generateReferralCode("María", { digits: 3, randomInt: fixed(174) }) === "MARIA274");
check("sin nombre → AMIGO + 4 cifras", generateReferralCode("", { randomInt: fixed(234) }) === "AMIGO1234");
check("las cifras nunca empiezan por 0", generateReferralCode("Ana", { randomInt: fixed(0) }) === "ANA10");

let allOk = true;
for (let i = 0; i < 2000; i++) {
  const c = generateReferralCode(i % 3 ? "Lucía" : null);
  if (!/^(LUCIA[1-9]\d|AMIGO[1-9]\d{3})$/.test(c)) allOk = false;
  if (c.startsWith("LIT-") || c.startsWith("LITREF-") || c.includes("-")) allOk = false;
}
check("2000 códigos aleatorios: formato correcto, sin guion, nunca LIT- ni LITREF-", allOk);

let rewardOk = true;
for (let i = 0; i < 500; i++) {
  const c = generateRewardCode();
  if (!/^LITREF-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/.test(c)) rewardOk = false;
}
check("códigos de recompensa: LITREF- + 8 sin ambiguos", rewardOk);
check("isRewardCode", isRewardCode(" litref-abcd2345 ") && !isRewardCode("MARIA27"));
check("renovación de Seal", isRenewalSource("subscription_contract_checkout_one") && !isRenewalSource("web") && !isRenewalSource(null));
check("etiqueta B2B, sin mirar B2B_ACCOUNT_ONLY", hasB2BTag([" B2B "]) && !hasB2BTag(["b2b-lead", "vip"]) && !hasB2BTag(null));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── compartir ──\n");

const es = buildShareText("MARIA27", "es");
const en = buildShareText("MARIA27", "en");
check("el texto lleva el código", es.includes("MARIA27") && en.includes("MARIA27"));
check("sin guiones largos", !/[—–]/.test(es + en));
check("sin emojis", !/\p{Extended_Pictographic}/u.test(es + en));
check("sin enlaces largos (solo litsalt.com)", !/https?:\/\//.test(es + en));
check(
  "el enlace de WhatsApp codifica el texto",
  decodeURIComponent(whatsappShareUrl(es).replace("https://wa.me/?text=", "")) === es,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── normalizadores ──\n");

check("email: mayúsculas y espacios", normalizeEmail("  Maria@Example.COM ") === "maria@example.com");
check("email: +etiqueta fuera", normalizeEmail("maria+lit@example.com") === "maria@example.com");
check("gmail: puntos fuera", normalizeEmail("ma.ri.a+x@gmail.com") === "maria@gmail.com");
check("googlemail = gmail", normalizeEmail("ma.ria@googlemail.com") === "maria@gmail.com");
check("email inválido → null", normalizeEmail("sin-arroba") === null);

check("móvil español sin prefijo → +34", normalizePhone("612 345 678") === "+34612345678");
check("con 0034", normalizePhone("0034 612345678") === "+34612345678");
check("con +34", normalizePhone("+34 612-34-56-78") === "+34612345678");
check("34 sin +", normalizePhone("34612345678") === "+34612345678");
check("demasiado corto → null", normalizePhone("1234") === null);

check(
  "«C/ Mayor 5, 2ºB» = «Calle Mayor 5 2B»",
  normalizeAddress("C/ Mayor 5, 2ºB", "28013") === normalizeAddress("Calle Mayor 5 2B", "28013"),
);
check(
  "«Avda. de la Paz 12» = «Avenida de la Paz, 12»",
  normalizeAddress("Avda. de la Paz 12", "41001") === normalizeAddress("Avenida de la Paz, 12", "41001"),
);
check(
  "la puerta cuenta: 2ºA ≠ 2ºB",
  normalizeAddress("Calle Mayor 5, 2ºA", "28013") !== normalizeAddress("Calle Mayor 5, 2ºB", "28013"),
);
check(
  "otro código postal ≠",
  normalizeAddress("Calle Mayor 5", "28013") !== normalizeAddress("Calle Mayor 5", "28014"),
);
check("sin código postal → null", normalizeAddress("Calle Mayor 5", null) === null);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── qué compró el amigo ──\n");

check("suscripción", purchaseTypeOf([{ inCollection: true, hasSellingPlan: true }]) === "subscription");
check("compra única", purchaseTypeOf([{ inCollection: true, hasSellingPlan: false }]) === "one_time");
check(
  "mixto",
  purchaseTypeOf([
    { inCollection: true, hasSellingPlan: true },
    { inCollection: true, hasSellingPlan: false },
  ]) === "mixed",
);
check(
  "lo que no es caja no cuenta (Discovery Set suelto)",
  purchaseTypeOf([{ inCollection: false, hasSellingPlan: false }]) === "none",
);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── cualificar al amigo ──\n");

const base: QualifyFacts = {
  isRenewal: false,
  orderVoided: false,
  hasLitBox: true,
  codeActive: true,
  referrerIsB2B: false,
  referrerCustomerId: "R1",
  friendCustomerId: "F1",
  sameEmail: false,
  samePhone: false,
  sameAddress: false,
  friendPriorBoxOrders: 0,
  friendOtherSealSubs: 0,
  friendAlreadyQualified: false,
  referrerQualifiedInWindow: 0,
  pendingForMs: 60_000,
};
const q = (patch: Partial<QualifyFacts>) => qualifyConversion({ ...base, ...patch });

check("caso normal → qualified", eq(q({}), { outcome: "qualified", reason: "ok" }));
check("renovación → rejected", q({ isRenewal: true }).reason === "renewal_order");
check("pedido cancelado o reembolsado → rejected", q({ orderVoided: true }).reason === "order_voided");
check("sin cajas LIT → rejected", q({ hasLitBox: false }).reason === "no_lit_box");
check("código no activo → rejected", q({ codeActive: false }).reason === "code_inactive");
check("quien invita es B2B → rejected", q({ referrerIsB2B: true }).reason === "referrer_b2b");
check("sin cliente → review", eq(q({ friendCustomerId: null }), { outcome: "review", reason: "no_customer" }));
check("su propio código (mismo cliente) → self_referral", q({ friendCustomerId: "R1" }).reason === "self_referral");
check("mismo email → self_referral", q({ sameEmail: true }).reason === "self_referral");
check("mismo teléfono → self_referral", q({ samePhone: true }).reason === "self_referral");
check("mismo domicilio → same_household", q({ sameAddress: true }).reason === "same_household");
check("amigo ya referido por otro → rejected", q({ friendAlreadyQualified: true }).reason === "friend_already_referred");
check("ya compró cajas antes → not_new_customer", q({ friendPriorBoxOrders: 1 }).reason === "not_new_customer");
check("ya tuvo suscripción (aunque cancelada) → not_new_customer", q({ friendOtherSealSubs: 1 }).reason === "not_new_customer");
check(
  "Seal o Shopify caídos → retry, NUNCA rejected",
  eq(q({ friendOtherSealSubs: null }), { outcome: "retry", reason: "verification_unavailable" }),
);
check(
  "sin poder verificar más de 7 días → review",
  q({ friendPriorBoxOrders: null, pendingForMs: QUALIFY_RETRY_MS + 1 }).outcome === "review",
);
check(
  `más de ${VELOCITY_LIMIT} en 30 días → review`,
  eq(q({ referrerQualifiedInWindow: VELOCITY_LIMIT }), { outcome: "review", reason: "velocity" }),
);
check("justo por debajo del tope → qualified", q({ referrerQualifiedInWindow: VELOCITY_LIMIT - 1 }).outcome === "qualified");

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── la recompensa: cuándo se aplica ──\n");

const NOW = Date.parse("2026-10-20T10:00:00Z");
const H = 3600_000;
const snap = (status: RewardSnapshot["status"], patch: Partial<RewardSnapshot> = {}): RewardSnapshot => ({
  status,
  expiresAtMs: NOW + 100 * 24 * H,
  updatedAtMs: NOW - 60_000,
  applySentAtMs: null,
  ...patch,
});
const facts = (patch: Partial<RewardFacts> = {}): RewardFacts => ({
  now: NOW,
  rewardsEnabled: true,
  friendOrderVoided: false,
  // El amigo pagó hace 3 días: la carencia de 48 h ya pasó.
  friendOrderAtMs: NOW - 72 * H,
  candidate: { sealSubscriptionId: "S1", nextChargeAtMs: NOW + 30 * H, hasBlockingCode: false, hasLiveReward: false },
  applied: null,
  ...patch,
});
const cand = (patch: Partial<NonNullable<RewardFacts["candidate"]>>) => ({
  sealSubscriptionId: "S1",
  nextChargeAtMs: NOW + 30 * H,
  hasBlockingCode: false,
  hasLiveReward: false,
  ...patch,
});

check("cobro a 30 h → apply", decideRewardAction(snap("queued"), facts()).kind === "apply");
check(
  "cobro a 5 días → espera (no se cuelga un código días antes)",
  decideRewardAction(snap("queued"), facts({ candidate: cand({ nextChargeAtMs: NOW + 5 * 24 * H }) })).kind === "wait",
);
check(
  "cobro justo en el borde de 48 h → apply",
  decideRewardAction(snap("queued"), facts({ candidate: cand({ nextChargeAtMs: NOW + APPLY_WINDOW_MS }) })).kind === "apply",
);
check(
  "cobro en menos de 1 h → espera al siguiente",
  decideRewardAction(snap("queued"), facts({ candidate: cand({ nextChargeAtMs: NOW + APPLY_MIN_LEAD_MS - 1 }) })).kind === "wait",
);
check(
  "la sub lleva LITSTAY15 → espera",
  (decideRewardAction(snap("queued"), facts({ candidate: cand({ hasBlockingCode: true }) })) as { reason?: string }).reason ===
    "sub_has_other_code",
);
check(
  "la sub ya tiene otra recompensa viva → espera",
  (decideRewardAction(snap("queued"), facts({ candidate: cand({ hasLiveReward: true }) })) as { reason?: string }).reason ===
    "sub_has_live_reward",
);
check("sin sub cobrable → espera", decideRewardAction(snap("queued"), facts({ candidate: null })).kind === "wait");
check(
  "flag de recompensas apagado → espera (no se pierde)",
  (decideRewardAction(snap("queued"), facts({ rewardsEnabled: false })) as { reason?: string }).reason === "rewards_disabled",
);
check("pedido del amigo anulado → revoke (sin tocar Seal)", decideRewardAction(snap("queued"), facts({ friendOrderVoided: true })).kind === "revoke");
check(
  "no se pudo leer el pedido del amigo → espera, no aplica",
  decideRewardAction(snap("queued"), facts({ friendOrderVoided: null })).kind === "wait",
);
check(
  "carencia: el amigo pagó hace 20 h → espera",
  (decideRewardAction(snap("queued"), facts({ friendOrderAtMs: NOW - 20 * H })) as { reason?: string }).reason ===
    "cooling_off",
);
check(
  "caducada y SIN sub cobrable → expire",
  decideRewardAction(snap("queued", { expiresAtMs: NOW - 1 }), facts({ candidate: null })).kind === "expire",
);
check(
  "caducada pero CON sub activa → no caduca (aplica en su ventana)",
  decideRewardAction(snap("queued", { expiresAtMs: NOW - 1 }), facts()).kind === "apply",
);
check(
  "caducada con el flag apagado → espera, no caduca",
  decideRewardAction(snap("queued", { expiresAtMs: NOW - 1 }), facts({ candidate: null, rewardsEnabled: false })).kind ===
    "wait",
);
check(
  "anulada Y caducada → revoke gana (el motivo correcto)",
  decideRewardAction(snap("queued", { expiresAtMs: NOW - 1 }), facts({ friendOrderVoided: true, candidate: null })).kind ===
    "revoke",
);
check(
  "pedido del amigo que Shopify no encuentra → failed para una persona (ni paga ni revoca a ciegas)",
  eq(decideRewardAction(snap("queued"), facts({ friendOrderMissing: true, friendOrderVoided: null })), {
    kind: "fail",
    reason: "friend_order_missing",
  }),
);
check(
  "no se pudieron leer las subs de quien invita → espera, NUNCA caduca por eso",
  eq(decideRewardAction(snap("queued", { expiresAtMs: NOW - 1 }), facts({ candidate: null, candidateUnknown: true })), {
    kind: "wait",
    reason: "subs_unreadable",
  }),
);
check(
  "y vuelve a mirarse en la pasada siguiente",
  nextCheckAt("subs_unreadable", null, null, NOW) === NOW + SWEEP_INTERVAL_MS,
);
check(
  "pero un pedido anulado se revoca aunque no se lean sus subs",
  decideRewardAction(snap("queued"), facts({ candidate: null, candidateUnknown: true, friendOrderVoided: true })).kind ===
    "revoke",
);
check(
  "anulado gana a «no se encuentra» (si se pudo ver anulado, se revoca)",
  decideRewardAction(snap("queued"), facts({ friendOrderMissing: true, friendOrderVoided: true })).kind === "revoke",
);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── la recompensa: aplicada ──\n");

const sub = (patch: Partial<AppliedSubState> = {}): AppliedSubState => ({
  exists: true,
  chargeable: true,
  nextChargeAtMs: NOW + 20 * H,
  codeVisible: true,
  consumedOrderId: null,
  chargedWithoutCode: false,
  chargeEvidenceUnknown: false,
  ...patch,
});
const ap = (patch: Partial<AppliedSubState>, f: Partial<RewardFacts> = {}) =>
  decideRewardAction(snap("applied"), facts({ candidate: null, applied: sub(patch), ...f }));

check("esperando su cobro → wait", ap({}).kind === "wait");
check("pedido de renovación con el código → consume", eq(ap({ consumedOrderId: "999" }), { kind: "consume", orderId: "999" }));
check(
  "consumida aunque el amigo anule DESPUÉS → consume (el cobro ya salió)",
  ap({ consumedOrderId: "999" }, { friendOrderVoided: true }).kind === "consume",
);
check("amigo anula antes del cobro → detach_revoke", ap({}, { friendOrderVoided: true }).kind === "detach_revoke");
check(
  "cobro sin el código y el siguiente lejos → se retira y vuelve a la cola, con su motivo",
  eq(ap({ chargedWithoutCode: true, nextChargeAtMs: NOW + 25 * 24 * H }), {
    kind: "detach_requeue",
    reason: "charged_without_code",
  }),
);
check(
  "cobro sin el código y el siguiente cerca → aviso, el código se queda",
  ap({ chargedWithoutCode: true }).kind === "keep_alert",
);
check(
  "el código dejó de verse sin pedido que lo explique → fail (NUNCA reaplicar encima)",
  ap({ codeVisible: false }).kind === "fail",
);
check("sub pausada o cancelada → detach_requeue", ap({ chargeable: false }).kind === "detach_requeue");
check(
  "el cobro se alejó más de 72 h (salto) → detach_requeue",
  ap({ nextChargeAtMs: NOW + CHARGE_MOVED_AWAY_MS + H }).kind === "detach_requeue",
);
check("sin próximo cobro → detach_requeue", ap({ nextChargeAtMs: null }).kind === "detach_requeue");
check("la sub ya no existe en Seal → aviso", ap({ exists: false }).kind === "keep_alert");
check(
  "cobro cuyo pedido no se puede leer → aviso, NI se retira NI se reencola a ciegas",
  eq(ap({ chargeEvidenceUnknown: true, nextChargeAtMs: NOW + 25 * 24 * H }), {
    kind: "keep_alert",
    reason: "charge_evidence_unknown",
  }),
);
check(
  "Seal no contesta → espera (no se decide a ciegas)",
  decideRewardAction(snap("applied"), facts({ applied: null })).kind === "wait",
);
check(
  "pedido del amigo que no se encuentra con la recompensa YA aplicada → sigue a su cobro",
  ap({}, { friendOrderMissing: true, friendOrderVoided: null }).kind === "wait",
);

console.log("\n── la recompensa: aplicándose ──\n");
check(
  "applying con el código visible → adopt (no se aplica dos veces)",
  decideRewardAction(snap("applying"), facts({ applied: sub({ codeVisible: true }) })).kind === "adopt",
);
check(
  "applying reciente sin código → espera",
  decideRewardAction(snap("applying"), facts({ applied: sub({ codeVisible: false }) })).kind === "wait",
);
check(
  "applying atascado, la orden SALIÓ y no hay código → fail (nunca se reaplica solo)",
  decideRewardAction(
    snap("applying", { updatedAtMs: NOW - APPLYING_STUCK_MS - 1, applySentAtMs: NOW - APPLYING_STUCK_MS - 1 }),
    facts({ applied: sub({ codeVisible: false }) }),
  ).kind === "fail",
);
check(
  "applying atascado y la orden NUNCA salió → vuelve a la cola sin tocar Seal",
  eq(
    decideRewardAction(
      snap("applying", { updatedAtMs: NOW - APPLYING_STUCK_MS - 1, applySentAtMs: null }),
      facts({ applied: sub({ codeVisible: false }) }),
    ),
    { kind: "requeue", reason: "apply_never_sent" },
  ),
);
check(
  "applying y el cobro YA salió con el código → consume (adoptar con fecha de hoy daría 20 €)",
  eq(
    decideRewardAction(snap("applying"), facts({ applied: sub({ codeVisible: false, consumedOrderId: "777" }) })),
    { kind: "consume", orderId: "777" },
  ),
);
for (const s of ["consumed", "revoked", "expired", "failed"] as const) {
  check(`${s} es terminal`, decideRewardAction(snap(s), facts({ friendOrderVoided: true })).kind === "noop");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── presupuesto y calendario de la pasada ──\n");

check("con 30 s de función se puede empezar a aplicar", canStartApply(30_000));
check("con 29 s no", !canStartApply(29_999));
check(
  "el umbral cabe en la función (60 s): una pasada que empieza a tiempo SÍ puede aplicar",
  APPLY_MIN_BUDGET_MS < 55_000,
);
check(
  "cobro a 20 días → volver 48 h antes, pero como mucho a 7 días",
  nextCheckAt("charge_not_in_window", NOW + 20 * 24 * H, null, NOW) === NOW + MAX_NEXT_CHECK_MS,
);
check(
  "cobro a 4 días → volver justo 48 h antes",
  nextCheckAt("charge_not_in_window", NOW + 96 * H, null, NOW) === NOW + 48 * H,
);
check(
  "carencia → volver cuando acaba",
  nextCheckAt("cooling_off", null, NOW - 10 * H, NOW) === NOW + 38 * H,
);
check(
  "una espera sin motivo conocido → la pasada siguiente, NUNCA sin fecha",
  nextCheckAt("sub_has_other_code", null, null, NOW) === NOW + SWEEP_INTERVAL_MS,
);
check("nunca en el pasado", nextCheckAt("charge_not_in_window", NOW + H, null, NOW) === NOW);
check("flag de recompensas apagado → volver en un día", nextCheckAt("rewards_disabled", null, null, NOW) === NOW + 24 * H);
check("sin sub cobrable → volver en dos días", nextCheckAt("no_chargeable_sub", null, null, NOW) === NOW + 48 * H);
check(
  "cobro sin fecha conocida → la pasada siguiente",
  nextCheckAt("charge_not_in_window", null, null, NOW) === NOW + SWEEP_INTERVAL_MS,
);
check(
  "la ventana tiene una docena de pasadas dentro (una que falle no se lleva el cobro)",
  APPLY_WINDOW_MS / SWEEP_INTERVAL_MS >= 10,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── comprobación tras aplicar ──\n");

check("28,35 → 18,35: ok", checkApplyPostcondition(2835, 1835, 1000) === "ok");
check("un céntimo de redondeo: ok", checkApplyPostcondition(2835, 1836, 1000) === "ok");
check("multi-línea con 10 € por línea (−20): over_discount", checkApplyPostcondition(5670, 3670, 1000) === "over_discount");
check("aún no reflejado: not_reflected", checkApplyPostcondition(2835, 2835, 1000) === "not_reflected");
check("bajó menos de 10: under_discount", checkApplyPostcondition(2835, 2335, 1000) === "under_discount");
check("euros de Seal a céntimos", eurosToCents(28.35) === 2835 && eurosToCents("67.93") === 6793 && eurosToCents(null) === 0);

console.log(failed ? `\n${failed} FALLO(S)\n` : "\nTodo bien.\n");
process.exit(failed ? 1 : 0);

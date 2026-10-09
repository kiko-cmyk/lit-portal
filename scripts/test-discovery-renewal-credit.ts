/**
 * Crédito del Discovery Set en la renovación (Discovery + suscripción en el
 * mismo pedido, lib/discovery-renewal-credit).
 *
 *   npx tsx scripts/test-discovery-renewal-credit.ts
 *
 * Dos partes:
 *   1. Las dos funciones puras que deciden A QUÉ sub va el crédito y CUÁNDO se
 *      ha cobrado la renovación que lo consume.
 *   2. Comprobaciones de código fuente sobre las invariantes de dinero, como
 *      su gemelo `test-discovery-discount-guard.ts`: el módulo habla con Seal,
 *      Supabase y Klaviyo, y lo que no puede volver a pasar se ve leyendo.
 */

import { readFileSync } from "node:fs";
import { firstChargeSince, subBornFromOrder } from "@/lib/discovery-renewal-credit";
import type { SealBillingAttempt, SealSubscription } from "@/lib/seal";

let failed = 0;
function check(name: string, cond: boolean, hint: string) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name}\n    ${hint}`);
    failed++;
  }
}

function attempt(p: Partial<SealBillingAttempt>): SealBillingAttempt {
  return {
    id: 1,
    date: "2026-11-23T11:00:00+00:00",
    status: "",
    order_id: "",
    error_code: "",
    error_message: "",
    triggered_manually: "",
    customer_authentication_challenge_url: "",
    completed_at: "",
    ...p,
  };
}

function sub(p: Partial<SealSubscription>): SealSubscription {
  return { id: 1, status: "ACTIVE", order_id: "", items: [], billing_attempts: [], ...p } as SealSubscription;
}

console.log("\n── a qué sub va el crédito ──\n");

// El caso real: pedido #11724 → sub 16797052.
const natasha = sub({
  id: 16797052,
  order_id: "19117326958982",
  billing_attempts: [attempt({ date: "2026-11-23T11:00:00+00:00" })],
});
const older = sub({ id: 111, order_id: "19000000000000" });

check(
  "elige la sub nacida del pedido",
  subBornFromOrder([older, natasha], "19117326958982")?.id === 16797052,
  "subBornFromOrder debe casar sub.order_id con el id del pedido de Shopify.",
);
check(
  "sin sub de ese pedido → null (Seal aún no la ha creado)",
  subBornFromOrder([older], "19117326958982") === null,
  "Si no hay sub del pedido, no se puede aplicar a ninguna otra: el crédito es de ESA suscripción.",
);
check(
  "una cancelada no recibe el crédito",
  subBornFromOrder([sub({ id: 5, order_id: "42", status: "CANCELLED" })], "42") === null,
  "Aplicar a una sub cancelada es tirar el crédito: no hay renovación.",
);
check(
  "order_id numérico también casa",
  subBornFromOrder([sub({ id: 7, order_id: 42 as unknown as string })], "42")?.id === 7,
  "Seal devuelve order_id como string, pero si llega como número tiene que casar igual.",
);

const twoCadences = [
  sub({ id: 21, order_id: "77", billing_attempts: [attempt({ date: "2027-01-07T11:00:00+00:00" })] }),
  sub({ id: 22, order_id: "77", billing_attempts: [attempt({ date: "2026-10-24T11:00:00+00:00" })] }),
];
check(
  "dos subs del mismo pedido → la que se cobra antes",
  subBornFromOrder(twoCadences, "77")?.id === 22,
  "El crédito es uno: va a 'su siguiente renovación', la más próxima.",
);

console.log("\n── cuándo se ha cobrado la renovación ──\n");

const appliedAt = Date.parse("2026-10-09T11:21:00Z");
check(
  "sin cobros completados → no se ha cobrado",
  firstChargeSince(natasha, appliedAt) === null,
  "Con solo intentos pendientes el código tiene que quedarse: se le debe la renovación con descuento.",
);
check(
  "un cobro ANTERIOR a la aplicación no cuenta",
  firstChargeSince(
    sub({ billing_attempts: [attempt({ status: "succeeded", completed_at: "2026-10-01T10:00:00+00:00" })] }),
    appliedAt,
  ) === null,
  "Solo consume el crédito un cobro posterior a applied_at.",
);
check(
  "un cobro FALLIDO no cuenta",
  firstChargeSince(
    sub({ billing_attempts: [attempt({ status: "failed", completed_at: "2026-11-23T11:01:00+00:00" })] }),
    appliedAt,
  ) === null,
  "Si se retirara tras un fallo, el reintento de Seal cobraría sin los 4,99 €.",
);
const charged = firstChargeSince(
  sub({
    billing_attempts: [
      attempt({ id: 2, status: "succeeded", completed_at: "2027-01-07T11:01:00+00:00" }),
      attempt({ id: 1, status: "succeeded", completed_at: "2026-11-23T11:01:00+00:00" }),
    ],
  }),
  appliedAt,
);
check(
  "cobro posterior con éxito → es la renovación (la primera, aunque Seal las desordene)",
  charged?.id === 1,
  "firstChargeSince debe ordenar por completed_at y quedarse con la primera.",
);

console.log("\n── invariantes de dinero (código fuente) ──\n");

const mod = readFileSync("src/lib/discovery-renewal-credit.ts", "utf8");
const code = mod
  .split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

check(
  "reclama la fila antes de aplicar (pending_apply → applying condicionado)",
  /status:\s*"applying"/.test(code) && /\.eq\("status",\s*"pending_apply"\)/.test(code),
  "PUT /subscription-discount-code no es idempotente: sin reclamo, dos procesos a la vez aplicarían 9,98 €.",
);
check(
  "mira si el código YA está antes de aplicarlo",
  code.indexOf("findAllAppliedDiscountCodeIds(fresh") >= 0 &&
    code.indexOf("findAllAppliedDiscountCodeIds(fresh") < code.indexOf("seal.applyDiscountCode"),
  "Un intento anterior pudo aplicarlo y morir antes de apuntarlo: aplicar de nuevo lo duplica.",
);
check(
  "tras un error al aplicar, relee la sub antes de decidir",
  /catch \(err\)[\s\S]{0,200}getSubscriptionById/.test(code),
  "Timeout ≠ no aplicado (incidente 2-oct). Liberar la fila sin releer arriesga un doble apply.",
);
check(
  "retira TODAS las entradas del código, no solo la primera",
  /for \(const id of ids\)[\s\S]{0,80}removeDiscountCode/.test(code) && !/findAppliedDiscountCodeId\(/.test(code),
  "En una sub de varias líneas sale una entrada por línea; quitar solo una deja 4,99 € de descuento para siempre.",
);

console.log("\n── al tocar líneas (cambio de plan o sabor, reparación) ──\n");

const ensureStart = code.indexOf("export async function ensureDiscoveryCreditAttached");
const ensureFn = ensureStart >= 0 ? code.slice(ensureStart, code.indexOf("\nexport ", ensureStart + 10)) : "";
check(
  "solo se repone si se le sigue debiendo (antes de aplicar mira fila y cobros)",
  ensureFn.indexOf("firstChargeSince") > 0 &&
    ensureFn.indexOf("if (!owed)") > 0 &&
    ensureFn.indexOf("if (!owed)") < ensureFn.indexOf("seal.applyDiscountCode"),
  "Si la renovación ya se cobró mientras se tocaban las líneas, reponer el código descontaría OTRO envío.",
);
check(
  "si ya no se debe, quita lo que haya puesto",
  /if \(!owed\) \{[\s\S]{0,120}removeDiscountCode/.test(ensureFn),
  "Un código visible sin deuda detrás es justo la fuga de 4,99 € por envío.",
);
check(
  "no aplica encima de un código visible",
  /if \(!ids\.length\) \{[\s\S]{0,80}seal\.applyDiscountCode/.test(ensureFn),
  "Aplicar dos veces el mismo código en Seal descuenta el doble (incidente BONUS5).",
);

const planRoute = readFileSync("src/app/api/subscription/plan/route.ts", "utf8");
const carryDecl = planRoute.indexOf("let discoveryCarry");
const pendingRead = planRoute.indexOf("pendingDiscoveryCreditForSub(sealSubscriptionId)");
const detachCall = planRoute.indexOf("seal.removeDiscountCode(sealSubscriptionId, id)", pendingRead);
const firstAdd = planRoute.indexOf("seal.addItems(");
check(
  "la ruta del plan suelta el crédito Discovery antes del swap",
  carryDecl > 0 && carryDecl < pendingRead && pendingRead < detachCall && detachCall < firstAdd,
  "Sin soltarlo, add_items + remove_items lo dejan invisible y se repetiría en cada envío.",
);
check(
  "la ruta del plan nunca lo repone sin haberlo soltado",
  /if \(!discoveryCarry\.detached\) \{\s*alertSlackError[\s\S]{0,400}return;/.test(planRoute),
  "Reponer encima de un código que no se pudo soltar es el duplicado invisible.",
);
check(
  "todas las salidas de la ruta reponen los dos códigos",
  !/reattachRetentionDiscount\(\)/.test(planRoute) &&
    (planRoute.match(/await reattachCarriedDiscounts\(\);/g) ?? []).length >= 6 &&
    /reattachRetentionDiscountNow\(\);\s*await reattachDiscoveryCreditNow\(\);/.test(planRoute),
  "Si alguna salida solo repusiera el 15%, el cliente perdería su crédito Discovery en ese camino.",
);

const drain = readFileSync("src/app/api/cron/mix-repair-drain/route.ts", "utf8");
check(
  "el cron de reparación trata el crédito Discovery como código seguido",
  /trackedDiscoveryCode\(subId\)/.test(drain) && /ensureDiscoveryCreditAttached\(/.test(drain),
  "Si no, la reparación se para con el código puesto y la sub puede quedarse cobrando de más.",
);

console.log("");
if (failed > 0) {
  console.error(`${failed} comprobación(es) fallida(s)`);
  process.exit(1);
}
console.log("Todo OK");

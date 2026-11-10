/**
 * «Adelantar» espera 15 días desde el último cobro (10-nov-2026).
 *
 *   npx tsx scripts/test-charge-now-recent.ts
 *
 * La regla de lib/charge-now-recent.ts con los casos medidos el 10-nov en `charge_now_attempts`,
 * los bordes de día en Madrid, y guardas de código de que la ruta la comprueba antes de la del
 * primer pedido y del cobro, y de que las pantallas enseñan la espera.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function check(name: string, cond: boolean, hint: string) {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}\n    ${hint}`);
    failed++;
  }
}
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const DAY = 86_400_000;

type Attempt = { completed_at: string; status?: string; error_code?: string };
const sub = (attempts: Attempt[], orderPlaced = "2026-03-01T10:00:00+01:00") =>
  ({
    order_placed: orderPlaced,
    billing_attempts: attempts.map((a, i) => ({
      id: i + 1,
      date: a.completed_at || "2026-12-01T13:00:00+00:00",
      status: a.status ?? (a.completed_at ? "completed" : ""),
      order_id: "",
      error_code: a.error_code ?? "",
      error_message: "",
      triggered_manually: "",
      customer_authentication_challenge_url: "",
      completed_at: a.completed_at,
    })),
  }) as unknown as Parameters<typeof import("../src/lib/charge-now-recent").chargeNowWait>[0];

async function main() {
  const r = await import("../src/lib/charge-now-recent");

  console.log("\n── último cobro bueno ──\n");
  const pilar = sub(
    [
      { completed_at: "2026-07-25T15:11:09+00:00" },
      { completed_at: "2026-11-05T17:08:13+00:00" },
      // El Adelantar del 9-nov que paró el antifraude: sin completed_at.
      { completed_at: "", status: "error", error_code: "FRAUD__SUSPECTED" },
      { completed_at: "" },
    ],
    "2026-05-25T17:07:51+02:00",
  );
  check(
    "el cobro completado más reciente",
    r.lastGoodChargeAt(pilar) === Date.parse("2026-11-05T17:08:13Z"),
    "Tiene que ser el Adelantar cobrado del 5-nov, no el rechazado del 9-nov.",
  );
  check(
    "la compra inicial cuenta si es lo último",
    r.lastGoodChargeAt(sub([], "2026-10-24T23:30:27+02:00")) === Date.parse("2026-10-24T21:30:27Z"),
    "17152630 adelantó 1,8 días después de comprar y le saltó el antifraude.",
  );
  check(
    "un fallido que Seal cobró después sí cuenta",
    r.lastGoodChargeAt(sub([{ completed_at: "2026-10-29T15:09:00+00:00", error_code: "INVALID_PURCHASE_TYPE" }])) ===
      Date.parse("2026-10-29T15:09:00Z"),
    "13175857: el intento conserva el error_code pero se cobró.",
  );
  check(
    "sin ninguna fecha legible: null",
    r.lastGoodChargeAt(sub([{ completed_at: "" }], "")) === null && r.chargeNowWait(sub([], "basura")) === null,
    "Sin cobro conocido no hay nada que esperar.",
  );

  console.log("\n── el caso de Pilar (sub 13900481) ──\n");
  const w = r.chargeNowWait(pilar, Date.parse("2026-11-09T20:49:36Z"));
  check(
    "el 9-nov espera hasta el 21-nov",
    w?.lastChargedOn === "2026-11-05" && w?.availableFrom === "2026-11-21",
    `Dio ${JSON.stringify(w)}.`,
  );
  check(
    "el 20-nov a las 23:59 de Madrid todavía espera",
    r.chargeNowWait(pilar, Date.parse("2026-11-20T22:59:59Z")) !== null,
    "El día 21 empieza a las 23:00 UTC del 20 en horario de invierno.",
  );
  check(
    "el 21-nov a las 00:00 de Madrid ya puede",
    r.chargeNowWait(pilar, Date.parse("2026-11-20T23:00:00Z")) === null,
    "La fecha que ve el cliente vale para todo el día.",
  );

  console.log("\n── los Adelantar medidos el 10-nov ──\n");
  // Hueco desde el cobro anterior, en días, y si la pasarela lo paró.
  const measured: Array<[string, number, boolean]> = [
    ["13977271", 0.9, true],
    ["17152630", 1.8, true],
    ["13900481", 4.2, true],
    ["12427925", 13.4, true],
    ["14382603", 20.1, false],
    ["14382603", 22.5, false],
  ];
  const base = Date.parse("2026-10-01T10:00:00Z");
  for (const [id, gap, fraud] of measured) {
    const blocked = r.chargeNowWait(sub([{ completed_at: new Date(base).toISOString() }]), base + gap * DAY) !== null;
    check(
      `${id} a ${gap} días: ${fraud ? "en espera" : "se puede"}`,
      blocked === fraud,
      fraud ? "Lo paró el antifraude: la regla tiene que frenarlo antes." : "Se cobró bien: no hay que frenarlo.",
    );
  }

  console.log("\n── bordes ──\n");
  let minGap = Infinity;
  let maxGap = 0;
  for (let m = 0; m < 24 * 60; m += 7) {
    const last = Date.parse("2026-11-05T00:00:00+01:00") + m * 60_000;
    const wait = r.chargeNowWait(sub([{ completed_at: new Date(last).toISOString() }]), last + DAY);
    if (!wait) continue;
    const opens = Date.parse(`${wait.availableFrom}T00:00:00+01:00`);
    minGap = Math.min(minGap, opens - last);
    maxGap = Math.max(maxGap, opens - last);
  }
  check(
    "entre cobro y apertura siempre hay al menos 15 días enteros",
    minGap >= r.CHARGE_NOW_MIN_DAYS * DAY && maxGap <= (r.CHARGE_NOW_MIN_DAYS + 1) * DAY,
    `Hueco mínimo ${(minGap / DAY).toFixed(3)} d, máximo ${(maxGap / DAY).toFixed(3)} d.`,
  );
  const lateNight = r.chargeNowWait(sub([{ completed_at: "2026-11-05T23:30:00Z" }]), Date.parse("2026-11-07T10:00:00Z"));
  check(
    "un cobro a las 00:30 de Madrid es del día siguiente",
    lateNight?.lastChargedOn === "2026-11-06" && lateNight?.availableFrom === "2026-11-22",
    `Dio ${JSON.stringify(lateNight)}.`,
  );
  const dst = r.chargeNowWait(sub([{ completed_at: "2026-10-20T09:00:00Z" }]), Date.parse("2026-10-25T12:00:00Z"));
  check(
    "cruzando el cambio de hora del 25-oct",
    dst?.availableFrom === "2026-11-05",
    `Dio ${JSON.stringify(dst)}.`,
  );

  console.log("\n── la pantalla, con su reloj ──\n");
  check("sin espera del servidor: null", r.activeChargeNowWait(null) === null, "Nada que enseñar.");
  check(
    "espera vigente: se enseña",
    r.activeChargeNowWait(w, Date.parse("2026-11-15T10:00:00Z"))?.availableFrom === "2026-11-21",
    "Antes del día 21 la tarjeta va en gris.",
  );
  check(
    "página abierta hasta el día bueno: ya no espera",
    r.activeChargeNowWait(w, Date.parse("2026-11-21T08:00:00Z")) === null,
    "Si se dejó la página abierta, el botón vuelve sin recargar.",
  );

  console.log("\n── guardas de código ──\n");
  const root = join(__dirname, "..");
  const route = code(readFileSync(join(root, "src/app/api/subscription/charge-now/route.ts"), "utf8"));
  const iWait = route.indexOf("chargeNowWait(sub)");
  const iFirst = route.indexOf("await assertFirstOrderShipped(");
  const iIntent = route.indexOf("await recordChargeNowIntent(");
  const iCharge = route.indexOf("seal.chargeNow(");
  check(
    "la ruta mira la espera antes del primer pedido, del apunte y del cobro",
    iWait > 0 && iWait < iFirst && iWait < iIntent && iWait < iCharge && /"recent_charge"/.test(route),
    "Sin esto, una pantalla vieja lanzaría un cobro que el antifraude va a parar.",
  );
  const seal = code(readFileSync(join(root, "src/lib/seal.ts"), "utf8"));
  check(
    "mapToSubscription manda la espera",
    /chargeNowWait:\s*chargeNowWait\(s\)/.test(seal),
    "Las pantallas la leen de la suscripción.",
  );
  const overlay = code(readFileSync(join(root, "src/components/ChargeNowOverlay.tsx"), "utf8"));
  check(
    "la ventana explica la espera y entiende el 409",
    /activeChargeNowWait\(subscription\.chargeNowWait\)/.test(overlay) &&
      /wait && !done \?/.test(overlay) &&
      /code === "recent_charge"/.test(overlay),
    "Al pulsar la tarjeta en gris tiene que salir desde qué día, sin llamar al servidor.",
  );
  const myLit = code(readFileSync(join(root, "src/app/[locale]/my-lit/page.tsx"), "utf8"));
  check(
    "Mi LIT pinta la tarjeta en gris y pulsable",
    /muted=\{!!chargeNowWaitNow\}/.test(myLit) && /Disponible desde el/.test(myLit),
    "Kiko: la función no se esconde, sale en gris y dice desde cuándo.",
  );
  const account = code(readFileSync(join(root, "src/app/[locale]/account/page.tsx"), "utf8"));
  check(
    "Cuenta también",
    /muted: chargeNowWaiting/.test(account) && /activeChargeNowWait\(subscription\.chargeNowWait\)/.test(account),
    "El botón pequeño de Adelantar de Cuenta abre la misma ventana.",
  );

  console.log(failed ? `\n✗ ${failed} fallo(s)\n` : "\n✓ todo bien\n");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

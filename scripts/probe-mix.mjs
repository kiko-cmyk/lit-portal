// Fase 0 del plan "mezcla de sabores": sondeos contra la API de Seal para verificar que el
// modelo multi-línea funciona ANTES de escribir código de producción.
//
// Contexto: una suscripción LIT tiene hoy UNA línea recurrente con quantity:1, y la variante
// codifica cajas + sabor (SL90 = 3 cajas de limón). La mezcla necesita N líneas, una por
// sabor, sobre la variante de 1 CAJA con quantity = nº de cajas y un `price` por unidad que
// reparte el total del tramo. Todo el plan depende de que Seal respete ese precio.
//
// Cada acción hace UNA cosa y relee la sub. Las mutaciones exigen --yes: sin él solo imprimen
// el payload que enviarían. Regla de la casa: nunca mutar la API de producción sin avisar.
//
// Uso:
//   node scripts/probe-mix.mjs state
//   node scripts/probe-mix.mjs prep        --yes   # SL60(2 cajas) -> SL90(3 cajas). Valida el token de pago
//   node scripts/probe-mix.mjs p1-add      --yes   # + SL30 x2 @22.64 + W30 x1 @22.65
//   node scripts/probe-mix.mjs p2-remove   --yes   # - la línea SL90
//   node scripts/probe-mix.mjs p3-edit     --yes   # edit_items: 2L+1W -> 1L+2W (solo cantidades/precios)
//   node scripts/probe-mix.mjs p6-interval --yes   # edit delivery_interval a "45 day"
//   node scripts/probe-mix.mjs p6-revert   --yes   # y volver a "2 month"
//   node scripts/probe-mix.mjs p7-onetime  --yes   # trampa: variante NO asociada al plan
//   node scripts/probe-mix.mjs restore     --yes   # volver a SL60 x1 (estado inicial)
//
// P4 (charge-now) y P5 (cupón) van aparte, con OK explícito de Juan, porque P4 cobra de
// verdad una tarjeta y P5 toca descuentos.
//
// Env: SEAL_API_TOKEN (ojo: el de .env.local está caducado, usar el de .env.development.local)

import fs from "node:fs";
import path from "node:path";

const SEAL_TOKEN = process.env.SEAL_API_TOKEN;
if (!SEAL_TOKEN) throw new Error("SEAL_API_TOKEN required");

const SEAL_BASE = "https://app.sealsubscriptions.com/shopify/merchant/api";

// Sub de PRUEBAS (clon sin cobro de juan@litsalt.com). NO es la sub real de Juan.
const SUB_ID = Number(process.env.PROBE_SUB_ID ?? 14692586);

// La sub real de Juan. Nunca sondear aquí: tiene cobros completados y un cargo futuro.
const FORBIDDEN_SUBS = new Set([12635109]);
if (FORBIDDEN_SUBS.has(SUB_ID)) {
  console.error(`REFUSED: ${SUB_ID} es una suscripción real, no una de pruebas.`);
  process.exit(1);
}

const LEMON = { productId: "16008517550429", label: "Salty Lemon" };
const MELON = { productId: "16272445112669", label: "Salty Watermelon" };
const V = {
  SL30: "63887092154717", SL60: "64629025341789", SL90: "63887092220253",
  W30: "65046727459165", W60: "65046727491933", W90: "65046727524701",
};
// Escalera web 2026-08-22 (antes: precio de la variante por tramo — 6793/9057/…).
const TIER_TOTAL = { 1: 2835, 2: 5670, 3: 8505, 4: 8505, 5: 11340, 6: 14175 };
// Selling plan canónico de "2 meses" (el intervalo actual de la sub de pruebas).
const PLAN_2MO = "691259900253";
const PLAN_45D = "691259867485";

const SNAP_DIR = path.join(process.cwd(), ".probe-mix");
const action = process.argv[2];
const CONFIRMED = process.argv.includes("--yes");

/** Reparto del total del tramo entre líneas: unidad base + el residuo en las líneas más
 *  pequeñas, de forma que Σ qty×unit <= tierTotal SIEMPRE (nunca cobrar de más). */
function distribute(tierTotalCents, boxesPerLine) {
  const total = boxesPerLine.reduce((a, b) => a + b, 0);
  const unit = Math.floor(tierTotalCents / total);
  let residual = tierTotalCents - unit * total;
  const order = boxesPerLine.map((b, i) => ({ i, b })).sort((a, b) => a.b - b.b);
  const units = new Array(boxesPerLine.length).fill(unit);
  for (const { i, b } of order) {
    if (residual >= b) { units[i] = unit + 1; residual -= b; }
  }
  const charged = units.reduce((s, u, i) => s + u * boxesPerLine[i], 0);
  if (charged > tierTotalCents) throw new Error(`reparto cobra de más: ${charged} > ${tierTotalCents}`);
  return { units, charged, residual: tierTotalCents - charged };
}

const cents = (c) => (c / 100).toFixed(2);

async function seal(pathname, init) {
  const r = await fetch(`${SEAL_BASE}${pathname}`, {
    ...init,
    headers: { "X-Seal-Token": SEAL_TOKEN, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  // Seal devuelve 200 con {success:false} muy a menudo: hay que mirar el cuerpo, no el status.
  return { httpStatus: r.status, json };
}

async function getSub() {
  const { httpStatus, json } = await seal(`/subscription?id=${SUB_ID}&with-items=true&with-billing-attempts=true`);
  if (httpStatus !== 200) throw new Error(`GET /subscription -> HTTP ${httpStatus}: ${JSON.stringify(json).slice(0, 300)}`);
  const s = json.payload?.subscription ?? json.payload;
  if (!s?.id) throw new Error(`payload inesperado: ${JSON.stringify(json).slice(0, 300)}`);
  return s;
}

const recurring = (s) => (s.items ?? []).filter((i) => !Number(i.is_one_time_item));
const oneTime = (s) => (s.items ?? []).filter((i) => Number(i.is_one_time_item));
const pendingAttempts = (s) =>
  (s.billing_attempts ?? [])
    .filter((b) => !b.completed_at && !b.status && !b.skipped_on)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

function show(s, title = "estado") {
  const rec = recurring(s);
  const sum = rec.reduce((a, i) => a + Math.round(parseFloat(i.price) * 100) * Number(i.quantity ?? 1), 0);
  console.log(`\n=== ${title}: sub ${s.id} ===`);
  console.log(`status=${s.status} interval="${s.delivery_interval}" total_value=${s.total_value} delivery_price=${s.delivery_price}`);
  console.log(`lineas recurrentes: ${rec.length}   Σ price×qty = ${cents(sum)}`);
  for (const it of rec) {
    console.log(`  item ${it.id}  ${it.variant_sku ?? "?"}  v=${it.variant_id}  qty=${it.quantity}  price=${it.price}  plan=${it.selling_plan_id} ("${it.selling_plan_name ?? ""}")`);
    if (it.discount_codes?.length) console.log(`      cupones: ${JSON.stringify(it.discount_codes)}`);
  }
  for (const it of oneTime(s)) {
    console.log(`  [ONE-TIME] item ${it.id}  ${it.variant_sku ?? "?"}  qty=${it.quantity}  price=${it.price}`);
  }
  const pend = pendingAttempts(s);
  console.log(`billing_attempts pendientes: ${pend.length}${pend.length ? `  proximo=${String(pend[0].date).slice(0, 10)}` : ""}`);
  console.log(`  ids+fechas: ${(s.billing_attempts ?? []).map((b) => `${b.id}@${String(b.date).slice(0, 10)}`).join(" ") || "(ninguno)"}`);
  return { rec, sum, attempts: (s.billing_attempts ?? []).map((b) => `${b.id}@${String(b.date).slice(0, 10)}`).join(" ") };
}

function saveSnapshot(name, s) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const f = path.join(SNAP_DIR, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  console.log(`\n[snapshot] ${f}`);
}

function loadSnapshot(name) {
  const f = path.join(SNAP_DIR, `${name}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

/** Imprime el payload y solo muta si viene --yes. */
async function mutate(label, pathname, body, method = "PUT") {
  console.log(`\n--- ${label} ---`);
  console.log(`${method} ${pathname}`);
  console.log(JSON.stringify(body, null, 2));
  if (!CONFIRMED) {
    console.log("\n[DRY] sin --yes no se envía nada. Añade --yes para ejecutarlo.");
    return null;
  }
  const { httpStatus, json } = await seal(pathname, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  console.log(`\n<- HTTP ${httpStatus}  ${JSON.stringify(json).slice(0, 500)}`);
  if (json?.success === false) {
    console.error(`\n*** Seal RECHAZÓ: ${json.message ?? "(sin mensaje)"}`);
    // "Payment method token is invalid" = la sub de pruebas no tiene tarjeta usable.
    if (String(json.message ?? "").toLowerCase().includes("payment method")) {
      console.error("*** BLOQUEO: hay que crear una sub de pruebas con tarjeta real antes de seguir.");
    }
    return { failed: true, json };
  }
  await sleep(1500);
  return { failed: false, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `taxable` / `requires_shipping` se copian de la línea que ya tiene la sub en vez de
// hardcodearlos: la sub de pruebas tiene taxable:0 y meter un 1 cambiaría el importe.
let LINE_FLAGS = { taxable: 0, requires_shipping: 1 };

/** Construye una línea de add_items para (sabor, cajas, precio por unidad). */
function line(flavor, variantId, sku, qty, unitCents, sellingPlanId) {
  return {
    product_id: flavor.productId,
    variant_id: variantId,
    quantity: qty,
    title: flavor.label,
    sku,
    taxable: LINE_FLAGS.taxable,
    requires_shipping: LINE_FLAGS.requires_shipping,
    one_time: 0,
    price: cents(unitCents),
    selling_plan_id: sellingPlanId,
  };
}

function assert(ok, msg) {
  console.log(`  ${ok ? "OK  " : "FALLO"}  ${msg}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const ACTIONS = ["state", "prep", "p1-add", "p2-remove", "p3-edit", "p6-interval", "p6-revert",
                   "p7-onetime", "cleanup-onetime", "restore"];
  if (!ACTIONS.includes(action)) {
    console.error(`Usa una de: ${ACTIONS.join(" | ")}`);
    process.exit(1);
  }

  const before = await getSub();
  const b = show(before, `ANTES (${action})`);

  const model = b.rec[0];
  if (model) {
    LINE_FLAGS = {
      taxable: Number(model.taxable ?? 0),
      requires_shipping: Number(model.requires_shipping ?? 1),
    };
    console.log(`\n[flags copiados de item ${model.id}] taxable=${LINE_FLAGS.taxable} requires_shipping=${LINE_FLAGS.requires_shipping}`);
  }

  switch (action) {
    case "state": {
      // No sobrescribir el baseline si ya existe: es el estado al que hay que poder volver.
      saveSnapshot(loadSnapshot("baseline") ? `state-${Date.now()}` : "baseline", before);
      // Reparto que usaríamos para 3 cajas 2L+1W, para verlo antes de tocar nada.
      const d = distribute(TIER_TOTAL[3], [2, 1]);
      console.log(`\nreparto previsto 3 cajas (2L+1W): unidades ${d.units.map(cents).join(" / ")}  cobra ${cents(d.charged)}  tramo ${cents(TIER_TOTAL[3])}  residuo ${d.residual}c`);
      console.log(`\nAviso: a 2 CAJAS el precio por caja de la mezcla (28,35) es el natural de SL30/W30,`);
      console.log(`así que NO ejercita el precio custom. Hay que pasar la sub a 3 cajas ("prep") primero.`);
      return;
    }

    case "prep": {
      // SL60 (2 cajas) -> SL90 (3 cajas), con el add+remove de siempre. Doble propósito:
      // deja la sub en 3 cajas (donde el tramo del 40% hace que el precio custom importe) y
      // verifica que el token de pago de la sub de pruebas sirve para add_items.
      const cur = b.rec.find((i) => i.variant_id === V.SL60) ?? b.rec[0];
      if (!cur) throw new Error("sin línea recurrente de partida");
      const add = await mutate("prep: add SL90 (3 cajas, precio de catálogo)", "/subscription", {
        action: "add_items", id: SUB_ID,
        add_items: [line(LEMON, V.SL90, "SL90", 1, TIER_TOTAL[3], PLAN_2MO)],
      });
      if (!add || add.failed) return;
      await mutate(`prep: remove item ${cur.id} (${cur.variant_sku})`, "/subscription", {
        action: "remove_items", id: SUB_ID, remove_items: [cur.id],
      });
      break;
    }

    case "p1-add": {
      // P1: dos líneas recurrentes en UNA llamada, con precio custom que reparte el tramo.
      const d = distribute(TIER_TOTAL[3], [2, 1]);
      console.log(`\nreparto: SL30 x2 @${cents(d.units[0])} + W30 x1 @${cents(d.units[1])} = ${cents(d.charged)} (tramo ${cents(TIER_TOTAL[3])}, residuo ${d.residual}c)`);
      await mutate("P1: add_items con 2 líneas en una llamada", "/subscription", {
        action: "add_items", id: SUB_ID,
        add_items: [
          line(LEMON, V.SL30, "SL30", 2, d.units[0], PLAN_2MO),
          line(MELON, V.W30, "W30", 1, d.units[1], PLAN_2MO),
        ],
      });
      break;
    }

    case "p2-remove": {
      const pack = b.rec.find((i) => [V.SL60, V.SL90].includes(i.variant_id));
      if (!pack) { console.log("\nno hay línea de pack que quitar"); return; }
      await mutate(`P2: remove_items [${pack.id}] (${pack.variant_sku})`, "/subscription", {
        action: "remove_items", id: SUB_ID, remove_items: [pack.id],
      });
      break;
    }

    case "p3-edit": {
      // P3 (decisivo): cambiar el reparto SIN tocar variantes ni ids de item.
      const lemon = b.rec.find((i) => i.variant_id === V.SL30);
      const melon = b.rec.find((i) => i.variant_id === V.W30);
      if (!lemon || !melon) { console.error("\nP3 necesita la mezcla de P1/P2 aplicada (SL30 + W30)"); return; }
      const d = distribute(TIER_TOTAL[3], [1, 2]); // ahora 1 limón + 2 sandía
      await mutate("P3: edit_items (2L+1W -> 1L+2W, solo cantidad y precio)", "/subscription", {
        action: "edit_items", id: SUB_ID,
        edit_items: [
          { id: lemon.id, quantity: 1, price: cents(d.units[0]) },
          { id: melon.id, quantity: 2, price: cents(d.units[1]) },
        ],
      });
      break;
    }

    case "p6-interval":
      await mutate('P6: edit delivery_interval -> "45 day"', "/subscription", {
        action: "edit", id: SUB_ID, edit: { delivery_interval: "45 day" },
      });
      break;

    case "p6-revert":
      await mutate('P6: edit delivery_interval -> "2 month"', "/subscription", {
        action: "edit", id: SUB_ID, edit: { delivery_interval: "2 month" },
      });
      break;

    case "p7-onetime": {
      // P7: añadir una variante de un producto NO asociado a los selling plans debe caer como
      // one-time. Confirma que la aserción `mix_line_not_recurring` del plan salta de verdad.
      // Producto "Salty Lemon - Compra única" (16182160523613), variante SL30 a 37,80.
      await mutate("P7: add_items de un producto no asociado al plan (debe caer one_time)", "/subscription", {
        action: "add_items", id: SUB_ID,
        add_items: [{
          product_id: "16182160523613", variant_id: "64634112213341", quantity: 1,
          title: "LIT Salty Lemon - Compra unica (PRUEBA)", sku: "SL30",
          taxable: 1, requires_shipping: 1, one_time: 0, price: "37.80", selling_plan_id: PLAN_2MO,
        }],
      });
      break;
    }

    case "cleanup-onetime": {
      const strays = oneTime(before).map((i) => i.id);
      if (!strays.length) { console.log("\nno hay líneas one-time que limpiar"); return; }
      await mutate(`cleanup: remove_items ${JSON.stringify(strays)} (one-time)`, "/subscription", {
        action: "remove_items", id: SUB_ID, remove_items: strays,
      });
      break;
    }

    case "restore": {
      // Vuelve al estado inicial: una línea SL60 x1 al precio de catálogo.
      const add = await mutate("restore: add SL60 x1 @56.70", "/subscription", {
        action: "add_items", id: SUB_ID,
        add_items: [line(LEMON, V.SL60, "SL60", 1, TIER_TOTAL[2], PLAN_2MO)],
      });
      if (!add || add.failed) return;
      const doomed = b.rec.map((i) => i.id);
      await mutate(`restore: remove_items ${JSON.stringify(doomed)}`, "/subscription", {
        action: "remove_items", id: SUB_ID, remove_items: doomed,
      });
      break;
    }

    default:
      console.error(`acción desconocida: ${action}`);
      process.exit(1);
  }

  if (!CONFIRMED) return;

  // ── Releer y afirmar ──
  await sleep(1500);
  const after = await getSub();
  const a = show(after, `DESPUÉS (${action})`);

  console.log("\n=== aserciones ===");
  assert(a.attempts === b.attempts, `billing_attempts intactos (${b.attempts || "ninguno"})`);
  assert(String(before.delivery_price) === String(after.delivery_price), `delivery_price sin cambios (${after.delivery_price})`);
  assert(oneTime(after).length === oneTime(before).length || action === "p7-onetime",
    `sin líneas one-time nuevas (${oneTime(after).length})`);

  if (action === "p1-add" || action === "p2-remove" || action === "p3-edit") {
    const boxes = a.rec.reduce((s, i) => s + Number(i.quantity ?? 1), 0);
    if (action !== "p1-add") {
      assert(a.sum === TIER_TOTAL[3], `Σ price×qty = ${cents(a.sum)} == tramo de 3 cajas ${cents(TIER_TOTAL[3])}`);
      assert(boxes === 3, `3 cajas repartidas (${boxes})`);
      assert(a.rec.every((i) => !Number(i.is_one_time_item)), "todas las líneas siguen recurrentes");
      const plans = new Set(a.rec.map((i) => i.selling_plan_id));
      assert(plans.size === 1, `todas las líneas en el mismo selling plan (${[...plans].join(",")})`);
    }
  }

  if (action === "p3-edit") {
    const beforeIds = new Set(b.rec.map((i) => i.id));
    const afterIds = a.rec.map((i) => i.id);
    assert(afterIds.length === beforeIds.size && afterIds.every((id) => beforeIds.has(id)),
      `edit_items NO cambió los ids de item (${afterIds.join(",")})`);
  }

  if (action === "p6-interval" || action === "p6-revert") {
    const want = action === "p6-interval" ? "45 day" : "2 month";
    assert(String(after.delivery_interval).replace(/s$/, "") === want, `delivery_interval = "${want}"`);
    const plans = new Set(a.rec.map((i) => i.selling_plan_id));
    assert(plans.size === 1, `TODAS las líneas realinearon a un solo plan (${[...plans].join(",")})`);
    if (action === "p6-interval") {
      assert([...plans][0] === PLAN_45D, `y ese plan es el de 45 días (${PLAN_45D})`);
    }
  }

  if (action === "p7-onetime") {
    const stray = oneTime(after).find((i) => i.variant_id === "64634112213341");
    assert(!!stray, "la variante no asociada al plan cayó como ONE-TIME (trampa confirmada)");
    if (stray) console.log(`\n  -> limpiar con: node scripts/probe-mix.mjs cleanup-onetime --yes  (item ${stray.id})`);
  }

  saveSnapshot(`after-${action}`, after);
}

main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });

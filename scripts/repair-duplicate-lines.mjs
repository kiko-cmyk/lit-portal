// Repara suscripciones que quedaron con líneas recurrentes de más por un cambio de
// plan interrumpido.
//
// CAUSA (verificada en el log de auditoría de Seal, 2026-07-28):
// /api/subscription/plan hace `edit interval` -> `add_items` -> pausa -> `remove_items`.
// Esa secuencia no es atómica ni idempotente, y falla de dos formas:
//   A) la petición muere entre el add y el remove: la línea vieja sobrevive. La
//      compensación de la ruta solo salta si remove_items LANZA; si matan el proceso
//      no se ejecuta ningún catch.
//   B) el cliente reintenta: sin clave de idempotencia, la segunda petición vuelve a
//      añadir la variante nueva y quita la original -> dos líneas nuevas.
// La Fase 2 (diff idempotente) lo mata de raíz. Este script limpia lo ya roto.
//
// El arreglo es SOLO `remove_items`: en los 7 casos la línea que se conserva ya tiene
// el precio correcto del tramo, así que no hay que añadir nada ni reprecificar.
//
// Uso:
//   node scripts/repair-duplicate-lines.mjs                 # seco, no toca nada
//   node scripts/repair-duplicate-lines.mjs --apply         # ejecuta
//   node scripts/repair-duplicate-lines.mjs --apply --only 12918887
//
// Env: SEAL_API_TOKEN

const TOKEN = process.env.SEAL_API_TOKEN;
if (!TOKEN) throw new Error("SEAL_API_TOKEN required");
const BASE = "https://app.sealsubscriptions.com/shopify/merchant/api";

const APPLY = process.argv.includes("--apply");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx !== -1 ? Number(process.argv[onlyIdx + 1]) : null;

const BOX_BY_VARIANT = {
  "63887092154717": 1, "64629025341789": 2, "63887092220253": 3,
  "64629029077341": 4, "64629160477021": 5, "64629047624029": 6,
  "65046727459165": 1, "65046727491933": 2, "65046727524701": 3,
  "65046727557469": 4, "65046727590237": 5, "65046727623005": 6,
};
/** OBSOLETO (escalera vieja, pre-2026-08-22). Script del incidente de líneas
 *  duplicadas de jul-2026: NO reusar con la escalera web sin actualizarlo. */
const TIER = { 1: 28.35, 2: 56.70, 3: 67.93, 4: 90.57, 5: 103.95, 6: 124.74 };

/**
 * Casos a reparar. `keep` dice qué línea se conserva y por qué:
 *   "newest"  el cambio del cliente SÍ añadió la línea nueva pero no quitó la vieja,
 *             así que conservar la nueva completa lo que él pidió.
 *   "lowest-id" las dos líneas son idénticas (mismo variant y precio), da igual cuál
 *             se quede; se elige la de id menor para que sea determinista.
 * `expect` es la firma que debe tener la sub AHORA. Si no coincide, se salta: alguien
 * la ha tocado desde la investigación y hay que volver a mirarla.
 */
const CASES = [
  { id: 12918887, keep: "lowest-id", expect: ["SL120", "SL120"], intent: "3->4 cajas + 4 meses (25-jul)" },
  { id: 14351318, keep: "newest",    expect: ["SL30", "SL60"],   intent: "1->2 cajas + 45 dias (12-jul)" },
  { id: 13284872, keep: "newest",    expect: ["SL90", "SL60"],   intent: "3->2 cajas + 4 meses (20-jul)" },
  { id: 12486429, keep: "lowest-id", expect: ["SL30", "SL30"],   intent: "->1 caja + 5 meses (26-jul)" },
  { id: 13408344, keep: "lowest-id", expect: ["SL30", "SL30"],   intent: "->1 caja + 5 meses (14-jun)" },
  { id: 12785759, keep: "lowest-id", expect: ["SL30", "SL30"],   intent: "->1 caja + 6 meses (27-jul, varios reintentos)" },
  { id: 12917692, keep: "lowest-id", expect: ["W30", "W30"],     intent: "->1 caja sandia + 6 meses (20-jul)" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seal(path, init) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "X-Seal-Token": TOKEN, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, json };
}

async function getSub(id) {
  const { status, json } = await seal(`/subscription?id=${id}&with-items=true&with-billing-attempts=true`);
  if (status !== 200) throw new Error(`GET sub ${id}: HTTP ${status}`);
  return json.payload?.subscription ?? json.payload;
}

const recurring = (s) => (s.items ?? []).filter((i) => !Number(i.is_one_time_item));
const boxesOf = (i) => (BOX_BY_VARIANT[String(i.variant_id)] ?? 1) * Math.max(1, Number(i.quantity) || 1);
const chargeOf = (lines) => lines.reduce((a, i) => a + Number(i.price) * Math.max(1, Number(i.quantity) || 1), 0);
const eur = (n) => `${n.toFixed(2)} EUR`;

function pendingNext(s) {
  return (s.billing_attempts ?? [])
    .filter((b) => !b.completed_at && !b.status && !b.skipped_on && b.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] ?? null;
}

const results = [];

for (const c of CASES) {
  if (ONLY && c.id !== ONLY) continue;
  console.log(`\n${"=".repeat(78)}`);
  const s = await getSub(c.id);
  const lines = recurring(s);
  const skus = lines.map((l) => l.variant_sku).sort();
  const next = pendingNext(s);

  console.log(`sub ${c.id} [${s.status}] ${s.delivery_interval}`);
  console.log(`  intento del cliente: ${c.intent}`);
  for (const l of lines) {
    console.log(`  linea item ${l.id}  ${l.variant_sku} x${l.quantity} @${l.price}  = ${boxesOf(l)} cajas` +
      (l.discount_codes?.length ? `  cupones: ${l.discount_codes.map((d) => d.code).join(",")}` : ""));
  }
  console.log(`  cobra ahora: ${eur(chargeOf(lines))}   proximo cobro: ${(next?.date ?? "-").slice(0, 10)}`);

  // ── Guardas ──
  if (lines.length < 2) {
    console.log(`  SALTADA: solo ${lines.length} linea recurrente, no hay nada que quitar`);
    results.push({ id: c.id, action: "skipped", why: "ya tiene una sola linea" });
    continue;
  }
  const expectSorted = [...c.expect].sort();
  if (JSON.stringify(skus) !== JSON.stringify(expectSorted)) {
    console.log(`  SALTADA: estado inesperado. esperaba [${expectSorted}] y hay [${skus}]. Revisar a mano.`);
    results.push({ id: c.id, action: "skipped", why: `estado cambiado: ${skus}` });
    continue;
  }
  if (next) {
    const hours = (new Date(next.date).getTime() - Date.now()) / 36e5;
    if (hours < 48) {
      console.log(`  SALTADA: el proximo cobro es en ${hours.toFixed(0)}h (<48h). No tocar tan cerca del cobro.`);
      results.push({ id: c.id, action: "skipped", why: "cobro a menos de 48h" });
      continue;
    }
  }

  // ── Qué conservar ──
  const sorted = [...lines].sort((a, b) => Number(a.id) - Number(b.id));
  const keep = c.keep === "newest" ? sorted[sorted.length - 1] : sorted[0];
  const drop = lines.filter((l) => l.id !== keep.id);

  const boxes = boxesOf(keep);
  const tier = TIER[Math.min(6, boxes)];
  const keepCharge = Number(keep.price) * Math.max(1, Number(keep.quantity) || 1);

  console.log(`  -> CONSERVAR item ${keep.id} (${keep.variant_sku} x${keep.quantity} @${keep.price}) = ${boxes} cajas, ${eur(keepCharge)}`);
  console.log(`  -> QUITAR     ${drop.map((d) => `item ${d.id} (${d.variant_sku})`).join(", ")}`);
  console.log(`  -> pasa de ${eur(chargeOf(lines))} a ${eur(keepCharge)}   (tramo de ${boxes} cajas = ${eur(tier)})`);

  if (Math.abs(keepCharge - tier) > 0.01) {
    console.log(`  ABORTADA: la linea que se conserva no cuadra con el tramo (${eur(keepCharge)} vs ${eur(tier)}). Revisar a mano.`);
    results.push({ id: c.id, action: "aborted", why: "precio no cuadra con el tramo" });
    continue;
  }

  if (!APPLY) {
    console.log(`  [SECO] sin --apply no se envia nada`);
    results.push({ id: c.id, action: "dry-run", from: chargeOf(lines), to: keepCharge });
    continue;
  }

  // ── Ejecutar ──
  const { json } = await seal("/subscription", {
    method: "PUT",
    body: JSON.stringify({ action: "remove_items", id: c.id, remove_items: drop.map((d) => d.id) }),
  });
  if (json?.success === false) {
    console.log(`  FALLO: ${json.message}`);
    results.push({ id: c.id, action: "failed", why: json.message });
    continue;
  }
  await sleep(1500);

  // ── Verificar releyendo ──
  const after = await getSub(c.id);
  const afterLines = recurring(after);
  const afterCharge = chargeOf(afterLines);
  const okLines = afterLines.length === 1 && afterLines[0].id === keep.id;
  const okMoney = Math.abs(afterCharge - tier) <= 0.01;
  const nextAfter = pendingNext(after);
  const okSchedule = (nextAfter?.date ?? null) === (next?.date ?? null);

  console.log(`  DESPUES: ${afterLines.length} linea(s) ${afterLines.map((l) => `${l.variant_sku}x${l.quantity}@${l.price}`).join(" + ")}  cobra ${eur(afterCharge)}`);
  console.log(`    ${okLines ? "OK  " : "FALLO"} queda exactamente la linea conservada`);
  console.log(`    ${okMoney ? "OK  " : "FALLO"} el cobro cuadra con el tramo`);
  console.log(`    ${okSchedule ? "OK  " : "AVISO"} el calendario no se movio (${(nextAfter?.date ?? "-").slice(0, 10)})`);
  const dc = afterLines[0]?.discount_codes ?? [];
  if (dc.length) console.log(`    cupones que siguen: ${dc.map((d) => `${d.code} (-${d.amount})`).join(", ")}`);

  results.push({
    id: c.id, action: okLines && okMoney ? "repaired" : "needs-review",
    from: chargeOf(lines), to: afterCharge,
  });
  await sleep(600);
}

console.log(`\n${"=".repeat(78)}\nRESUMEN${APPLY ? "" : " (SECO)"}`);
let saved = 0;
for (const r of results) {
  const delta = r.from != null && r.to != null ? ` ${eur(r.from)} -> ${eur(r.to)}` : "";
  console.log(`  ${r.id}  ${r.action}${delta}${r.why ? `  (${r.why})` : ""}`);
  if (r.from != null && r.to != null) saved += r.from - r.to;
}
console.log(`\nsobrecobro evitado por ciclo: ${eur(saved)}`);
if (!APPLY) console.log(`\nPara ejecutar: node scripts/repair-duplicate-lines.mjs --apply`);

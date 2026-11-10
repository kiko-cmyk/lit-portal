/**
 * Lleva HACIA ATRÁS el calendario de UNA suscripción hasta una fecha, con el código de
 * producción: `seal.pullCadenceBackTo` bajo el cerrojo de la sub (`tryWithPlanLock`), como
 * el webhook de Seal y el reanchor-drain. Puntual, para casos que el re-anclaje ya no
 * cubre porque su intención se cerró.
 *
 * Primer uso (10-nov-2026): la 16140086 pasó de 2 meses a 45 días el 05-nov con la próxima
 * entrega el 15-nov. `alta + 45 días` ya había pasado, Seal se saltó ese ciclo y la dejó el
 * 14-dic; el email «Plan actualizado» le dijo 15-nov. Regla de Juan: al acortar se mantiene
 * la fecha que tenía y la frecuencia nueva cuenta desde ella.
 *
 * `pullCadenceBackTo` desplaza TODOS los pendientes el mismo número de días (conserva el
 * espaciado de Seal), del más cercano al más lejano, nunca a una fecha anterior al objetivo
 * ni al pasado. Reprograma con la hora por defecto de `rescheduleBillingAttempt`: 13:00 UTC.
 *
 * Uso:
 *   npx tsx --env-file=.env.local scripts/pull-cadence-back.ts --sub 16140086 --to 2026-11-15          # lee y enseña el plan, no toca
 *   npx tsx --env-file=.env.local scripts/pull-cadence-back.ts --sub 16140086 --to 2026-11-15 --apply  # lo ejecuta y relee
 *
 * Se niega (sin escribir nada) si la sub no está activa, si ya está en el objetivo o antes,
 * si el objetivo cae dentro del corte de 24 h, si hay una intención de re-anclaje pendiente
 * (podría volver a moverla) o si no encuentra un único cliente del portal para el cerrojo.
 *
 * Env: SEAL_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { isWithinCutoff } from "../src/lib/cutoff";
import { tryWithPlanLock } from "../src/lib/plan-lock";
import { seal, type SealSubscription } from "../src/lib/seal";
import { supabaseAdmin } from "../src/lib/supabase";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
};
const SUB = Number(arg("--sub"));
const TO = arg("--to") ?? "";
const APPLY = process.argv.includes("--apply");
const RESCHEDULE_TIME = "13:00"; // la de `rescheduleBillingAttempt` por defecto

if (!process.env.SEAL_API_TOKEN) throw new Error("SEAL_API_TOKEN required");
if (!Number.isInteger(SUB) || SUB <= 0) throw new Error("--sub <id> required");
if (!/^\d{4}-\d{2}-\d{2}$/.test(TO)) throw new Error("--to YYYY-MM-DD required");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isPending = (a: SealSubscription["billing_attempts"][number]) => !a.completed_at && !a.status && !a.skipped_on;
const dayMs = 86_400_000;
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);

function printCalendar(sub: SealSubscription) {
  for (const a of [...sub.billing_attempts].sort((x, y) => x.date.localeCompare(y.date))) {
    const state = a.completed_at ? "cobrado" : a.skipped_on ? `saltado (${a.skipped_on})` : a.status || "pendiente";
    console.log(`    ${a.date}  ${state.padEnd(10)} id=${a.id}`);
  }
}

async function readIntents() {
  const { data, error } = await supabaseAdmin()
    .from("subscription_reanchor_intents")
    .select("customer_id, preserve_date, status, attempts, created_at, updated_at")
    .eq("seal_subscription_id", String(SUB));
  if (error) throw new Error(`subscription_reanchor_intents: ${error.message}`);
  return data ?? [];
}

async function portalCustomerId(): Promise<string> {
  const sb = supabaseAdmin();
  const { data: cached, error } = await sb
    .from("subscriptions")
    .select("customer_id")
    .eq("seal_subscription_id", String(SUB));
  if (error) throw new Error(`subscriptions: ${error.message}`);
  const { data: ledger } = await sb
    .from("subscription_changes")
    .select("customer_id")
    .eq("payload->>sealSubscriptionId", String(SUB))
    .limit(50);
  const ids = new Set([...(cached ?? []), ...(ledger ?? [])].map((r) => String(r.customer_id)));
  if (ids.size !== 1) throw new Error(`cliente del portal ambiguo o ausente para ${SUB}: ${JSON.stringify([...ids])}`);
  return [...ids][0];
}

async function main() {
  const sub = await seal.getSubscriptionById(SUB);
  if (!sub) throw new Error(`Seal no devuelve la sub ${SUB}`);
  const customerId = await portalCustomerId();
  const intents = await readIntents();
  const pending = sub.billing_attempts.filter(isPending).sort((a, b) => a.date.localeCompare(b.date));
  const first = pending[0]?.date.slice(0, 10) ?? null;

  console.log(`\nSub ${SUB} · ${sub.status} · ${sub.delivery_interval} · cliente del portal ${customerId}`);
  console.log(`  calendario en Seal:`);
  printCalendar(sub);
  console.log(`  intenciones de re-anclaje: ${intents.length ? JSON.stringify(intents) : "ninguna"}`);

  const refuse = (why: string) => {
    console.error(`\n✗ No se toca nada: ${why}`);
    process.exitCode = 1;
  };
  if (sub.status !== "ACTIVE") return refuse(`la sub está ${sub.status}`);
  if (!first) return refuse("no hay ningún cobro pendiente");
  if (first <= TO) return refuse(`el primer pendiente (${first}) ya está en ${TO} o antes`);
  if (isWithinCutoff(`${TO}T${RESCHEDULE_TIME}:00Z`)) return refuse(`${TO} está dentro del corte de 24 h`);
  if (intents.some((i) => i.status === "pending")) return refuse("hay una intención de re-anclaje pendiente que podría volver a moverla");

  const offset = daysBetween(first, TO);
  const today = new Date().toISOString().slice(0, 10);
  const moves = pending
    .map((a) => ({ id: a.id, cur: a.date, tgt: addDays(a.date.slice(0, 10), offset) }))
    .filter((m) => m.tgt >= today)
    .sort((a, b) => a.tgt.localeCompare(b.tgt));
  console.log(`\n  plan: pullCadenceBackTo(${SUB}, "${TO}") — ${offset} días, del más cercano al más lejano:`);
  for (const m of moves) console.log(`    id=${m.id}  ${m.cur}  →  ${m.tgt}T${RESCHEDULE_TIME} UTC`);

  if (!APPLY) {
    console.log("\n(lectura) No se ha escrito nada. Añade --apply para ejecutarlo.");
    return;
  }

  console.log(`\nEjecutando con el cerrojo de la sub…`);
  const res = await tryWithPlanLock(customerId, SUB, "script-pull-cadence-back", () => seal.pullCadenceBackTo(SUB, TO));
  if (!res.ran) return refuse(`otro tiene el cerrojo de la sub (${res.reason}); reintentar en un minuto`);
  console.log(`  pullCadenceBackTo movió ${res.value} cobros`);

  await sleep(5_000);
  const after = await seal.getSubscriptionById(SUB);
  const intentsAfter = await readIntents();
  if (!after) return refuse("no se pudo releer la sub; mirarla a mano antes de nada");
  console.log(`\nReleída: ${after.status} · ${after.delivery_interval}`);
  printCalendar(after);
  console.log(`  intenciones de re-anclaje: ${intentsAfter.length ? JSON.stringify(intentsAfter) : "ninguna"}`);

  const got = after.billing_attempts.filter(isPending).map((a) => a.date.slice(0, 10)).sort();
  const want = moves.map((m) => m.tgt);
  const ok =
    JSON.stringify(got) === JSON.stringify(want) &&
    got[0] === TO &&
    !intentsAfter.some((i) => i.status === "pending");
  if (!ok) return refuse(`no ha quedado como se esperaba (esperado ${want.join(", ")}). No se intenta nada más.`);
  console.log(`\n✓ Queda en ${TO} y desde ahí con el mismo espaciado (${want.join(", ")}), sin intención pendiente.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

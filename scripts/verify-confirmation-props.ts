/**
 * ¿Qué mandaría `confirmation_sent` con las líneas resueltas desde la Admin API?
 *
 * Los fixtures son pedidos REALES de producción (29-jul-2026), copiados de la Admin API.
 * Compara lo que el evento manda HOY (leyendo el payload del webhook, que no trae
 * selling-plan) con lo que mandará leyendo el pedido. Puro, sin red.
 */
import { compositionLabel, shortLabel } from "../src/lib/mix";
import { FREQUENCY_BY_SELLING_PLAN } from "../src/lib/seal-plans";
import { boxCountFromOrderLines, compositionFromOrderLines, type OrderLine } from "../src/lib/order-lines";

type Line = OrderLine;

const L = (title: string, quantity: number, variant_id: number, planId?: string, planName?: string): Line => ({
  title,
  quantity,
  variant_id,
  selling_plan_allocation: planId ? { selling_plan: { id: planId, name: planName } } : undefined,
});

const FIXTURES: Array<{ order: string; esperado: string; lines: Line[] }> = [
  {
    order: "#8964",
    esperado: "1 caja Salty Watermelon, cada 15 días",
    lines: [L("LIT Daily Hydration: Watermelon", 1, 65046727459165, "691259801949", "Suscripción cada 15 días")],
  },
  {
    order: "#8963",
    esperado: "1 caja Salty Lemon, cada mes",
    lines: [L("LIT Daily Hydration: Salty Lemon", 1, 63887092154717, "691259834717", "Suscripción 1 mes")],
  },
  {
    order: "#8960",
    esperado: "3 cajas Salty Lemon trimestral + una compra única de sandía que NO cuenta",
    lines: [
      L("LIT Daily Hydration: Watermelon - Compra única", 1, 65046758818141),
      L("LIT Daily Hydration: Salty Lemon", 1, 63887092220253, "691259933021", "Suscripción trimestral"),
    ],
  },
  {
    order: "#8959",
    esperado: "wholesale B2B: no es suscripción",
    lines: [L("LIT Salty Watermelon: Wholesale", 4, 65170910806365)],
  },
];

/** La misma lógica del webhook, sobre las líneas que se le pasen. */
function props(lines: Line[]) {
  const subLines = lines.filter((li) => li.selling_plan_allocation);
  const main = subLines[0] ?? lines[0];
  const planId = main?.selling_plan_allocation?.selling_plan?.id
    ? String(main.selling_plan_allocation.selling_plan.id)
    : null;
  const boxCount = boxCountFromOrderLines(lines);
  const composition = compositionFromOrderLines(subLines);
  return {
    box_count: boxCount,
    sachets: boxCount * 30,
    flavor: composition.length ? compositionLabel(composition) : main?.title ?? "Lemon Drop",
    is_mix: composition.length > 1,
    flavor_mix: composition.map((c) => ({ flavor: shortLabel(c.flavor), boxes: c.boxes })),
    frequency: planId ? FREQUENCY_BY_SELLING_PLAN[planId] ?? null : null,
    is_subscription: lines.some((li) => li.selling_plan_allocation),
    selling_plan_name: main?.selling_plan_allocation?.selling_plan?.name ?? null,
  };
}

/** Lo que llega hoy: el payload del webhook, SIN selling_plan_allocation. */
const stripPlans = (lines: Line[]): Line[] => lines.map((li) => ({ ...li, selling_plan_allocation: undefined }));

let fallos = 0;
for (const f of FIXTURES) {
  const antes = props(stripPlans(f.lines));
  const ahora = props(f.lines);
  console.log(`\n${f.order}  ${f.esperado}`);
  const fmt = (p: ReturnType<typeof props>) =>
    `box=${p.box_count} sobres=${p.sachets} freq=${p.frequency ?? "-"} sub=${p.is_subscription} mix=${p.is_mix} flavor="${p.flavor}"`;
  console.log(`  HOY    ${fmt(antes)}`);
  console.log(`  AHORA  ${fmt(ahora)}`);
  if (JSON.stringify(antes) === JSON.stringify(ahora) && f.lines.some((l) => l.selling_plan_allocation)) {
    console.log("  ✗ el arreglo no cambia nada en un pedido de suscripción");
    fallos++;
  }
}

// Aserciones sobre el resultado esperado
const a8964 = props(FIXTURES[0].lines);
const a8960 = props(FIXTURES[2].lines);
const a8959 = props(FIXTURES[3].lines);
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`✗ ${msg}`); fallos++; }
};
console.log();
check(a8964.box_count === 1 && a8964.frequency === "15d" && a8964.is_subscription, "#8964 debe ser 1 caja, 15d, suscripción");
check(a8964.flavor === "Salty Watermelon", `#8964 flavor debe ser "Salty Watermelon", es "${a8964.flavor}"`);
check(a8960.box_count === 3 && a8960.frequency === "3mo", `#8960 debe ser 3 cajas trimestral, es ${a8960.box_count}/${a8960.frequency}`);
check(a8960.flavor === "Salty Lemon" && !a8960.is_mix, `#8960 no es mezcla: la compra única no cuenta (flavor="${a8960.flavor}", mix=${a8960.is_mix})`);
check(a8959.is_subscription === false && a8959.frequency === null, "#8959 wholesale no es suscripción");
console.log(fallos ? `\n${fallos} FALLO(S)` : "\nsin fallos");
process.exitCode = fallos ? 1 : 0;

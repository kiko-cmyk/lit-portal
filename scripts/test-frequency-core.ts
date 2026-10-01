/**
 * Tests de src/lib/frequency-core.ts. Sin framework, como el resto de scripts de
 * test del repo: aserciones a mano y dobles inyectados por `FrequencyChangeDeps`.
 *
 *   npm test
 *   npx tsx scripts/test-frequency-core.ts
 *
 * Qué protege. El módulo se extrajo el 2026-09-21 para que la ruta del cliente y
 * la entrada máquina a máquina del bot de WhatsApp compartan el `delivery_interval`
 * que Seal acepta, la fecha natural y la intención de re-anclaje. Los casos que
 * no se pueden romper:
 *   - la fecha natural es último cobro completado + intervalo nuevo, con el
 *     fallback de «próxima menos un ciclo»; el pantallazo del área personal
 *     (45 días → 2 meses, del 24-oct al 9-nov) tiene que cuadrar;
 *   - una opción que no ALEJA la entrega sale con `gains: false` (LIT-464);
 *   - la escritura releída con el intervalo viejo es `frequency_not_persisted` y
 *     una que no se pudo releer es `frequency_unverified`: en la entrada del bot
 *     no hay «hecho» sin relectura, al revés que en la ruta del cliente;
 *   - la intención de re-anclaje se escribe con la fecha natural y NO dentro del
 *     corte de 24 h; y si falla, el cambio ya hecho no se deshace ni se esconde;
 *   - en modo `fromNext` (el del bot desde el 2026-10-01) la fecha se cuenta desde
 *     la próxima entrega, a quien ya saltó no se le niega el cambio, y sin
 *     intención de re-anclaje escrita no hay «hecho» (`reanchor_intent_failed`);
 *   - `spacedNextShipDate` (el área personal desde el 2026-10-02) da EXACTAMENTE la
 *     fecha que enseñan SkipOverlay, CancelTakeover y la encuesta, también a quien
 *     ya saltó, y nunca una que no aleje la entrega.
 */

import {
  assertGains,
  assertLonger,
  changeFrequencyOnly,
  type FrequencyChangeDeps,
  gainsFor,
  isFrequency,
  longerOptions,
  longerOptionsFromNext,
  naturalNextShipDate,
  SEAL_INTERVAL_BY_FREQUENCY,
  shiftedNextShipDate,
  spacedNextShipDate,
} from "@/lib/frequency-core";
import { addCycle, subCycle } from "@/lib/cadence";
import { longerFrequencies } from "@/lib/plan-options";
import type { SealSubscription } from "@/lib/seal";
import type { Frequency } from "@/lib/types";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function rejects(name: string, p: Promise<unknown>, code: string) {
  try {
    await p;
    failures++;
    console.error(`✗ ${name} — no lanzó nada, se esperaba ${code}`);
  } catch (err) {
    const actual = (err as { code?: string }).code;
    check(name, actual === code, `lanzó ${actual}`);
  }
}

function attempt(id: number, day: string, o: { completed?: boolean; skipped?: boolean } = {}) {
  return {
    id,
    date: `${day}T10:00:00+00:00`,
    completed_at: o.completed ? `${day} 10:02:11` : "",
    status: o.completed ? "completed" : "",
    skipped_on: o.skipped ? "2026-09-01 08:13:37" : "",
    order_id: o.completed ? "17570363605341" : "",
    error_code: "",
    error_message: "",
    triggered_manually: "",
    customer_authentication_challenge_url: "",
  };
}

function sub(over: Record<string, unknown> = {}): SealSubscription {
  return {
    id: 14030060,
    customer_id: "27453541548381",
    email: "kiko@velarque.com",
    status: "ACTIVE",
    delivery_interval: "45 days",
    billing_interval: "45 days",
    items: [],
    billing_attempts: [
      attempt(1, "2026-09-09", { completed: true }),
      attempt(2, "2026-10-24"),
      attempt(3, "2026-12-08"),
    ],
    ...over,
  } as unknown as SealSubscription;
}

/** Fechas relativas a hoy para lo que pasa por el corte de 24 h, que mira el reloj. */
function day(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function fakeDeps(o: {
  editFails?: number;
  readBack?: FrequencyChangeDeps["readBack"];
  intentFails?: boolean;
} = {}) {
  const calls = { edits: [] as Record<string, unknown>[], audits: [] as string[], intents: [] as string[], sleeps: [] as number[] };
  let editFails = o.editFails ?? 0;
  const deps: FrequencyChangeDeps = {
    editSubscription: async (_id, edits) => {
      calls.edits.push(edits);
      if (editFails > 0) {
        editFails--;
        throw new Error("Seal edit rejected: busy");
      }
    },
    readBack: o.readBack ?? (async () => sub({ delivery_interval: "2 months" })),
    writeAudit: async (row) => {
      calls.audits.push(String(row.payload.outcome));
    },
    writeReanchorIntent: async (_c, _id, preserve) => {
      if (o.intentFails) throw new Error("supabase down");
      calls.intents.push(preserve);
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
  };
  return { deps, calls };
}

const run = async () => {
  // ── la aritmética del portal ──────────────────────────────────────────────
  check(
    "el pantallazo: 45 días → 2 meses mueve la entrega del 24-oct al 9-nov",
    naturalNextShipDate(sub(), "2026-10-24T10:00:00+00:00", "45d", "2mo") === "2026-11-09",
  );
  check(
    "sin cobro completado a la vista, el ancla es la próxima menos un ciclo (da lo mismo, 9-nov)",
    naturalNextShipDate(sub({ billing_attempts: [attempt(2, "2026-10-24")] }), "2026-10-24T10:00:00+00:00", "45d", "2mo") ===
      "2026-11-09",
  );
  check("sin ancla ninguna, null", naturalNextShipDate(sub({ billing_attempts: [] }), null, "45d", "2mo") === null);
  check(
    "los meses son de calendario: 9-sep + 3 meses es el 9-dic",
    naturalNextShipDate(sub(), null, "45d", "3mo") === "2026-12-09",
  );

  const opts = longerOptions(sub(), "45d");
  check(
    "solo se ofrece hacia arriba",
    opts.map((o) => o.frequency).join(",") === "2mo,3mo,4mo,5mo,6mo",
    opts.map((o) => o.frequency).join(","),
  );
  check("todas las del pantallazo alejan la entrega", opts.every((o) => o.gains));
  check("y traen su fecha", opts[0].naturalNextShipDate === "2026-11-09");

  // LIT-464: quien ya había saltado tiene el último cobro lejos.
  const saltos = sub({
    delivery_interval: "1 month",
    billing_attempts: [
      attempt(1, "2026-03-01", { completed: true }),
      attempt(2, "2026-04-01", { skipped: true }),
      attempt(3, "2026-05-01", { skipped: true }),
      attempt(4, "2026-10-24"),
    ],
  });
  const opts464 = longerOptions(saltos, "1mo");
  check(
    "LIT-464: con el último cobro en marzo ninguna opción aleja una entrega de octubre",
    opts464.length === 6 && opts464.every((o) => !o.gains),
    opts464.map((o) => `${o.frequency}:${o.naturalNextShipDate}`).join(" "),
  );

  // La forma REAL de la 14030060 el 2026-09-22: mensual, sin cobro completado a la
  // vista, saltados de julio a diciembre, pendientes desde el 1-ene. La ingenua
  // anclaría en diciembre; los saltos prueban que el cobro real es de junio.
  const real14030060 = sub({
    delivery_interval: "1 month",
    billing_attempts: [
      ...[7, 8, 9, 10, 11, 12].map((m, i) => attempt(i + 1, `2026-${String(m).padStart(2, "0")}-01`, { skipped: true })),
      attempt(7, "2027-01-01"),
      attempt(8, "2027-02-01"),
    ],
  });
  const opts14030060 = longerOptions(real14030060, "1mo");
  check(
    "la 14030060 real: ninguna opción gana (ancla en junio, no en diciembre)",
    opts14030060.length === 6 && opts14030060.every((o) => !o.gains),
    opts14030060.map((o) => `${o.frequency}:${o.gains}`).join(" "),
  );
  check(
    "pero la fecha natural (la que se preservaría) sigue siendo la ingenua, la que ve el cliente en pantalla",
    opts14030060[0].naturalNextShipDate === "2027-01-15",
  );
  try {
    assertGains(real14030060, "2027-01-01T10:00:00+00:00", "1mo", "2mo");
    failures++;
    console.error("✗ assertGains no lanzó en la 14030060");
  } catch (err) {
    check("assertGains sobre la 14030060 es no_gain", (err as { code?: string }).code === "no_gain");
  }
  {
    const { deps, calls } = fakeDeps();
    await rejects(
      "changeFrequencyOnly sobre la 14030060 es no_gain ANTES de tocar Seal",
      changeFrequencyOnly(
        { sealSub: real14030060, target: "2mo", customerId: "27453541548381", source: "whatsapp", reanchorMode: "natural" },
        deps,
      ),
      "no_gain",
    );
    check("y no hay edit ni auditoría", calls.edits.length === 0 && calls.audits.length === 0);
  }
  // Saltos solo desde octubre: el ancla retrocede a septiembre, y gana a partir de 5 meses.
  const saltosOct = sub({
    delivery_interval: "1 month",
    billing_attempts: [
      attempt(1, "2026-10-01", { skipped: true }),
      attempt(2, "2026-11-01", { skipped: true }),
      attempt(3, "2026-12-01", { skipped: true }),
      attempt(4, "2027-01-01"),
    ],
  });
  const optsOct = longerOptions(saltosOct, "1mo");
  check(
    "gains se lee opción por opción: con saltos desde octubre ganan 5 y 6 meses, no las de antes",
    optsOct.map((o) => `${o.frequency}:${o.gains}`).join(" ") === "45d:false 2mo:false 3mo:false 4mo:false 5mo:true 6mo:true",
    optsOct.map((o) => `${o.frequency}:${o.gains}`).join(" "),
  );
  check("gainsFor con el pantallazo, todo gana", gainsFor(sub(), "2026-10-24T10:00:00+00:00", "45d", "2mo"));
  check("sin próxima fecha no se puede ganar", !gainsFor(sub({ billing_attempts: [] }), null, "45d", "2mo"));

  check("SEAL_INTERVAL_BY_FREQUENCY va en singular, como acepta Seal", SEAL_INTERVAL_BY_FREQUENCY["45d"] === "45 day" && SEAL_INTERVAL_BY_FREQUENCY["2mo"] === "2 month");
  check("isFrequency acepta la escalera y nada más", isFrequency("2mo") && !isFrequency("7mo") && !isFrequency(2));

  for (const [cur, tgt] of [["2mo", "45d"], ["2mo", "2mo"], ["6mo", "1mo"]] as const) {
    try {
      assertLonger(cur, tgt);
      failures++;
      console.error(`✗ assertLonger(${cur}, ${tgt}) no lanzó`);
    } catch (err) {
      check(`assertLonger(${cur}, ${tgt}) es not_longer`, (err as { code?: string }).code === "not_longer");
    }
  }
  assertLonger("45d", "2mo");
  check("assertLonger deja pasar una más larga", true);

  // ── changeFrequencyOnly ───────────────────────────────────────────────────
  // Fechas relativas a hoy: la intención pasa por el corte de 24 h, que mira el reloj.
  const completedDay = day(-5);
  const nextDay = day(40);
  const vivo = sub({
    billing_attempts: [attempt(1, completedDay, { completed: true }), attempt(2, nextDay)],
  });
  const base = { sealSub: vivo, target: "2mo" as const, customerId: "27453541548381", source: "whatsapp", reanchorMode: "natural" as const };

  {
    const { deps, calls } = fakeDeps({
      readBack: async () => sub({ delivery_interval: "2 months", billing_attempts: [attempt(9, day(55))] }),
    });
    const r = await changeFrequencyOnly({ ...base, reason: "not_using_enough" }, deps);
    const esperado = naturalNextShipDate(vivo, `${nextDay}T10:00:00+00:00`, "45d", "2mo");
    check("escritura ok: changed y frecuencia nueva", r.changed && r.frequency === "2mo" && r.previousFrequency === "45d");
    check("el edit manda SOLO delivery_interval, en singular", JSON.stringify(calls.edits) === JSON.stringify([{ delivery_interval: "2 month" }]));
    check("auditoría: intent y verified, en ese orden", calls.audits.join(",") === "intent,verified", calls.audits.join(","));
    check("la intención de re-anclaje lleva la fecha natural", calls.intents.length === 1 && calls.intents[0] === esperado, `${calls.intents[0]} vs ${esperado}`);
    check("y la fecha prometida es esa, a las 13:00Z", r.nextShipDate === `${esperado}T13:00:00Z` && r.reanchor === "intent_written");
    check("el intervalo devuelto es el releído", r.deliveryInterval === "2 months");
    check("espera entre edit y relectura", calls.sleeps.includes(500));
  }

  {
    const { deps, calls } = fakeDeps();
    const r = await changeFrequencyOnly({ ...base, sealSub: sub({ delivery_interval: "2 months" }), target: "2mo" }, deps);
    check("ya en el objetivo: no toca Seal ni audita", !r.changed && calls.edits.length === 0 && calls.audits.length === 0 && r.reanchor === "none");
  }

  {
    const { deps, calls } = fakeDeps({ editFails: 1 });
    const r = await changeFrequencyOnly(base, deps);
    check("un edit que falla una vez se reintenta y sale", r.changed && calls.edits.length === 2 && calls.sleeps[0] === 700);
  }

  {
    const { deps, calls } = fakeDeps({ editFails: 2 });
    await rejects("dos fallos del edit son frequency_change_failed", changeFrequencyOnly(base, deps), "frequency_change_failed");
    check("y no se escribe intención ni se da por verificado", calls.intents.length === 0 && calls.audits.join(",") === "intent,edit_failed", calls.audits.join(","));
  }

  {
    const { deps, calls } = fakeDeps({ readBack: async () => null });
    await rejects("sin relectura no hay hecho: frequency_unverified", changeFrequencyOnly(base, deps), "frequency_unverified");
    check("pero la intención queda escrita para que el cron converja", calls.intents.length === 1);
    check("y la auditoría dice verify_not_found", calls.audits.at(-1) === "verify_not_found", calls.audits.join(","));
  }

  {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { deps, calls } = fakeDeps({ readBack: async () => { throw abort; } });
    await rejects("la relectura que caduca también es frequency_unverified", changeFrequencyOnly(base, deps), "frequency_unverified");
    check("con verify_timeout en la auditoría", calls.audits.at(-1) === "verify_timeout", calls.audits.join(","));
  }

  {
    const { deps, calls } = fakeDeps({ readBack: async () => sub({ delivery_interval: "45 days" }) });
    await rejects("Seal devuelve el intervalo viejo: frequency_not_persisted", changeFrequencyOnly(base, deps), "frequency_not_persisted");
    check("sin intención de re-anclaje sobre un cambio que no existe", calls.intents.length === 0 && calls.audits.at(-1) === "verify_mismatch");
  }

  {
    // Modo preserve con la próxima entrega a diez horas: la fecha preservada cae
    // dentro del corte, así que no se re-ancla y se devuelve lo que Seal enseña.
    const enHoras = new Date(Date.now() + 10 * 3_600_000).toISOString();
    const pronto = sub({ billing_attempts: [attempt(2, enHoras.slice(0, 10))] });
    const { deps, calls } = fakeDeps({
      readBack: async () => sub({ delivery_interval: "2 months", billing_attempts: [attempt(9, day(60))] }),
    });
    const r = await changeFrequencyOnly({ ...base, sealSub: pronto, reanchorMode: "preserve" }, deps);
    check("dentro del corte no se escribe intención", r.reanchor === "within_cutoff" && calls.intents.length === 0);
    check("y la fecha es la que Seal enseña tras releer", r.nextShipDate === `${day(60)}T10:00:00+00:00`);
  }

  {
    const { deps } = fakeDeps({ intentFails: true });
    const r = await changeFrequencyOnly(base, deps);
    check("si la intención no se puede escribir, el cambio hecho no se esconde", r.changed && r.reanchor === "intent_failed" && r.nextShipDate !== null);
  }

  // ── fromNext: la fecha que promete el bot desde el 2026-10-01 ─────────────
  check(
    "fromNext: la 12320700 de la prueba con Michel, de 2 a 3 meses con la próxima el 4-oct, es el 4-nov",
    shiftedNextShipDate("2026-10-04T10:00:00+00:00", "2mo", "3mo") === "2026-11-04",
  );
  check(
    "fromNext: el pantallazo da lo mismo que la natural, 9-nov",
    shiftedNextShipDate("2026-10-24T10:00:00+00:00", "45d", "2mo") === "2026-11-09",
  );
  check("fromNext: sin próxima, null", shiftedNextShipDate(null, "45d", "2mo") === null);
  const desdeLaProxima = longerOptionsFromNext(saltos, "1mo");
  check(
    "fromNext: a quien ya saltó (último cobro en marzo) todas las opciones le alejan la entrega",
    desdeLaProxima.length === 6 && desdeLaProxima.every((o) => o.gains) && desdeLaProxima[0].nextShipDate === "2026-11-08",
    desdeLaProxima.map((o) => `${o.frequency}:${o.nextShipDate}`).join(" "),
  );

  // Cada 2 meses, cobró hace 120 días y saltó hace 60: la natural de 3 meses cae
  // en el pasado (no_gain); contada desde la próxima, no.
  const saltadoVivo = sub({
    delivery_interval: "2 months",
    billing_attempts: [
      attempt(1, day(-120), { completed: true }),
      attempt(2, day(-60), { skipped: true }),
      attempt(3, nextDay),
    ],
  });
  const tresMeses = async () => sub({ delivery_interval: "3 months", billing_attempts: [attempt(9, day(1))] });
  const baseFromNext = { ...base, sealSub: saltadoVivo, target: "3mo" as const, reanchorMode: "fromNext" as const };
  {
    const { deps } = fakeDeps();
    await rejects(
      "contraste: en modo natural ese mismo cambio es no_gain",
      changeFrequencyOnly({ ...baseFromNext, reanchorMode: "natural" }, deps),
      "no_gain",
    );
  }
  {
    const { deps, calls } = fakeDeps({ readBack: tresMeses });
    const r = await changeFrequencyOnly(baseFromNext, deps);
    const esperado = shiftedNextShipDate(`${nextDay}T10:00:00+00:00`, "2mo", "3mo");
    check("fromNext: a quien ya saltó no se le niega el cambio", r.changed && r.frequency === "3mo");
    check("fromNext: la intención lleva la fecha contada desde la próxima", calls.intents.length === 1 && calls.intents[0] === esperado, `${calls.intents[0]} vs ${esperado}`);
    check("fromNext: y se promete esa", r.nextShipDate === `${esperado}T13:00:00Z` && r.reanchor === "intent_written");
  }
  {
    const { deps, calls } = fakeDeps({ readBack: tresMeses, intentFails: true });
    await rejects(
      "fromNext: sin intención de re-anclaje no hay «hecho» (Seal cobraría antes)",
      changeFrequencyOnly(baseFromNext, deps),
      "reanchor_intent_failed",
    );
    check("y la auditoría lo apunta", calls.audits.at(-1) === "reanchor_intent_failed", calls.audits.join(","));
  }

  // ── área personal: la fecha que se escribe es la que se enseña (2026-10-02) ─
  //
  // La pantalla del SkipOverlay (y la de CancelTakeover) calcula su vista previa
  // así, en el navegador. Si el backend escribe otra, al cliente se le promete una
  // fecha y se guarda otra: es lo que pasaba con la natural a quien había saltado.
  const pantalla = (nextIso: string, cur: Frequency, tgt: Frequency) =>
    addCycle(subCycle(new Date(nextIso), cur), tgt).toISOString().slice(0, 10);

  check(
    "área personal: la 12320700 (2 → 3 meses, próxima 4-oct) se escribe en 4-nov, lo que dice la pantalla",
    spacedNextShipDate("2026-10-04T11:00:00+00:00", "2mo", "3mo") === "2026-11-04",
  );
  check(
    "área personal: y de 2 a 6 meses, el 4-feb",
    spacedNextShipDate("2026-10-04T11:00:00+00:00", "2mo", "6mo") === "2027-02-04",
  );

  // La regresión de fondo: con su historial real (último cobro 27-may, tres
  // saltados) la natural caía en el PASADO y el guard del corte mataba la intención.
  const kiko = sub({
    delivery_interval: "2 month",
    billing_attempts: [
      attempt(1, "2026-05-20", { skipped: true }),
      attempt(2, "2026-05-27", { completed: true }),
      attempt(3, "2026-06-20", { skipped: true }),
      attempt(4, "2026-08-04", { skipped: true }),
      attempt(5, "2026-10-04"),
    ],
  });
  const natural464 = naturalNextShipDate(kiko, "2026-10-04T11:00:00+00:00", "2mo", "3mo");
  check(
    "área personal: con ese historial la natural de antes caía en el pasado (27-ago), la causa del fallo",
    natural464 === "2026-08-27",
    String(natural464),
  );
  check(
    "área personal: la nueva no depende del historial, solo de la próxima",
    spacedNextShipDate("2026-10-04T11:00:00+00:00", "2mo", "3mo") === "2026-11-04",
  );

  // Pantalla = backend para TODA la escalera, con fechas incómodas (fin de mes,
  // febrero, cambio de año).
  let iguales = 0;
  let casos = 0;
  const desiguales: string[] = [];
  for (const next of ["2026-10-04", "2026-10-31", "2026-01-31", "2026-12-15", "2027-02-28", "2026-08-30"]) {
    const nextIso = `${next}T10:00:00+00:00`;
    for (const cur of ["15d", "1mo", "45d", "2mo", "3mo", "4mo", "5mo"] as Frequency[]) {
      for (const tgt of longerFrequencies(cur)) {
        casos++;
        const back = spacedNextShipDate(nextIso, cur, tgt);
        const front = pantalla(nextIso, cur, tgt);
        if (back === front && back > next) iguales++;
        else desiguales.push(`${next} ${cur}→${tgt}: pantalla ${front}, backend ${back}`);
      }
    }
  }
  check(
    `área personal: pantalla y backend dan la misma fecha, y posterior a la próxima, en los ${casos} casos`,
    iguales === casos,
    desiguales.slice(0, 3).join(" | "),
  );

  check(
    "área personal: una frecuencia más corta no da fecha (se queda la que tiene, nunca hacia atrás)",
    spacedNextShipDate("2026-10-04T11:00:00+00:00", "2mo", "1mo") === null,
  );
  check(
    "área personal: la misma frecuencia tampoco",
    spacedNextShipDate("2026-10-04T11:00:00+00:00", "2mo", "2mo") === null,
  );
  check("área personal: sin próxima, null", spacedNextShipDate(null, "2mo", "3mo") === null);

  if (failures) {
    console.error(`\n${failures} aserciones fallidas`);
    process.exit(1);
  }
  console.log("\nfrequency-core: todo en verde");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

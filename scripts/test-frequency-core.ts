/**
 * Tests de src/lib/frequency-core.ts. Sin framework, como el resto de scripts de
 * test del repo: aserciones a mano y dobles inyectados por `FrequencyChangeDeps`.
 *
 *   npm test
 *   npx tsx scripts/test-frequency-core.ts
 *
 * Qué protege. El módulo se extrajo el 2026-09-21 para que la ruta del cliente y
 * la entrada máquina a máquina del bot de WhatsApp compartan el `delivery_interval`
 * que Seal acepta, la fecha a la que se espacia y la intención de re-anclaje. Los
 * casos que no se pueden romper:
 *   - la escritura releída con el intervalo viejo es `frequency_not_persisted` y
 *     una que no se pudo releer es `frequency_unverified`: en la entrada del bot
 *     no hay «hecho» sin relectura, al revés que en la ruta del cliente;
 *   - la intención de re-anclaje se escribe con la fecha espaciada y NO dentro del
 *     corte de 24 h; y si falla, el cambio ya hecho no se deshace ni se esconde;
 *   - `writeReanchorIntent` LANZA cuando Supabase devuelve `{ error }` (antes se lo
 *     tragaba y una intención no escrita pasaba por escrita);
 *   - en modo `fromNext` (el del bot desde el 2026-10-01) la fecha se cuenta desde
 *     la próxima entrega, a quien ya saltó no se le niega el cambio, y sin
 *     intención de re-anclaje escrita no hay «hecho» (`reanchor_intent_failed`);
 *   - `spacedNextShipDate` (el área personal desde el 2026-10-02) nunca da una fecha
 *     que no aleje la entrega, en toda la escalera y con fechas incómodas. Que sea
 *     la MISMA que enseñan SkipOverlay y CancelTakeover lo garantiza el código, no
 *     este test: las tres usan `spacedFromNext` de `@/lib/cadence`.
 *
 * El modo `natural` (último cobro + intervalo nuevo), `gainsFor`/`assertGains`, el
 * ancla conservadora y `longerOptions` se quitaron el 2026-10-05 con sus tests: tras
 * el PR #122 no los usaba nadie.
 */

import {
  assertLonger,
  changeFrequencyOnly,
  type FrequencyChangeDeps,
  isFrequency,
  longerOptionsFromNext,
  SEAL_INTERVAL_BY_FREQUENCY,
  shiftedNextShipDate,
  spacedNextShipDate,
  writeReanchorIntent,
} from "@/lib/frequency-core";
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
  const base = { sealSub: vivo, target: "2mo" as const, customerId: "27453541548381", source: "whatsapp", reanchorMode: "fromNext" as const };

  {
    const { deps, calls } = fakeDeps({
      readBack: async () => sub({ delivery_interval: "2 months", billing_attempts: [attempt(9, day(55))] }),
    });
    const r = await changeFrequencyOnly({ ...base, reason: "not_using_enough" }, deps);
    const esperado = shiftedNextShipDate(`${nextDay}T10:00:00+00:00`, "45d", "2mo");
    check("escritura ok: changed y frecuencia nueva", r.changed && r.frequency === "2mo" && r.previousFrequency === "45d");
    check("el edit manda SOLO delivery_interval, en singular", JSON.stringify(calls.edits) === JSON.stringify([{ delivery_interval: "2 month" }]));
    check("auditoría: intent y verified, en ese orden", calls.audits.join(",") === "intent,verified", calls.audits.join(","));
    check("la intención de re-anclaje lleva la fecha contada desde la próxima", calls.intents.length === 1 && calls.intents[0] === esperado, `${calls.intents[0]} vs ${esperado}`);
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
    // En `preserve` la intención solo protege una fecha que el cliente ya tenía:
    // si no se escribe, el cambio hecho se devuelve con `intent_failed`, no se
    // esconde. (En `fromNext` es un 502, más abajo.)
    const { deps } = fakeDeps({ intentFails: true });
    const r = await changeFrequencyOnly({ ...base, reanchorMode: "preserve" }, deps);
    check("preserve: si la intención no se puede escribir, el cambio hecho no se esconde", r.changed && r.reanchor === "intent_failed" && r.nextShipDate !== null);
  }

  // ── fromNext: la fecha que promete el bot desde el 2026-10-01 ─────────────
  check(
    "fromNext: la 12320700 de la prueba con Michel, de 2 a 3 meses con la próxima el 4-oct, es el 4-nov",
    shiftedNextShipDate("2026-10-04T10:00:00+00:00", "2mo", "3mo") === "2026-11-04",
  );
  check(
    "fromNext: el pantallazo del SkipOverlay, 9-nov",
    shiftedNextShipDate("2026-10-24T10:00:00+00:00", "45d", "2mo") === "2026-11-09",
  );
  check("fromNext: sin próxima, null", shiftedNextShipDate(null, "45d", "2mo") === null);
  // Mensual, cobró el 1-mar y saltó abril y mayo: la próxima es el 24-oct.
  const saltos = sub({
    delivery_interval: "1 month",
    billing_attempts: [
      attempt(1, "2026-03-01", { completed: true }),
      attempt(2, "2026-04-01", { skipped: true }),
      attempt(3, "2026-05-01", { skipped: true }),
      attempt(4, "2026-10-24"),
    ],
  });
  const desdeLaProxima = longerOptionsFromNext(saltos, "1mo");
  check(
    "fromNext: a quien ya saltó (último cobro en marzo) todas las opciones le alejan la entrega",
    desdeLaProxima.length === 6 && desdeLaProxima.every((o) => o.gains) && desdeLaProxima[0].nextShipDate === "2026-11-08",
    desdeLaProxima.map((o) => `${o.frequency}:${o.nextShipDate}`).join(" "),
  );

  // Cada 2 meses, cobró hace 120 días y saltó hace 60: contada desde el último
  // cobro (la natural de antes) 3 meses caería en el pasado; desde la próxima, no.
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

  // ── área personal: la fecha que se escribe (2026-10-02) ─────────────────
  //
  // Que pantalla y backend den la MISMA fecha ya no lo prueba un test que compare
  // dos copias de la misma suma (no podía fallar, revisión de Kiko del PR #122): lo
  // garantiza que SkipOverlay, CancelTakeover y `spacedNextShipDate` llamen a la
  // misma `spacedFromNext`. Aquí se prueba lo que SÍ puede romperse: que la fecha
  // aleje siempre la entrega y que la cuenta de calendario sea la esperada.
  check(
    "área personal: la 12320700 (2 → 3 meses, próxima 4-oct) se espacia al 4-nov",
    spacedNextShipDate("2026-10-04T11:00:00+00:00", "2mo", "3mo") === "2026-11-04",
  );
  check(
    "área personal: y de 2 a 6 meses, al 4-feb",
    spacedNextShipDate("2026-10-04T11:00:00+00:00", "2mo", "6mo") === "2027-02-04",
  );
  check(
    "área personal: el pantallazo del SkipOverlay, 45 días → 2 meses con la próxima el 24-oct, al 9-nov",
    spacedNextShipDate("2026-10-24T10:00:00+00:00", "45d", "2mo") === "2026-11-09",
  );
  check(
    "área personal: el bot y el área personal prometen la misma fecha",
    spacedNextShipDate("2026-10-04T11:00:00+00:00", "2mo", "4mo") ===
      shiftedNextShipDate("2026-10-04T11:00:00+00:00", "2mo", "4mo"),
  );

  // Propiedad: en TODA la escalera, con fin de mes, febrero y cambio de año, una
  // frecuencia más larga da una fecha posterior a la próxima. Si alguien cambia la
  // suma de `spacedFromNext` por una que retrocede, aquí salta.
  const noAlejan: string[] = [];
  let casos = 0;
  for (const next of ["2026-10-04", "2026-10-31", "2026-01-31", "2026-12-15", "2027-02-28", "2026-08-30"]) {
    for (const cur of ["15d", "1mo", "45d", "2mo", "3mo", "4mo", "5mo"] as Frequency[]) {
      for (const tgt of longerFrequencies(cur)) {
        casos++;
        const d = spacedNextShipDate(`${next}T10:00:00+00:00`, cur, tgt);
        if (!d || d <= next) noAlejan.push(`${next} ${cur}→${tgt}: ${d}`);
      }
    }
  }
  check(
    `área personal: una frecuencia más larga siempre aleja la entrega (${casos} casos)`,
    noAlejan.length === 0,
    noAlejan.slice(0, 3).join(" | "),
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

  // ── writeReanchorIntent: el `error` de supabase-js (2026-10-05) ───────────
  //
  // supabase-js no lanza: devuelve `{ error }`, también cuando salta el timeout de
  // `fetchDeadline`. Si `writeReanchorIntent` no lo mira, el `502
  // reanchor_intent_failed` del bot no salta nunca y el plan route promete la fecha
  // sin nada que la sujete.
  const fakeDb = (error: { message: string } | null) => {
    const upserts: Record<string, unknown>[] = [];
    const db = {
      from: (table: string) => ({
        upsert: async (row: Record<string, unknown>) => {
          upserts.push({ table, ...row });
          return { error };
        },
      }),
    } as unknown as Parameters<typeof writeReanchorIntent>[3];
    return { db, upserts };
  };
  {
    const { db, upserts } = fakeDb(null);
    await writeReanchorIntent("27136755892573", 12320700, "2026-11-04", db);
    check(
      "writeReanchorIntent escribe la fila pendiente con la fecha",
      upserts.length === 1 && upserts[0].table === "subscription_reanchor_intents" &&
        upserts[0].preserve_date === "2026-11-04" && upserts[0].status === "pending",
    );
  }
  {
    const { db } = fakeDb({ message: "AbortError: fetch deadline exceeded" });
    let lanzo = false;
    try {
      await writeReanchorIntent("27136755892573", 12320700, "2026-11-04", db);
    } catch (err) {
      lanzo = String(err).includes("fetch deadline exceeded");
    }
    check("writeReanchorIntent LANZA cuando Supabase devuelve { error } (antes se lo tragaba)", lanzo);
  }

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

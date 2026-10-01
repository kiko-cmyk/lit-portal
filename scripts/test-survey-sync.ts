/**
 * Tests de la marca condicional del cron de sync del perfilado a Klaviyo.
 *
 *   npx tsx scripts/test-survey-sync.ts
 *
 * Qué protege: que una petición de BORRADO que llega mientras el cron está a
 * mitad de pasada no quede marcada como sincronizada con los datos viejos
 * subidos. Si eso pasa, Postgres dice "borrado" y Klaviyo guarda las `cs_*`
 * para siempre, sin error. Ver `src/lib/survey-sync.ts`.
 *
 * La tabla es un array en memoria detrás de un falso cliente de Supabase que
 * implementa SOLO lo que usa la marca: update → eq/is → select. Las filas tienen
 * la forma real de `profile_survey_answers`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { markSyncedIfUnchanged } from "@/lib/survey-sync";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Row = {
  customer_id: string;
  answers: Record<string, string>;
  consent: boolean;
  deleted_at: string | null;
  klaviyo_synced_at: string | null;
  updated_at: string | null;
};

function fakeClient(table: Row[]): SupabaseClient {
  return {
    from: (_t: string) => ({
      update: (patch: Partial<Row>) => {
        const filters: Array<(r: Row) => boolean> = [];
        const b = {
          eq: (col: keyof Row, val: unknown) => (filters.push((r) => r[col] === val), b),
          is: (col: keyof Row, val: null) => (filters.push((r) => r[col] === val), b),
          select: async (_cols: string) => {
            const hit = table.filter((r) => filters.every((f) => f(r)));
            for (const r of hit) Object.assign(r, patch);
            return { data: hit.map((r) => ({ customer_id: r.customer_id })), error: null };
          },
        };
        return b;
      },
    }),
  } as unknown as SupabaseClient;
}

const V1 = "2026-09-23T07:43:35.653975+00:00";
const V2 = "2026-09-23T07:44:02.118201+00:00";
const pendiente = (id: string, extra: Partial<Row> = {}): Row => ({
  customer_id: id,
  answers: { uso: "Deporte", momento: "Mañana" },
  consent: true,
  deleted_at: null,
  klaviyo_synced_at: null,
  updated_at: V1,
  ...extra,
});

async function main() {
  console.log("\n── marca condicional ──");

  {
    const t = [pendiente("A")];
    const ok = await markSyncedIfUnchanged(fakeClient(t), "A", V1);
    check("fila sin cambios: se marca", ok && t[0].klaviyo_synced_at !== null);
  }

  {
    // La carrera: el cron lee A en V1; antes de marcar, llega el borrado.
    const t = [pendiente("A")];
    const leida = { ...t[0] };
    Object.assign(t[0], {
      answers: {}, consent: false, deleted_at: V2, klaviyo_synced_at: null, updated_at: V2,
    });
    const ok = await markSyncedIfUnchanged(fakeClient(t), "A", leida.updated_at);
    check("borrado a mitad de pasada: NO se marca", !ok);
    check("y la lápida sigue en la cola para la pasada siguiente", t[0].klaviyo_synced_at === null && t[0].deleted_at === V2);
  }

  {
    const t = [pendiente("A")];
    Object.assign(t[0], { answers: { uso: "Resaca" }, updated_at: V2 });
    const ok = await markSyncedIfUnchanged(fakeClient(t), "A", V1);
    check("respuesta editada a mitad de pasada: NO se marca", !ok && t[0].klaviyo_synced_at === null);
  }

  {
    // Dos tiradas del cron solapadas: la segunda no re-marca.
    const t = [pendiente("A", { klaviyo_synced_at: V2 })];
    const antes = t[0].klaviyo_synced_at;
    const ok = await markSyncedIfUnchanged(fakeClient(t), "A", V1);
    check("ya sincronizada por otra tirada: no se toca", !ok && t[0].klaviyo_synced_at === antes);
  }

  {
    const t = [pendiente("A"), pendiente("B")];
    await markSyncedIfUnchanged(fakeClient(t), "A", V1);
    check("solo marca a su cliente", t[1].klaviyo_synced_at === null);
  }

  {
    const t = [pendiente("A", { updated_at: null })];
    const ok = await markSyncedIfUnchanged(fakeClient(t), "A", null);
    check("una fila sin updated_at se sigue pudiendo marcar", ok);
  }

  if (failures) {
    console.error(`\n${failures} fallo(s).`);
    process.exit(1);
  }
  console.log("\nTodo en verde.");
}

main();

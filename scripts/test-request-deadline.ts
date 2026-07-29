/**
 * Tests del deadline de petición de src/lib/http-timeout.ts. Sin framework (el
 * repo no tiene ninguno): aserciones a mano.
 *
 *   npx tsx scripts/test-request-deadline.ts
 *
 * Mide cuándo aborta DE VERDAD el signal, en vez de dar por bueno lo que dice el
 * código. Los dos casos que importan y que son fáciles de romper sin enterarse:
 * que el segundo upstream de una cadena herede el tiempo que queda en vez de un
 * presupuesto nuevo (si no, la suma vuelve a pasarse del App Proxy y reaparece el
 * gateway_timeout), y que runWithoutRequestDeadline devuelva el presupuesto
 * completo (si no, el sync de Shopify del after() aborta al instante y parece
 * roto otra vez).
 */
import {
  budgetWithin,
  fetchDeadline,
  msLeft,
  requestDeadlineLeft,
  runWithoutRequestDeadline,
  runWithRequestDeadline,
} from "@/lib/http-timeout";

/** Espera a que el signal aborte y devuelve cuántos ms tardó. */
function timeToAbort(signal: AbortSignal): Promise<number> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(0);
    signal.addEventListener("abort", () => resolve(Date.now() - t0), { once: true });
  });
}

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail: string) {
  results.push([name, pass, detail]);
}

async function main() {
  // AbortSignal.timeout usa un timer unref'd: sin esto Node cierra el bucle de
  // eventos antes de que aborte nada y el script sale en silencio con exit 0.
  // En producción no pasa porque siempre hay un fetch pendiente sujetando el loop.
  const keepAlive = setInterval(() => {}, 25);

  // 1. Sin deadline ambiente: manda el ms que pide el cliente.
  check("sin ambiente, no hay presupuesto", requestDeadlineLeft() === null, `left=${requestDeadlineLeft()}`);
  {
    const { signal } = fetchDeadline(300);
    const ms = await timeToAbort(signal);
    check("sin ambiente, aborta a su propio ms", ms >= 250 && ms <= 450, `abortó a ${ms}ms (esperado ~300)`);
  }

  // 2. Con deadline ambiente MÁS CORTO: gana el ambiente.
  await runWithRequestDeadline(300, async () => {
    const { signal, timedOut } = fetchDeadline(5_000);
    const ms = await timeToAbort(signal);
    check(
      "ambiente corto recorta al cliente",
      ms >= 250 && ms <= 500,
      `pidió 5000ms, abortó a ${ms}ms (esperado ~300)`,
    );
    check("timedOut() lo reporta", timedOut(), `timedOut=${timedOut()}`);
  });

  // 3. Presupuesto compartido: el segundo cliente hereda lo que queda, no un budget nuevo.
  await runWithRequestDeadline(600, async () => {
    const primero = budgetWithin(9_000);
    await new Promise((r) => setTimeout(r, 350));
    const segundo = budgetWithin(9_000);
    const restante = msLeft(segundo);
    check(
      "el segundo upstream hereda el resto",
      restante > 150 && restante < 350,
      `tras gastar 350ms de 600ms quedan ${restante}ms (un budget nuevo daría 9000)`,
    );
    check("el presupuesto no crece entre llamadas", segundo <= primero + 5, `${segundo} <= ${primero}`);
  });

  // 4. Presupuesto agotado: aborta ya, no espera.
  await runWithRequestDeadline(50, async () => {
    await new Promise((r) => setTimeout(r, 120));
    const t0 = Date.now();
    const { signal } = fetchDeadline(5_000);
    const ms = await timeToAbort(signal);
    check(
      "presupuesto agotado aborta inmediato",
      Date.now() - t0 < 100,
      `abortó a ${ms}ms tras agotarse (no espera los 5000)`,
    );
  });

  // 5. runWithoutRequestDeadline: el after() recupera su presupuesto completo.
  await runWithRequestDeadline(50, async () => {
    await new Promise((r) => setTimeout(r, 120)); // presupuesto agotado
    await runWithoutRequestDeadline(async () => {
      check("dentro de without, no hay ambiente", requestDeadlineLeft() === null, `left=${requestDeadlineLeft()}`);
      const { signal } = fetchDeadline(300);
      const ms = await timeToAbort(signal);
      check(
        "el sync de after() recupera su ms entero",
        ms >= 250 && ms <= 450,
        `abortó a ${ms}ms (esperado ~300, NO 0)`,
      );
    });
    check("al salir de without, el ambiente vuelve", requestDeadlineLeft() !== null, `left=${requestDeadlineLeft()}`);
  });

  // 6. Aislamiento entre peticiones concurrentes.
  const [a, b] = await Promise.all([
    runWithRequestDeadline(250, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return requestDeadlineLeft()!;
    }),
    runWithRequestDeadline(4_000, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return requestDeadlineLeft()!;
    }),
  ]);
  check(
    "peticiones concurrentes no se pisan",
    a < 250 && b > 3_500,
    `corta=${a}ms restantes, larga=${b}ms restantes`,
  );

  let failed = 0;
  for (const [name, pass, detail] of results) {
    if (!pass) failed++;
    console.log(`${pass ? "✓" : "✗"} ${name} — ${detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} OK`);
  clearInterval(keepAlive);
  process.exitCode = failed ? 1 : 0;
}

void main();

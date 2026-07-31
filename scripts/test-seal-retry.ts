/**
 * Tests del reintento y de los presupuestos de src/lib/seal.ts. Sin framework
 * (el repo no tiene ninguno, igual que test-mix.ts y test-request-deadline.ts):
 * aserciones a mano y un `fetch` de mentira.
 *
 *   npm test          (encadena los tres scripts de test del repo)
 *   npx tsx scripts/test-seal-retry.ts
 *
 * Qué protege (incidencia 2026-07-30): el recordatorio de renovación de 7d murió
 * con "seal timed out after 6000ms on /subscriptions?...&page=17" y esa tirada no
 * avisó a nadie. El timeout PROPIO era el único modo de fallo sin reintento: los
 * 429, los 5xx y los cortes de conexión sí se reintentaban, nuestro deadline no,
 * porque se lanzaba antes de llegar al bloque de reintento. Con ~51 páginas por
 * barrido, bastaba con que una se atascara para perder la tirada entera.
 *
 * Los casos que no se pueden romper:
 *   - un timeout transitorio en una página se recupera;
 *   - un timeout persistente sigue fallando fuerte, nunca lista parcial;
 *   - una ruta interactiva NO gana presupuesto extra NI el reintento (las dos
 *     cosas empujan el 503 tipado hacia la paciencia de ~10s del App Proxy y
 *     reproducen la incidencia del 2026-07-27);
 *   - el tope del barrido no mata una tirada sana, y cuando salta lo dice con su
 *     nombre en vez de culpar a Seal de una página que nunca se pidió.
 *
 * Los tiempos van inyectados (SealTimings) para que el test tarde ~13s en vez de
 * esperar los 6-45s reales de cada deadline. La lógica bajo prueba es la real.
 *
 * Las aserciones son deterministas a propósito: cuentan llamadas al fetch falso y
 * miran `err.ms`, en vez de cronometrar con Date.now() contra timers reales. Un
 * umbral de reloj sobre una máquina cargada rompe la suite sin que haya cambiado
 * nada del código, y que el signal aborte cuando toca ya lo mide
 * test-request-deadline.ts.
 */

import { runAsBackgroundJob, UpstreamTimeoutError } from "@/lib/http-timeout";
import { SealApiError, SealClient, SealSweepTimeoutError, type SealTimings } from "@/lib/seal";

process.env.SEAL_API_TOKEN = "test-token";

// Escala de los tiempos de producción (6s por intento dentro de 9s totales,
// 10s dentro de 25s en cron, 45s de barrido). Lo que importa es la PROPORCIÓN:
// que en el cron quepan dos intentos más el backoff y en el interactivo no.
const TIMINGS: SealTimings = {
  attemptMs: 200,
  totalMs: 400,
  cronAttemptMs: 900,
  cronTotalMs: 4_000,
  sweepMs: 6_000,
};

/** Un interactivo con sitio de sobra: sirve para probar que lo que corta el
 *  reintento es el SCOPE, no la falta de presupuesto. */
const ROOMY: SealTimings = { ...TIMINGS, attemptMs: 900, totalMs: 4_000 };

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail: string) {
  results.push([name, pass, detail]);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Qué hace el upstream falso en esta llamada concreta. */
type Behaviour = "ok" | "stall" | "429";

interface StubState {
  /** Nº de llamadas por página (`page` de la query; 0 para las rutas sin paginar). */
  byPage: Map<number, number>;
  total: number;
  inFlight: number;
  maxInFlight: number;
}

/**
 * Un socket que se queda colgado: no responde nunca y solo rechaza cuando el
 * signal aborta, que es exactamente lo que hace `fetch` de verdad. Es la única
 * forma de que `timedOut()` sea true, así que es el corazón del test.
 */
function stall(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const fail = () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      reject(e);
    };
    if (!signal) return; // nunca pasa: seal.ts siempre pasa su signal
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail, { once: true });
  });
}

function jsonPage(page: number, totalPages: number, subs: unknown[]): Response {
  return new Response(
    JSON.stringify({ success: true, payload: { subscriptions: subs, page, total_pages: totalPages } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function jsonSubscription(id: number): Response {
  return new Response(JSON.stringify({ success: true, payload: { id, items: [] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Instala el `fetch` falso. `behaviour(page, callNo)` decide qué pasa en la
 * llamada `callNo` (1-based) de esa página; `body` construye la respuesta OK.
 * `latencyMs` es lo que tarda el camino feliz: sin latencia las respuestas se
 * resuelven en el mismo microtask y no habría ni concurrencia que medir (test
 * del POOL) ni reloj que gastar (tests del barrido).
 */
function stubFetch(
  behaviour: (page: number, callNo: number) => Behaviour,
  body: (page: number) => Response,
  latencyMs = 30,
): StubState {
  const state: StubState = { byPage: new Map(), total: 0, inFlight: 0, maxInFlight: 0 };
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? 0);
    const callNo = (state.byPage.get(page) ?? 0) + 1;
    state.byPage.set(page, callNo);
    state.total++;
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      const what = behaviour(page, callNo);
      if (what === "stall") return await stall(init?.signal);
      await sleep(latencyMs);
      if (what === "429") return new Response("rate limited", { status: 429 });
      return body(page);
    } finally {
      state.inFlight--;
    }
  }) as typeof fetch;
  return state;
}

async function main() {
  // AbortSignal.timeout usa un timer unref'd y aquí los sockets falsos no sujetan
  // el bucle de eventos: sin esto Node saldría antes de que aborte nada.
  const keepAlive = setInterval(() => {}, 25);
  const realFetch = globalThis.fetch;

  const cron = new SealClient(TIMINGS);
  const interactive = new SealClient(TIMINGS);
  const interactiveRoomy = new SealClient(ROOMY);

  // 1. Timeout transitorio en UNA página: el barrido se recupera solo.
  //    Es literalmente la incidencia del 2026-07-30 con 3 páginas en vez de ~51.
  {
    const st = stubFetch(
      (page, callNo) => (page === 2 && callNo === 1 ? "stall" : "ok"),
      (page) => jsonPage(page, 3, [{ id: page }]),
    );
    const subs = await runAsBackgroundJob(() => cron.listAllSubscriptions());
    check(
      "timeout transitorio en una página se recupera",
      subs.length === 3,
      `devolvió ${subs.length}/3 subs`,
    );
    check(
      "y reintenta solo esa página",
      st.byPage.get(2) === 2 && st.total === 4,
      `página 2 pedida ${st.byPage.get(2)} veces, ${st.total} llamadas en total (esperado 2 y 4)`,
    );
  }

  // 2. Timeout persistente: sigue fallando FUERTE y acotado.
  {
    const st = stubFetch(
      (page) => (page === 2 ? "stall" : "ok"),
      (page) => jsonPage(page, 2, [{ id: page }]),
    );
    let err: unknown = null;
    let resolved: unknown = null;
    try {
      resolved = await runAsBackgroundJob(() => cron.listAllSubscriptions());
    } catch (e) {
      err = e;
    }
    check(
      "timeout persistente sigue fallando fuerte",
      err instanceof UpstreamTimeoutError && !(err instanceof SealSweepTimeoutError),
      `lanzó ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
    check(
      "sin truncar en silencio: no devuelve la parte que sí bajó",
      resolved === null,
      `resolved=${resolved === null ? "no resolvió" : JSON.stringify(resolved)}`,
    );
    check(
      "el reintento del timeout está acotado a 1",
      st.byPage.get(2) === 2,
      `página 2 intentada ${st.byPage.get(2)} veces (esperado 2: el original + 1 reintento)`,
    );
  }

  // 3. Una ruta INTERACTIVA no gana presupuesto extra Y NO reintenta su propio
  //    timeout. Las dos cosas juntas son lo que mantiene el 503 tipado en ~6s
  //    reales; si se rompen, el 503 se va a ~9s contra la paciencia de ~10s del
  //    App Proxy y vuelve el gateway_timeout del 2026-07-27.
  {
    const st = stubFetch(() => "stall", () => jsonSubscription(1));
    let err: unknown = null;
    try {
      await interactive.getSubscriptionById(123);
    } catch (e) {
      err = e;
    }
    check(
      "una ruta interactiva no gana el presupuesto del cron",
      err instanceof UpstreamTimeoutError && err.ms === TIMINGS.attemptMs,
      `reportó ms=${err instanceof UpstreamTimeoutError ? err.ms : "?"} (esperado ${TIMINGS.attemptMs}, NO ${TIMINGS.cronAttemptMs})`,
    );
    check(
      "y NO reintenta su propio timeout: un solo intento hasta el 503",
      st.total === 1,
      `${st.total} llamada(s) al upstream (esperado 1: reintentar duplicaría la latencia hasta el 503)`,
    );
  }

  // 4. El ensanche va atado al SCOPE, no al cliente: el MISMO objeto cliente da
  //    un presupuesto dentro de runAsBackgroundJob y otro fuera.
  {
    const outside = stubFetch(() => "stall", () => jsonSubscription(1));
    let errOut: unknown = null;
    try {
      await cron.getSubscriptionById(123);
    } catch (e) {
      errOut = e;
    }
    const inside = stubFetch(() => "stall", () => jsonSubscription(1));
    let errIn: unknown = null;
    try {
      await runAsBackgroundJob(() => cron.getSubscriptionById(123));
    } catch (e) {
      errIn = e;
    }
    check(
      "el mismo cliente fuera del scope usa el presupuesto interactivo",
      errOut instanceof UpstreamTimeoutError &&
        errOut.ms === TIMINGS.attemptMs &&
        outside.total === 1,
      `fuera: ms=${errOut instanceof UpstreamTimeoutError ? errOut.ms : "?"} en ${outside.total} llamada(s) (esperado ${TIMINGS.attemptMs} y 1)`,
    );
    check(
      "y dentro del scope, el del cron con su reintento",
      errIn instanceof UpstreamTimeoutError &&
        errIn.ms === TIMINGS.cronAttemptMs &&
        inside.total === 2,
      `dentro: ms=${errIn instanceof UpstreamTimeoutError ? errIn.ms : "?"} en ${inside.total} llamada(s) (esperado ${TIMINGS.cronAttemptMs} y 2)`,
    );
  }

  // 5. Un interactivo con presupuesto DE SOBRA tampoco reintenta. Es el
  //    guardarraíl de verdad del defecto: lo que corta el reintento tiene que ser
  //    el scope, no que no quepa. Con ROOMY cabe holgadamente (900ms dentro de
  //    4000ms) y aun así debe hacer un único intento.
  {
    const st = stubFetch((_page, callNo) => (callNo === 1 ? "stall" : "ok"), () => jsonSubscription(123));
    let err: unknown = null;
    try {
      await interactiveRoomy.getSubscriptionById(123);
    } catch (e) {
      err = e;
    }
    check(
      "un interactivo con presupuesto de sobra sigue sin reintentar",
      err instanceof UpstreamTimeoutError && st.total === 1,
      `${st.total} llamada(s) (esperado 1), error=${err instanceof Error ? err.name : String(err)}`,
    );
  }

  // 6. Las mutaciones NUNCA se reintentan, tampoco ante un timeout: Seal
  //    regenera billing_attempts en cada escritura y un PUT repetido duplica.
  //    Se prueba DENTRO del scope de cron, que es donde el reintento sí existe.
  {
    const st = stubFetch(() => "stall", () => jsonSubscription(1));
    let err: unknown = null;
    try {
      await runAsBackgroundJob(() =>
        cron.editSubscription(123, { delivery_interval: "1 month" }),
      );
    } catch (e) {
      err = e;
    }
    check(
      "una mutación no se reintenta ante un timeout, ni siquiera en cron",
      err instanceof UpstreamTimeoutError && st.total === 1,
      `${st.total} llamada(s) (esperado 1), error=${err instanceof Error ? err.name : String(err)}`,
    );
  }

  // 7. Guardarraíl del defecto 3: un 429 previo NO se come el reintento del
  //    stall. Antes compartían contador, así que en la noche mixta (throttle +
  //    lentitud) el arreglo no llegaba a ejecutarse ni una vez.
  {
    const st = stubFetch(
      (_page, callNo) => (callNo === 1 ? "429" : callNo === 2 ? "stall" : "ok"),
      () => jsonSubscription(123),
    );
    const sub = await runAsBackgroundJob(() => cron.getSubscriptionById(123));
    check(
      "tras un 429, el stall siguiente todavía tiene su reintento",
      sub?.id === 123 && st.total === 3,
      `sub=${sub?.id ?? "null"} tras ${st.total} llamadas (esperado 123 y 3: 429 → stall → ok)`,
    );
  }

  // 8. El barrido no dispara más de POOL páginas a la vez. La presión en
  //    paralelo sobre este endpoint pesado es un disparador conocido: ~50
  //    páginas de golpe reventaron el rate limit de Seal el 2026-07-06.
  {
    const st = stubFetch(() => "ok", (page) => jsonPage(page, 10, [{ id: page }]));
    const subs = await runAsBackgroundJob(() => cron.listAllSubscriptions());
    check(
      "el barrido baja todas las páginas",
      subs.length === 10 && st.total === 10,
      `${subs.length} subs en ${st.total} llamadas`,
    );
    check(
      "y lanza exactamente POOL=8 en paralelo, ni más ni menos",
      st.maxInFlight === 8,
      `máximo ${st.maxInFlight} en vuelo (esperado 8: bajarlo alarga el barrido, subirlo aprieta a Seal)`,
    );
  }

  // 9. Guardarraíl: el reintento que YA existía (429) sigue funcionando.
  {
    const st = stubFetch((_page, callNo) => (callNo === 1 ? "429" : "ok"), (page) => jsonPage(page, 1, [{ id: page }]));
    const subs = await runAsBackgroundJob(() => cron.listAllSubscriptions());
    check(
      "un 429 transitorio se sigue reintentando",
      subs.length === 1 && st.total === 2,
      `${subs.length} sub(s) tras ${st.total} llamadas (esperado 1 y 2)`,
    );
  }

  // 10. Guardarraíl: un 4xx que no es 429 no se reintenta y propaga tipado.
  {
    let err: unknown = null;
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    try {
      await runAsBackgroundJob(() => cron.listAllSubscriptions());
    } catch (e) {
      err = e;
    }
    check(
      "un 404 propaga como SealApiError, sin reintentos",
      err instanceof SealApiError && err.status === 404,
      `error=${err instanceof SealApiError ? `SealApiError ${err.status}` : String(err)}`,
    );
  }

  // 11. EL DEFECTO 1, de frente: un barrido en el que TODAS las páginas responden
  //     bien no puede morir por el tope. La primera versión de este arreglo lo
  //     mataba (tope mal dimensionado + POOL a la mitad, que dobla las oleadas):
  //     20 páginas sanas y solo bajaban 9.
  {
    const healthy = new SealClient({ ...TIMINGS, sweepMs: 1_500 });
    const st = stubFetch(() => "ok", (page) => jsonPage(page, 20, [{ id: page }]), 200);
    let err: unknown = null;
    let subs: unknown[] = [];
    try {
      subs = await runAsBackgroundJob(() => healthy.listAllSubscriptions());
    } catch (e) {
      err = e;
    }
    check(
      "un barrido SANO de 20 páginas no lo mata el tope",
      err === null && subs.length === 20 && st.total === 20,
      `${subs.length}/20 subs en ${st.total} llamadas, error=${err instanceof Error ? err.message : "ninguno"}`,
    );
  }

  // 12. Y cuando el tope SÍ salta, lo dice con su nombre. La primera versión
  //     reusaba UpstreamTimeoutError y posteaba "seal timed out after 25000ms on
  //     ...&page=14" sobre una página que nunca se pidió: el de guardia se iba a
  //     depurar Seal en vez de mirar nuestro propio tope.
  {
    const tight = new SealClient({ ...TIMINGS, sweepMs: 1_000 });
    stubFetch(() => "ok", (page) => jsonPage(page, 20, [{ id: page }]), 200);
    let err: unknown = null;
    try {
      await runAsBackgroundJob(() => tight.listAllSubscriptions());
    } catch (e) {
      err = e;
    }
    const swept = err instanceof SealSweepTimeoutError ? err : null;
    check(
      "pasarse del tope lanza SealSweepTimeoutError, no un timeout de Seal",
      swept !== null,
      `lanzó ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
    check(
      "y el mensaje nombra el barrido y el avance, sin culpar a una página",
      swept !== null &&
        /sweep/i.test(swept.message) &&
        !/page=/.test(swept.message) &&
        swept.totalPages === 20 &&
        swept.pagesFetched >= 1 &&
        swept.pagesFetched < 20,
      swept ? `"${swept.message}"` : "no hubo SealSweepTimeoutError",
    );
  }

  // 13. El tope del barrido es SOLO de background. Un interactivo (hoy nadie,
  //     pero los scripts de mantenimiento sí) no debe verse cortado por él.
  {
    const noSweepScope = new SealClient({ ...ROOMY, sweepMs: 100 });
    const st = stubFetch(() => "ok", (page) => jsonPage(page, 20, [{ id: page }]), 200);
    let err: unknown = null;
    let subs: unknown[] = [];
    try {
      subs = await noSweepScope.listAllSubscriptions();
    } catch (e) {
      err = e;
    }
    check(
      "fuera del scope de cron no hay tope de barrido",
      err === null && subs.length === 20 && st.total === 20,
      `${subs.length}/20 subs, error=${err instanceof Error ? err.message : "ninguno"}`,
    );
  }

  // 14. El otro camino del tope: la oleada ya había arrancado y el reloj se
  //     acaba DEBAJO de ella. Ahí la página sí llega a pedirse, así que el error
  //     nativo es un timeout de Seal con una ventana truncada ("after 870ms") —
  //     verdadero sobre el socket y mentira sobre lo que falló. Tiene que salir
  //     igualmente re-etiquetado como tope del barrido.
  {
    const cutMidWave = new SealClient({ ...TIMINGS, sweepMs: 900 });
    stubFetch(
      (page) => (page === 1 ? "ok" : "stall"),
      (page) => jsonPage(page, 20, [{ id: page }]),
    );
    let err: unknown = null;
    try {
      await runAsBackgroundJob(() => cutMidWave.listAllSubscriptions());
    } catch (e) {
      err = e;
    }
    check(
      "una página cortada por el tope a media oleada también se re-etiqueta",
      err instanceof SealSweepTimeoutError && !/page=/.test(err.message),
      `lanzó ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
  }

  globalThis.fetch = realFetch;

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

/**
 * Qué de una pasada del cron de referidos merece un mensaje en #server-errors (26-oct-2026).
 *
 * Al canal solo va lo que pide que alguien mire algo (Kiko). Antes salía cada vez que se
 * daba de alta un código, que es el funcionamiento normal (cada suscriptor nuevo recibe el
 * suyo): seis mensajes en verde al día. Lo normal se queda en el log y en la respuesta.
 * Sale lo que falla, lo que pide revisión, lo que indica que la pasada no da abasto
 * (`deadline_left`, `apply_deferred_*`) y cualquier resultado que no esté en la lista de
 * normales: uno nuevo sale hasta que alguien lo clasifique.
 */

/**
 * Resultados normales. Recompensas (`runRewardSweep`): aplicada, adoptada, consumida,
 * revocada, caducada, quitada, reencolada y los no-op. Conversiones
 * (`qualifyPendingBacklog`): cualificada o rechazada. `retry` es un fallo pasajero que
 * reintenta la siguiente pasada.
 */
export const QUIET_SWEEP_OUTCOMES: ReadonlySet<string> = new Set([
  "applied",
  "adopted",
  "consumed",
  "revoked",
  "expired",
  "removed",
  "requeued",
  "noop",
  "not_pending",
  "already_closed",
  "retry",
  "qualified",
  "rejected",
]);

/** Las claves de la cuenta que piden mirar algo, como `k=v, k=v`; "" si ninguna. */
export function notableSweepOutcomes(tally: Record<string, number>): string {
  return Object.entries(tally)
    .filter(
      ([k, v]) =>
        v > 0 &&
        !QUIET_SWEEP_OUTCOMES.has(k) &&
        !k.startsWith("wait:") &&
        !k.startsWith("dry:") &&
        !k.startsWith("only_sub:"),
    )
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

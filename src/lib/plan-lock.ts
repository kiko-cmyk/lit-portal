import { ApiHttpError } from "./api-helpers";
import { runWithoutRequestDeadline } from "./http-timeout";
import { supabaseAdmin } from "./supabase";

/**
 * Cerrojo para el cambio de plan.
 *
 * `/api/subscription/plan` hace hasta tres mutaciones en Seal por petición y su única
 * defensa frente a la concurrencia era `expectedLineIds`, que es una comprobación
 * optimista: dos peticiones simultáneas leen el mismo estado, las dos lo encuentran
 * igual al esperado y las dos siguen. Resultado: `add_items` dos veces sobre las
 * mismas variantes, líneas duplicadas y el cliente pagando de más. Es el mismo daño
 * del incidente del 4-sep entrando por otra puerta, y basta un doble clic para
 * provocarlo.
 *
 * Implementado como fila con clave primaria y no como advisory lock porque la ruta
 * habla con Postgres por PostgREST: cada RPC sale por una conexión distinta del
 * pooler, así que un lock de sesión se tomaría en una conexión y se liberaría en
 * otra. Ver la migración 2026-09-04_plan_change_lock.sql.
 */

/**
 * Cuánto vive el cerrojo si nadie lo suelta.
 *
 * La ruta tiene 9,5s de presupuesto y por encima corre la compensación fuera de él
 * (reintento del remove, restore, intención de reparación). 30s cubre el peor caso
 * real con holgura y sigue siendo un bloqueo corto si una invocación muere sin
 * soltarlo. No se dimensiona sobre `maxDuration` (20s) porque el proceso puede morir
 * antes de que el runtime lo mate.
 */
const LOCK_TTL_SECONDS = 30;

export interface PlanLock {
  release: () => Promise<void>;
}

/**
 * Toma el cerrojo o lanza 409. `release()` es idempotente y no lanza nunca: si falla
 * el borrado, el `expires_at` lo recoge igual.
 *
 * IMPORTANTE: llamar SIEMPRE a `release()` en un `finally`. Un cerrojo que no se
 * suelta no es fatal (caduca), pero deja al cliente esperando hasta 30s.
 */
export async function acquirePlanLock(
  customerId: string,
  sealSubscriptionId: number | string,
  holder?: string,
): Promise<PlanLock> {
  const subId = String(sealSubscriptionId);
  // Fuera del presupuesto de la petición: el cerrojo se toma al principio, cuando
  // sobra tiempo, pero se SUELTA al final, cuando el presupuesto puede estar agotado
  // y `fetchDeadline` abortaría la llamada al instante. Si el release se abortara, el
  // cliente se quedaría bloqueado hasta el TTL sin motivo.
  const { data, error } = await runWithoutRequestDeadline(async () =>
    supabaseAdmin().rpc("plan_change_try_lock", {
      p_customer_id: customerId,
      p_subscription_id: subId,
      p_ttl_seconds: LOCK_TTL_SECONDS,
      p_holder: holder ?? null,
    }),
  );

  if (error) {
    // No se puede tomar el cerrojo. Se DEJA PASAR a propósito, con un log: la
    // alternativa es que un fallo de Supabase deje a todo el mundo sin poder cambiar
    // de plan, y la carrera que esto cierra necesita dos peticiones simultáneas sobre
    // la misma suscripción, que es raro. Degradar al comportamiento de ayer es peor
    // que ayer solo si además hay concurrencia justo en ese momento.
    console.warn(`[plan-lock] no se pudo tomar el cerrojo (se deja pasar): ${error.message}`);
    return { release: async () => {} };
  }

  // La función devuelve true si lo ganó, y nada (null) si la fila viva era de otro.
  if (data !== true) {
    throw new ApiHttpError(
      409,
      "plan_change_in_progress",
      "Another change to this subscription is still being applied; try again in a moment",
    );
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await runWithoutRequestDeadline(async () =>
          supabaseAdmin().rpc("plan_change_unlock", {
            p_customer_id: customerId,
            p_subscription_id: subId,
          }),
        );
      } catch (e) {
        // No es fatal: `expires_at` lo recoge en LOCK_TTL_SECONDS.
        console.warn(
          `[plan-lock] no se pudo soltar el cerrojo de ${subId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}

import { ApiHttpError } from "@/lib/api-helpers";
import { alertSlackErrorAwaited } from "@/lib/alert";
import { runWithoutRequestDeadline } from "@/lib/http-timeout";
import { klaviyo } from "@/lib/klaviyo";
import { sealWriteDefinitelyRejected } from "@/lib/line-repair";
import { assertNoPendingLineRepair } from "@/lib/line-repair-runner";
import { acquirePlanLock } from "@/lib/plan-lock";
import { findAppliedDiscountCodeId, getNextBillingAttempt, seal, type SealSubscription } from "@/lib/seal";
import { supabaseAdmin } from "@/lib/supabase";
import type { CancellationReason } from "@/lib/types";

/**
 * El 15 % «a la desesperada» de la baja, compartido por sus dos puertas (27-oct-2026):
 *
 *   - el paso «descuento» del asistente de baja del área personal
 *     (`/api/subscription/retention-discount`, CancelTakeover), y
 *   - el bot de WhatsApp de Permut, a través de lit-webhooks
 *     (`/api/internal/subscription/retention-discount`).
 *
 * Una sola copia de las guardas de Juan y del camino de dinero. Si el bot llevara la suya,
 * un cliente podría llevarse dos 15 % (uno por cada puerta) y la retirada tras el primer cobro
 * (`lib/retention-discount`, webhook de Seal + barrido diario) no vería el que no dejara fila.
 * El código (LITSTAY15) es el mismo, y la fila de `retention_discounts` también.
 */

export function retentionDiscountCode(): string {
  return process.env.RETENTION_DISCOUNT_CODE ?? "LITSTAY15";
}

const REASONS: readonly CancellationReason[] = [
  "too_expensive",
  "too_much_product",
  "not_using_enough",
  "taking_a_break",
  "dont_like",
  "other",
];

/**
 * La fecha (YYYY-MM-DD) del próximo cobro pendiente, o null: la del «tu próximo LIT» al que
 * se le aplica el 15 %. Es el mismo filtro que el resto del portal (`getNextBillingAttempt`).
 */
export function nextChargeDateOf(sub: SealSubscription): string | null {
  const date = getNextBillingAttempt(sub)?.date;
  return date ? date.slice(0, 10) : null;
}

/** El motivo tal y como lo guarda `retention_discounts.reason`: uno de la lista, o `other`. */
export function normalizeRetentionReason(raw: unknown): CancellationReason | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const r = String(raw).trim() as CancellationReason;
  return REASONS.includes(r) ? r : "other";
}

/**
 * Guardas (Juan): solo en la PRIMERA baja del cliente, y solo UNA vez en su vida
 * (`retention_discounts.customer_id` es la clave primaria). Así el descuento no se puede
 * «cosechar» cancelando una y otra vez. Lanzan 409 `already_used` / `not_first_cancel`.
 */
export async function assertRetentionDiscountAllowed(customerId: string): Promise<void> {
  const sb = supabaseAdmin();

  // Si una lectura falla, NO se deja pasar (Juan, 28-oct-2026): la de una vez por cliente la
  // sostiene además la clave primaria al reservar, pero la de la primera baja no, y el bot
  // ofrecería el 15 % a ciegas. 503 `guard_unavailable`: el bot no lo ofrece y avisa.

  // ── Guardrail 1: once ever per customer. ──
  const { data: existing, error: usedErr } = await sb
    .from("retention_discounts")
    .select("customer_id")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (usedErr) {
    throw new ApiHttpError(503, "guard_unavailable", `Could not check retention_discounts: ${usedErr.message}`);
  }
  if (existing) {
    throw new ApiHttpError(409, "already_used", "Retention discount already used for this customer");
  }

  // ── Guardrail 2: only on the FIRST cancellation (never cancelled before). ──
  const { data: prefs, error: prefsErr } = await sb
    .from("customer_preferences")
    .select("cancel_count")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (prefsErr) {
    throw new ApiHttpError(503, "guard_unavailable", `Could not check customer_preferences: ${prefsErr.message}`);
  }
  if ((prefs?.cancel_count ?? 0) >= 1) {
    throw new ApiHttpError(409, "not_first_cancel", "Retention discount is only offered on the first cancellation");
  }
}

export interface ApplyRetentionDiscountArgs {
  customerId: string;
  /** La suscripción YA resuelta y comprobada por quien llama (dueño, estado). */
  sub: SealSubscription;
  email: string | null;
  reason?: string | null;
  /** La ruta que llama, para las alertas. */
  path: string;
  /** Qué puerta lo pide, para Klaviyo. El bot va como `whatsapp_bot`, igual que sabor, frecuencia,
   *  dirección y salto: todo lo del bot se cuenta con un solo filtro (Juan, 28-oct-2026). */
  source: "portal" | "whatsapp_bot";
}

/**
 * Aplica el código en Seal con su fila de seguimiento. Quien llama ya pasó las guardas
 * (`assertRetentionDiscountAllowed`); la reserva de la fila las vuelve a hacer cumplir en
 * la base (23505 → `already_used`) si dos peticiones llegan a la vez.
 */
export async function applyRetentionDiscount(
  args: ApplyRetentionDiscountArgs,
): Promise<{ applied: true; code: string; discountCodeId: string | null }> {
  const { customerId, sub, email, reason, path, source } = args;
  const CODE = retentionDiscountCode();
  const sb = supabaseAdmin();

  // El cerrojo de los cambios de plan (27-oct-2026): un cambio de sabor o de cajas en esos
  // mismos segundos (por el área personal o por el bot) lee `retention_discounts` una sola vez y
  // cambia las líneas; si el 15 % entra a la vez, puede caer en la línea que se quita y quedar
  // invisible. Con el cerrojo, uno espera al otro (409 `plan_change_in_progress`).
  const lock = await acquirePlanLock(customerId, sub.id, "retention-discount");
  let discountCodeId: string | null = null;
  try {
    // Con un cambio de plan a medio aplicar no se pone el 15% (14-oct-2026): Seal lo pondría
    // en todas las líneas, también en las que hay que quitar, y quien termine el cambio
    // tendría que soltarlo y reponerlo por encima.
    await assertNoPendingLineRepair(customerId, sub.id, "retention-discount");

    // Una sola fila viva por suscripción (27-oct-2026): con dos `pending_charge` sobre la misma sub,
    // el retirador (`.maybeSingle()` en lib/retention-discount) no ve ninguna y el 15 % se quedaría
    // en todos los cobros. La clave por cliente ya lo impide si la sub y la sesión son del mismo
    // cliente; esto lo cierra también si algún día no lo fueran.
    const { data: livePerSub } = await sb
      .from("retention_discounts")
      .select("customer_id")
      .eq("seal_subscription_id", String(sub.id))
      .eq("status", "pending_charge")
      .limit(1);
    if (livePerSub && livePerSub.length) {
      throw new ApiHttpError(409, "already_used", "A retention discount is already pending on this subscription");
    }

    // ── Reserve the once-per-customer slot BEFORE applying. This guarantees the
    //    webhook can always find + remove the code after the first charge (no
    //    apply-without-tracking → no accidental recurring discount). ──
    const ins = await sb
      .from("retention_discounts")
      .insert({
        customer_id: customerId,
        seal_subscription_id: String(sub.id),
        code: CODE,
        status: "pending_charge",
        reason: reason ?? null,
      });
    if (ins.error) {
      // 23505 = someone raced us to the single slot → already used.
      if (ins.error.code === "23505") {
        throw new ApiHttpError(409, "already_used", "Retention discount already used for this customer");
      }
      throw new Error(`retention_discounts insert failed: ${ins.error.message}`);
    }

    // ── Apply the code in Seal. ──
    try {
      await seal.applyDiscountCode(sub.id, CODE);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[retention-discount] apply failed for sub ${sub.id}: ${msg}`);
      // UN FALLO NO ES "NO SE APLICÓ" (14-oct-2026). Antes, cualquier error borraba la fila de
      // seguimiento para no gastarle al cliente su única oportunidad. Pero si fue un timeout y
      // Seal SÍ lo aplicó, el 15% quedaba puesto sin fila: el webhook y el barrido solo quitan
      // los que siguen, así que se descontaba en TODOS los cobros, para siempre y sin rastro.
      if (sealWriteDefinitelyRejected(e)) {
        // Seal dijo que no: no se aplicó. Se libera la reserva para que pueda reintentarlo.
        await sb
          .from("retention_discounts")
          .delete()
          .eq("customer_id", customerId)
          .eq("seal_subscription_id", String(sub.id));
        throw new ApiHttpError(409, "discount_apply_failed", msg);
      }
      const seen = await seal.getSubscriptionById(sub.id).catch(() => null);
      const seenId = seen ? findAppliedDiscountCodeId(seen, CODE) : null;
      if (!seenId) {
        // No se ve, pero puede entrar tarde. La fila SE QUEDA: si el código aparece, se quita
        // tras su cobro como cualquier otro; si no aparece, lo cierra el barrido. A una
        // persona, para que lo mire, y al cliente que no lo repita.
        // Esperada (27-oct-2026): avisa y después lanza, y en una función serverless la variante
        // sin esperar puede no salir nunca (ver lib/alert). En el área personal es lo único que le
        // dice a una persona que mire.
        // Del bot (29-oct-2026), no avisa: le dice al cliente «Lo revisamos nosotros» y lo sigue
        // `check_bot_writes` en lit-tools, que mira en Seal y en el pedido del cobro y abre tarea en
        // LIT Tasks y ticket de Zendesk para Antonio. El aviso repetía ese mismo caso.
        if (source !== "whatsapp_bot") {
          await runWithoutRequestDeadline(() =>
            alertSlackErrorAwaited({
            path,
            code: `retention_apply_unknown:${sub.id}`,
            msg: `sub ${sub.id}: no se sabe si ${CODE} se aplicó (${msg}). La fila de seguimiento se mantiene. Comprobar en Seal en unos minutos que el código está UNA vez, o que no está y avisar al cliente.`,
            customerId,
          }),
          );
        }
        throw new ApiHttpError(409, "discount_apply_unconfirmed", msg);
      }
      console.warn(`[retention-discount] apply "failed" but ${CODE} is on sub ${sub.id}: treated as applied`);
    }

    // ── Capture the applied code's UUID for a clean webhook removal (best-effort;
    //    the webhook falls back to matching by code string if this is null). ──
    const fresh = await seal.getSubscriptionById(sub.id).catch(() => null);
    discountCodeId = fresh ? findAppliedDiscountCodeId(fresh, CODE) : null;
    if (discountCodeId) {
      await sb
        .from("retention_discounts")
        .update({ discount_code_id: discountCodeId, updated_at: new Date().toISOString() })
        .eq("customer_id", customerId);
    }

    // Fire-and-forget analytics.
    if (email) {
      klaviyo
        .trackEvent("retention_discount_accepted", email, {
          sealSubscriptionId: String(sub.id),
          code: CODE,
          reason: reason ?? undefined,
          source,
        })
        .catch((err) => console.warn("[retention-discount] klaviyo event failed:", err));
    }
  } finally {
    await lock.release();
  }

  return { applied: true, code: CODE, discountCodeId };
}

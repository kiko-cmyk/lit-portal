import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { referralsEnabledFor } from "@/lib/flags";
import { klaviyo } from "@/lib/klaviyo";
import { enforceRateLimit } from "@/lib/rate-limit";
import { shopifyAdmin } from "@/lib/shopify-admin";

const CHANNELS = new Set(["copy", "whatsapp", "native"]);

/**
 * POST /apps/portal/api/referral/track — «ha compartido su código».
 *
 * Solo para medir el KPI de la fase 0 (qué parte de los suscriptores comparte su
 * código, y por dónde). Guarda el CANAL y nada más: ni a quién ni qué texto.
 * Fire-and-forget desde la tarjeta: un fallo aquí no le importa al cliente.
 */
export const POST = withCustomer<{ ok: true }>(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "referral-track", { limit: 20, windowMs: 60_000 });
  if (!referralsEnabledFor(ctx.customerId)) return { ok: true };

  const body = (await req.json().catch(() => ({}))) as { channel?: string };
  const channel = String(body.channel ?? "");
  if (!CHANNELS.has(channel)) throw new ApiHttpError(400, "invalid_channel", "channel must be copy | whatsapp | native");

  const email = await shopifyAdmin.getCustomerEmail(ctx.customerId);
  if (email) {
    await klaviyo
      .trackEvent("referral_shared", email, { channel }, { externalId: ctx.customerId })
      .catch((e) => console.warn("[referral/track] klaviyo falló:", e instanceof Error ? e.message : String(e)));
  }
  return { ok: true };
});

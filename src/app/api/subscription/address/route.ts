import { after, type NextRequest } from "next/server";

import {
  assertBeforeCutoff,
  assertWriteBudget,
  normalizeAddress,
  reportAddressSaveFailure,
  syncShopifyDefaultAddress,
  validateAddressInput,
  writeAddress,
  type AddressAttempt,
  type AddressInput,
} from "@/lib/address-core";
import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { runWithoutRequestDeadline, runWithRequestDeadline } from "@/lib/http-timeout";
import { enforceRateLimit } from "@/lib/rate-limit";
import { mapToSubscription, seal } from "@/lib/seal";
import { shopifyAdmin } from "@/lib/shopify-admin";
import type { AppProxyContext } from "@/lib/shopify-app-proxy";
import { assertSubscriptionBelongsToCustomer } from "@/lib/sub-guard";
import { resolveActiveSubFast } from "@/lib/sub-resolve";

/**
 * Hard ceiling for this route. The default is 60s (vercel.json), which is 6x
 * longer than Shopify's App Proxy will wait: past ~10s the customer has already
 * been handed storefront HTML, so the remaining ~50s are spent on a request
 * nobody is listening to, invisible in every channel we watch. 20s leaves room
 * for the upstream budgets in lib/http-timeout.ts plus the `after()` sync while
 * bounding the invisible tail.
 *
 * This used to say the same ceiling was deliberately NOT applied to /plan or
 * /cancel, because chaining Seal mutations makes an early kill worse than a
 * slow request, and per-call deadlines were protection enough. Incident
 * 2026-09-04 disproved the second half: per-call budgets never bound the sum,
 * so /plan was killed anyway at Vercel's 60s, between add_items and
 * remove_items, leaving three subscriptions holding both line sets. /plan now
 * carries its own request deadline, made safe by a repair intent written before
 * the swap. /cancel still relies on per-call deadlines alone.
 */
export const maxDuration = 20;

/**
 * How long the read phase may take before we refuse to write at all. Kept just
 * under the App Proxy's ~10s so a save either completes where the customer can
 * see it, or does not happen.
 */
const PROXY_BUDGET_MS = 8_500;

/**
 * Wall-clock budget for the whole request, shared by every upstream call.
 *
 * Without it the per-call budgets still add up past the proxy: rate limiter
 * (Supabase 5s) + customer email (Shopify 9s) + subscription (Seal 9s) ≈ 23s,
 * and at ~10s the customer already has storefront HTML and reads
 * `gateway_timeout` — the very error this whole thread started with. With it,
 * the last call in the chain only gets the time that is actually left, so a
 * stall surfaces as a typed, alerted 503 BEFORE the proxy gives up. Set just
 * under the proxy's patience, and above PROXY_BUDGET_MS so the read guard below
 * is what normally stops a doomed save, not an abort mid-write.
 */
const REQUEST_BUDGET_MS = 9_500;

type AddressBody = AddressInput & {
  sealSubscriptionId?: number | string; // multi-sub: which sub to update (optional)
};

/**
 * PATCH /apps/portal/api/subscription/address
 *
 * Source of truth: Seal. We update Seal's s_* fields directly. Seal
 * generates the shipping label on the next billing attempt, so this
 * is what actually drives where the box gets sent.
 *
 * Best-effort: also sync the Shopify customer's default address so
 * future one-off storefront orders use the same address. If the
 * Shopify SubscriptionContract is active and present, we sync that
 * too. If it's cancelled / missing (e.g. after a Seal-direct
 * reactivate that didn't restore the Shopify contract), we just skip
 * that sync — Seal is enough for the subscription box.
 *
 * History (audit 2026-05-22 rewrite):
 *   - Pre-2026-05-13: Seal-only. Worked.
 *   - 2026-05-13: rewrote to Shopify-only, claiming Seal silently no-op'd.
 *     That claim was wrong for the address fields (probed 2026-05-22:
 *     Seal happily accepts s_* edits if you send all required fields,
 *     incl. s_first_name, s_last_name, s_country).
 *   - 2026-05-22: back to Seal-primary, Shopify-sync best-effort.
 *     Fixes Juan's `subscription_not_found` after a cancel+reactivate.
 */
export const PATCH = withCustomer((req, ctx) =>
  runWithRequestDeadline(REQUEST_BUDGET_MS, () => patchAddress(req, ctx)),
);

const PATH = "/api/subscription/address";

/**
 * Envoltorio que hace VISIBLE un guardado que no llega a escribirse.
 *
 * Las salidas más probables de esta ruta cuando algo va mal (`seal_busy` con
 * Seal saturado, `subscription_not_found`) devuelven un error al cliente y no
 * avisan a nadie, así que un cliente que no puede cambiar su dirección era
 * exactamente igual de silencioso que uno que sí puede. Ver
 * `reportAddressSaveFailure`, que decide qué merece aviso y qué no.
 *
 * El aviso va en `after()`: se manda con la respuesta ya fuera, así no le suma
 * latencia a un guardado que ya ha ido mal, y Next mantiene viva la invocación
 * hasta que sale (`after` corre también cuando el handler lanza). Y en
 * `runWithoutRequestDeadline` por el mismo motivo que el sync de Shopify: para
 * entonces el presupuesto de la petición está gastado por definición.
 */
async function patchAddress(
  req: NextRequest,
  ctx: AppProxyContext & { customerId: string },
) {
  const attempt: AddressAttempt = { path: PATH, customerId: ctx.customerId };
  try {
    return await savePatchAddress(req, ctx, attempt);
  } catch (err) {
    after(() => runWithoutRequestDeadline(() => reportAddressSaveFailure(attempt, err)));
    throw err;
  }
}

async function savePatchAddress(
  req: NextRequest,
  ctx: AppProxyContext & { customerId: string },
  attempt: AddressAttempt,
) {
  const startedAt = Date.now();
  await enforceRateLimit(ctx.customerId, "address", { limit: 10, windowMs: 60_000 });

  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) throw new ApiHttpError(404, "customer_not_found", `No email for ${ctx.customerId}`);

  const body = (await req.json().catch(() => ({}))) as AddressBody;
  // Antes de validar: si el fallo salta aquí, el aviso todavía puede decir a
  // dónde se quería mandar la caja.
  attempt.postalCode = body.postalCode;
  attempt.city = body.city;
  validateAddressInput(body);

  // Fast-path: resolve via the cached Seal id (1 quick call). Falls back to
  // the full email scan on a cache miss. The old scan-first approach (twice
  // over) was the source of the intermittent "subscription_not_found" and the
  // lag Juan hit when saving an address. For resilience the fallback also
  // accepts the most recent sub (lets you edit a re-activated sub even if Seal
  // hasn't promoted its status yet).
  const subSel = url.searchParams.get("seal_subscription_id") ?? body.sealSubscriptionId;
  let sealSub = await resolveActiveSubFast(ctx.customerId, email, subSel);
  if (!sealSub && subSel) {
    throw new ApiHttpError(404, "subscription_not_found", `No subscription ${subSel}`);
  }
  if (!sealSub) {
    const sealSubs = await seal.getSubscriptionsByEmail(email);
    sealSub =
      sealSubs.find((s) => s.status === "ACTIVE") ??
      sealSubs.sort((a, b) => b.order_placed.localeCompare(a.order_placed))[0] ??
      null;
  }
  if (!sealSub) {
    // Por id, no por email: este mensaje viaja a Slack en el aviso de fallo y el
    // id es lo que cruza con Shopify de todas formas.
    throw new ApiHttpError(
      404,
      "subscription_not_found",
      `No Seal subscription for customer ${ctx.customerId}`,
    );
  }
  attempt.sealSubscriptionId = sealSub.id;
  assertSubscriptionBelongsToCustomer(sealSub, email, "subscription/address");

  // Cutoff against the next billing attempt date (Seal's, since Seal is
  // source of truth for this flow).
  assertBeforeCutoff(sealSub);

  // Rellena lo que Seal exige y deriva la provincia del CP. Ver address-core.
  const addr = normalizeAddress(body, sealSub);

  // Deadline guard. Everything above is reads; the write starts here. Shopify's
  // App Proxy stops waiting at ~10s and hands the customer storefront HTML,
  // which the FE reports as `gateway_timeout` — so a write that lands after that
  // point succeeds INVISIBLY: her address changes while she reads "no se pudo
  // guardar" and writes to support. Refusing to start the write is the honest
  // outcome: retrying is safe and cheap, an untracked silent success is not.
  assertWriteBudget(startedAt, PROXY_BUDGET_MS, PATH, ctx.customerId);

  // Sin `verify`: la relectura es tolerante y nunca convierte en error un
  // guardado que sí ocurrió. Aquí hay una persona mirando la pantalla, y las
  // esperas que exige verificar se comerían el margen del App Proxy. La entrada
  // máquina a máquina sí verifica, que allí no mira nadie. Ver address-core.
  const { appliesFrom, refreshed } = await writeAddress(sealSub, addr);

  // Sync the Shopify customer default address (drives one-off storefront
  // orders, not the subscription box). Runs via `after()` so it is NOT
  // fire-and-forget: a bare floating promise on serverless can be killed the
  // moment the response is flushed, which is how `customerAddressCreate` can
  // land while the follow-up `customerDefaultAddressUpdate` never runs, leaving
  // an orphan address that is not the default. `after()` keeps the invocation
  // alive until it settles, and still never blocks the customer's response.
  after(() =>
    // Outside the request deadline on purpose: this runs after the response is
    // flushed, when that budget is spent by definition, and an inherited
    // exhausted deadline would abort the sync instantly.
    runWithoutRequestDeadline(() =>
      syncShopifyDefaultAddress(ctx.customerId, addr, PATH),
    ),
  );

  return {
    updated: true,
    appliesFrom,
    subscription: refreshed ? mapToSubscription(refreshed, ctx.customerId) : null,
  };
}

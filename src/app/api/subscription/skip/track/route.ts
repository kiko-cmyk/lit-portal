import { isDryRunRequest, withCustomer } from "@/lib/api-helpers";
import { klaviyo, type KlaviyoEvent } from "@/lib/klaviyo";
import { enforceRateLimit } from "@/lib/rate-limit";
import { shopifyAdmin } from "@/lib/shopify-admin";

// POST /apps/portal/api/subscription/skip/track
//
// Lightweight analytics endpoint for the skip retention flow. The Klaviyo
// private key is server-side, so the FE fires its funnel events through here:
//   - skip_flow_started: the customer opened the skip flow (denominator for the
//     save rate; captures the reason chip when picked).
//   - skip_retained: the customer chose to adjust (frequency/boxes) instead of
//     skipping — the "save" (numerator).
// The actual skip is still tracked server-side by /api/subscription/skip
// (subscription_skip), so this endpoint only handles the two funnel events.
//
// Events are whitelisted (no arbitrary metric injection) and suppressed in
// dry-run so local "simulación" testing never pollutes Klaviyo.
const ALLOWED_EVENTS: KlaviyoEvent[] = ["skip_flow_started", "skip_retained"];

export const POST = withCustomer<{ tracked: boolean }>(async (req, ctx) => {
  await enforceRateLimit(ctx.customerId, "skip-track", { limit: 30, windowMs: 60_000 });

  const body = (await req.json().catch(() => ({}))) as {
    event?: string;
    properties?: Record<string, unknown>;
    dryRun?: boolean;
  };

  const event = body.event as KlaviyoEvent | undefined;
  if (!event || !ALLOWED_EVENTS.includes(event)) {
    return { tracked: false };
  }

  // Simulación: don't fire test events into the real Klaviyo account.
  if (isDryRunRequest(req, body)) {
    console.log("[skip-track] dry-run, skipping klaviyo", { event });
    return { tracked: false };
  }

  const url = new URL(req.url);
  const devEmail = process.env.NODE_ENV === "development" ? url.searchParams.get("__dev_email") : null;
  const email = devEmail ?? (await shopifyAdmin.getCustomerEmail(ctx.customerId));
  if (!email) return { tracked: false };

  await klaviyo
    .trackEvent(event, email, { ...(body.properties ?? {}) })
    .catch((err) => console.warn("[skip-track] klaviyo event failed:", err));

  return { tracked: true };
});

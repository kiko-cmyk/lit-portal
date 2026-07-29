/**
 * Klaviyo client for LIT.
 *
 * Used for:
 *   - trackEvent: fires custom events that Klaviyo flows can pick up
 *     (tier_unlocked, reward_claimed, winback_d14, winback_d30, confirmation_sent,
 *     first_login_completed)
 *   - upsertProfile: updates profile properties (language_pref, whatsapp_opt_in,
 *     drops_balance, tier_earned)
 *
 * API revision: 2024-10-15. See reference_klaviyo_credentials.md.
 */

const KLAVIYO_API_BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";

function key(): string {
  const k = process.env.KLAVIYO_PRIVATE_API_KEY;
  if (!k) throw new Error("KLAVIYO_PRIVATE_API_KEY not set");
  return k;
}

export type KlaviyoEvent =
  | "tier_unlocked"
  | "reward_claimed"
  | "winback_d14"
  | "winback_d30"
  | "confirmation_sent"
  | "first_login_completed"
  | "subscription_cancelled"
  | "retention_discount_accepted"
  | "subscription_reactivated"
  | "subscription_skip"
  | "skip_flow_started"
  | "skip_retained"
  | "subscription_charge_now"
  | "subscription_renewal_reminder"
  | "drops_earned"
  | "email_change_requested"
  // Dunning (2026-07-28). Fired from the Seal webhook when a charge fails, on
  // the FIRST failure of each cycle — see lib/dunning.ts. Seal retries 4 times
  // and then auto-cancels, so this is the trigger that has to beat Seal's own
  // email to the inbox.
  | "payment_failed"
  // Fired when Seal reports a subscription paused. The PAUSE button was removed
  // from Seal's customer portal on 2026-07-28, so new pauses should be rare;
  // the event exists so the 86 already-paused customers can be walked back into
  // the portal to resume.
  | "subscription_paused"
  | "subscription_resumed";

// Transient-failure retry budget. Klaviyo throttles /events/ (429) and can 5xx
// under load; without a retry a single hiccup on a high-volume day (e.g. the
// renewal-reminder spike) silently drops that profile's event and the daily
// crons can't recover it (their window has moved on). trackEvent/upsertProfile
// are effectively idempotent (event ingestion + profile upsert), so retrying is
// safe. We retry 429/5xx and network errors only; other 4xx fail fast.
const KLAVIYO_MAX_RETRIES = 3;
const KLAVIYO_BACKOFF_MS = 400;
const klaviyoSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class KlaviyoClient {
  private async req<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
    try {
      const res = await fetch(`${KLAVIYO_API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Klaviyo-API-Key ${key()}`,
          revision: REVISION,
          accept: "application/vnd.api+json",
          "content-type": "application/vnd.api+json",
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        if (attempt < KLAVIYO_MAX_RETRIES && (res.status === 429 || res.status >= 500)) {
          await klaviyoSleep(KLAVIYO_BACKOFF_MS * (attempt + 1));
          return this.req<T>(path, init, attempt + 1);
        }
        const body = await res.text().catch(() => "");
        throw new Error(`Klaviyo ${res.status}: ${body}`);
      }
      // 202 / 204 returns may have empty body
      if (res.status === 202 || res.status === 204) return undefined as T;
      return res.json() as Promise<T>;
    } catch (err) {
      // fetch() itself rejected (network/DNS/reset). Retry — but never retry an
      // HTTP error we already chose not to retry above, nor a caller abort.
      const name = (err as { name?: string }).name;
      const isHttpError = err instanceof Error && err.message.startsWith("Klaviyo ");
      if (attempt < KLAVIYO_MAX_RETRIES && !isHttpError && name !== "AbortError") {
        await klaviyoSleep(KLAVIYO_BACKOFF_MS * (attempt + 1));
        return this.req<T>(path, init, attempt + 1);
      }
      throw err;
    }
  }

  /**
   * Fire a custom event for a profile (identified by email). Klaviyo flows
   * triggered by `metric=event_name` will fan out from here.
   */
  async trackEvent(
    event: KlaviyoEvent,
    email: string,
    properties: Record<string, unknown> = {},
  ): Promise<void> {
    await this.req("/events/", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "event",
          attributes: {
            properties,
            metric: { data: { type: "metric", attributes: { name: event } } },
            profile: { data: { type: "profile", attributes: { email } } },
          },
        },
      }),
    });
  }

  /**
   * Upsert profile properties — used to sync language pref, opt-ins, drops
   * balance, tier status to Klaviyo for use in flow logic and email merge tags.
   */
  async upsertProfile(
    email: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await this.req("/profile-import/", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "profile",
          attributes: {
            email,
            properties,
          },
        },
      }),
    });
  }
}

export const klaviyo = new KlaviyoClient();

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
  | "subscription_reactivated"
  | "subscription_skip"
  | "subscription_charge_now"
  | "subscription_renewal_reminder"
  | "drops_earned"
  | "email_change_requested";

class KlaviyoClient {
  private async req<T>(path: string, init?: RequestInit): Promise<T> {
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
      const body = await res.text().catch(() => "");
      throw new Error(`Klaviyo ${res.status}: ${body}`);
    }
    // 202 / 204 returns may have empty body
    if (res.status === 202 || res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
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

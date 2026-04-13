// Klaviyo integration for LIT Portal magic link emails

const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY || '';
const KLAVIYO_API_URL = 'https://a.klaviyo.com/api';

export async function sendMagicLinkEmail(email: string, magicLink: string): Promise<boolean> {
  if (!KLAVIYO_API_KEY) {
    console.error('[Klaviyo] KLAVIYO_PRIVATE_API_KEY not configured');
    return false;
  }

  try {
    const response = await fetch(`${KLAVIYO_API_URL}/events/`, {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15',
      },
      body: JSON.stringify({
        data: {
          type: 'event',
          attributes: {
            metric: {
              data: {
                type: 'metric',
                attributes: {
                  name: 'Portal Magic Link Requested',
                },
              },
            },
            profile: {
              data: {
                type: 'profile',
                attributes: {
                  email: email.toLowerCase(),
                },
              },
            },
            properties: {
              magic_link: magicLink,
              requested_at: new Date().toISOString(),
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Klaviyo] Error sending magic link event: ${response.status} ${errorText}`);
      return false;
    }

    console.log(`[Klaviyo] Magic link event sent for ${email}`);
    return true;
  } catch (error) {
    console.error('[Klaviyo] Failed to send magic link event:', error);
    return false;
  }
}

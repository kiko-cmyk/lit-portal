const KLAVIYO_COMPANY_ID = 'TFtcEn';

export async function sendKlaviyoEvent(
  eventName: string,
  email: string,
  properties: Record<string, unknown> = {}
) {
  try {
    await fetch(`https://a.klaviyo.com/client/events/?company_id=${KLAVIYO_COMPANY_ID}`, {
      method: 'POST',
      headers: {
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
                attributes: { name: eventName },
              },
            },
            profile: {
              data: {
                type: 'profile',
                attributes: { email: email.toLowerCase() },
              },
            },
            properties,
          },
        },
      }),
    });
  } catch (error) {
    console.error(`[Klaviyo] Event ${eventName} error:`, error);
  }
}

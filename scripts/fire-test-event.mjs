/**
 * Fire a test `confirmation_sent` event so the metric appears in Klaviyo
 * and Juan can build the flow against it.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
if (!KEY) throw new Error("KLAVIYO_PRIVATE_API_KEY not set");

const body = {
  data: {
    type: "event",
    attributes: {
      properties: {
        order_number: "TEST-PHASE1",
        box_count: 1,
        sachets: 30,
        plan_label: "1 box · every 1 month",
        flavor: "Lemon Drop",
        ship_date: "May 12",
        delivery_date: "May 14",
        first_name: "Phase1Test",
        total: "28.35",
        currency: "EUR",
      },
      metric: { data: { type: "metric", attributes: { name: "confirmation_sent" } } },
      profile: { data: { type: "profile", attributes: { email: "juan@litsalt.com" } } },
    },
  },
};

const r = await fetch("https://a.klaviyo.com/api/events/", {
  method: "POST",
  headers: {
    Authorization: `Klaviyo-API-Key ${KEY}`,
    revision: "2024-10-15",
    accept: "application/vnd.api+json",
    "content-type": "application/vnd.api+json",
  },
  body: JSON.stringify(body),
});

if (r.status === 202) {
  console.log("✓ Test event fired. Metric 'confirmation_sent' should appear in Klaviyo within ~30s.");
} else {
  console.error(`HTTP ${r.status}:`, await r.text());
  process.exit(1);
}

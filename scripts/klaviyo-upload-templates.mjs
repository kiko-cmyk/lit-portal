/**
 * One-shot: upload the Confirmation email template to Klaviyo via API.
 * Adapts the hi-fi HTML from designs/mobile/lit-confirmation-hifi/index.html:
 *   - Strips scenario picker + language toggle UI (dev tools)
 *   - Strips JS scenarios (Klaviyo handles variants via flow conditional logic)
 *   - Injects merge tags for dynamic values (first_name, plan, flavor, ship date)
 *   - Single EN version for now; ES variant can be a separate template or
 *     same template gated by profile.language property.
 *
 * Run: node scripts/klaviyo-upload-templates.mjs
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
if (!KEY) throw new Error("KLAVIYO_PRIVATE_API_KEY not set");
const REVISION = "2024-10-15";
const API = "https://a.klaviyo.com/api";

const TEMPLATES = [
  {
    name: "LIT — Confirmation Email (post-checkout)",
    html: confirmationEmailHtml(),
  },
];

async function upsertTemplate({ name, html }) {
  // Look up existing by name to update instead of duplicating
  const list = await fetch(`${API}/templates/?filter=equals(name,"${encodeURIComponent(name)}")`, {
    headers: {
      Authorization: `Klaviyo-API-Key ${KEY}`,
      revision: REVISION,
      accept: "application/vnd.api+json",
    },
  }).then((r) => r.json());

  const existing = list.data?.[0];
  const body = {
    data: {
      type: "template",
      attributes: {
        name,
        editor_type: "CODE",
        html,
        text: "Plain text version coming soon. Open in HTML mode.",
      },
    },
  };

  if (existing) {
    body.data.id = existing.id;
    const r = await fetch(`${API}/templates/${existing.id}/`, {
      method: "PATCH",
      headers: {
        Authorization: `Klaviyo-API-Key ${KEY}`,
        revision: REVISION,
        accept: "application/vnd.api+json",
        "content-type": "application/vnd.api+json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.error("PATCH failed", r.status, await r.text());
      throw new Error("template patch failed");
    }
    console.log(`✓ Updated existing template "${name}" (id: ${existing.id})`);
    return existing.id;
  } else {
    const r = await fetch(`${API}/templates/`, {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${KEY}`,
        revision: REVISION,
        accept: "application/vnd.api+json",
        "content-type": "application/vnd.api+json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.error("POST failed", r.status, await r.text());
      throw new Error("template create failed");
    }
    const json = await r.json();
    console.log(`✓ Created template "${name}" (id: ${json.data.id})`);
    return json.data.id;
  }
}

for (const t of TEMPLATES) {
  await upsertTemplate(t);
}

console.log("\nDone. Templates available in Klaviyo dashboard → Email → Templates.");
console.log("\nNext: build flows in the dashboard with these templates as the email step.");
console.log("See docs/KLAVIYO_SETUP.md for the 6 flows to create.");

// ============================================================
// Email HTML — adapted from designs/mobile/lit-confirmation-hifi
// EN-only for MVP; merge tags for dynamic content.
// ============================================================

function confirmationEmailHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LIT — Welcome</title>
<style>
  body { margin: 0; padding: 0; background: #e6e6e4; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #323743; -webkit-font-smoothing: antialiased; }
  .viewport { padding: 40px 20px 60px; }
  .mail-frame { width: 100%; max-width: 600px; margin: 0 auto; background: #E9EBDE; border-radius: 8px; overflow: hidden; }
  .email-header-bar { padding: 32px 40px 16px; display: flex; justify-content: space-between; align-items: center; }
  .email-logo { font-weight: 900; font-size: 24px; letter-spacing: 0.08em; color: #323743; font-family: 'Arial Black', 'Helvetica Neue', sans-serif; }
  .email-order-num { font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 700; color: #7A746A; }
  .hero { padding: 20px 40px 40px; }
  .hero-kicker { font-size: 10px; letter-spacing: 0.35em; text-transform: uppercase; font-weight: 700; color: #7A746A; margin-bottom: 18px; }
  .hero-big { font-weight: 900; font-size: 88px; line-height: 0.82; letter-spacing: -0.045em; color: #323743; text-transform: uppercase; margin-bottom: 14px; font-family: 'Arial Black', 'Helvetica Neue', sans-serif; }
  .hero-big .dot { color: #EBEE62; }
  .hero-welcome { font-weight: 900; font-size: 20px; letter-spacing: -0.01em; color: #7A746A; text-transform: uppercase; font-family: 'Arial Black', 'Helvetica Neue', sans-serif; }
  .order-card { background: #F8F9F2; border-radius: 14px; margin: 0 40px 24px; padding: 26px; }
  .oc-lead { font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; font-weight: 700; color: #7A746A; margin-bottom: 10px; }
  .oc-head { font-weight: 900; font-size: 30px; line-height: 1; color: #323743; text-transform: uppercase; margin-bottom: 20px; font-family: 'Arial Black', 'Helvetica Neue', sans-serif; }
  .oc-meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding-top: 18px; border-top: 1px solid rgba(50, 55, 67, 0.06); }
  .oc-meta-label { font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; font-weight: 700; color: #7A746A; margin-bottom: 4px; }
  .oc-meta-val { font-weight: 900; font-size: 18px; color: #323743; text-transform: uppercase; font-family: 'Arial Black', 'Helvetica Neue', sans-serif; }
  .section { padding: 0 40px; margin-bottom: 32px; }
  .section-eyebrow { font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; font-weight: 700; color: #7A746A; margin-bottom: 14px; }
  .science { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .science-stat { background: #F8F9F2; border-radius: 10px; padding: 20px 12px; text-align: center; }
  .sci-num { font-weight: 900; font-size: 28px; color: #323743; margin-bottom: 4px; font-family: 'Arial Black', 'Helvetica Neue', sans-serif; }
  .sci-unit { font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; font-weight: 700; color: #7A746A; margin-bottom: 8px; }
  .sci-sub { font-size: 11px; color: #7A746A; line-height: 1.3; }
  .cta-section { padding: 0 40px 32px; text-align: center; }
  .cta-btn { display: inline-block; background: #323743; color: #EBEE62; padding: 18px 36px; font-size: 12px; font-weight: 900; letter-spacing: 0.2em; text-transform: uppercase; text-decoration: none; border-radius: 4px; margin-bottom: 18px; }
  .cta-secondary { display: block; color: #323743; font-size: 13px; font-weight: 700; padding: 10px; }
  .reward-chip { display: inline-block; font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 900; padding: 3px 7px; background: #EBEE62; color: #323743; border-radius: 2px; margin-left: 6px; vertical-align: middle; }
  .email-footer { padding: 30px 40px 36px; background: #F8F9F2; text-align: center; }
  .footer-mark { font-weight: 900; font-size: 13px; letter-spacing: 0.35em; color: #7A746A; text-transform: uppercase; margin-bottom: 16px; font-family: 'Arial Black', 'Helvetica Neue', sans-serif; }
  .footer-meta { font-size: 11px; color: #7A746A; line-height: 1.7; }
  .footer-meta a { color: #323743; text-decoration: underline; }
  .footer-address { font-size: 10px; color: #B5AE9F; margin-top: 12px; }
</style>
</head>
<body>
<div class="viewport">
  <div class="mail-frame">
    <div class="email-header-bar">
      <div class="email-logo">LIT</div>
      <div class="email-order-num">Order #{{ event.order_number|default:"—" }}</div>
    </div>
    <div class="hero">
      <div class="hero-kicker">Confirmed</div>
      <h1 class="hero-big">YOU'RE<br>IN<span class="dot">.</span></h1>
      <div class="hero-welcome">Welcome, {{ first_name|default:"friend" }}.</div>
    </div>

    <div class="order-card">
      <div class="oc-lead">Your subscription</div>
      <h2 class="oc-head">{{ event.box_count|default:1 }} BOX{% if event.box_count > 1 %}ES{% endif %} · {{ event.sachets|default:30 }} SACHETS</h2>
      <div class="oc-meta-grid">
        <div>
          <div class="oc-meta-label">Flavor</div>
          <div class="oc-meta-val">{{ event.flavor|default:"Lemon Drop" }}</div>
        </div>
        <div>
          <div class="oc-meta-label">Plan</div>
          <div class="oc-meta-val">{{ event.plan_label|default:"1 box · every 1 month" }}</div>
        </div>
        <div>
          <div class="oc-meta-label">Ships</div>
          <div class="oc-meta-val">{{ event.ship_date|default:"Soon" }}</div>
        </div>
        <div>
          <div class="oc-meta-label">Lands around</div>
          <div class="oc-meta-val">{{ event.delivery_date|default:"In a few days" }}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-eyebrow">What's in a sachet</div>
      <div class="science">
        <div class="science-stat"><div class="sci-num">1,000</div><div class="sci-unit">MG</div><div class="sci-sub">Electrolytes</div></div>
        <div class="science-stat"><div class="sci-num">0</div><div class="sci-unit">G</div><div class="sci-sub">Sugar. Ever.</div></div>
        <div class="science-stat"><div class="sci-num">72</div><div class="sci-unit">TRACE</div><div class="sci-sub">Minerals from sea salt</div></div>
      </div>
    </div>

    <div class="cta-section">
      <a class="cta-btn" href="https://litsalt.com/apps/portal/your-lit">Open Your LIT Account</a>
      <a class="cta-secondary" href="https://litsalt.com/apps/portal/your-lit">
        Turn on WhatsApp updates <span class="reward-chip">+50 DROPS</span>
      </a>
    </div>

    <div class="email-footer">
      <div class="footer-mark">Stay LIT.</div>
      <div class="footer-meta">
        Questions?
        <a href="mailto:hello@litsalt.com">Contact us</a> ·
        <a href="https://litsalt.com/apps/portal/account">Manage preferences</a> ·
        <a href="{% unsubscribe %}">Unsubscribe</a>
      </div>
      <div class="footer-address">LIT · Madrid, España</div>
    </div>
  </div>
</div>
</body>
</html>`;
}

/**
 * One-shot: upload the Phase 1 Confirmation email template to Klaviyo.
 *
 * Adapts the Phase 1 hi-fi HTML (designs/fase-1/LIT-Post-Purchase-Mobile-EN-ES.html)
 * to a Klaviyo-friendly version:
 *   - Strips dev tooling (scenario picker, language toggle UI)
 *   - Uses Klaviyo merge tags for dynamic content
 *   - EN-only base; ES variant rendered via Klaviyo conditional content using
 *     `person.language_pref` profile property (set from /api/first-login/language
 *     and /api/customer/language)
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
  const list = await fetch(
    `${API}/templates/?filter=equals(name,"${encodeURIComponent(name)}")`,
    {
      headers: {
        Authorization: `Klaviyo-API-Key ${KEY}`,
        revision: REVISION,
        accept: "application/vnd.api+json",
      },
    },
  ).then((r) => r.json());

  const existing = list.data?.[0];
  const body = {
    data: {
      type: "template",
      attributes: { name, html, text: "Open in HTML mode for the full design." },
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
    if (!r.ok) throw new Error(`PATCH ${r.status}: ${await r.text()}`);
    console.log(`✓ Updated template "${name}" (id: ${existing.id})`);
    return existing.id;
  } else {
    // POST requires editor_type; PATCH rejects it
    const postBody = {
      ...body,
      data: { ...body.data, attributes: { ...body.data.attributes, editor_type: "CODE" } },
    };
    const r = await fetch(`${API}/templates/`, {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${KEY}`,
        revision: REVISION,
        accept: "application/vnd.api+json",
        "content-type": "application/vnd.api+json",
      },
      body: JSON.stringify(postBody),
    });
    if (!r.ok) throw new Error(`POST ${r.status}: ${await r.text()}`);
    const json = await r.json();
    console.log(`✓ Created template "${name}" (id: ${json.data.id})`);
    return json.data.id;
  }
}

for (const t of TEMPLATES) {
  await upsertTemplate(t);
}

console.log("\nDone. Use this template in your Klaviyo flows.");
console.log("Build the flow at https://www.klaviyo.com/flows.");

// ============================================================
// Phase 1 confirmation email HTML
// ============================================================

function confirmationEmailHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>You're in.</title>
<style>
  body { margin: 0; padding: 0; background: #e6e6e4; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #323743; -webkit-font-smoothing: antialiased; }
  .frame { width: 100%; max-width: 600px; margin: 40px auto 60px; background: #E9EBDE; border-radius: 8px; overflow: hidden; }
  .header { padding: 32px 40px 16px; display: flex; justify-content: space-between; align-items: center; }
  .logo { font-weight: 900; font-size: 24px; letter-spacing: 0.08em; color: #323743; font-family: 'Arial Black', sans-serif; }
  .order-num { font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 700; color: #7A746A; }
  .hero { padding: 20px 40px 40px; }
  .kicker { font-size: 10px; letter-spacing: 0.35em; text-transform: uppercase; font-weight: 700; color: #7A746A; margin-bottom: 18px; }
  .big { font-weight: 900; font-size: 88px; line-height: 0.82; letter-spacing: -0.045em; color: #323743; text-transform: uppercase; margin: 0 0 14px; font-family: 'Arial Black', sans-serif; }
  .big .dot { color: #EBEE62; }
  .welcome { font-weight: 900; font-size: 20px; letter-spacing: -0.01em; color: #7A746A; text-transform: uppercase; font-family: 'Arial Black', sans-serif; }
  .order-card { background: #F8F9F2; border-radius: 14px; margin: 0 40px 24px; padding: 26px; }
  .lead { font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; font-weight: 700; color: #7A746A; margin-bottom: 10px; }
  .head { font-weight: 900; font-size: 30px; line-height: 1; color: #323743; text-transform: uppercase; margin: 0 0 20px; font-family: 'Arial Black', sans-serif; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding-top: 18px; border-top: 1px solid rgba(50,55,67,0.06); }
  .label { font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; font-weight: 700; color: #7A746A; margin-bottom: 4px; }
  .val { font-weight: 900; font-size: 18px; color: #323743; text-transform: uppercase; font-family: 'Arial Black', sans-serif; }
  .section { padding: 0 40px; margin-bottom: 32px; }
  .eyebrow { font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; font-weight: 700; color: #7A746A; margin-bottom: 14px; }
  .nutri { background: #F8F9F2; border-radius: 14px; padding: 22px; }
  .nutri-row { display: flex; justify-content: space-between; align-items: baseline; padding: 10px 0; border-bottom: 1px solid rgba(50,55,67,0.06); }
  .nutri-row:last-child { border-bottom: none; }
  .nutri-name { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 700; color: #323743; }
  .nutri-val { font-weight: 900; font-size: 18px; color: #323743; font-family: 'Arial Black', sans-serif; }
  .nutri-unit { font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: #7A746A; margin-left: 4px; }
  .cta-section { padding: 0 40px 32px; text-align: center; }
  .cta-btn { display: inline-block; background: #323743; color: #EBEE62; padding: 18px 36px; font-size: 12px; font-weight: 900; letter-spacing: 0.2em; text-transform: uppercase; text-decoration: none; border-radius: 4px; }
  .footer { padding: 30px 40px 36px; background: #F8F9F2; text-align: center; }
  .mark { font-weight: 900; font-size: 13px; letter-spacing: 0.35em; color: #7A746A; text-transform: uppercase; margin-bottom: 16px; font-family: 'Arial Black', sans-serif; }
  .meta { font-size: 11px; color: #7A746A; line-height: 1.7; }
  .meta a { color: #323743; text-decoration: underline; }
</style>
</head>
<body>
<div class="frame">
  <div class="header">
    <div class="logo">LIT</div>
    <div class="order-num">{% if person.language_pref == "es" %}Pedido{% else %}Order{% endif %} #{{ event.order_number|default:"—" }}</div>
  </div>

  <div class="hero">
    <div class="kicker">{% if person.language_pref == "es" %}Confirmado{% else %}Confirmed{% endif %}</div>
    <h1 class="big">
      {% if person.language_pref == "es" %}ESTÁS<br>DENTRO{% else %}YOU'RE<br>IN{% endif %}<span class="dot">.</span>
    </h1>
    <div class="welcome">
      {% if person.language_pref == "es" %}Bienvenida, {{ first_name|default:"" }}.{% else %}Welcome, {{ first_name|default:"" }}.{% endif %}
    </div>
  </div>

  <div class="order-card">
    <div class="lead">{% if person.language_pref == "es" %}Tu suscripción{% else %}Your subscription{% endif %}</div>
    <h2 class="head">
      {{ event.box_count|default:1 }} {% if event.box_count > 1 %}{% if person.language_pref == "es" %}CAJAS{% else %}BOXES{% endif %}{% else %}{% if person.language_pref == "es" %}CAJA{% else %}BOX{% endif %}{% endif %}
      ·
      {{ event.sachets|default:30 }} {% if person.language_pref == "es" %}SOBRES{% else %}SACHETS{% endif %}
    </h2>
    <div class="meta-grid">
      <div>
        <div class="label">{% if person.language_pref == "es" %}Sabor{% else %}Flavor{% endif %}</div>
        <div class="val">{{ event.flavor|default:"Lemon Drop" }}</div>
      </div>
      <div>
        <div class="label">{% if person.language_pref == "es" %}Plan{% else %}Plan{% endif %}</div>
        <div class="val">{{ event.plan_label|default:"" }}</div>
      </div>
      <div>
        <div class="label">{% if person.language_pref == "es" %}Sale{% else %}Ships{% endif %}</div>
        <div class="val">{{ event.ship_date|default:"Soon" }}</div>
      </div>
      <div>
        <div class="label">{% if person.language_pref == "es" %}Llega{% else %}Lands{% endif %}</div>
        <div class="val">{{ event.delivery_date|default:"Soon" }}</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="eyebrow">{% if person.language_pref == "es" %}Qué lleva un sobre{% else %}What's in a sachet{% endif %}</div>
    <div class="nutri">
      <div class="nutri-row">
        <span class="nutri-name">{% if person.language_pref == "es" %}Sodio{% else %}Sodium{% endif %}</span>
        <span><span class="nutri-val">1,000</span><span class="nutri-unit">MG</span></span>
      </div>
      <div class="nutri-row">
        <span class="nutri-name">{% if person.language_pref == "es" %}Potasio{% else %}Potassium{% endif %}</span>
        <span><span class="nutri-val">200</span><span class="nutri-unit">MG</span></span>
      </div>
      <div class="nutri-row">
        <span class="nutri-name">{% if person.language_pref == "es" %}Magnesio{% else %}Magnesium{% endif %}</span>
        <span><span class="nutri-val">60</span><span class="nutri-unit">MG</span></span>
      </div>
      <div class="nutri-row">
        <span class="nutri-name">{% if person.language_pref == "es" %}Azúcar{% else %}Sugar{% endif %}</span>
        <span><span class="nutri-val">0</span><span class="nutri-unit">G</span></span>
      </div>
    </div>
  </div>

  <div class="cta-section">
    <a class="cta-btn" href="https://litsalt.com/apps/portal/your-lit">
      {% if person.language_pref == "es" %}Abrir tu cuenta LIT{% else %}Open your LIT account{% endif %}
    </a>
  </div>

  <div class="footer">
    <div class="mark">Stay LIT.</div>
    <div class="meta">
      {% if person.language_pref == "es" %}¿Preguntas? <a href="mailto:hello@litsalt.com">Escríbenos</a> · <a href="https://litsalt.com/apps/portal/account">Preferencias</a> · <a href="{% unsubscribe %}">Darme de baja</a>{% else %}Questions? <a href="mailto:hello@litsalt.com">Contact us</a> · <a href="https://litsalt.com/apps/portal/account">Preferences</a> · <a href="{% unsubscribe %}">Unsubscribe</a>{% endif %}
    </div>
    <div style="font-size: 10px; color: #B5AE9F; margin-top: 12px;">LIT · Madrid · 2026</div>
  </div>
</div>
</body>
</html>`;
}

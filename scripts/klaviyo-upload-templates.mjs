/**
 * Phase 1 — upload TWO confirmation email templates (EN + ES) to Klaviyo.
 *
 * Design fidelity: matches Diane's hi-fi (2026-05-11) — meta header bar,
 * massive Clash Display headlines, yellow square period, burgundy box visual,
 * tan nutritional block, dark crew photo section, yellow full-width CTA.
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

const EN = {
  htmlLang: "en",
  subject: "You're in. Here's what's coming.",
  preheader: "First box ships {{ event.ship_date|default:'soon' }}. Order #{{ event.order_number|default:'—' }}.",
  orderLabelTop: "ORDER #LIT-{{ event.order_number|default:'00000' }}",
  kicker: "CONFIRMED",
  heroL1: "YOU'RE",
  heroL2: "IN",
  welcome: 'Welcome, {{ first_name|default:"friend" }}. Your first box lands around {{ event.delivery_date|default:"soon" }}.',
  subLabel: "YOUR SUBSCRIPTION",
  planLabel: "PLAN",
  planValue: '{{ event.box_count|default:1 }} BOX · {{ event.plan_label|default:"" }}',
  flavorLabel: "FLAVOR",
  flavorValue: '{{ event.flavor|default:"Salty Lemon" }}',
  shipsLabel: "SHIPS",
  shipsValue: '{{ event.ship_date|default:"Soon" }}',
  landsLabel: "LANDS",
  landsValue: '~{{ event.delivery_date|default:"Soon" }}',
  nutriSodium: "SODIUM",
  nutriPotassium: "POTASSIUM",
  nutriMagnesium: "MAGNESIUM",
  crewKicker: "— MY ACCOUNT",
  crewL1: "ACCESS",
  crewL2: "YOUR ACCOUNT",
  crewSub: "+10,000 people. Community. Hydration.",
  cta: "OPEN MY LIT",
  ctaUrl: "https://litsalt.com/apps/portal/my-lit",
  // Footer: solo JOIN THE LIT MOVEMENT (per Juan 2026-05-20).
  footerUnsubscribe: "Unsubscribe",
  footerPreferences: "Preferences",
};

const ES = {
  htmlLang: "es",
  subject: "Estás dentro. Esto es lo que viene.",
  preheader: "Primera caja sale el {{ event.ship_date|default:'pronto' }}. Pedido #{{ event.order_number|default:'—' }}.",
  orderLabelTop: "PEDIDO #LIT-{{ event.order_number|default:'00000' }}",
  kicker: "CONFIRMADO",
  heroL1: "ESTÁS",
  heroL2: "DENTRO",
  welcome: 'Te damos la bienvenida, {{ first_name|default:"" }}. Tu primera caja llega sobre el {{ event.delivery_date|default:"pronto" }}.',
  subLabel: "TU SUSCRIPCIÓN",
  planLabel: "PLAN",
  planValue: '{{ event.box_count|default:1 }} CAJA · {{ event.plan_label|default:"" }}',
  flavorLabel: "SABOR",
  flavorValue: '{{ event.flavor|default:"Salty Lemon" }}',
  shipsLabel: "SALE",
  shipsValue: '{{ event.ship_date|default:"Pronto" }}',
  landsLabel: "ATERRIZA",
  landsValue: '~{{ event.delivery_date|default:"Pronto" }}',
  nutriSodium: "SODIO",
  nutriPotassium: "POTASIO",
  nutriMagnesium: "MAGNESIO",
  crewKicker: "— ÁREA PERSONAL",
  crewL1: "ACCEDE",
  crewL2: "A TU CUENTA",
  crewSub: "+10.000 personas. Comunidad. Hidratación.",
  cta: "ENTRAR A MI LIT",
  ctaUrl: "https://litsalt.com/apps/portal/mi-lit",
  // Footer: solo JOIN THE LIT MOVEMENT (per Juan 2026-05-20).
  footerUnsubscribe: "Cancelar suscripción",
  footerPreferences: "Preferencias",
};

function emailHtml(lang) {
  const t = lang === "es" ? ES : EN;
  return `<!DOCTYPE html>
<html lang="${t.htmlLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t.subject}</title>
<link href="https://api.fontshare.com/v2/css?f[]=clash-display@700,900&f[]=satoshi@500,700,900&display=swap" rel="stylesheet">
<style>
  body { margin: 0; padding: 0; background: #E9EBDE; font-family: 'Satoshi', 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #323743; -webkit-font-smoothing: antialiased; }
  .frame { width: 100%; max-width: 640px; margin: 0 auto; background: #E9EBDE; }

  /* Logo + order */
  .logo-bar { display: flex; justify-content: space-between; align-items: center; padding: 36px 32px 12px; }
  .logo-img { height: 32px; width: auto; display: block; }
  .order-top { font-size: 10px; letter-spacing: 0.18em; font-weight: 900; color: #7A746A; }

  /* Hero */
  .hero { padding: 8px 32px 24px; }
  .kicker-row { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  .kicker-line { width: 36px; height: 2px; background: #EBEE62; }
  .kicker-text { font-size: 11px; letter-spacing: 0.25em; font-weight: 900; color: #323743; }
  .hero-h1 { font-family: 'Clash Display', 'Arial Black', sans-serif; font-weight: 900; font-size: 92px; line-height: 0.85; letter-spacing: -0.04em; color: #323743; text-transform: uppercase; margin: 0; }
  .yellow-square { display: inline-block; width: 28px; height: 28px; background: #EBEE62; vertical-align: bottom; margin-left: 4px; margin-bottom: 8px; }
  .welcome { font-size: 14px; color: #323743; line-height: 1.5; margin-top: 22px; }

  /* Subscription card */
  .sub-card { background: #F8F9F2; margin: 8px 32px 0; padding: 26px 24px; border-radius: 4px; }
  .sub-label { font-size: 10px; letter-spacing: 0.22em; font-weight: 900; color: #323743; text-transform: uppercase; margin-bottom: 18px; }
  .sub-grid { width: 100%; }
  .sub-grid td { padding: 0 0 18px 0; vertical-align: top; }
  .grid-key { font-size: 10px; letter-spacing: 0.18em; font-weight: 700; color: #7A746A; text-transform: uppercase; margin-bottom: 6px; }
  .grid-val { font-family: 'Clash Display', 'Arial Black', sans-serif; font-weight: 900; font-size: 18px; color: #323743; text-transform: uppercase; letter-spacing: -0.01em; }
  .sub-divider { border-top: 1px dashed rgba(50,55,67,0.25); margin: 4px 0 22px; }
  .box-visual { display: inline-block; background: #8B2640; width: 62px; height: 62px; position: relative; border-radius: 2px; }
  .box-num { position: absolute; bottom: 6px; left: 50%; transform: translateX(-50%); font-family: 'Clash Display', 'Arial Black', sans-serif; font-weight: 900; font-size: 9px; color: #E9EBDE; letter-spacing: 0.15em; }

  /* Nutritional facts */
  .nutri { background: #CFBFAD; margin: 18px 32px 0; padding: 30px 24px; border-radius: 4px; }
  .nutri-grid { width: 100%; }
  .nutri-cell { display: inline-block; width: 32%; vertical-align: top; }
  .nutri-num { font-family: 'Clash Display', 'Arial Black', sans-serif; font-weight: 900; font-size: 38px; color: #323743; line-height: 1; letter-spacing: -0.02em; }
  .nutri-unit { font-size: 11px; font-weight: 700; color: #7A746A; vertical-align: top; margin-left: 1px; }
  .nutri-name { font-size: 10px; letter-spacing: 0.22em; font-weight: 700; color: #7A746A; text-transform: uppercase; margin-top: 8px; }

  /* Crew photo block */
  .crew { background: #1A1726; background-image: linear-gradient(180deg, rgba(15,14,26,0.25) 0%, rgba(15,14,26,0.85) 100%); position: relative; margin: 22px 32px 0; padding: 70px 24px 28px; border-radius: 4px; min-height: 340px; }
  .crew-kicker { font-size: 11px; letter-spacing: 0.25em; font-weight: 900; color: #EBEE62; margin-bottom: 16px; }
  .crew-h1 { font-family: 'Clash Display', 'Arial Black', sans-serif; font-weight: 900; font-size: 50px; line-height: 0.9; letter-spacing: -0.03em; color: #E9EBDE; text-transform: uppercase; margin: 0; }
  .crew-h1 .ysq { display: inline-block; width: 14px; height: 14px; background: #EBEE62; vertical-align: bottom; margin-left: 2px; margin-bottom: 6px; }
  .crew-sub { font-size: 13px; line-height: 1.55; color: rgba(245,240,221,0.85); margin-top: 18px; }

  /* CTA */
  .cta-wrap { padding: 22px 32px; }
  .cta-btn { display: block; width: 100%; background: #EBEE62; color: #323743; text-align: center; padding: 22px 0; font-family: 'Clash Display', 'Arial Black', sans-serif; font-weight: 900; font-size: 13px; letter-spacing: 0.22em; text-transform: uppercase; text-decoration: none; border-radius: 4px; }

  /* Footer is rendered as inline-styled <table>s (brand standard from
     /brand/email-assets/footer.html) — no .footer CSS classes needed
     since Klaviyo / email clients prefer inline styles for safety. */
</style>
</head>
<body>
<div class="frame">

  <!-- Logo + order -->
  <div class="logo-bar">
    <img src="https://litsalt.com/cdn/shop/t/31/assets/lit-logo-dark-indigo.png" alt="LIT" class="logo-img" width="auto" height="32">
    <div class="order-top">${t.orderLabelTop}</div>
  </div>

  <!-- Hero -->
  <div class="hero">
    <div class="kicker-row"><span class="kicker-line"></span><span class="kicker-text">${t.kicker}</span></div>
    <h1 class="hero-h1">${t.heroL1}<br>${t.heroL2}<span class="yellow-square"></span></h1>
    <p class="welcome">${t.welcome}</p>
  </div>

  <!-- Subscription card -->
  <div class="sub-card">
    <div class="sub-label">${t.subLabel}</div>
    <table class="sub-grid" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td width="50%">
          <div class="grid-key">${t.planLabel}</div>
          <div class="grid-val">${t.planValue}</div>
        </td>
        <td width="50%">
          <div class="grid-key">${t.flavorLabel}</div>
          <div class="grid-val">${t.flavorValue}</div>
        </td>
      </tr>
      <tr>
        <td>
          <div class="grid-key">${t.shipsLabel}</div>
          <div class="grid-val">${t.shipsValue}</div>
        </td>
        <td>
          <div class="grid-key">${t.landsLabel}</div>
          <div class="grid-val">${t.landsValue}</div>
        </td>
      </tr>
    </table>
    <div class="sub-divider"></div>
    <div class="box-visual"><div class="box-num">01</div></div>
  </div>

  <!-- Nutritional -->
  <div class="nutri">
    <table class="nutri-grid" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td width="33%" valign="top">
          <div><span class="nutri-num">500</span><span class="nutri-unit">mg</span></div>
          <div class="nutri-name">${t.nutriSodium}</div>
        </td>
        <td width="33%" valign="top">
          <div><span class="nutri-num">150</span><span class="nutri-unit">mg</span></div>
          <div class="nutri-name">${t.nutriPotassium}</div>
        </td>
        <td width="33%" valign="top">
          <div><span class="nutri-num">60</span><span class="nutri-unit">mg</span></div>
          <div class="nutri-name">${t.nutriMagnesium}</div>
        </td>
      </tr>
    </table>
  </div>

  <!-- Crew section -->
  <div class="crew">
    <div class="crew-kicker">${t.crewKicker}</div>
    <h2 class="crew-h1">${t.crewL1}<br>${t.crewL2}<span class="ysq"></span></h2>
    <p class="crew-sub">${t.crewSub}</p>
  </div>

  <!-- CTA -->
  <div class="cta-wrap">
    <a class="cta-btn" href="${t.ctaUrl}">${t.cta}</a>
  </div>

  <!-- Footer: solo JOIN THE LIT MOVEMENT bar (per Juan 2026-05-20). -->
  <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="max-width:480px;margin:0 auto;">
    <tr>
      <td style="background:#323743;padding:24px 0 20px;text-align:center;">
        <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto;">
          <tr>
            <td style="font-family:'Barlow',Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:#ebee62;letter-spacing:2px;line-height:1;mso-line-height-rule:exactly;vertical-align:middle;padding-right:8px;white-space:nowrap;">JOIN THE</td>
            <td style="vertical-align:middle;">
              <img alt="LIT" src="https://d3k81ch9hvuctc.cloudfront.net/company/TFtcEn/images/54dcff58-73a9-459a-87cc-d0e1c1fc7c8f.png" width="60"/>
            </td>
            <td style="font-family:'Barlow',Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:#ebee62;letter-spacing:2px;line-height:1;mso-line-height-rule:exactly;vertical-align:middle;padding-left:8px;white-space:nowrap;">MOVEMENT</td>
          </tr>
        </table>
        <p style="font-family:'Barlow',Arial,Helvetica,sans-serif;font-size:8px;font-weight:400;color:#888;margin:12px 0 0;line-height:1.5;mso-line-height-rule:exactly;letter-spacing:0;">
          LIT Hydration&reg; &mdash; Superior Hydration<br/>
          {% unsubscribe '${t.footerUnsubscribe}' %} &middot; {% manage_preferences '${t.footerPreferences}' %}
        </p>
      </td>
    </tr>
  </table>

</div>
</body>
</html>`;
}

const TEMPLATES = [
  { name: "LIT — Confirmation Email EN", html: emailHtml("en") },
  { name: "LIT — Confirmation Email ES", html: emailHtml("es") },
];

async function upsertTemplate({ name, html }) {
  // Paginate ALL templates and find by exact name match. The filter
  // query syntax was unreliable, hence client-side filtering.
  const allTemplates = [];
  let cursor = null;
  do {
    const url = new URL(`${API}/templates/`);
    url.searchParams.set("page[size]", "10");
    if (cursor) url.searchParams.set("page[cursor]", cursor);
    const r = await fetch(url, {
      headers: {
        Authorization: `Klaviyo-API-Key ${KEY}`,
        revision: REVISION,
        accept: "application/vnd.api+json",
      },
    });
    if (!r.ok) throw new Error(`LIST ${r.status}: ${await r.text()}`);
    const data = await r.json();
    allTemplates.push(...(data.data || []));
    cursor = data.links?.next
      ? new URL(data.links.next).searchParams.get("page[cursor]")
      : null;
  } while (cursor);

  const existing = allTemplates.find((t) => t.attributes?.name === name);
  const baseAttrs = { name, html, text: "Open in HTML mode for the full design." };

  if (existing) {
    const r = await fetch(`${API}/templates/${existing.id}/`, {
      method: "PATCH",
      headers: {
        Authorization: `Klaviyo-API-Key ${KEY}`,
        revision: REVISION,
        accept: "application/vnd.api+json",
        "content-type": "application/vnd.api+json",
      },
      body: JSON.stringify({
        data: { type: "template", id: existing.id, attributes: baseAttrs },
      }),
    });
    if (!r.ok) throw new Error(`PATCH ${r.status}: ${await r.text()}`);
    console.log(`✓ Updated "${name}" (id: ${existing.id})`);
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
      body: JSON.stringify({
        data: { type: "template", attributes: { ...baseAttrs, editor_type: "CODE" } },
      }),
    });
    if (!r.ok) throw new Error(`POST ${r.status}: ${await r.text()}`);
    const json = await r.json();
    console.log(`✓ Created "${name}" (id: ${json.data.id})`);
    return json.data.id;
  }
}

for (const t of TEMPLATES) {
  await upsertTemplate(t);
}

console.log("\n✓ Templates updated with Diane's hi-fi design.");
console.log("  Re-fire test event: node scripts/fire-test-event.mjs");

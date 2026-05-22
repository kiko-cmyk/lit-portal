#!/usr/bin/env python3
"""Build PORTAL_LIT_DOC.html with embedded LIT logo as base64."""
import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # LIT-AGENTS
LOGO = ROOT / "brand" / "logos" / "BRISKY-OFF-WHITE.png"
OUT = Path(__file__).resolve().parent / "PORTAL_LIT_DOC.html"

logo_b64 = base64.b64encode(LOGO.read_bytes()).decode()
logo_uri = f"data:image/png;base64,{logo_b64}"

HTML = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Portal LIT — Documentación técnica</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;500;600;700;800;900&family=Barlow+Condensed:wght@500;600;700;800;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --lit-grey:   #323743;
    --lit-grey-2: #1F2330;
    --cream:      #F8F9F2;
    --yellow:     #EBEE62;
    --yellow-2:   #D4D850;
    --warm:       #757575;
    --white:      #FFFFFF;
    --gray-50:    #FAFAF6;
    --gray-100:   #F3F4ED;
    --gray-200:   #E5E7DA;
    --gray-300:   #D1D3C5;
    --gray-400:   #9CA0A8;
    --gray-500:   #6B7280;
    --gray-600:   #4B5563;
    --gray-700:   #374151;
    --gray-800:   #1F2937;
    --gray-900:   #111827;
    --red:        #DC2626;
    --amber:      #F59E0B;
    --blue:       #2563EB;
    --green:      #16A34A;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'Barlow', sans-serif;
    background: var(--gray-100);
    color: var(--gray-800);
    font-size: 9.5pt;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  @page { size: A4; margin: 0; }

  /* Force each .page to exactly fill one A4 sheet */
  .page {
    width: 210mm;
    height: 297mm;
    margin: 0 auto;
    background: var(--white);
    overflow: hidden;
    position: relative;
    page-break-after: always;
    page-break-inside: avoid;
  }
  .page:last-child { page-break-after: auto; }

  .page-inner {
    padding: 17mm 20mm 14mm 20mm;
    height: 100%;
    position: relative;
  }
  .page:not(.cover):not(.thankyou)::after {
    content: '';
    position: absolute;
    top: 0; bottom: 0; left: 0;
    width: 4px;
    background: linear-gradient(180deg, var(--yellow) 0%, var(--lit-grey) 100%);
  }

  /* ─── HEADER ─── */
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    padding-bottom: 9px;
    border-bottom: 2px solid var(--lit-grey);
  }
  .page-header-left h2 {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 16pt;
    font-weight: 800;
    color: var(--lit-grey);
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: 0.01em;
  }
  .page-header-left .subtitle {
    font-size: 8.5pt;
    color: var(--gray-500);
    font-weight: 500;
    margin-top: 2px;
  }
  .page-header-right {
    text-align: right;
    font-size: 7pt;
    color: var(--gray-400);
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .page-header-right .brand {
    font-weight: 800;
    color: var(--lit-grey);
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 9pt;
    letter-spacing: 0.18em;
  }

  /* ─── FOOTER ─── */
  .page-footer {
    position: absolute;
    bottom: 7mm;
    left: 20mm;
    right: 20mm;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 6.5pt;
    color: var(--gray-400);
    border-top: 1px solid var(--gray-200);
    padding-top: 4px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .page-footer .brand-pf {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 800;
    color: var(--lit-grey);
  }

  /* ─── COVER ─── */
  .cover {
    background:
      radial-gradient(ellipse 600px 400px at 15% 25%, rgba(235,238,98,0.08) 0%, transparent 70%),
      radial-gradient(ellipse 500px 500px at 85% 75%, rgba(235,238,98,0.04) 0%, transparent 70%),
      linear-gradient(160deg, #14171F 0%, #1F2330 35%, #323743 65%, #1F2330 100%);
    color: var(--white);
    display: flex;
    flex-direction: column;
    padding: 18mm 22mm;
  }
  .cover-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .cover-logo {
    width: 38mm;
    height: 38mm;
    object-fit: contain;
  }
  .cover-version {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 8pt;
    font-weight: 600;
    letter-spacing: 0.3em;
    color: rgba(255,255,255,0.4);
    text-transform: uppercase;
    margin-top: 4mm;
  }
  .cover-center {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    max-width: 155mm;
  }
  .cover-eyebrow {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 10pt;
    font-weight: 700;
    letter-spacing: 0.32em;
    text-transform: uppercase;
    color: var(--yellow);
    margin-bottom: 14px;
  }
  .cover-title {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 60pt;
    font-weight: 900;
    line-height: 0.92;
    letter-spacing: -0.015em;
    text-transform: uppercase;
    color: var(--white);
    margin-bottom: 18px;
  }
  .cover-title .accent { color: var(--yellow); }
  .cover-subtitle {
    font-size: 14pt;
    font-weight: 300;
    line-height: 1.35;
    color: rgba(255,255,255,0.75);
    max-width: 140mm;
  }
  .cover-divider {
    width: 60px;
    height: 3px;
    background: var(--yellow);
    margin: 20px 0;
  }
  .cover-meta {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 8pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: rgba(255,255,255,0.5);
    border-top: 1px solid rgba(255,255,255,0.15);
    padding-top: 8mm;
    margin-top: 14mm;
  }
  .cover-meta b { color: var(--white); font-weight: 800; }

  /* ─── TOC ─── */
  .toc { list-style: none; counter-reset: toc; }
  .toc li {
    counter-increment: toc;
    padding: 8px 0;
    border-bottom: 1px solid var(--gray-200);
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .toc li::before {
    content: counter(toc, decimal-leading-zero);
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 11pt;
    font-weight: 800;
    color: var(--yellow-2);
    background: var(--lit-grey);
    padding: 3px 8px;
    border-radius: 5px;
    letter-spacing: 0.04em;
    min-width: 38px;
    text-align: center;
  }
  .toc .toc-title {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 12pt;
    font-weight: 700;
    color: var(--lit-grey);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex: 1;
  }
  .toc .toc-desc {
    font-size: 8pt;
    color: var(--gray-500);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    display: block;
    margin-top: 1px;
  }
  .toc .toc-page {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 8.5pt;
    color: var(--gray-400);
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  /* ─── SECTIONS ─── */
  .section-title {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 11pt;
    font-weight: 800;
    color: var(--lit-grey);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 12px 0 7px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-title::before {
    content: '';
    width: 14px;
    height: 3px;
    background: var(--yellow);
  }

  p { margin-bottom: 6px; color: var(--gray-700); font-size: 9pt; }
  p strong { color: var(--lit-grey); font-weight: 700; }
  ul, ol { padding-left: 17px; margin-bottom: 7px; }
  li { margin-bottom: 2px; font-size: 8.5pt; color: var(--gray-700); }
  li strong { color: var(--lit-grey); font-weight: 700; }

  code, kbd {
    font-family: 'JetBrains Mono', Consolas, monospace;
    font-size: 8pt;
    background: var(--gray-100);
    color: var(--lit-grey);
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid var(--gray-200);
  }

  /* ─── KPI ROW ─── */
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-bottom: 10px;
  }
  .kpi-card {
    background: var(--white);
    border: 1px solid var(--gray-200);
    border-radius: 8px;
    padding: 10px 12px;
    position: relative;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03);
  }
  .kpi-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: var(--yellow);
  }
  .kpi-card.dark::before { background: var(--lit-grey); }
  .kpi-card.amber::before { background: var(--amber); }
  .kpi-card.blue::before { background: var(--blue); }
  .kpi-card.green::before { background: var(--green); }

  .kpi-label {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 7pt;
    font-weight: 700;
    color: var(--gray-500);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 3px;
  }
  .kpi-value {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 16pt;
    font-weight: 900;
    color: var(--lit-grey);
    line-height: 1;
    letter-spacing: -0.01em;
  }
  .kpi-value.smaller { font-size: 13pt; }
  .kpi-detail {
    font-size: 7pt;
    color: var(--gray-500);
    margin-top: 3px;
    font-weight: 500;
    line-height: 1.3;
  }

  /* ─── INSIGHTS ─── */
  .insight {
    border-radius: 7px;
    padding: 9px 14px;
    font-size: 8.5pt;
    line-height: 1.5;
    margin-bottom: 8px;
  }
  .insight.yellow { background: #FFFCE5; border-left: 4px solid var(--yellow); color: #5C5A0F; }
  .insight.dark { background: linear-gradient(135deg, var(--lit-grey) 0%, var(--lit-grey-2) 100%); color: var(--white); border-left: 4px solid var(--yellow); }
  .insight.dark p { color: rgba(255,255,255,0.85); font-size: 8.5pt; }
  .insight.dark strong { color: var(--yellow); }
  .insight.amber { background: #FFFBEB; border-left: 4px solid var(--amber); color: #78350F; }
  .insight.green { background: #F0FDF4; border-left: 4px solid var(--green); color: #166534; }
  .insight .label {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 7pt;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    margin-bottom: 3px;
    display: block;
  }
  .insight.yellow .label { color: #846F00; }
  .insight.dark .label { color: var(--yellow); }
  .insight.amber .label { color: #92400E; }
  .insight.green .label { color: #15803D; }

  /* ─── TABLES ─── */
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 8pt;
    margin-bottom: 10px;
  }
  .data-table thead th {
    background: var(--lit-grey);
    color: var(--white);
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 700;
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 6px 10px;
    text-align: left;
  }
  .data-table thead th:first-child { border-radius: 5px 0 0 0; }
  .data-table thead th:last-child { border-radius: 0 5px 0 0; }
  .data-table tbody td {
    padding: 5px 10px;
    border-bottom: 1px solid var(--gray-100);
    vertical-align: top;
    color: var(--gray-700);
    font-size: 8pt;
  }
  .data-table tbody tr:nth-child(even) td { background: var(--gray-50); }
  .data-table tbody tr:last-child td { border-bottom: none; }
  .data-table .bold { font-weight: 700; color: var(--lit-grey); }
  .data-table .mono { font-family: 'JetBrains Mono', monospace; font-size: 7pt; color: var(--lit-grey); }

  /* ─── DIAGRAM ─── */
  .diagram {
    font-family: 'JetBrains Mono', monospace;
    font-size: 7pt;
    background: var(--gray-50);
    color: var(--gray-700);
    padding: 11px 14px;
    border-radius: 7px;
    border: 1px solid var(--gray-200);
    line-height: 1.45;
    white-space: pre;
    margin-bottom: 9px;
    overflow-x: hidden;
  }

  pre {
    font-family: 'JetBrains Mono', monospace;
    font-size: 7.5pt;
    background: var(--lit-grey-2);
    color: var(--cream);
    padding: 9px 13px;
    border-radius: 7px;
    overflow-x: hidden;
    white-space: pre-wrap;
    line-height: 1.45;
    margin-bottom: 9px;
  }
  pre .y { color: var(--yellow); }
  pre .c { color: #8b9099; font-style: italic; }

  /* ─── SURFACE CARDS ─── */
  .surface {
    border: 1px solid var(--gray-200);
    border-radius: 8px;
    padding: 9px 14px 10px;
    margin-bottom: 8px;
    background: var(--white);
    position: relative;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03);
  }
  .surface::before {
    content: '';
    position: absolute;
    top: 0; left: 0; bottom: 0;
    width: 3.5px;
    background: var(--yellow);
  }
  .surface-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 4px;
  }
  .surface-name {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 10.5pt;
    font-weight: 800;
    color: var(--lit-grey);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .surface-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 7pt;
    color: var(--gray-500);
    margin-top: 1px;
  }
  .surface-tags { display: flex; gap: 4px; flex-shrink: 0; }
  .surface-tag {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 6pt;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--gray-100);
    color: var(--gray-600);
  }
  .surface-tag.dark { background: var(--lit-grey); color: var(--yellow); }
  .surface-tag.yellow { background: var(--yellow); color: var(--lit-grey); }
  .surface-desc { font-size: 8.5pt; color: var(--gray-700); line-height: 1.5; }
  .surface-desc ul { margin-top: 3px; padding-left: 15px; }
  .surface-desc li { font-size: 8pt; margin-bottom: 1px; }

  /* ─── STACK GRID ─── */
  .stack-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-bottom: 9px; }
  .stack-item { background: var(--gray-50); border: 1px solid var(--gray-200); border-radius: 7px; padding: 9px 11px; }
  .stack-item .name {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 9.5pt;
    font-weight: 800;
    color: var(--lit-grey);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .stack-item .why { font-size: 7.5pt; color: var(--gray-600); line-height: 1.4; margin-top: 2px; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

  /* ─── GOTCHA ─── */
  .gotcha {
    border: 1px solid var(--gray-200);
    border-left: 4px solid var(--amber);
    border-radius: 7px;
    padding: 9px 13px;
    margin-bottom: 7px;
    background: var(--white);
  }
  .gotcha-title {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 9.5pt;
    font-weight: 800;
    color: var(--lit-grey);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin-bottom: 3px;
  }
  .gotcha-title .badge {
    font-size: 6pt;
    font-weight: 700;
    background: var(--amber);
    color: var(--white);
    padding: 1px 6px;
    border-radius: 3px;
    margin-right: 5px;
    vertical-align: middle;
    letter-spacing: 0.1em;
  }
  .gotcha-body { font-size: 8pt; line-height: 1.45; color: var(--gray-700); }
  .gotcha-body strong { color: var(--lit-grey); font-weight: 700; }

  /* ─── THANK YOU ─── */
  .thankyou {
    background:
      radial-gradient(ellipse 600px 400px at 15% 25%, rgba(235,238,98,0.08) 0%, transparent 70%),
      linear-gradient(160deg, #14171F 0%, #1F2330 35%, #323743 65%, #1F2330 100%);
    color: var(--white);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 30mm;
    text-align: center;
  }
</style>
</head>
<body>

<!-- ════════ COVER ════════ -->
<div class="page cover">
  <div class="cover-top">
    <div>
      <img src="__LOGO__" class="cover-logo" alt="LIT">
    </div>
    <div class="cover-version">DOC V1.0 · 21 · 05 · 2026</div>
  </div>

  <div class="cover-center">
    <div class="cover-eyebrow">Portal de Cliente · Documentación técnica</div>
    <h1 class="cover-title">El portal<br>post-purchase<br>de LIT<span class="accent">.</span></h1>
    <div class="cover-divider"></div>
    <p class="cover-subtitle">Cómo está construido, qué hace cada superficie, y las decisiones técnicas detrás del producto.</p>
  </div>

  <div class="cover-meta">
    <div>Branch <b>feat/master-spec-rewrite</b></div>
    <div>Commit <b>97837d6</b></div>
    <div>Stack <b>NEXT.JS · VERCEL · SUPABASE</b></div>
  </div>
</div>

<!-- ════════ TOC ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>Índice del documento</h2>
        <div class="subtitle">Seis secciones que cubren producto, arquitectura, superficies, integraciones y decisiones de diseño.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Documentación · V1.0</div>
      </div>
    </div>
    <ol class="toc">
      <li><div style="flex:1"><div class="toc-title">Resumen ejecutivo<span class="toc-desc">Qué es el portal, para quién es, y qué problema resuelve.</span></div></div><div class="toc-page">P. 03</div></li>
      <li><div style="flex:1"><div class="toc-title">Stack y arquitectura<span class="toc-desc">Next.js + Vercel + Supabase + Seal. Diagrama y razones detrás de cada pieza.</span></div></div><div class="toc-page">P. 04</div></li>
      <li><div style="flex:1"><div class="toc-title">Autenticación y sesiones<span class="toc-desc">Dos vías de auth conviviendo: App Proxy y Customer Account API OAuth.</span></div></div><div class="toc-page">P. 05</div></li>
      <li><div style="flex:1"><div class="toc-title">Superficies del portal<span class="toc-desc">Mi LIT, Cuenta, Skip, Plan, Cancel, Login, Address, Payment.</span></div></div><div class="toc-page">P. 06</div></li>
      <li><div style="flex:1"><div class="toc-title">Integraciones<span class="toc-desc">Seal, Shopify Admin, Klaviyo, Supabase, App Proxy.</span></div></div><div class="toc-page">P. 09</div></li>
      <li><div style="flex:1"><div class="toc-title">Decisiones y aprendizajes<span class="toc-desc">Los gotchas que aprendimos por las malas y por qué la solución es la que es.</span></div></div><div class="toc-page">P. 11</div></li>
      <li><div style="flex:1"><div class="toc-title">MVP y dimensiones<span class="toc-desc">Qué entra en V1, qué se queda fuera, números del proyecto.</span></div></div><div class="toc-page">P. 13</div></li>
      <li><div style="flex:1"><div class="toc-title">Próximas fases<span class="toc-desc">Collection, Drops, Inner Circle, The World. Follow-ups técnicos.</span></div></div><div class="toc-page">P. 14</div></li>
    </ol>
    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 02</div>
    </div>
  </div>
</div>

<!-- ════════ RESUMEN EJECUTIVO ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>01 · Resumen ejecutivo</h2>
        <div class="subtitle">Qué es el portal, qué consigue el cliente, qué consigue LIT.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 01</div>
      </div>
    </div>
    <p>El <strong>Portal de Cliente de LIT</strong> es la nueva área privada donde el suscriptor gestiona su caja: cambia el plan, salta envíos, modifica la dirección, añade extras, y, llegado el caso, cancela. Sustituye al portal genérico que venía con la herramienta de suscripciones (Seal), que vivía en otro dominio y rompía la identidad de marca.</p>

    <div class="insight dark">
      <span class="label">El porqué</span>
      <p>El portal antiguo era una página técnica, fea, en otro dominio (<code>tracking.litsalt.com</code>). Tener uno propio significa que el cliente <strong>jamás sale de litsalt.com</strong>, ve la identidad LIT en todo momento, y nosotros controlamos cada flujo (cancelación, win-back, recompensas) en lugar de depender de lo que Seal ofrezca por defecto.</p>
    </div>

    <div class="section-title">Lo que consigue el cliente</div>
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-label">Self-service</div><div class="kpi-value smaller">Total</div><div class="kpi-detail">Saltar caja, cambiar plan, dirección y pago en un click.</div></div>
      <div class="kpi-card dark"><div class="kpi-label">Sin salir de marca</div><div class="kpi-value smaller">litsalt</div><div class="kpi-detail">Todo el flujo dentro de /apps/portal/*.</div></div>
      <div class="kpi-card amber"><div class="kpi-label">Cancelación</div><div class="kpi-value smaller">4 pasos</div><div class="kpi-detail">Con alternativas antes del fin: skip, plan, sabor.</div></div>
      <div class="kpi-card blue"><div class="kpi-label">Visibilidad</div><div class="kpi-value smaller">100%</div><div class="kpi-detail">Próximas entregas, historial, sabor, dirección.</div></div>
    </div>

    <div class="section-title">Lo que consigue LIT</div>
    <ul>
      <li><strong>Reducción de tickets a soporte</strong>: la mayoría de "skip mi caja" / "cambiar plan" pasan a self-service.</li>
      <li><strong>Marca consistente</strong> de extremo a extremo. Misma tipografía, mismo idioma, mismo trato.</li>
      <li><strong>Recuperación de cancelaciones integrada</strong>: el cliente ve alternativas antes de la decisión final.</li>
      <li><strong>Telemetría limpia</strong>: cada acción se loguea en Klaviyo para alimentar flujos automáticos de retención.</li>
      <li><strong>Control sobre el roadmap</strong>: Drops, Collection, Inner Circle, eventos. Fase 2 ya con chasis montado.</li>
    </ul>

    <div class="section-title">Estado actual</div>
    <p>El portal está <strong>desplegado en producción</strong> en <code>litsalt.com/apps/portal/*</code>. Los flujos críticos (login OAuth, ver suscripción, saltar, cambiar plan, cambiar dirección, cancelar) funcionan end-to-end. Hay una auditoría de seguridad ejecutada el 21 de mayo con findings documentados aparte (<code>docs/SECURITY_AUDIT_2026-05-21.md</code>). Fases siguientes (Collection, Drops, Inner Circle) tienen schema listo en Supabase y UI con stubs.</p>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 03</div>
    </div>
  </div>
</div>

<!-- ════════ STACK ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>02 · Stack y arquitectura</h2>
        <div class="subtitle">Las piezas técnicas y por qué cada una está elegida.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 02</div>
      </div>
    </div>

    <p><strong>Next.js 16 (App Router)</strong> en Vercel, servido al cliente vía <strong>Shopify App Proxy</strong>, con <strong>Supabase Postgres</strong> como base de datos, e integrado contra <strong>Seal Subscriptions</strong>, <strong>Shopify Admin API</strong> y <strong>Klaviyo</strong>.</p>

    <div class="section-title">Diagrama de alto nivel</div>
<div class="diagram">                  Cliente final (navegador)
                            │
                            │ https://litsalt.com/apps/portal/*
                            ▼
              ┌──────────────────────────────────┐
              │       Shopify App Proxy          │  ← firma HMAC
              │       + logged_in_customer_id    │
              └──────────────────────────────────┘
                            │  proxy transparente
                            ▼
              ┌──────────────────────────────────┐
              │       Vercel · Next.js 16        │
              │  · /app/[locale]/...  pages      │
              │  · /app/api/*  route handlers    │
              │  · components/  overlays + UI    │
              └──────────────────────────────────┘
                    │           │           │
                    ▼           ▼           ▼
              ┌──────────┐  ┌────────┐  ┌────────────┐
              │ Supabase │  │  Seal  │  │  Shopify   │
              │ Postgres │  │   API  │  │  Admin API │
              └──────────┘  └────────┘  └────────────┘
                    │                        │
                    └──► Klaviyo events ◄────┘
</div>

    <div class="section-title">Las piezas, una por una</div>
    <div class="stack-grid">
      <div class="stack-item"><div class="name">Next.js 16</div><div class="why">App Router. Server components para precargar datos sin exponer tokens al bundle. SSR para first paint rápido.</div></div>
      <div class="stack-item"><div class="name">Shopify App Proxy</div><div class="why">El cliente nunca sale de litsalt.com. Shopify firma cada request con HMAC y adjunta el customer_id.</div></div>
      <div class="stack-item"><div class="name">Vercel</div><div class="why">Deploy continuo desde GitHub, escala automática, edge functions. Sin operar infra propia.</div></div>
      <div class="stack-item"><div class="name">Supabase</div><div class="why">Postgres gestionado + Auth + panel para ops review. Una sola DB para todo el portal.</div></div>
      <div class="stack-item"><div class="name">Seal Subscriptions</div><div class="why">Motor de suscripciones existente. El portal habla con su Merchant API para leer y mutar.</div></div>
      <div class="stack-item"><div class="name">Customer Account API</div><div class="why">OAuth moderno con PKCE de Shopify. Sustituye el login viejo. Soporta deep-links desde email.</div></div>
    </div>

    <div class="insight yellow">
      <span class="label">Decisión de marca</span>
      <p>Toda la UI usa las tipografías brand (<strong>Barlow</strong> y <strong>Barlow Condensed</strong>) y los colores LIT (<strong>cream</strong> <code>#F8F9F2</code>, <strong>lit-grey</strong> <code>#323743</code>, <strong>bold-yellow</strong> <code>#EBEE62</code>). Sin hojas de estilo neutras. Todo brand consistente.</p>
    </div>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 04</div>
    </div>
  </div>
</div>

<!-- ════════ AUTH ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>03 · Autenticación y sesiones</h2>
        <div class="subtitle">Dos mecanismos de auth coexistiendo. Cualquiera identifica al cliente.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 03</div>
      </div>
    </div>

    <p>El middleware <code>withCustomer</code> intenta dos vías de identificar al cliente. La primera funciona cuando viene desde un email (App Proxy). La segunda cuando entra directamente (OAuth).</p>

    <div class="two-col">
      <div class="kpi-card"><div class="kpi-label">Vía A · Pasiva</div><div class="kpi-value smaller">App Proxy</div><div class="kpi-detail">Shopify firma la URL con HMAC y adjunta logged_in_customer_id. Si está logueado en storefront, ya está dentro.</div></div>
      <div class="kpi-card dark"><div class="kpi-label">Vía B · Activa</div><div class="kpi-value smaller">OAuth (PKCE)</div><div class="kpi-detail">Customer Account API. Tras el callback creamos un session_id opaco en Supabase. FE lo manda en X-LIT-Session.</div></div>
    </div>

    <div class="section-title">Flujo OAuth (Vía B)</div>
<div class="diagram">    Cliente              Portal (Vercel)             Shopify
      │                       │                       │
      │  GET /apps/portal/.   │ no auth, no token     │
      ├──────────────────────►│                       │
      │   redirect /login     │                       │
      │◄──────────────────────┤                       │
      │  → /authorize (PKCE, code_verifier, signed state JWT)
      ├────────────────────────────────────────────────►│
      │   login + consent                              │
      │◄───────────────────────────────────────────────┤
      │   ?code=... &state=...
      ├──────────►/api/auth/callback ──────────────────►│
      │                       │  exchange code → tokens │
      │                       │◄────────────────────────┤
      │                       │ INSERT auth_sessions    │
      │                       │ con session_id opaco    │
      │  redirect /handoff?s= │
      │◄──────────────────────┤
      │   handoff page mueve session_id a localStorage
      │   Autenticación: X-LIT-Session header desde aquí
</div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">GOTCHA</span>Shopify intercepta Authorization en mutations</div>
      <div class="gotcha-body">
        Shopify App Proxy <strong>intercepta el header <code>Authorization</code></strong> en POST/PATCH/DELETE y NO las reenvía al upstream. Devuelve un 500 con el HTML del tema. Headers custom <code>X-*</code> pasan limpios. Migramos a <code>X-LIT-Session</code> y todas las mutations volvieron a funcionar.
      </div>
    </div>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 05</div>
    </div>
  </div>
</div>

<!-- ════════ SURFACES 1: Hub + Cuenta ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>04 · Superficies del portal</h2>
        <div class="subtitle">Mi LIT (Hub) y Cuenta — las dos pantallas raíz.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 04 · 1/3</div>
      </div>
    </div>

    <p>Cada superficie tiene una URL clara y una responsabilidad. Todas comparten header móvil fijo, tipografías brand y colores LIT.</p>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-name">4.1 · Mi LIT (Hub)</div>
          <div class="surface-meta">/apps/portal/[es|en]/mi-lit</div>
        </div>
        <div class="surface-tags">
          <span class="surface-tag dark">HOME</span>
          <span class="surface-tag yellow">RUTA PRIMARIA</span>
        </div>
      </div>
      <div class="surface-desc">
        Pantalla principal. Estructura:
        <ul>
          <li><strong>Hero "Next Box"</strong>: fecha del próximo envío, sabor, plan. 4 variantes (default, skipped con banner+undo, locked dentro 24h, new primera caja).</li>
          <li><strong>Quick Actions</strong>: 4 botones para Cambiar plan, Saltar próxima, Cambiar sabor (F2), Extras (F2).</li>
          <li><strong>Calendar</strong>: próximas 5-6 fechas que Seal tiene pre-agendadas.</li>
          <li><strong>Mini Collection grid</strong>: preview de la colección de cartas (Fase 2).</li>
          <li><strong>Order history</strong>: últimos 10 pedidos completados con tracking si está disponible.</li>
        </ul>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-name">4.2 · Cuenta</div>
          <div class="surface-meta">/apps/portal/[es|en]/cuenta</div>
        </div>
        <div class="surface-tags">
          <span class="surface-tag">ACCOUNT</span>
          <span class="surface-tag">SETTINGS</span>
        </div>
      </div>
      <div class="surface-desc">
        Misma información que Mi LIT en formato ficha: nombre, email, teléfono, suscripción, dirección, método de pago, historial completo. Incluye <strong>Danger Zone</strong> al final con "Cerrar sesión" y "Cancelar suscripción".
        <ul>
          <li>Los Quick Actions funcionan exactamente igual que en Mi LIT (mismas reglas de disabled, mismo banner "Saltaste la entrega anterior — Deshacer" si hay skip activo).</li>
          <li>Sincronización vía <code>localStorage</code> (<code>lit:just-skipped</code>): saltas en Mi LIT y navegas a Cuenta, lo ves. Y viceversa.</li>
        </ul>
      </div>
    </div>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 06</div>
    </div>
  </div>
</div>

<!-- ════════ SURFACES 2: Skip + Plan + Address + Payment ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>04 · Superficies del portal</h2>
        <div class="subtitle">Skip, Plan, Address y Payment — las mutations.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 04 · 2/3</div>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-name">4.3 · Skip overlay</div>
          <div class="surface-meta">POST /api/subscription/skip</div>
        </div>
        <div class="surface-tags"><span class="surface-tag dark">OVERLAY</span><span class="surface-tag">MUTATION</span></div>
      </div>
      <div class="surface-desc">
        Bottom-sheet en móvil, modal en desktop. Muestra "¿Te vas de viaje?", fecha actual y botón "Confirmar saltar". El backend valida ownership en Supabase (fast-path), hace GET dirigido a Seal por ID, comprueba cutoff de 24h, llama <code>skipBillingAttempt</code>, dispara Klaviyo event.
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-name">4.4 · Plan overlay</div>
          <div class="surface-meta">PATCH /api/subscription/plan</div>
        </div>
        <div class="surface-tags"><span class="surface-tag dark">OVERLAY</span><span class="surface-tag">MUTATION</span></div>
      </div>
      <div class="surface-desc">
        Selector de cajas (1 a 6) + frecuencia (15d hasta 6 meses). Precio dinámico desde Shopify. Si hay skip activo, aviso amarillo. Al guardar:
        <ul>
          <li>Si cambia frecuencia: <code>editSubscription(delivery_interval)</code> primero.</li>
          <li>Si cambia nº de cajas: <code>addItems</code> + <code>removeItems</code> (Seal no permite swap directo).</li>
          <li>Pausas de 500ms entre mutations (Seal regenera billing_attempts en background).</li>
          <li>Verify con AbortController 4s. Si timed out, respuesta sintética + re-poll silencioso 60s en FE.</li>
        </ul>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-name">4.5 · Address + 4.6 · Payment</div>
          <div class="surface-meta">PATCH /api/subscription/address  ·  Shopify customerPaymentMethodSendUpdateEmail</div>
        </div>
        <div class="surface-tags"><span class="surface-tag yellow">EMAIL-ONLY</span></div>
      </div>
      <div class="surface-desc">
        <strong>Address</strong>: formulario con cutoff de 24h. PATCH llama a <code>seal.updateShippingAddress</code>.
        <br><strong>Payment</strong>: <strong>100% email-only</strong> (locked 2026-05-19). Botón dispara Shopify Admin API que envía enlace seguro al email. El portal muestra: <em>"Te hemos enviado un enlace a tu correo, vuelve aquí al terminar"</em>. Sin Stripe, sin pasarela nueva.
      </div>
    </div>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 07</div>
    </div>
  </div>
</div>

<!-- ════════ SURFACES 3: Cancel + Login ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>04 · Superficies del portal</h2>
        <div class="subtitle">El takeover de cancelación: el flujo más cuidado del portal.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 04 · 3/3</div>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-name">4.7 · Cancel takeover</div>
          <div class="surface-meta">/api/subscription/cancel (steps 1 → 4)</div>
        </div>
        <div class="surface-tags">
          <span class="surface-tag dark">FULL-SCREEN</span>
          <span class="surface-tag yellow">WIN-BACK</span>
        </div>
      </div>
      <div class="surface-desc">No es un overlay, es un takeover oscuro a pantalla completa. 4 pasos:</div>
    </div>

    <div class="two-col">
      <div class="kpi-card"><div class="kpi-label">Step 01</div><div class="kpi-value smaller">Stats</div><div class="kpi-detail">"Has recibido N cajas y llevas M meses en LIT". Reconocer el viaje antes de proponer salirse.</div></div>
      <div class="kpi-card dark"><div class="kpi-label">Step 02</div><div class="kpi-value smaller">Alternativas</div><div class="kpi-detail">Botones para Saltar, Cambiar plan, Sabores. Pivotan al overlay sin cerrar el takeover.</div></div>
      <div class="kpi-card amber"><div class="kpi-label">Step 03</div><div class="kpi-value smaller">Motivo</div><div class="kpi-detail">Razón (caro / mucho / no lo uso / pausa / otro) + free text opcional.</div></div>
      <div class="kpi-card blue"><div class="kpi-label">Step 04</div><div class="kpi-value smaller">Confirmar</div><div class="kpi-detail">Copy condicional según cutoff. Botón final "Cancelar suscripción".</div></div>
    </div>

    <div class="section-title">Qué pasa al confirmar</div>
    <ol>
      <li>Marca la cancellation row en Supabase como <code>committing</code> (estado intermedio para detectar cancels colgados).</li>
      <li>Llama <code>seal.cancelSubscription</code> (es <strong>inmediato</strong>, Seal pone <code>cancelled_on</code> al momento).</li>
      <li>Promueve la row a <code>confirmed</code>. Si es second-cancel: reset inmediato del balance Drops. First-cancel: hold 90 días.</li>
      <li>Dispara evento Klaviyo con razón, freeText, cancelCount, fecha último envío, drops hold.</li>
      <li>Muestra done state: <em>"Muchas gracias por haber confiado en LIT. Ojalá poder tenerte de vuelta pronto."</em></li>
    </ol>

    <div class="insight dark">
      <span class="label">Salida limpia</span>
      <p>El botón "Volver a LIT" del done state hace <strong>logout completo</strong> y redirige a <code>litsalt.com</code>. El cliente NO vuelve al portal con estado stale. Si más tarde quiere volver, el Hub le mostrará el ReactivateCard.</p>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-name">4.8 · Login / EmptyState</div>
          <div class="surface-meta">/apps/portal/[es|en]/mi-lit (sin auth)</div>
        </div>
        <div class="surface-tags"><span class="surface-tag">FALLBACK</span></div>
      </div>
      <div class="surface-desc">
        Sin sesión → <strong>LoginScreen</strong> con CTA a OAuth. Autenticado sin sub activa (one-shot o cancelado) → <strong>EmptyState</strong> con "Gracias por probar LIT" + CTA a suscripción con descuento "desde el 25%".
      </div>
    </div>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 08</div>
    </div>
  </div>
</div>

<!-- ════════ INTEGRACIONES 1 ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>05 · Integraciones</h2>
        <div class="subtitle">Seal Subscriptions y Shopify Admin API.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 05 · 1/2</div>
      </div>
    </div>

    <div class="section-title">5.1 · Seal Subscriptions (Merchant API)</div>
    <p>El motor de suscripciones de LIT. El portal lee y muta el estado únicamente a través de su Merchant API.</p>
    <table class="data-table">
      <thead><tr><th>Acción</th><th>Endpoint</th><th>Notas</th></tr></thead>
      <tbody>
        <tr><td class="bold">Listar subs por email</td><td class="mono">GET /subscriptions?page=N</td><td>Sin filtro server-side. Hay que paginar hasta 33 páginas en cuentas grandes.</td></tr>
        <tr><td class="bold">Sub por ID</td><td class="mono">GET /subscription?id=X</td><td>Endpoint SINGULAR que sí honra el filtro. Evita paginar.</td></tr>
        <tr><td class="bold">Cambiar intervalo</td><td class="mono">PUT /subscription action=edit</td><td>Solo delivery_interval. NO mandar billing_interval.</td></tr>
        <tr><td class="bold">Cambiar variant</td><td class="mono">add_items + remove_items</td><td>No hay endpoint de swap. Añadir nuevo + quitar viejo.</td></tr>
        <tr><td class="bold">Saltar attempt</td><td class="mono">PUT action=skip</td><td>Puede devolver 200 con success: false. Hay que chequear el body.</td></tr>
        <tr><td class="bold">Cancelar / reactivar</td><td class="mono">PUT action=cancel|reactivate</td><td>Cancel es INMEDIATO. cancelled_on al momento.</td></tr>
      </tbody>
    </table>

    <div class="section-title">5.2 · Shopify Admin API (GraphQL)</div>
    <p>Datos del cliente y operaciones que Seal no expone:</p>
    <ul>
      <li><strong>Lookup de email</strong> por customer_id — App Proxy da el ID pero Seal indexa por email.</li>
      <li><strong>Actualizar customer</strong>: nombre, teléfono, language preference.</li>
      <li><strong>Catalog de extras</strong>: productos con tag <code>add-to-box</code> añadibles a la siguiente caja.</li>
      <li><strong>Payment update email</strong>: <code>customerPaymentMethodSendUpdateEmail</code>.</li>
      <li><strong>Order history</strong>: últimos pedidos para el historial.</li>
    </ul>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 09</div>
    </div>
  </div>
</div>

<!-- ════════ INTEGRACIONES 2 ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>05 · Integraciones</h2>
        <div class="subtitle">Klaviyo, Supabase, App Proxy.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 05 · 2/2</div>
      </div>
    </div>

    <div class="section-title">5.3 · Klaviyo (telemetría + emails)</div>
    <p>Cada acción importante dispara un evento en Klaviyo, que alimenta flujos automáticos.</p>
    <table class="data-table">
      <thead><tr><th>Evento</th><th>Cuándo</th><th>Properties principales</th></tr></thead>
      <tbody>
        <tr><td class="mono bold">subscription_skip</td><td>Tras skip exitoso</td><td>newNextShipDate, sealSubscriptionId</td></tr>
        <tr><td class="mono bold">subscription_cancelled</td><td>Tras cancel step 4</td><td>primaryReason, freeText, cancelCount, lastShipDate, dropsHeldUntil</td></tr>
        <tr><td class="mono bold">welcome_to_portal</td><td>Primera sesión OAuth</td><td>customerId, email, locale</td></tr>
      </tbody>
    </table>

    <div class="section-title">5.4 · Supabase (Postgres)</div>
    <table class="data-table">
      <thead><tr><th>Tabla</th><th>Propósito</th></tr></thead>
      <tbody>
        <tr><td class="mono bold">auth_sessions</td><td>session_id ↔ customer_id, expiry, id_token para logout OIDC.</td></tr>
        <tr><td class="mono bold">subscriptions</td><td>Cache customer_id ↔ seal_subscription_id. Evita el scan de 33 páginas.</td></tr>
        <tr><td class="mono bold">cancellations</td><td>Multi-step cancel: pending → committing → confirmed.</td></tr>
        <tr><td class="mono bold">customer_preferences</td><td>cancel_count, language_pref. Lógica "second-cancel = drops reset inmediato".</td></tr>
        <tr><td class="mono bold">drops_balances / events</td><td>Balance Drops + log de cambios (Fase 2 activa cuando los triggers estén listos).</td></tr>
        <tr><td class="mono bold">webhook_log</td><td>Idempotency log de webhooks Shopify y Seal.</td></tr>
      </tbody>
    </table>

    <div class="section-title">5.5 · Shopify App Proxy</div>
<pre>[app_proxy]
url     = <span class="y">"https://lit-portal-drab.vercel.app"</span>
subpath = <span class="y">"portal"</span>
prefix  = <span class="y">"apps"</span></pre>
    <p>Cualquier request a <code>litsalt.com/apps/portal/*</code> se reenvía con HMAC + customer_id + shop + timestamp. El middleware <code>verifyAppProxyRequest</code> valida la firma antes de procesar.</p>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 10</div>
    </div>
  </div>
</div>

<!-- ════════ DECISIONES 1 (Gotchas 1-5) ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>06 · Decisiones y aprendizajes</h2>
        <div class="subtitle">Los gotchas que aprendimos por las malas. Para que no se repitan.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 06 · 1/2</div>
      </div>
    </div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">GOTCHA 01</span>Shopify App Proxy sustituye 5xx con HTML del storefront</div>
      <div class="gotcha-body">
        Cuando el upstream devuelve un HTTP 5xx, App Proxy <strong>NO reenvía esa respuesta</strong>. Renderiza el HTML del tema con la URL como canonical. El cliente recibe ~50KB de markup con status 500 y <code>content-type: text/html</code>. <strong>Diagnóstico</strong>: bypass del proxy con curl directo a Vercel para ver el error JSON real.
      </div>
    </div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">GOTCHA 02</span>Seal regenera billing_attempts en cada plan change</div>
      <div class="gotcha-body">
        Cualquier <code>editSubscription</code> en Seal regenera la lista de <code>billing_attempts</code> desde cero. <strong>Cualquier skip aplicado previamente se borra silenciosamente.</strong> Mitigación: el FE limpia el flag <code>justSkipped</code> de localStorage cuando hay plan change exitoso, y el PlanOverlay avisa al usuario si va a cambiar plan con un skip activo.
      </div>
    </div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">GOTCHA 03</span>Eventual consistency en Seal</div>
      <div class="gotcha-body">
        Tras una mutation, un GET inmediato puede devolver datos stale. Soluciones: (1) el skip endpoint <strong>computa el nuevo nextShipDate localmente</strong>; (2) el plan endpoint usa AbortController con timeout de 4s; (3) el FE arranca re-poll silencioso de 60s tras un plan change.
      </div>
    </div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">GOTCHA 04</span>Constraint CHECK sin migration aplicada en prod</div>
      <div class="gotcha-body">
        El código de cancel step 4 escribía <code>status='committing'</code> pero la constraint solo permitía <code>('pending','confirmed')</code>. Durante semanas <strong>nadie podía cancelar</strong>. El 500 se enmascaró por el Gotcha 01. Fix: ALTER CONSTRAINT aplicado 2026-05-21. Schema sincronizado.
      </div>
    </div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">GOTCHA 05</span>Cancel es INMEDIATO en Seal</div>
      <div class="gotcha-body">
        El comportamiento por defecto de Seal cancel pone <code>cancelled_on</code> al instante, no tras el último envío. El portal refleja esto en el copy según el cutoff: <em>"Cancelación inmediata"</em>, excepto si el próximo envío ya está procesando dentro de 24h.
      </div>
    </div>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 11</div>
    </div>
  </div>
</div>

<!-- ════════ DECISIONES 2 (Reglas 6-10) ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>06 · Decisiones y aprendizajes</h2>
        <div class="subtitle">Las reglas duras de marca y producto.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 06 · 2/2</div>
      </div>
    </div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">REGLA 06</span>El cliente JAMÁS ve tracking.litsalt.com</div>
      <div class="gotcha-body">
        El cliente final no puede ver el portal de tracking antiguo en ningún momento. Todo dentro de <code>litsalt.com/apps/portal/*</code>. Cambio de pago = email. Cancel = takeover. Error = inline. El portal viejo deja de existir para el cliente.
      </div>
    </div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">REGLA 07</span>Sin em-dashes en NINGÚN copy</div>
      <div class="gotcha-body">
        Ningún copy de LIT (portal + emails + ads) puede llevar un em-dash. Usar coma o punto. Preferencia consistente del founder.
      </div>
    </div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">REGLA 08</span>Cutoff de 24h (antes 72h)</div>
      <div class="gotcha-body">
        El operador interno necesita al menos 24h para procesar cambios antes del envío. Antes eran 72h, que bloqueaba demasiados cambios. Se aplica a skip, plan, address, extras. Constante única en <code>src/lib/cutoff.ts</code>.
      </div>
    </div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">REGLA 09</span>Cambio de método de pago = email-only</div>
      <div class="gotcha-body">
        100% email-only via Shopify <code>customerPaymentMethodSendUpdateEmail</code>. Sin Stripe, sin pasarela nueva. Shopify ya tiene el método y la pasarela.
      </div>
    </div>

    <div class="gotcha">
      <div class="gotcha-title"><span class="badge">REGLA 10</span>X-LIT-Session, no Authorization</div>
      <div class="gotcha-body">
        El portal envía el session token en header custom <code>X-LIT-Session</code>. El backend acepta ambos para back-compat, pero el FE solo usa el custom. Esto resolvió de raíz "la mutation parece que funciona pero nunca llega al servidor".
      </div>
    </div>

    <div class="insight yellow">
      <span class="label">Cierre</span>
      <p>El portal está vivo, los flujos críticos funcionan end-to-end, y el cliente puede gestionar su suscripción sin ver el portal antiguo. La base es sólida. Las decisiones documentadas en estas páginas son las que evitarán que el equipo repita los mismos errores en Fase 2 (Collection, Drops, Inner Circle) o cuando se monte un portal para otra marca con la misma arquitectura.</p>
    </div>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 12</div>
    </div>
  </div>
</div>

<!-- ════════ MVP Y DIMENSIONES ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>07 · MVP y dimensiones</h2>
        <div class="subtitle">Qué entra en V1 y qué tamaño tiene el proyecto.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 07</div>
      </div>
    </div>

    <div class="section-title">Qué entra en el MVP</div>
    <p>El MVP del portal cubre los flujos imprescindibles para que un suscriptor gestione su caja sin tocar soporte. Todo lo demás (Collection, Drops, eventos) queda como Fase 2 con el chasis ya montado.</p>

    <ul>
      <li><strong>Login OAuth</strong> con Customer Account API de Shopify (PKCE + nonce + JWKS verification).</li>
      <li><strong>Mi LIT (Hub)</strong>: hero con próximo envío, quick actions, calendar de próximas entregas, historial de pedidos.</li>
      <li><strong>Cuenta</strong>: ficha de cliente, suscripción, dirección, método de pago, cancelación.</li>
      <li><strong>Skip / Undo</strong>: saltar próxima caja, deshacer en ventana de 5 minutos.</li>
      <li><strong>Plan change</strong>: cambiar cajas y/o frecuencia con precio dinámico desde Shopify.</li>
      <li><strong>Cancel</strong>: takeover en 4 pasos con alternativas (skip, plan, sabor) antes del fin.</li>
      <li><strong>Reactivate</strong>: ventana de 90 días tras primera cancelación.</li>
      <li><strong>Address change</strong>: cambio de dirección de envío vía Seal directo.</li>
      <li><strong>Payment update</strong>: 100% email-only via Shopify <code>customerPaymentMethodSendUpdateEmail</code>.</li>
      <li><strong>Email change</strong>: con verificación por magic link al nuevo email.</li>
      <li><strong>EmptyState</strong>: para clientes sin suscripción activa (one-shot buyers, cancelados).</li>
      <li><strong>Bilingüe ES/EN</strong>: idioma persistido + URL <code>/es/*</code> o <code>/en/*</code>.</li>
      <li><strong>Telemetría Klaviyo</strong>: eventos para subscription_skip, subscription_cancelled, welcome_to_portal, email_change_requested, subscription_reactivated.</li>
      <li><strong>Seguridad cerrada</strong>: 13 hallazgos críticos/altos auditados y resueltos. Re-audit confirma cero regresiones.</li>
    </ul>

    <div class="section-title">Dimensiones</div>
    <div class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-label">Líneas de código</div>
        <div class="kpi-value">14k</div>
        <div class="kpi-detail">TypeScript + TSX en src/</div>
      </div>
      <div class="kpi-card dark">
        <div class="kpi-label">Endpoints API</div>
        <div class="kpi-value">41</div>
        <div class="kpi-detail">routes en src/app/api/</div>
      </div>
      <div class="kpi-card amber">
        <div class="kpi-label">Componentes React</div>
        <div class="kpi-value">25</div>
        <div class="kpi-detail">UI atómicos en src/components/</div>
      </div>
      <div class="kpi-card blue">
        <div class="kpi-label">Migrations en prod</div>
        <div class="kpi-value">04</div>
        <div class="kpi-detail">cancellations, auth_sessions_hash, email_change_requests, rate_buckets</div>
      </div>
    </div>

    <div class="section-title">Tabla de superficies y endpoints</div>
    <table class="data-table">
      <thead><tr><th>Capa</th><th>Cuenta</th><th>Notas</th></tr></thead>
      <tbody>
        <tr><td class="bold">Superficies activas</td><td>08</td><td>Hub, Cuenta, Skip, Plan, Cancel, Address, Login/Empty, Confirmación post-cancel</td></tr>
        <tr><td class="bold">Superficies Fase 2 (UI con stub)</td><td>03</td><td>Collection, The World, Inner Circle</td></tr>
        <tr><td class="bold">Tablas Supabase</td><td>13+</td><td>auth_sessions, subscriptions, cancellations, customer_preferences, drops_*, events, moments, stories, webhook_log, rate_buckets, email_change_requests</td></tr>
        <tr><td class="bold">Integraciones externas</td><td>05</td><td>Seal, Shopify Admin, Klaviyo, Customer Account API OAuth, App Proxy</td></tr>
        <tr><td class="bold">Eventos Klaviyo</td><td>10</td><td>skip, cancelled, reactivated, email_change_requested, welcome_to_portal, tier_unlocked, reward_claimed, winback_d14/d30, drops_earned</td></tr>
      </tbody>
    </table>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 13</div>
    </div>
  </div>
</div>

<!-- ════════ PRÓXIMAS FASES ════════ -->
<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <div class="page-header-left">
        <h2>08 · Próximas fases</h2>
        <div class="subtitle">Lo que queda por construir y por afinar.</div>
      </div>
      <div class="page-header-right">
        <div class="brand">PORTAL LIT</div>
        <div>Sección 08</div>
      </div>
    </div>

    <div class="section-title">Fase 2 — Engagement & loyalty</div>
    <table class="data-table">
      <thead><tr><th>Bloque</th><th>Estado</th><th>Qué falta</th></tr></thead>
      <tbody>
        <tr><td class="bold">Collection (cartas)</td><td>UI stub en Hub</td><td>Backend de unlocks (drops_events trigger por box shipped), grid completa en /collection, animación de carta nueva.</td></tr>
        <tr><td class="bold">Drops (recompensas)</td><td>Schema listo</td><td>Triggers: box_shipped (+10), referral_converted (+50), monthly_streak (+5), product_review (+15). Rewards claim flow + carrito de recompensas.</td></tr>
        <tr><td class="bold">Inner Circle (tier)</td><td>Pill visible</td><td>Threshold de unlock (X cajas o Y meses), beneficios visibles, evento Klaviyo tier_unlocked ya está pero no se dispara nada.</td></tr>
        <tr><td class="bold">The World (eventos)</td><td>Schema + 1 endpoint</td><td>UI completa /the-world, calendario, RSVP, lista de espera Barcelona, integración con admin para crear eventos.</td></tr>
        <tr><td class="bold">Flavor switcher</td><td>QA disabled</td><td>Activar cuando haya catálogo &gt;1 sabor. La logic de mutation ya existe (es un plan change variant).</td></tr>
        <tr><td class="bold">Extras catalog</td><td>Backend completo</td><td>UI activar cuando Shopify tenga productos con tag <code>add-to-box</code>.</td></tr>
      </tbody>
    </table>

    <div class="section-title">Hardening pendiente (low priority)</div>
    <ul>
      <li><strong>Drop columna <code>session_id</code> raw</strong> de <code>auth_sessions</code>. Hoy se conserva por rollback safety; tras unas semanas estable se puede tirar.</li>
      <li><strong>Drop <code>auth_sessions.email</code></strong> si no se usa (defense in depth — DB leak no debería exponer emails).</li>
      <li><strong>Rate limit en <code>/api/customer/confirm-email</code></strong>: token de 256 bits hace que la probabilidad de adivinar sea ~0, pero limitar IP cubre el caso de scanning.</li>
      <li><strong>Comentar trust model</strong> del logout id_token decode (cosmético — el auditor lo notó).</li>
      <li><strong>Auditoría bimensual automática</strong>: cron programado para 2026-06-05; cuando dispare, los 3 agentes ejecutan y se auto-reagenda.</li>
    </ul>

    <div class="section-title">Mejoras de operaciones</div>
    <ul>
      <li><strong>Dashboard ops</strong> para ver cancellations en estado <code>committing</code> (cancels colgados que requieren intervención manual).</li>
      <li><strong>Sentry o equivalente</strong> para tracking de errores en producción. Hoy todo va a Vercel logs sin alerting.</li>
      <li><strong>E2E tests con Playwright</strong> para los flujos críticos: skip, plan change, cancel, address.</li>
      <li><strong>Webhook log replay</strong> tool para reprocesar eventos Shopify/Seal fallidos.</li>
      <li><strong>Linear integration</strong>: pipe del audit bimensual a tickets automáticos si hay críticos.</li>
    </ul>

    <div class="insight dark">
      <span class="label">Estado a fecha de hoy</span>
      <p>El portal está <strong>en producción y listo para lanzamiento al cliente final</strong>. Los flujos críticos están validados end-to-end, la auditoría de seguridad ha quedado limpia, y la cadencia de re-audit bimensual está programada. La Fase 2 (Collection / Drops / Inner Circle) tiene schema y stubs en su sitio — no es un sprint nuevo de arquitectura, es un sprint de relleno.</p>
    </div>

    <div class="page-footer">
      <div><span class="brand-pf">PORTAL LIT</span> · Documentación técnica · V1.0</div>
      <div>P. 14</div>
    </div>
  </div>
</div>

<!-- ════════ THANK YOU ════════ -->
<div class="page thankyou">
  <img src="__LOGO__" style="width: 40mm; height: 40mm; object-fit: contain; margin-bottom: 22mm;" alt="LIT">
  <div style="font-family: 'Barlow Condensed', sans-serif; font-size: 10pt; font-weight: 700; letter-spacing: 0.32em; text-transform: uppercase; color: var(--yellow); margin-bottom: 14px;">Fin del documento</div>
  <h1 style="font-family: 'Barlow Condensed', sans-serif; font-size: 44pt; font-weight: 900; line-height: 0.95; letter-spacing: -0.015em; text-transform: uppercase; color: var(--white); margin-bottom: 12mm;">Gracias por leer<span style="color: var(--yellow);">.</span></h1>
  <div style="width: 60px; height: 3px; background: var(--yellow); margin: 6mm 0;"></div>
  <div style="font-family: 'Barlow Condensed', sans-serif; font-size: 8pt; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: rgba(255,255,255,0.5);">PORTAL LIT · DOC V1.0 · 21 · 05 · 2026</div>
</div>

</body>
</html>
"""

HTML = HTML.replace("__LOGO__", logo_uri)
OUT.write_text(HTML, encoding="utf-8")
print(f"wrote {OUT} ({len(HTML)} chars)")

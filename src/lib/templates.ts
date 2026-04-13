// LIT Portal — Template renderer
// Returns HTML wrapped in Liquid for Shopify App Proxy

const BRAND = {
  dark: '#323743',
  yellow: '#ebee62',
  offWhite: '#e9ebde',
  white: '#F8F9F2',
  indigo: '#373554',
  beige: '#cfbfad',
  red: '#c0392b',
};

export function wrapInLiquid(title: string, bodyHtml: string, sessionToken?: string): string {
  const tokenParam = sessionToken ? `?s=${sessionToken}` : '';

  return `
{% layout none %}
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — LIT Hydration</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    @font-face {
      font-family: 'Clash Display';
      src: url('https://cdn.shopify.com/s/files/1/0693/8322/1498/files/ClashDisplay-Variable.woff2') format('woff2');
      font-weight: 200 700;
      font-display: swap;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Barlow', sans-serif;
      background: ${BRAND.white};
      color: ${BRAND.dark};
      min-height: 100vh;
    }
    .portal-nav {
      background: ${BRAND.dark};
      padding: 12px 20px;
      display: flex;
      gap: 16px;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .portal-nav a {
      color: ${BRAND.offWhite};
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      padding: 8px 16px;
      border-radius: 8px;
      transition: background 0.2s;
    }
    .portal-nav a:hover, .portal-nav a.active {
      background: ${BRAND.indigo};
      color: ${BRAND.yellow};
    }
    .portal-container {
      max-width: 800px;
      margin: 0 auto;
      padding: 24px 16px;
    }
    h1, h2, h3 {
      font-family: 'Clash Display', sans-serif;
      font-weight: 600;
    }
    h1 { font-size: 28px; margin-bottom: 24px; }
    h2 { font-size: 22px; margin-bottom: 16px; }
    h3 { font-size: 18px; margin-bottom: 12px; }
    .card {
      background: white;
      border: 1px solid ${BRAND.offWhite};
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .badge-active { background: ${BRAND.yellow}; color: ${BRAND.dark}; }
    .badge-paused { background: ${BRAND.beige}; color: ${BRAND.dark}; }
    .badge-cancelled { background: ${BRAND.red}; color: white; }
    .badge-bronze { background: #cd7f32; color: white; }
    .badge-silver { background: #c0c0c0; color: ${BRAND.dark}; }
    .badge-gold { background: #ffd700; color: ${BRAND.dark}; }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      border-radius: 10px;
      font-family: 'Barlow', sans-serif;
      font-size: 15px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary {
      background: ${BRAND.yellow};
      color: ${BRAND.dark};
    }
    .btn-secondary {
      background: transparent;
      color: ${BRAND.dark};
      border: 2px solid ${BRAND.dark};
    }
    .btn-danger {
      background: transparent;
      color: ${BRAND.red};
      border: 2px solid ${BRAND.red};
    }
    .btn-sm { padding: 8px 16px; font-size: 13px; }
    .btn-block { display: block; width: 100%; text-align: center; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid ${BRAND.offWhite};
      font-size: 14px;
    }
    .detail-row:last-child { border-bottom: none; }
    .detail-label { color: ${BRAND.beige}; font-weight: 500; }
    .input {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid ${BRAND.offWhite};
      border-radius: 10px;
      font-family: 'Barlow', sans-serif;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    .input:focus { border-color: ${BRAND.yellow}; }
    .progress-bar {
      width: 100%;
      height: 8px;
      background: ${BRAND.offWhite};
      border-radius: 4px;
      overflow: hidden;
      margin: 8px 0;
    }
    .progress-fill {
      height: 100%;
      background: ${BRAND.yellow};
      border-radius: 4px;
      transition: width 0.3s;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .stat-card {
      background: ${BRAND.dark};
      color: ${BRAND.offWhite};
      border-radius: 12px;
      padding: 16px;
      text-align: center;
    }
    .stat-value {
      font-family: 'Clash Display', sans-serif;
      font-size: 32px;
      font-weight: 700;
      color: ${BRAND.yellow};
    }
    .stat-label { font-size: 12px; margin-top: 4px; }
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: ${BRAND.beige};
    }
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: rgba(50,55,67,0.75);
      z-index: 9999;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: ${BRAND.white};
      border-radius: 16px;
      max-width: 420px;
      width: 90%;
      padding: 32px 24px;
      text-align: center;
    }
    @media (max-width: 600px) {
      .grid-2 { grid-template-columns: 1fr; }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <nav class="portal-nav">
    <a href="/${tokenParam}">Inicio</a>
    <a href="//suscripciones${tokenParam}">Suscripciones</a>
    <a href="//recompensas${tokenParam}">Recompensas</a>
    <a href="//referidos${tokenParam}">Referidos</a>
    <a href="//pedidos${tokenParam}">Pedidos</a>
    <a href="//contenido${tokenParam}">Contenido</a>
  </nav>
  <div class="portal-container">
    ${bodyHtml}
  </div>
</body>
</html>
  `.trim();
}

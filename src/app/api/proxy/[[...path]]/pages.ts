import { wrapInLiquid } from '@/lib/templates';
import { getSubscriptionsByEmail, getBillingAttempts } from '@/lib/seal';
import { getBalance, getTiers, getEvents } from '@/lib/rewards';
import { getOrCreateReferralCode, getReferralStats } from '@/lib/referrals';
import { getCustomerOrders } from '@/lib/shopify-admin';
import { getAccessibleContent } from '@/lib/content';

// =============================================
// LOGIN PAGE
// =============================================
export function renderLoginPage(emailSent: boolean, error?: string): string {
  let body = '';

  if (emailSent) {
    body = `
      <div style="text-align:center;padding:60px 20px;">
        <div style="font-size:48px;margin-bottom:16px;">📧</div>
        <h1>Revisa tu email</h1>
        <p style="font-size:16px;color:#cfbfad;max-width:400px;margin:0 auto;">
          Te hemos enviado un enlace de acceso. Haz clic en el enlace del email para entrar a tu portal.
        </p>
        <p style="font-size:13px;color:#cfbfad;margin-top:24px;">
          ¿No lo encuentras? Revisa tu carpeta de spam.
        </p>
      </div>
    `;
  } else {
    body = `
      <div style="text-align:center;padding:60px 20px;">
        <div style="font-size:48px;margin-bottom:16px;">⚡</div>
        <h1>Portal LIT</h1>
        <p style="font-size:16px;color:#cfbfad;max-width:400px;margin:0 auto 32px;">
          Accede a tu portal de suscriptor. Gestiona tu suscripción, acumula puntos y descubre contenido exclusivo.
        </p>
        ${error ? `<p style="color:#c0392b;margin-bottom:16px;">${error}</p>` : ''}
        <form method="POST" action="/api/proxy/login" style="max-width:360px;margin:0 auto;">
          <input type="email" name="email" placeholder="tu@email.com" required class="input" style="margin-bottom:12px;">
          <button type="submit" class="btn btn-primary btn-block">Enviar enlace de acceso</button>
        </form>
      </div>
    `;
  }

  return wrapInLiquid('Acceder', body);
}

// =============================================
// HOME PAGE
// =============================================
export async function renderHomePage(email: string, sessionToken: string): Promise<string> {
  const s = sessionToken ? `?s=${sessionToken}` : '';

  let subsHtml = '';
  try {
    const subs = await getSubscriptionsByEmail(email);
    const activeSubs = (subs || []).filter((sub: { status: string }) => sub.status === 'active');
    subsHtml = activeSubs.length > 0
      ? `<span class="badge badge-active">${activeSubs.length} activa${activeSubs.length > 1 ? 's' : ''}</span>`
      : '<span style="color:#cfbfad;">Sin suscripciones activas</span>';
  } catch {
    subsHtml = '<span style="color:#cfbfad;">—</span>';
  }

  let balance;
  try {
    balance = await getBalance(email);
  } catch {
    balance = { total_points: 0, current_tier: 'bronze' };
  }

  const body = `
    <div style="margin-bottom:32px;">
      <h1>Hola, bienvenido a tu portal 👋</h1>
      <p style="color:#cfbfad;font-size:15px;">${email}</p>
    </div>

    <div class="grid-2" style="margin-bottom:24px;">
      <div class="stat-card">
        <div class="stat-value">${balance.total_points}</div>
        <div class="stat-label">PUNTOS</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="text-transform:uppercase;font-size:24px;">${balance.current_tier}</div>
        <div class="stat-label">TU NIVEL</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Mis Suscripciones</h3>
        ${subsHtml}
      </div>
      <a href="/api/proxy/suscripciones${s}" class="btn btn-primary btn-sm">Gestionar</a>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Recompensas</h3>
        <span class="badge badge-${balance.current_tier}">${balance.current_tier}</span>
      </div>
      <p style="font-size:14px;color:#cfbfad;margin-bottom:12px;">Acumula puntos con cada compra y sube de nivel.</p>
      <a href="/api/proxy/recompensas${s}" class="btn btn-primary btn-sm">Ver mis puntos</a>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Invita a un amigo</h3>
      </div>
      <p style="font-size:14px;color:#cfbfad;margin-bottom:12px;">Comparte tu código y ganáis puntos los dos.</p>
      <a href="/api/proxy/referidos${s}" class="btn btn-primary btn-sm">Mi código de referido</a>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <a href="/api/proxy/pedidos${s}" class="card" style="text-decoration:none;color:inherit;text-align:center;">
        <div style="font-size:24px;margin-bottom:8px;">📦</div>
        <h3 style="font-size:15px;">Mis Pedidos</h3>
      </a>
      <a href="/api/proxy/contenido${s}" class="card" style="text-decoration:none;color:inherit;text-align:center;">
        <div style="font-size:24px;margin-bottom:8px;">🎬</div>
        <h3 style="font-size:15px;">Contenido Exclusivo</h3>
      </a>
    </div>
  `;

  return wrapInLiquid('Mi Portal', body, sessionToken);
}

// =============================================
// SUBSCRIPTIONS PAGE
// =============================================
export async function renderSubscriptionsPage(email: string, sessionToken: string): Promise<string> {
  const s = sessionToken ? `?s=${sessionToken}` : '';

  let subs;
  try {
    subs = await getSubscriptionsByEmail(email);
  } catch {
    subs = [];
  }

  if (!subs || subs.length === 0) {
    const body = `
      <h1>Mis Suscripciones</h1>
      <div class="empty-state">
        <div style="font-size:48px;margin-bottom:16px;">📭</div>
        <h2>No tienes suscripciones</h2>
        <p>Cuando te suscribas a un producto, aparecerá aquí.</p>
        <a href="https://litsalt.com" class="btn btn-primary" style="margin-top:16px;">Explorar productos</a>
      </div>
    `;
    return wrapInLiquid('Suscripciones', body, sessionToken);
  }

  let cardsHtml = '';
  for (const sub of subs) {
    const statusClass = sub.status === 'active' ? 'active' : sub.status === 'paused' ? 'paused' : 'cancelled';
    const statusLabel = sub.status === 'active' ? 'Activa' : sub.status === 'paused' ? 'Pausada' : 'Cancelada';

    const products = (sub.lines || sub.line_items || [])
      .map((line: { title: string; quantity: number; price: string }) =>
        `<div style="font-size:14px;padding:4px 0;">${line.title} × ${line.quantity} — ${line.price}€</div>`
      ).join('');

    const nextDelivery = sub.next_billing_date
      ? new Date(sub.next_billing_date).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })
      : '—';

    cardsHtml += `
      <div class="card">
        <div class="card-header">
          <h3>#${sub.id}</h3>
          <span class="badge badge-${statusClass}">${statusLabel}</span>
        </div>
        ${products}
        <div class="detail-row" style="margin-top:12px;">
          <span class="detail-label">Frecuencia</span>
          <span>Cada ${sub.delivery_interval || '?'} ${sub.delivery_interval_type || 'mes'}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Próxima entrega</span>
          <span>${nextDelivery}</span>
        </div>
        <div class="actions">
          ${sub.status === 'active' ? `
            <a href="/api/proxy/api/action/skip/${sub.id}${s ? s + '&' : '?'}action=skip" class="btn btn-primary btn-sm">Saltar entrega</a>
            <a href="/api/proxy/api/action/pause/${sub.id}${s ? s + '&' : '?'}action=pause" class="btn btn-secondary btn-sm">Pausar</a>
            <button onclick="showCancelModal('${sub.id}')" class="btn btn-danger btn-sm">Cancelar</button>
          ` : ''}
          ${sub.status === 'paused' ? `
            <a href="/api/proxy/api/action/resume/${sub.id}${s ? s + '&' : '?'}action=resume" class="btn btn-primary btn-sm">Reanudar</a>
          ` : ''}
        </div>
      </div>
    `;
  }

  const body = `
    <h1>Mis Suscripciones</h1>
    ${cardsHtml}

    <!-- Anti-churn modal -->
    <div class="modal-overlay" id="cancelModal">
      <div class="modal">
        <div id="cancelStep1">
          <div style="font-size:36px;margin-bottom:12px;">⚡</div>
          <h2>Antes de irte...</h2>
          <p style="font-size:15px;color:#cfbfad;margin-bottom:24px;">
            No tienes que cancelar. Puedes <strong>saltarte la próxima entrega</strong> y seguir disfrutando de tu suscripción.
          </p>
          <button onclick="doSkip()" class="btn btn-primary btn-block" style="margin-bottom:12px;">Saltarme esta entrega</button>
          <button onclick="showStep('cancelStep2')" class="btn btn-secondary btn-block">Quiero cancelar de verdad</button>
          <button onclick="closeModal()" style="background:none;border:none;color:#cfbfad;padding:10px;cursor:pointer;font-size:13px;margin-top:8px;">Volver</button>
        </div>
        <div id="cancelStep2" style="display:none;">
          <div style="font-size:36px;margin-bottom:12px;">😢</div>
          <h2>¿Seguro?</h2>
          <p style="font-size:15px;color:#cfbfad;margin-bottom:24px;">
            Perderás tu precio de suscriptor y los beneficios exclusivos.
          </p>
          <button onclick="closeModal()" class="btn btn-primary btn-block" style="margin-bottom:12px;">Mejor me la quedo</button>
          <button onclick="doCancel()" class="btn btn-danger btn-block">Cancelar suscripción</button>
        </div>
      </div>
    </div>

    <script>
      var currentSubId = null;
      function showCancelModal(subId) {
        currentSubId = subId;
        document.getElementById('cancelModal').classList.add('active');
        document.getElementById('cancelStep1').style.display = 'block';
        document.getElementById('cancelStep2').style.display = 'none';
      }
      function closeModal() {
        document.getElementById('cancelModal').classList.remove('active');
      }
      function showStep(id) {
        document.getElementById('cancelStep1').style.display = 'none';
        document.getElementById('cancelStep2').style.display = 'block';
      }
      function doSkip() {
        if (currentSubId) window.location.href = '/api/proxy/api/action/skip/' + currentSubId + '${s ? s + "&" : "?"}action=skip';
      }
      function doCancel() {
        if (currentSubId) window.location.href = '/api/proxy/api/action/cancel/' + currentSubId + '${s ? s + "&" : "?"}action=cancel';
      }
      document.getElementById('cancelModal').addEventListener('click', function(e) {
        if (e.target === this) closeModal();
      });
    </script>
  `;

  return wrapInLiquid('Suscripciones', body, sessionToken);
}

// =============================================
// SUBSCRIPTION DETAIL
// =============================================
export async function renderSubscriptionDetail(email: string, subId: string, sessionToken: string): Promise<string> {
  // For now, redirect to the list — detail can be added later
  return renderSubscriptionsPage(email, sessionToken);
}

// =============================================
// REWARDS PAGE
// =============================================
export async function renderRewardsPage(email: string, sessionToken: string): Promise<string> {
  const balance = await getBalance(email);
  const tiers = await getTiers();
  const events = await getEvents(email);

  // Find next tier
  const currentTierIndex = tiers.findIndex(t => t.name === balance.current_tier);
  const nextTier = tiers[currentTierIndex + 1];
  const progressPercent = nextTier
    ? Math.min(100, Math.round((balance.total_points / nextTier.min_points) * 100))
    : 100;
  const pointsToNext = nextTier ? nextTier.min_points - balance.total_points : 0;

  // Tier benefits
  const currentTierData = tiers.find(t => t.name === balance.current_tier);
  const benefitsHtml = (currentTierData?.benefits_json || [])
    .map((b: string) => `<div style="padding:4px 0;font-size:14px;">✅ ${b}</div>`).join('');

  // Events history
  const eventsHtml = events.length > 0
    ? events.map(e => {
        const typeLabels: Record<string, string> = {
          purchase: '🛒 Compra',
          referral: '👥 Referido',
          review: '⭐ Review',
          challenge: '🏆 Reto',
          redemption: '🎁 Canje',
        };
        const date = new Date(e.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
        const sign = e.points >= 0 ? '+' : '';
        return `
          <div class="detail-row">
            <span>${typeLabels[e.event_type] || e.event_type} <span style="color:#cfbfad;font-size:12px;">${date}</span></span>
            <span style="font-weight:700;color:${e.points >= 0 ? '#323743' : '#c0392b'};">${sign}${e.points} pts</span>
          </div>
        `;
      }).join('')
    : '<div class="empty-state"><p>Aún no tienes movimientos</p></div>';

  const body = `
    <h1>Mis Recompensas</h1>

    <div class="grid-2" style="margin-bottom:24px;">
      <div class="stat-card">
        <div class="stat-value">${balance.total_points}</div>
        <div class="stat-label">PUNTOS TOTALES</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="text-transform:uppercase;font-size:24px;">${balance.current_tier}</div>
        <div class="stat-label">TU NIVEL</div>
      </div>
    </div>

    ${nextTier ? `
      <div class="card">
        <h3>Próximo nivel: ${nextTier.name.charAt(0).toUpperCase() + nextTier.name.slice(1)}</h3>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${progressPercent}%"></div>
        </div>
        <p style="font-size:13px;color:#cfbfad;">Te faltan ${pointsToNext} puntos para subir a ${nextTier.name}</p>
      </div>
    ` : `
      <div class="card">
        <h3>🏆 ¡Nivel máximo alcanzado!</h3>
        <p style="font-size:14px;color:#cfbfad;">Estás en el nivel más alto. Disfruta de todos los beneficios.</p>
      </div>
    `}

    <div class="card">
      <h3>Beneficios de tu nivel</h3>
      ${benefitsHtml}
    </div>

    <div class="card">
      <h3>Cómo ganar puntos</h3>
      <div class="detail-row"><span>🛒 Cada compra</span><span>1 punto por €</span></div>
      <div class="detail-row"><span>👥 Referir un amigo</span><span>500 puntos</span></div>
      <div class="detail-row"><span>⭐ Dejar una review</span><span>100 puntos</span></div>
      <div class="detail-row"><span>🏆 Completar un reto</span><span>Variable</span></div>
    </div>

    <div class="card">
      <h3>Historial de movimientos</h3>
      ${eventsHtml}
    </div>
  `;

  return wrapInLiquid('Recompensas', body, sessionToken);
}

// =============================================
// REFERRALS PAGE
// =============================================
export async function renderReferralsPage(email: string, sessionToken: string): Promise<string> {
  const code = await getOrCreateReferralCode(email);
  const stats = await getReferralStats(email);
  const referralLink = `https://litsalt.com?ref=${code}`;

  const conversionsHtml = stats.conversions.length > 0
    ? stats.conversions.map(c => {
        const date = new Date(c.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
        const statusBadge = c.status === 'confirmed'
          ? '<span class="badge badge-active">Confirmado</span>'
          : '<span class="badge badge-paused">Pendiente</span>';
        return `
          <div class="detail-row">
            <span>${c.referred_email.replace(/(.{2}).*(@.*)/, '$1***$2')} <span style="color:#cfbfad;font-size:12px;">${date}</span></span>
            <span>${statusBadge} ${c.points_awarded > 0 ? `+${c.points_awarded} pts` : ''}</span>
          </div>
        `;
      }).join('')
    : '<div class="empty-state"><p>Aún no tienes referidos. ¡Comparte tu link!</p></div>';

  const body = `
    <h1>Invita a un amigo</h1>

    <div class="card">
      <h3>Tu código de referido</h3>
      <div style="background:#323743;color:#ebee62;padding:16px;border-radius:10px;text-align:center;font-size:24px;font-family:'Clash Display',sans-serif;font-weight:700;margin:12px 0;">
        ${code}
      </div>
      <div style="margin:12px 0;">
        <input type="text" value="${referralLink}" readonly class="input" id="refLink" style="font-size:13px;">
      </div>
      <div class="actions" style="justify-content:center;">
        <button onclick="navigator.clipboard.writeText('${referralLink}');this.textContent='¡Copiado!'" class="btn btn-primary btn-sm">Copiar link</button>
        <a href="https://wa.me/?text=${encodeURIComponent(`¡Prueba LIT Hydration! Usa mi link: ${referralLink}`)}" target="_blank" class="btn btn-secondary btn-sm">WhatsApp</a>
      </div>
    </div>

    <div class="grid-2" style="margin-bottom:16px;">
      <div class="stat-card">
        <div class="stat-value">${stats.conversions.length}</div>
        <div class="stat-label">REFERIDOS</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.totalPoints}</div>
        <div class="stat-label">PUNTOS GANADOS</div>
      </div>
    </div>

    <div class="card">
      <h3>Cómo funciona</h3>
      <div class="detail-row"><span>1.</span><span>Comparte tu link con un amigo</span></div>
      <div class="detail-row"><span>2.</span><span>Tu amigo compra en LIT</span></div>
      <div class="detail-row"><span>3.</span><span>¡Los dos ganáis 500 puntos!</span></div>
    </div>

    <div class="card">
      <h3>Mis referidos</h3>
      ${conversionsHtml}
    </div>
  `;

  return wrapInLiquid('Referidos', body, sessionToken);
}

// =============================================
// ORDERS PAGE
// =============================================
export async function renderOrdersPage(email: string, sessionToken: string): Promise<string> {
  let orders;
  try {
    orders = await getCustomerOrders(email);
  } catch {
    orders = [];
  }

  if (!orders || orders.length === 0) {
    const body = `
      <h1>Mis Pedidos</h1>
      <div class="empty-state">
        <div style="font-size:48px;margin-bottom:16px;">📦</div>
        <h2>No tienes pedidos</h2>
        <a href="https://litsalt.com" class="btn btn-primary" style="margin-top:16px;">Ir a la tienda</a>
      </div>
    `;
    return wrapInLiquid('Pedidos', body, sessionToken);
  }

  const ordersHtml = orders.map((order: {
    name: string;
    createdAt: string;
    displayFinancialStatus: string;
    displayFulfillmentStatus: string;
    totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
    lineItems: { edges: { node: { title: string; quantity: number; variant?: { image?: { url: string } } } }[] };
    fulfillments: { trackingInfo: { number: string; url: string }[]; status: string }[];
  }) => {
    const date = new Date(order.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    const total = `${parseFloat(order.totalPriceSet.shopMoney.amount).toFixed(2)} ${order.totalPriceSet.shopMoney.currencyCode}`;

    const fulfillmentStatus = order.displayFulfillmentStatus || 'PENDING';
    const statusMap: Record<string, string> = {
      FULFILLED: 'Enviado',
      UNFULFILLED: 'Preparando',
      PARTIALLY_FULFILLED: 'Parcialmente enviado',
      PENDING: 'Pendiente',
    };

    const tracking = order.fulfillments?.[0]?.trackingInfo?.[0];

    const items = order.lineItems.edges.map(({ node }: { node: { title: string; quantity: number; variant?: { image?: { url: string } } } }) => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 0;">
        ${node.variant?.image?.url ? `<img src="${node.variant.image.url}" width="40" height="40" style="border-radius:6px;object-fit:cover;">` : ''}
        <span style="font-size:14px;">${node.title} × ${node.quantity}</span>
      </div>
    `).join('');

    return `
      <div class="card">
        <div class="card-header">
          <h3>${order.name}</h3>
          <span class="badge badge-active">${statusMap[fulfillmentStatus] || fulfillmentStatus}</span>
        </div>
        <p style="font-size:13px;color:#cfbfad;margin-bottom:8px;">${date} — ${total}</p>
        ${items}
        ${tracking ? `
          <div style="margin-top:12px;">
            <a href="${tracking.url}" target="_blank" class="btn btn-secondary btn-sm">📍 Tracking: ${tracking.number}</a>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  const body = `
    <h1>Mis Pedidos</h1>
    ${ordersHtml}
  `;

  return wrapInLiquid('Pedidos', body, sessionToken);
}

// =============================================
// CONTENT PAGE
// =============================================
export async function renderContentPage(email: string, sessionToken: string): Promise<string> {
  const balance = await getBalance(email);

  // Check if active subscriber
  let isActiveSubscriber = false;
  try {
    const subs = await getSubscriptionsByEmail(email);
    isActiveSubscriber = (subs || []).some((sub: { status: string }) => sub.status === 'active');
  } catch {
    // ignore
  }

  const { accessible, locked } = await getAccessibleContent(balance.current_tier, isActiveSubscriber);

  const accessibleHtml = accessible.length > 0
    ? accessible.map(item => `
        <div class="card">
          ${item.thumbnail_url ? `<img src="${item.thumbnail_url}" style="width:100%;border-radius:8px;margin-bottom:12px;">` : ''}
          <h3>${item.title}</h3>
          <p style="font-size:14px;color:#cfbfad;margin-bottom:12px;">${item.description || ''}</p>
          ${item.video_url ? `
            <div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;">
              <iframe src="${item.video_url}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;" allowfullscreen></iframe>
            </div>
          ` : ''}
        </div>
      `).join('')
    : '<div class="empty-state"><p>No hay contenido disponible todavía.</p></div>';

  const lockedHtml = locked.length > 0
    ? locked.map(item => `
        <div class="card" style="opacity:0.5;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h3>🔒 ${item.title}</h3>
            <span class="badge badge-${item.required_tier}">${item.required_tier}</span>
          </div>
          <p style="font-size:13px;color:#cfbfad;">
            ${item.required_status === 'active_subscriber' ? 'Requiere suscripción activa' : ''}
            ${item.required_tier !== 'bronze' ? `Nivel ${item.required_tier} o superior` : ''}
          </p>
        </div>
      `).join('')
    : '';

  const body = `
    <h1>Contenido Exclusivo</h1>
    <p style="color:#cfbfad;margin-bottom:24px;">
      Tu nivel: <span class="badge badge-${balance.current_tier}">${balance.current_tier}</span>
      ${isActiveSubscriber ? '<span class="badge badge-active" style="margin-left:8px;">Suscriptor activo</span>' : ''}
    </p>

    ${accessibleHtml}

    ${lockedHtml ? `
      <h2 style="margin-top:32px;">Contenido bloqueado</h2>
      <p style="color:#cfbfad;margin-bottom:16px;font-size:14px;">Sube de nivel o activa tu suscripción para desbloquear.</p>
      ${lockedHtml}
    ` : ''}
  `;

  return wrapInLiquid('Contenido', body, sessionToken);
}

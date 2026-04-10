import { NextRequest, NextResponse } from 'next/server';
import { validateToken, validateSession, createMagicToken, getMagicLinkUrl } from '@/lib/auth';
import { wrapInLiquid } from '@/lib/templates';
import { renderLoginPage, renderHomePage, renderSubscriptionsPage, renderSubscriptionDetail, renderRewardsPage, renderReferralsPage, renderOrdersPage, renderContentPage } from './pages';

// App Proxy handler — receives all requests from Shopify
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await params;
  const route = (path || []).join('/');
  const searchParams = request.nextUrl.searchParams;

  // --- Auth: check for token or session ---
  const token = searchParams.get('token');
  const sessionToken = searchParams.get('s');

  let session = null;

  if (token) {
    // Magic link click — validate and create session
    session = await validateToken(token);
    if (session) {
      // Redirect to portal with session token
      // We need to return the page directly since App Proxy doesn't support redirects well
    }
  }

  if (!session && sessionToken) {
    session = await validateSession(sessionToken);
  }

  // --- Routing ---
  try {
    // Login page (no auth required)
    if (!session) {
      return liquidResponse(renderLoginPage(route === 'login-sent'));
    }

    const email = session.email;
    const sParam = sessionToken || '';

    switch (route) {
      case '':
      case 'inicio':
        return liquidResponse(await renderHomePage(email, sParam));

      case 'suscripciones':
        return liquidResponse(await renderSubscriptionsPage(email, sParam));

      case route.match(/^suscripciones\/(.+)/)?.input: {
        const subId = route.replace('suscripciones/', '');
        return liquidResponse(await renderSubscriptionDetail(email, subId, sParam));
      }

      case 'recompensas':
        return liquidResponse(await renderRewardsPage(email, sParam));

      case 'referidos':
        return liquidResponse(await renderReferralsPage(email, sParam));

      case 'pedidos':
        return liquidResponse(await renderOrdersPage(email, sParam));

      case 'contenido':
        return liquidResponse(await renderContentPage(email, sParam));

      default:
        return liquidResponse(await renderHomePage(email, sParam));
    }
  } catch (error) {
    console.error('[LIT Portal] Error:', error);
    return liquidResponse(
      wrapInLiquid('Error', '<div class="empty-state"><h2>Algo salió mal</h2><p>Inténtalo de nuevo más tarde.</p></div>')
    );
  }
}

// Handle login form submission
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const email = formData.get('email') as string;

    if (!email) {
      return liquidResponse(renderLoginPage(false, 'Por favor introduce tu email.'));
    }

    // Create magic token
    const token = await createMagicToken(email);
    const magicLink = getMagicLinkUrl(token);

    // TODO: Send email via Klaviyo
    // For now, log the link (remove in production)
    console.log(`[LIT Portal] Magic link for ${email}: ${magicLink}`);

    return liquidResponse(renderLoginPage(true));
  } catch (error) {
    console.error('[LIT Portal] Login error:', error);
    return liquidResponse(renderLoginPage(false, 'Error al enviar el email. Inténtalo de nuevo.'));
  }
}

function liquidResponse(html: string) {
  return new NextResponse(html, {
    headers: {
      'Content-Type': 'application/liquid',
    },
  });
}

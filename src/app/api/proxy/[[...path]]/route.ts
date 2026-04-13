import { NextRequest, NextResponse } from 'next/server';
import { validateToken, validateSession, createMagicToken, getMagicLinkUrl } from '@/lib/auth';
import { wrapInLiquid } from '@/lib/templates';
import { sendMagicLinkEmail } from '@/lib/klaviyo';
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
      return portalResponse(renderLoginPage(route === 'login-sent'), request);
    }

    const email = session.email;
    const sParam = sessionToken || '';

    switch (route) {
      case '':
      case 'inicio':
        return portalResponse(await renderHomePage(email, sParam), request);

      case 'suscripciones':
        return portalResponse(await renderSubscriptionsPage(email, sParam), request);

      case route.match(/^suscripciones\/(.+)/)?.input: {
        const subId = route.replace('suscripciones/', '');
        return portalResponse(await renderSubscriptionDetail(email, subId, sParam), request);
      }

      case 'recompensas':
        return portalResponse(await renderRewardsPage(email, sParam), request);

      case 'referidos':
        return portalResponse(await renderReferralsPage(email, sParam), request);

      case 'pedidos':
        return portalResponse(await renderOrdersPage(email, sParam), request);

      case 'contenido':
        return portalResponse(await renderContentPage(email, sParam), request);

      default:
        return portalResponse(await renderHomePage(email, sParam), request);
    }
  } catch (error) {
    console.error('[LIT Portal] Error:', error);
    return portalResponse(
      wrapInLiquid('Error', '<div class="empty-state"><h2>Algo salió mal</h2><p>Inténtalo de nuevo más tarde.</p></div>'),
      request
    );
  }
}

// Handle login form submission
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const email = formData.get('email') as string;

    if (!email) {
      return portalResponse(renderLoginPage(false, 'Por favor introduce tu email.'), request);
    }

    // Create magic token
    const token = await createMagicToken(email);
    const magicLink = getMagicLinkUrl(token);

    // Send magic link via Klaviyo
    const sent = await sendMagicLinkEmail(email, magicLink);
    if (!sent) {
      console.warn(`[LIT Portal] Klaviyo failed, magic link for ${email}: ${magicLink}`);
    }

    return portalResponse(renderLoginPage(true), request);
  } catch (error) {
    console.error('[LIT Portal] Login error:', error);
    return portalResponse(renderLoginPage(false, 'Error al enviar el email. Inténtalo de nuevo.'), request);
  }
}

function isAppProxy(request: NextRequest): boolean {
  return request.nextUrl.searchParams.has('shop') && request.nextUrl.searchParams.has('signature');
}

function portalResponse(html: string, request?: NextRequest): NextResponse {
  const viaProxy = request ? isAppProxy(request) : false;
  let content = html;

  // Strip Liquid tags when serving directly (not via App Proxy)
  if (!viaProxy) {
    content = content.replace(/\{%.*?%\}/g, '');
  }

  return new NextResponse(content, {
    headers: {
      'Content-Type': viaProxy ? 'application/liquid' : 'text/html; charset=utf-8',
    },
  });
}

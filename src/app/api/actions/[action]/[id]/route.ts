import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/auth';
import { pauseSubscription, resumeSubscription, cancelSubscription, skipBillingAttempt, getBillingAttempts } from '@/lib/seal';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ action: string; id: string }> }
) {
  const { action, id } = await params;
  const sessionToken = request.nextUrl.searchParams.get('s') || '';

  // Verify session
  const session = await validateSession(sessionToken);
  if (!session) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  try {
    switch (action) {
      case 'skip': {
        // Get billing attempts for this subscription and skip the next one
        const response = await getBillingAttempts(id);
        const attempts = response?.payload?.billing_attempts || response?.billing_attempts || response || [];
        const nextAttempt = attempts.find((a: { status: string }) =>
          a.status === 'PENDING' || a.status === 'QUEUED'
        );
        if (nextAttempt) {
          await skipBillingAttempt(nextAttempt.id);
        }
        break;
      }
      case 'pause':
        await pauseSubscription(id);
        break;
      case 'resume':
        await resumeSubscription(id);
        break;
      case 'cancel':
        await cancelSubscription(id);
        break;
      default:
        break;
    }
  } catch (error) {
    console.error(`[LIT Portal] Action ${action} error:`, error);
  }

  // Redirect back to subscriptions page
  const redirectUrl = new URL(`/suscripciones${sessionToken ? `?s=${sessionToken}` : ''}`, request.url);
  return NextResponse.redirect(redirectUrl);
}

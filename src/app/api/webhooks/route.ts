import { NextRequest, NextResponse } from 'next/server';
import { addPoints } from '@/lib/rewards';

// Webhook handler for Shopify events (orders/create, etc.)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const topic = request.headers.get('x-shopify-topic');

    switch (topic) {
      case 'orders/create':
      case 'orders/paid': {
        const email = body.email || body.customer?.email;
        const totalPrice = parseFloat(body.total_price || '0');

        if (email && totalPrice > 0) {
          const points = Math.floor(totalPrice); // 1 point per EUR
          await addPoints(email, 'purchase', points, {
            order_id: body.id,
            order_name: body.name,
            total_price: totalPrice,
          });
          console.log(`[Webhook] Added ${points} points for ${email} (order ${body.name})`);
        }

        // Check for referral UTM
        const refCode = body.note_attributes?.find(
          (attr: { name: string; value: string }) => attr.name === 'ref'
        )?.value;

        if (refCode && email) {
          const { supabase } = await import('@/lib/supabase');

          // Check if referral code exists
          const { data: codeData } = await supabase
            .from('referral_codes')
            .select('code, customer_email')
            .eq('code', refCode)
            .single();

          if (codeData && codeData.customer_email !== email.toLowerCase()) {
            // Register conversion
            await supabase.from('referral_conversions').insert({
              referrer_code: refCode,
              referred_email: email.toLowerCase(),
              order_id: String(body.id),
              status: 'confirmed',
              points_awarded: 500,
            });

            // Award points to referrer
            await addPoints(codeData.customer_email, 'referral', 500, {
              referred_email: email,
              order_id: body.id,
            });

            // Award points to referred
            await addPoints(email, 'referral', 500, {
              referrer_code: refCode,
              type: 'welcome_bonus',
            });

            console.log(`[Webhook] Referral: ${refCode} → ${email}, 500 pts each`);
          }
        }
        break;
      }

      default:
        console.log(`[Webhook] Unhandled topic: ${topic}`);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Webhook] Error:', error);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

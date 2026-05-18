import { withCustomer } from "@/lib/api-helpers";
import { shopifyAdmin, type PaymentInstrument } from "@/lib/shopify-admin";

interface PaymentMethodResponse {
  instrument: PaymentInstrument | null;
  /**
   * Single-use Shopify-hosted URL where the customer can replace their
   * stored payment method. Null when the customer has no method on file
   * or when Shopify returns userErrors.
   */
  updateUrl: string | null;
}

/**
 * GET /apps/portal/api/payment-method
 *
 * Returns the customer's active payment instrument (PayPal / card / Shop
 * Pay) plus a fresh single-use URL to update it. Generated on every read
 * because Shopify's update URLs expire after first use.
 */
export const GET = withCustomer<PaymentMethodResponse>(async (_req, ctx) => {
  const instrument = await shopifyAdmin.getCustomerPaymentMethod(ctx.customerId);
  if (!instrument) {
    return { instrument: null, updateUrl: null };
  }
  const updateUrl = await shopifyAdmin
    .getPaymentMethodUpdateUrl(instrument.id)
    .catch(() => null);
  return { instrument, updateUrl };
});

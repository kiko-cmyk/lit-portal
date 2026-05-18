import { ApiHttpError, withCustomer } from "@/lib/api-helpers";
import { shopifyAdmin } from "@/lib/shopify-admin";

interface Response {
  sent: boolean;
  email: string | null;
}

/**
 * POST /apps/portal/api/payment-method/send-update-email
 *
 * Fallback for payment methods Shopify can't update inline (PayPal,
 * Shop Pay): triggers `customerPaymentMethodSendUpdateEmail` so the
 * customer receives a one-time link in their inbox. Returns the email
 * we sent to so the UI can show a confirmation toast.
 */
export const POST = withCustomer<Response>(async (_req, ctx) => {
  const instrument = await shopifyAdmin.getCustomerPaymentMethod(ctx.customerId);
  if (!instrument) {
    throw new ApiHttpError(404, "no_payment_method", "Customer has no payment method on file");
  }
  const sent = await shopifyAdmin.sendPaymentMethodUpdateEmail(instrument.id);
  if (!sent) {
    throw new ApiHttpError(500, "shopify_email_failed", "Shopify rejected the send-update-email request");
  }
  const email = await shopifyAdmin.getCustomerEmail(ctx.customerId);
  return { sent: true, email };
});

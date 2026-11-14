import { isHtmlErrorPage } from './isHtmlErrorPage'
import { extractStructuredApiError } from './extractStructuredApiError'
import { extractApiErrorMessage } from './extractApiErrorMessage'

export interface RefundPaymentIntentResult {
  ok: boolean
  message?: string
  /** With `ok: false`: no clear answer came back, so the money may have gone. Without it, Stripe or
   *  the Worker said no, and nothing moved. */
  unsure?: boolean
}

/**
 * Refunds `amount` (decimal pounds) against a Stripe PaymentIntent via the deployed backend's
 * /api/payments/refund-order endpoint — the same call refundOrder.ts uses for card refunds.
 * Used by createOrder.ts's membership-subscription compensation path: when a subscription's
 * first invoice was charged but the rest of the order failed, the payment is refunded so no
 * money is left taken for an order that never happened.
 *
 * Only `{ success: true }` is a yes, and only a JSON error is a no. Anything else, including a
 * call that threw, is `unsure`, and so is a JSON error saying the Worker lost Stripe's answer.
 *
 * `idempotencyKey`: Stripe answers a repeat of the key with the first refund instead of making a
 * second, so a retry after a lost answer can't pay twice. Keys last at least 24 hours.
 */
export async function refundPaymentIntent(
  paymentIntentId: string,
  amount: number,
  idempotencyKey?: string
): Promise<RefundPaymentIntentResult> {
  try {
    const response = await paddockBackendApi2.rawRequest<{ success?: boolean; error?: string; details?: string; unsure?: boolean }>({
      path: '/api/payments/refund-order',
      method: 'POST',
      body: { paymentIntentId, amount, ...(idempotencyKey ? { idempotencyKey } : {}) },
    })
    if (isHtmlErrorPage(response.data)) {
      return { ok: false, unsure: true, message: 'The refund endpoint returned an HTML page instead of a JSON response.' }
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      return { ok: false, message: structuredError, ...(response.data.unsure === true ? { unsure: true } : {}) }
    }
    if (response.data?.success !== true) {
      return { ok: false, unsure: true, message: "The refund endpoint's answer didn't say whether the refund went through." }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, unsure: true, message: extractApiErrorMessage(err, 'Failed to refund the payment') }
  }
}

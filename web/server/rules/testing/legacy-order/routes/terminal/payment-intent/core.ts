import Stripe from 'stripe'

// Look up or cancel a card-reader PaymentIntent. Used by Retool's order-first reader flow:
//   - 'retrieve': finalise checks the charge really succeeded (status, amount, currency, metadata)
//     before marking the pending order paid; the scheduled check uses it for stuck orders.
//   - 'cancel':   when the reader is cancelled, declined or times out, the PaymentIntent is
//     cancelled so it can never be captured later. A PaymentIntent that has already succeeded is
//     NEVER cancelled; the caller gets alreadySucceeded: true and must finalise instead.

export type PaymentIntentAction = 'retrieve' | 'cancel'

export interface PaymentIntentParams {
  paymentIntentId: string
  action: PaymentIntentAction
}

export interface PaymentIntentSummary {
  id: string
  status: Stripe.PaymentIntent.Status
  amount: number // pounds
  amountReceived: number // pounds
  currency: string
  metadata: Record<string, string>
  customerId: string | null
  created: string
}

export type PaymentIntentResult =
  | { success: true; paymentIntent: PaymentIntentSummary; cancelled?: boolean; alreadySucceeded?: boolean }
  | { success: false; status: number; error: string; code?: string }

export interface PaymentIntentDeps {
  retrieve: (id: string) => Promise<Stripe.PaymentIntent>
  cancel: (id: string) => Promise<Stripe.PaymentIntent>
}

const CANCELLABLE: Stripe.PaymentIntent.Status[] = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture',
  'processing',
]

export function summarise(pi: Stripe.PaymentIntent): PaymentIntentSummary {
  const customer = pi.customer
  return {
    id: pi.id,
    status: pi.status,
    amount: (pi.amount ?? 0) / 100,
    amountReceived: (pi.amount_received ?? 0) / 100,
    currency: pi.currency,
    metadata: (pi.metadata ?? {}) as Record<string, string>,
    customerId: typeof customer === 'string' ? customer : customer?.id ?? null,
    created: new Date((pi.created ?? 0) * 1000).toISOString(),
  }
}

export async function handlePaymentIntent(
  params: PaymentIntentParams,
  deps: PaymentIntentDeps
): Promise<PaymentIntentResult> {
  const { paymentIntentId, action } = params
  if (!paymentIntentId || typeof paymentIntentId !== 'string' || !paymentIntentId.startsWith('pi_')) {
    return { success: false, status: 400, error: 'paymentIntentId must be a Stripe PaymentIntent id (pi_...)', code: 'invalid_id' }
  }
  if (action !== 'retrieve' && action !== 'cancel') {
    return { success: false, status: 400, error: 'action must be "retrieve" or "cancel"', code: 'invalid_action' }
  }

  let pi: Stripe.PaymentIntent
  try {
    pi = await deps.retrieve(paymentIntentId)
  } catch (error) {
    const err = error as Stripe.errors.StripeError
    if (err?.statusCode === 404 || err?.code === 'resource_missing') {
      return { success: false, status: 404, error: 'PaymentIntent not found', code: 'not_found' }
    }
    return { success: false, status: 502, error: err?.message ?? 'Failed to retrieve PaymentIntent', code: 'stripe_error' }
  }

  if (action === 'retrieve') return { success: true, paymentIntent: summarise(pi) }

  if (pi.status === 'succeeded') {
    return { success: true, paymentIntent: summarise(pi), cancelled: false, alreadySucceeded: true }
  }
  if (pi.status === 'canceled') {
    return { success: true, paymentIntent: summarise(pi), cancelled: true }
  }
  if (!CANCELLABLE.includes(pi.status)) {
    return { success: false, status: 409, error: `PaymentIntent cannot be cancelled in status ${pi.status}`, code: 'not_cancellable' }
  }

  try {
    const cancelled = await deps.cancel(paymentIntentId)
    return { success: true, paymentIntent: summarise(cancelled), cancelled: true }
  } catch (error) {
    // The charge may have completed between our retrieve and cancel. Re-read so the caller
    // finalises instead of rolling back an order whose money was taken.
    try {
      const latest = await deps.retrieve(paymentIntentId)
      if (latest.status === 'succeeded') {
        return { success: true, paymentIntent: summarise(latest), cancelled: false, alreadySucceeded: true }
      }
      if (latest.status === 'canceled') {
        return { success: true, paymentIntent: summarise(latest), cancelled: true }
      }
    } catch {
      // fall through to the original error
    }
    const err = error as Stripe.errors.StripeError
    return { success: false, status: 502, error: err?.message ?? 'Failed to cancel PaymentIntent', code: 'stripe_error' }
  }
}

import { isHtmlErrorPage } from './shared/isHtmlErrorPage'
import { extractStructuredApiError } from './shared/extractStructuredApiError'
import { extractApiErrorMessage } from './shared/extractApiErrorMessage'
import { resolveStaffId } from './shared/resolveStaffId'

export interface CreateTerminalPaymentIntentParams {
  customerId: string
  /** The amount to charge, in the same decimal-pounds units used everywhere else in this app (e.g. 15.00, not 1500). */
  amount: number
  /** When true, the backend attaches setup_future_usage: 'off_session' so the card can be reused later. */
  saveCard: boolean
  /** Optional Stripe metadata keys the Worker accepts (only order_id, flow, record_id; non-empty
   *  strings). The PaymentIntent always also carries supabase_customer_id. */
  metadata?: Record<string, string>
  /** Optional human-readable description stored on the PaymentIntent. */
  description?: string
}

// Verified live against the deployed backend (2026-09-08): { success: true, clientSecret,
// paymentIntentId, stripeCustomerId }. Creating the PaymentIntent itself does not move any
// money — only the Terminal SDK's collectPaymentMethod + processPayment steps (run from the
// frontend against this clientSecret) actually charge the card.
export interface CreateTerminalPaymentIntentResult {
  clientSecret: string
  paymentIntentId: string
  stripeCustomerId: string
}

/** The work itself, for functions that have already refused an inactive account at their start,
 *  so nothing new can fail in the middle of their payment flow. */
export async function createTerminalPaymentIntentUnguarded(
  req: { params: CreateTerminalPaymentIntentParams }
): Promise<CreateTerminalPaymentIntentResult> {
  // Pull metadata/description explicitly — they are optional but used below.
  const { customerId, amount, saveCard, metadata, description } = req.params
  if (!customerId) {
    throw new Error('customerId is required')
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number')
  }

  try {
    const response = await paddockBackendApi2.rawRequest<{
      success?: boolean
      clientSecret?: string
      paymentIntentId?: string
      stripeCustomerId?: string
      error?: string
      details?: string
    }>({
      path: '/api/terminal/create-payment-intent',
      method: 'POST',
      body: {
        customerId,
        amount,
        saveCard,
        ...(metadata ? { metadata } : {}),
        ...(description ? { description } : {}),
      },
    })
    if (isHtmlErrorPage(response.data)) {
      throw new Error(
        'The payment-intent endpoint returned an HTML page instead of a JSON response — the "Paddock ' +
          'Backend API" resource is very likely misconfigured.'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      throw new Error(structuredError)
    }
    if (!response.data.clientSecret || !response.data.paymentIntentId || !response.data.stripeCustomerId) {
      throw new Error('The payment-intent endpoint did not return the expected fields.')
    }
    return {
      clientSecret: response.data.clientSecret,
      paymentIntentId: response.data.paymentIntentId,
      stripeCustomerId: response.data.stripeCustomerId,
    }
  } catch (err) {
    throw new Error(extractApiErrorMessage(err, 'Failed to create terminal payment intent'))
  }
}

export default async function createTerminalPaymentIntent(req: { params: CreateTerminalPaymentIntentParams; user: User }): Promise<CreateTerminalPaymentIntentResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  return createTerminalPaymentIntentUnguarded(req)
}

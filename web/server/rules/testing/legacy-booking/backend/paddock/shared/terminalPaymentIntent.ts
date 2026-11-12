import { isHtmlErrorPage } from './isHtmlErrorPage'
import { extractStructuredApiError } from './extractStructuredApiError'
import { extractApiErrorMessage } from './extractApiErrorMessage'

export type TerminalPaymentIntentAction = 'retrieve' | 'cancel'

export interface TerminalPaymentIntentInfo {
  id: string
  status: string
  /** Pounds (decimal), as returned by the Worker. */
  amount: number
  /** Pounds actually received (0 until succeeded). */
  amountReceived: number
  currency: string
  metadata: Record<string, string>
  customerId: string | null
  created: string | null
}

export interface TerminalPaymentIntentResult {
  ok: boolean
  paymentIntent?: TerminalPaymentIntentInfo
  /** 'cancel' action only: the intent was already SUCCEEDED — the Worker never cancels a
   *  succeeded intent; the caller must finalise instead of rolling back. */
  alreadySucceeded?: boolean
  /** 'cancel' action only: the Worker cancelled the intent. */
  cancelled?: boolean
  code?: 'invalid_id' | 'invalid_action' | 'not_found' | 'not_cancellable' | 'stripe_error' | 'http_error'
  message?: string
}

interface WorkerResponse {
  success?: boolean
  paymentIntent?: {
    id?: string
    status?: string
    amount?: number | string
    amountReceived?: number | string
    amount_received?: number | string
    currency?: string
    metadata?: Record<string, unknown>
    customerId?: string | null
    customer_id?: string | null
    created?: string | null
  }
  cancelled?: boolean
  alreadySucceeded?: boolean
  error?: string
  code?: string
  details?: string
}

/** retrieve/cancel a Terminal PaymentIntent via the Worker's
 *  POST /api/terminal/payment-intent ({ paymentIntentId, action }). Cancel NEVER cancels a
 *  succeeded intent — it reports alreadySucceeded so the caller finalises instead. */
export async function terminalPaymentIntentAction(
  paymentIntentId: string,
  action: TerminalPaymentIntentAction
): Promise<TerminalPaymentIntentResult> {
  try {
    const response = await paddockBackendApi2.rawRequest<WorkerResponse>({
      path: '/api/terminal/payment-intent',
      method: 'POST',
      body: { paymentIntentId, action },
    })
    if (isHtmlErrorPage(response.data)) {
      return {
        ok: false,
        code: 'http_error',
        message:
          'The payment-intent endpoint returned an HTML page instead of a JSON response — the "Paddock Backend API" resource is very likely misconfigured.',
      }
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      const code = typeof response.data.code === 'string' ? response.data.code : undefined
      const normalized =
        code === 'invalid_id' || code === 'invalid_action' || code === 'not_found' || code === 'not_cancellable' || code === 'stripe_error'
          ? code
          : 'stripe_error'
      return { ok: false, code: normalized, message: structuredError }
    }
    const pi = response.data.paymentIntent
    if (!response.data.success || !pi?.id || typeof pi.status !== 'string') {
      return { ok: false, code: 'stripe_error', message: 'The payment-intent endpoint did not return the expected fields.' }
    }
    const metadata: Record<string, string> = {}
    if (pi.metadata && typeof pi.metadata === 'object') {
      for (const [key, value] of Object.entries(pi.metadata)) {
        if (typeof value === 'string') metadata[key] = value
      }
    }
    return {
      ok: true,
      paymentIntent: {
        id: pi.id,
        status: pi.status,
        amount: typeof pi.amount === 'number' ? pi.amount : Number.parseFloat(String(pi.amount ?? '0')) || 0,
        amountReceived:
          typeof pi.amount_received === 'number'
            ? pi.amount_received
            : Number.parseFloat(String(pi.amount_received ?? pi.amountReceived ?? '0')) || 0,
        currency: (pi.currency ?? '').toLowerCase(),
        metadata,
        customerId: pi.customer_id ?? pi.customerId ?? null,
        created: pi.created ?? null,
      },
      ...(action === 'cancel' ? { cancelled: response.data.cancelled === true, alreadySucceeded: response.data.alreadySucceeded === true } : {}),
    }
  } catch (err) {
    return { ok: false, code: 'stripe_error', message: extractApiErrorMessage(err, 'Failed to look up the payment intent') }
  }
}

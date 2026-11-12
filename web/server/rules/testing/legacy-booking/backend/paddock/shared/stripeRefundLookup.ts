import { callWorker, READ_TIMEOUT_MS } from './callWorker'
import type { PaymentIntentRefundsOutput } from './workerContracts'

/**
 * Stripe keeps an idempotency key for at least 24 hours, then may drop it, and a refund sent again
 * after that could be a second refund. So a card refund that got no clear answer more than
 * STRIPE_KEY_SAFE_HOURS ago is never sent again: it is looked for instead, by the key the Worker
 * writes on every refund's metadata (/api/v1/staff/payments/refunds). Read-only.
 */
export const STRIPE_KEY_SAFE_HOURS = 23

/** A refund that failed or was cancelled at Stripe gave no money back. */
const GAVE_NOTHING = new Set(['failed', 'canceled'])

/** Whether a refund with exactly this key is on the payment and gave money back. Throws if it can't
 *  look, which the caller must treat as "can't tell", never as "not there". */
export async function cardRefundWithKey(user: User, paymentIntentId: string, key: string): Promise<{ amount: number } | null> {
  const listed = await callWorker<PaymentIntentRefundsOutput>(user, {
    path: '/api/v1/staff/payments/refunds',
    method: 'GET',
    queryParams: { paymentIntentId },
    timeoutMs: READ_TIMEOUT_MS,
  })
  const found = listed.refunds.find((refund) => refund.key === key && !GAVE_NOTHING.has(refund.status))
  return found ? { amount: found.amount } : null
}

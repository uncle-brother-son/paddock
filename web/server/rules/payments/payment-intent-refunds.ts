import 'server-only'
import type { PaymentIntentRefund, PaymentIntentRefundsOutput } from '@/contracts'
import { ApiError } from '@/server/http/errors'
import type { StripeClient } from '@/server/stripe/client'
import { readStripeFailure } from '@/server/stripe/outcome'

/** The refund metadata field that holds the Stripe key it was sent with (refund-order/route.ts). */
export const REFUND_KEY_METADATA = 'refund_key'

/** Stripe lists 100 at most per page. Ten pages is far past any real payment. */
const PAGE = 100
const MOST_PAGES = 10

/**
 * Every refund on one PaymentIntent, newest first, with the key each was sent with. Read-only. The
 * staff app uses it to settle a card refund that got no clear answer more than 23 hours ago, when
 * Stripe may have forgotten the key and sending it again could pay twice.
 */
export async function listPaymentIntentRefunds(stripe: StripeClient, paymentIntentId: string): Promise<PaymentIntentRefundsOutput> {
  const refunds: PaymentIntentRefund[] = []
  let startingAfter: string | undefined
  for (let page = 0; page < MOST_PAGES; page++) {
    let listed: Awaited<ReturnType<StripeClient['refunds']['list']>>
    try {
      listed = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: PAGE, ...(startingAfter ? { starting_after: startingAfter } : {}) })
    } catch (err) {
      if (readStripeFailure(err).code === 'resource_missing') throw new ApiError('NOT_FOUND', `Stripe has no payment ${paymentIntentId}.`)
      throw err
    }
    for (const refund of listed.data) {
      refunds.push({
        id: refund.id,
        amount: refund.amount / 100,
        status: refund.status ?? 'unknown',
        key: refund.metadata?.[REFUND_KEY_METADATA] ?? null,
        createdAt: new Date(refund.created * 1000).toISOString(),
      })
    }
    const last = listed.data.at(-1)
    if (!listed.has_more || !last) return { refunds }
    startingAfter = last.id
  }
  throw new Error(`Payment ${paymentIntentId} has more than ${PAGE * MOST_PAGES} refunds: look in Stripe.`)
}

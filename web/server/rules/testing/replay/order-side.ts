import type { ApiFailure, BasketQuoteOutput, OrderRefusalDetails, PlaceOrderInput, PlaceOrderOutput } from '@/contracts'
import { POST as cancelRoute } from '@/app/api/v1/staff/orders/[orderId]/cancel/route'
import { POST as finaliseRoute } from '@/app/api/v1/staff/orders/[orderId]/finalise/route'
import { POST as ordersRoute } from '@/app/api/v1/staff/orders/route'
import { POST as quoteRoute } from '@/app/api/v1/staff/quotes/basket/route'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { REPLAY_USER, type ReplaySide } from './harness'
import { chargesTakeASecond, replayStripe } from './stripe-binding'

/**
 * The new side of W06's replay: createOrder's params go to POST /api/v1/staff/orders, and its answer
 * comes back in createOrder's shape, as the staff app's wrapper will give it to the screen at W14. A
 * test file using this mocks @/server/db/connection to the replay database and sets STAFF_API_KEY.
 */

/** createOrder's params as the route takes them: the cash figure on the tick becomes `confirmed.toCollect`. */
export function orderInput(params: Record<string, unknown>): PlaceOrderInput {
  // The Stripe key for a membership: nothing to do with an order the Worker builds now.
  const { payment, ...rest } = params as Record<string, unknown> & { payment?: Record<string, unknown> }
  const basket = Object.fromEntries(Object.entries(rest).filter(([name]) => name !== 'membershipIdempotencyKey'))
  const { confirmedCashAmount, ...parts } = payment ?? {}
  return {
    ...(basket as PlaceOrderInput),
    payment: parts as PlaceOrderInput['payment'],
    ...(typeof confirmedCashAmount === 'number' ? { confirmed: { toCollect: confirmedCashAmount } } : {}),
  }
}

/** A refusal in createOrder's shape, from the error's details. */
export function oldRefusal(details: OrderRefusalDetails): Record<string, unknown> {
  return {
    success: false,
    stage: details.stage,
    reason: details.reason,
    ...(details.message !== undefined ? { message: details.message } : {}),
    ...(details.bookingFailureReason !== undefined ? { bookingFailureReason: details.bookingFailureReason } : {}),
    ...(details.productVariantId !== undefined ? { productVariantId: details.productVariantId } : {}),
    ...(details.amountDueTotal !== undefined ? { amountDueTotal: details.amountDueTotal } : {}),
  }
}

/** The route's answer in createOrder's shape. Anything that isn't a refusal or an order comes back as the error. */
export function oldResult(body: { ok: true; data: PlaceOrderOutput } | ApiFailure): Record<string, unknown> {
  if (body.ok && body.data.status === 'pending_reader') {
    // W11: createOrder's reader branch answered only the order, the method and what the reader collects.
    const { orderId, payment, pendingReaderPayment } = body.data
    return { success: true, orderId, cardCharged: payment.cardCharged, paymentMethodUsed: payment.method, ...(pendingReaderPayment ? { pendingReaderPayment } : {}) }
  }
  if (body.ok) {
    const { orderId, bookingId, eventBookingId, sessionPassId, giftCardId, giftCardCode, payment } = body.data
    return {
      success: true,
      orderId,
      ...(bookingId ? { bookingId } : {}),
      ...(eventBookingId ? { eventBookingId } : {}),
      ...(giftCardId ? { giftCardId } : {}),
      ...(giftCardCode ? { giftCardCode } : {}),
      ...(sessionPassId ? { sessionPassId } : {}),
      cardCharged: payment.cardCharged,
      cardAmount: payment.collected,
      // W09: createOrder named the gift card and store credit taken only when there were any.
      ...(payment.giftCardApplied > 0 ? { giftCardRedeemedAmount: payment.giftCardApplied } : {}),
      ...(payment.storeCreditApplied > 0 ? { storeCreditRedeemedAmount: payment.storeCreditApplied } : {}),
      paymentMethodUsed: payment.method,
    }
  }
  const details = body.error.details as Partial<OrderRefusalDetails> | undefined
  if (details?.reason && details.stage) return oldRefusal(details as OrderRefusalDetails)
  return { success: false, error: { code: body.error.code, message: body.error.message } }
}

export interface OrderAnswer {
  status: number
  body: { ok: true; data: PlaceOrderOutput } | ApiFailure
}

export async function postOrder(input: unknown, { key = crypto.randomUUID(), email = REPLAY_USER.email } = {}): Promise<OrderAnswer> {
  const response = await ordersRoute(
    new Request('https://worker.test/api/v1/staff/orders', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.STAFF_API_KEY}`,
        'x-staff-email': email,
        'idempotency-key': key,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    })
  )
  return { status: response.status, body: (await response.json()) as OrderAnswer['body'] }
}

/**
 * W10: the card figure staff confirm, as the screen will send it from W14: the basket quote's
 * `toCollect.card`. The old createOrder's params never had one, and the order route keeps the
 * confirmed-amount rule for the card (a missing figure counts as nothing confirmed). W11: the reader's
 * single tap likewise, the quote's `toCollect.reader`.
 */
export async function withQuotedCardFigure(input: PlaceOrderInput): Promise<PlaceOrderInput> {
  const method = input.payment?.method
  if ((method !== 'card' && method !== 'reader') || typeof input.confirmed?.toCollect === 'number') return input
  const basket: Partial<PlaceOrderInput> = { ...input }
  delete basket.confirmed
  const response = await quoteRoute(
    new Request('https://worker.test/api/v1/staff/quotes/basket', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.STAFF_API_KEY}`, 'x-staff-email': REPLAY_USER.email, 'content-type': 'application/json' },
      body: JSON.stringify(basket),
    })
  )
  const body = (await response.json()) as { ok: boolean; data?: BasketQuoteOutput }
  if (!body.ok || !body.data) return input
  return { ...input, confirmed: { ...input.confirmed, toCollect: method === 'reader' ? body.data.totals.toCollect.reader : body.data.totals.toCollect.card } }
}

/** W11: POST /api/v1/staff/orders/:orderId/finalise or /cancel, as the staff app's wrappers will call them at W14. */
export async function postReaderStep(step: 'finalise' | 'cancel', orderId: string, { key = crypto.randomUUID(), email = REPLAY_USER.email } = {}): Promise<OrderAnswer> {
  const route = step === 'finalise' ? finaliseRoute : cancelRoute
  const response = await route(
    new Request(`https://worker.test/api/v1/staff/orders/${orderId}/${step}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.STAFF_API_KEY}`,
        'x-staff-email': email,
        'idempotency-key': key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ orderId }) }
  )
  return { status: response.status, body: (await response.json()) as OrderAnswer['body'] }
}

/** The reader step's answer as the old function gave it: the data itself, or the error when there is no data. */
function oldReaderStepResult(answer: OrderAnswer): unknown {
  const body = answer.body as { ok: true; data: unknown } | ApiFailure
  return body.ok ? body.data : { error: { code: body.error.code, message: body.error.message } }
}

/**
 * Replays createOrder through the new route. `answers` keeps each raw answer, for what staff see.
 * `adjust` changes what is sent where a decision changes it (order-differences.ts, NEW_SIDE_CONFIRMS).
 * W10: the run's FakeStripe is the one the route charges (stripe-binding.ts), and a card order sends
 * the quote's card figure as confirmed.
 */
export function newOrderSide(answers: OrderAnswer[] = [], adjust: (input: PlaceOrderInput) => PlaceOrderInput = (input) => input): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (_db, stripe) => {
    replayStripe.current = stripe
    chargesTakeASecond(stripe)
    return {
      name: 'new',
      async call(action, params) {
        // W11: the reader's finalise and cancel, on the order the route placed.
        if (action === 'finaliseReaderOrder' || action === 'cancelReaderOrder') {
          const { orderId } = params as { orderId: string }
          const answer = await postReaderStep(action === 'finaliseReaderOrder' ? 'finalise' : 'cancel', orderId)
          answers.push(answer)
          return oldReaderStepResult(answer)
        }
        if (action !== 'createOrder') throw new Error(`The order route builds createOrder, finaliseReaderOrder and cancelReaderOrder only, not ${action}.`)
        const answer = await postOrder(adjust(await withQuotedCardFigure(orderInput(params as Record<string, unknown>))))
        answers.push(answer)
        return oldResult(answer.body)
      },
    }
  }
}

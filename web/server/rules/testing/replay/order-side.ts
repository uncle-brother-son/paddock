import type { ApiFailure, OrderRefusalDetails, PlaceOrderInput, PlaceOrderOutput } from '@/contracts'
import { POST as ordersRoute } from '@/app/api/v1/staff/orders/route'
import { REPLAY_USER, type ReplaySide } from './harness'

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
  if (body.ok) {
    const { orderId, bookingId, payment } = body.data
    return {
      success: true,
      orderId,
      ...(bookingId ? { bookingId } : {}),
      cardCharged: payment.cardCharged,
      cardAmount: payment.collected,
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

/** Replays createOrder through the new route. `answers` keeps each raw answer, for what staff see. */
export function newOrderSide(answers: OrderAnswer[] = []): () => ReplaySide {
  return () => ({
    name: 'new',
    async call(action, params) {
      if (action !== 'createOrder') throw new Error(`W06 builds createOrder only, not ${action}.`)
      const answer = await postOrder(orderInput(params as Record<string, unknown>))
      answers.push(answer)
      return oldResult(answer.body)
    },
  })
}

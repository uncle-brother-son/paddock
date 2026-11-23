import { saveCustomerCardInputSchema, savedCardRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { replaceCustomerCard } from '@/server/rules/customers/saved-card'
import { cardMovePathOff } from '@/server/rules/memberships/membership-switch'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'
import { stripeTiming } from '@/server/stripe/deadline'

/**
 * W11: saveCustomerCardOnFile. Reads which card the tap left (Stripe reads only, each under the 30 s deadline from
 * the request's start, server/stripe/deadline.ts) and writes it to the customer with its audit row. Idempotent. Any
 * active staff member, as the old function: the customer is standing at the reader.
 *
 * W42 (F-plan 4.7; Q19, Q45, F4 / FB17), behind its own switch kind `card_moves`. On: the card is refused unless the
 * tap was made for this customer's Stripe customer; the card, its audit row and one card step per live membership go
 * in one transaction; then each subscription and, last, the Stripe customer's invoice default are moved to the new
 * card (W42a), and the answer says how many moved and how many are still to move (server/rules/customers/saved-card.ts). Off
 * (W68, H5; the W45 audit's row 50): refused, with nothing read and nothing saved. The Stripe client is
 * made with ORDER_STRIPE_LIMITS (10 seconds a call, no retries by the SDK), as every client that sends a step must be
 * (memberships/left.ts).
 */
export const POST = defineRoute(
  { auth: 'staff', input: saveCustomerCardInputSchema, output: savedCardRouteOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const off = cardMovePathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    const stripe = createStripeClient(undefined, ORDER_STRIPE_LIMITS)
    return replaceCustomerCard(db, stripe, input, { actor: { type: 'staff', id: staff.id }, requestId, timing: stripeTiming(startedAt) })
  }
)

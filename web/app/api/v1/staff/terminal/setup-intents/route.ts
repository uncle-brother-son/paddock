import { terminalSetupIntentInputSchema, terminalSetupIntentOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { cardMovePathOff } from '@/server/rules/memberships/membership-switch'
import { terminalSetupIntent } from '@/server/rules/payments/terminal'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'
import { stripeTiming } from '@/server/stripe/deadline'

/**
 * W11: createTerminalSetupIntent. What the reader collects a card against with no charge: moves no
 * money (saving the card is the saved-card route, after the tap). Idempotent, and the intent carries a
 * Stripe key from the customer and this press. Any active staff member, as the old function. W11a: its
 * Stripe calls and the Stripe customer's statements end by the 30 s deadline from the request's start
 * (server/stripe/deadline.ts), as the other reader routes'. W68a (W68 noticed 1): with `card_moves` off it is refused
 * here, in the switch's words and before anything is read, as the save after the tap is, so no customer taps for nothing.
 */
export const POST = defineRoute(
  { auth: 'staff', input: terminalSetupIntentInputSchema, output: terminalSetupIntentOutputSchema, idempotent: true },
  async ({ db, input, idempotencyKey, requestId, startedAt }) => {
    const off = cardMovePathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    return terminalSetupIntent(db, createStripeClient(undefined, ORDER_STRIPE_LIMITS), input, idempotencyKey ?? requestId, stripeTiming(startedAt))
  }
)

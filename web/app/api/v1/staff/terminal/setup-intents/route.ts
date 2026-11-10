import { terminalSetupIntentInputSchema, terminalSetupIntentOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { terminalSetupIntent } from '@/server/rules/payments/terminal'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'
import { stripeTiming } from '@/server/stripe/deadline'

/**
 * W11: createTerminalSetupIntent. What the reader collects a card against with no charge: moves no
 * money (saving the card is the saved-card route, after the tap). Idempotent, and the intent carries a
 * Stripe key from the customer and this press. Any active staff member, as the old function. W11a: its
 * Stripe calls and the Stripe customer's statements end by the 30 s deadline from the request's start
 * (server/stripe/deadline.ts), as the other reader routes'.
 */
export const POST = defineRoute(
  { auth: 'staff', input: terminalSetupIntentInputSchema, output: terminalSetupIntentOutputSchema, idempotent: true },
  async ({ db, input, idempotencyKey, requestId, startedAt }) =>
    terminalSetupIntent(db, createStripeClient(undefined, ORDER_STRIPE_LIMITS), input, idempotencyKey ?? requestId, stripeTiming(startedAt))
)

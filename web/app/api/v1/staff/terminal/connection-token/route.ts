import { terminalConnectionTokenInputSchema, terminalConnectionTokenOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { terminalConnectionToken } from '@/server/rules/payments/terminal'
import { createStripeClient, READ_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W11: getTerminalConnectionToken. The Terminal SDK asks for a token whenever it needs one; making one
 * moves no money and repeating it is harmless, so it isn't idempotent, and it has read limits (10 s, one
 * retry by the SDK). Any active staff member, as the old function.
 */
export const POST = defineRoute(
  { auth: 'staff', input: terminalConnectionTokenInputSchema, output: terminalConnectionTokenOutputSchema },
  async ({ input }) => terminalConnectionToken(createStripeClient(undefined, READ_STRIPE_LIMITS), input)
)

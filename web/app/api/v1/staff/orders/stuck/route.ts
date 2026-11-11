import { defineRoute } from '@/server/http/define-route'
import { stuckListInputSchema, stuckListOutputSchema } from '@/contracts'
import { stuckList } from '@/server/rules/orders/stuck-list'

/**
 * W12: getStuckReaderPayments, for the Orders page's banner: the reader orders and flows held longer than
 * the window, the Worker's saved-card orders held too (W10-3), each with what reconcile last found, the
 * automatic refunds still waiting for Stripe, recent warnings, and an alert when Stripe refused the key.
 * Read-only. Any active staff member, as the old function.
 */
export const GET = defineRoute({ auth: 'staff', input: stuckListInputSchema, output: stuckListOutputSchema }, async ({ db, input }) =>
  stuckList(db, input.olderThanMinutes === undefined ? {} : { olderThanMinutes: input.olderThanMinutes })
)

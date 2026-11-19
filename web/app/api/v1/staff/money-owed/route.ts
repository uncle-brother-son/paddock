import { defineRoute } from '@/server/http/define-route'
import { moneyOwedInputSchema, moneyOwedOutputSchema } from '@/contracts'
import { moneyOwedList } from '@/server/rules/refunds/money-owed-list'

/**
 * W47 (G-plan 4.7): the "Money still to refund" list for the Orders page and Overview's count: every order and every
 * booking with card refund money still owed to the customer, and, for information, the money kept on lapsed
 * bookings. Read-only. Any active staff member, as the stuck list.
 */
export const GET = defineRoute({ auth: 'staff', input: moneyOwedInputSchema, output: moneyOwedOutputSchema }, async ({ db }) => moneyOwedList(db))

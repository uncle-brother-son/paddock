import { customerDetailInputSchema, customerDetailOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { getCustomerDetail } from '@/server/rules/customers/read'

/**
 * W39 (F-plan 4.6): getCustomerDetail, the customer's profile: memberships (with why "Change payment date" is
 * refused), session passes, booking history, store credit and its last 100 movements, event bookings. The shapes are
 * the old function's. Any active staff member (FB16: the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: customerDetailInputSchema, output: customerDetailOutputSchema }, async ({ db, input }) => getCustomerDetail(db, input.customerId))

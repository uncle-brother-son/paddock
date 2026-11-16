import { createCustomerInputSchema, createCustomerOutputSchema, customerListInputSchema, customerListOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { createCustomer } from '@/server/rules/customers/create'
import { listCustomers } from '@/server/rules/customers/read'

/**
 * W39 (F-plan 4.6): getCustomers, for the Customers page, the customer picker and New Order's payment step: one
 * customer by id, a search (every word in a name, the email or the phone), or the newest 200. Named fields. Any
 * active staff member (FB16: the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: customerListInputSchema, output: customerListOutputSchema }, async ({ db, input }) => listCustomers(db, input))

/**
 * W39 (F-plan 4.6; bugs FB21 and FB23): createCustomer, the New Customer dialog (the Customers page and the customer
 * picker on New Order). The old checks and words; the email lower-cased; an email already on file in any case
 * refused with the old duplicate words, also when two creates race (FB21); a date of birth the calendar doesn't have
 * refused in our own words (FB23); a `customer.created` audit row with who and the channel. Any active staff member.
 * No Stripe, so no switch kind. Idempotent: the same press key gets the first press's answer, so a lost answer
 * pressed again never makes a second customer.
 */
export const POST = defineRoute({ auth: 'staff', input: createCustomerInputSchema, output: createCustomerOutputSchema, idempotent: true }, async ({ db, input, staff, requestId }) =>
  createCustomer(db, input, { channel: 'staff', staffId: staff.id, requestId })
)

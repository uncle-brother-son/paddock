import { customerMeInputSchema, customerMeOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { readMe } from '@/server/rules/customer/sign-in'

/**
 * W85a (backend log 25): who am I. The signed-in customer's first name and email, and which account sections the site
 * shows (its menu and its redirects). A login with no customer yet answers CUSTOMER_NOT_LINKED: the site calls link.
 * A read.
 */
export const GET = defineRoute({ auth: 'customer', input: customerMeInputSchema, output: customerMeOutputSchema }, async ({ db, customer }) =>
  readMe(db, customer.customerId)
)

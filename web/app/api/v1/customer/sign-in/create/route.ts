import { customerSignInCreateInputSchema, customerSignInCreateOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { createSignInCustomer } from '@/server/rules/customer/sign-in'

/**
 * W85a (backend log 9): Create your account, after link answered `needs_details`. First name, last name, phone
 * optional; the email is the signed-in login's (from the token), with no date of birth and no age check. The customer
 * is made and linked in one transaction; a customer of that email made at the same moment (staff, a guest checkout)
 * ends in the link, never a duplicate. Safe to call twice (the second answers as linked). Changes no money.
 */
export const POST = defineRoute({ auth: 'customer_sign_in', input: customerSignInCreateInputSchema, output: customerSignInCreateOutputSchema }, async ({ db, login, input, requestId }) =>
  createSignInCustomer(db, login, input, requestId)
)

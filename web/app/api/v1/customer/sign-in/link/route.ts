import { customerSignInLinkInputSchema, customerSignInLinkOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { linkSignIn } from '@/server/rules/customer/sign-in'

/**
 * W85a (backend log 9): called by the website straight after a sign-in. The signed-in login (its confirmed email from
 * the token, never the body) is matched to its customer: linked already; one customer of that email with no login,
 * linked now; or `needs_details` (Create your account). A customer of that email with another login is refused
 * (CONFLICT, `email_linked_elsewhere`) and logged for staff. Safe to call twice. Changes no money.
 */
export const POST = defineRoute({ auth: 'customer_sign_in', input: customerSignInLinkInputSchema, output: customerSignInLinkOutputSchema }, async ({ db, login, requestId }) =>
  linkSignIn(db, login, requestId)
)

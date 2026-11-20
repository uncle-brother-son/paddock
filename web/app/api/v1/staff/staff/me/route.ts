import { adminGetCurrentStaffOutputSchema, emptyInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { getOwnStaffRow } from '@/server/rules/staff/admin'

/**
 * W49 (lead call L10; G-plan 4.3): getCurrentStaff. The signed-in user's own staff row whether active or not, so the
 * screen can say the account is inactive; null for a sign-in with no staff row. The one route on the `staff_sign_in`
 * mode (the shared key and the signed-in email, with no staff row asked for): every other staff route still refuses
 * an inactive or unknown member. The email finds its row in lower case, as the staff check does (GB16).
 * W54a (review F3): the mode's config must say `method: 'GET'`, and the route refuses any other verb.
 */
export const GET = defineRoute({ auth: 'staff_sign_in', method: 'GET', input: emptyInputSchema, output: adminGetCurrentStaffOutputSchema }, async ({ db, signIn }) => getOwnStaffRow(db, signIn.email))

import { adminCreatePromoCodeOutputSchema, emptyInputSchema, promoCreateRouteInputSchema, promoListRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { createPromoCode, listPromoCodes } from '@/server/rules/promo/admin'

/**
 * W54 (G-plan 4.3; bug GB14): getPromoCodes, the Promo Codes page's list: every code, newest first, with how often
 * it was used and who a restricted one is for. Named fields. Any active staff member (the old read checked nobody).
 * W54a: each row carries its stamp, which the page's switch and edit dialog send back (a row changed since is refused).
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: promoListRouteOutputSchema }, async ({ db, staff }) => listPromoCodes(db, adminActor(staff)))

/**
 * W54 (G-plan 4.3; bug GB18): createPromoCode, New Promo Code. Manage pricing (the rule, in the old words). One
 * transaction: a code already there in any letter case refused, the row, and a `promo.created` audit row.
 * Idempotent: the same press key gets the first press's answer, so a lost answer pressed again never tries to make
 * the code twice.
 */
export const POST = defineRoute({ auth: 'staff', input: promoCreateRouteInputSchema, output: adminCreatePromoCodeOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  createPromoCode(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey, createdBy: staff.email })
)

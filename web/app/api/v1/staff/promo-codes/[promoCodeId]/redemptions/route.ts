import { adminGetPromoCodeRedemptionsOutputSchema, promoRedemptionsRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listPromoCodeRedemptions } from '@/server/rules/promo/admin'

/**
 * W54 (G-plan 4.3; bug GB14): getPromoCodeRedemptions, one code's uses in the Promo Codes page's expanding row: the
 * order, when, the customer and the discount, newest first. Named fields. Any active staff member (the old read
 * checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: promoRedemptionsRouteInputSchema, output: adminGetPromoCodeRedemptionsOutputSchema }, async ({ db, input, staff }) =>
  listPromoCodeRedemptions(db, input.promoCodeId, adminActor(staff))
)

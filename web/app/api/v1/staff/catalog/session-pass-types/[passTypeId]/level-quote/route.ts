import { catalogPassLevelQuoteRouteInputSchema, catalogPassLevelQuoteRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { passLevelQuote } from '@/server/rules/catalog/passes-gift-cards'

/**
 * Brief W56 (Wayne's Q52; the lead's words): before a pass type's level is saved, how many customers hold unused
 * sessions on it, and the sentence the dialog shows. A read: any active staff member.
 */
export const GET = defineRoute({ auth: 'staff', input: catalogPassLevelQuoteRouteInputSchema, output: catalogPassLevelQuoteRouteOutputSchema }, async ({ db, input, staff }) =>
  passLevelQuote(db, input.passTypeId, adminActor(staff))
)

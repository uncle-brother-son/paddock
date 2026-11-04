import { promoDiscountResultSchema, validatePromoCodeInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { validatePromoCode } from '@/server/rules/promo/validate-promo-code'

/** Read-only, so not idempotent and no audit row. POST because the input is a structured body. */
export const POST = defineRoute({ auth: 'staff', input: validatePromoCodeInputSchema, output: promoDiscountResultSchema }, async ({ db, input }) => validatePromoCode(db, input))

import { emptyInputSchema, pricingConfigOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { getPricingConfig } from '@/server/rules/pricing/pricing-config'

export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: pricingConfigOutputSchema }, async ({ db, staff }) => getPricingConfig(db, staff.canManagePricing))

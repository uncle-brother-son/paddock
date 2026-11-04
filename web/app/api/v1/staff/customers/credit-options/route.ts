import { customerCreditOptionsInputSchema, customerCreditOptionsOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { getCustomerCreditOptions } from '@/server/rules/credits/credit-options'

export const GET = defineRoute({ auth: 'staff', input: customerCreditOptionsInputSchema, output: customerCreditOptionsOutputSchema }, async ({ db, input }) => getCustomerCreditOptions(db, input.customerId, input.sessionId))

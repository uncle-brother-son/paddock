import { customerDayConflictInputSchema, customerDayConflictOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { checkCustomerDayConflict } from '@/server/rules/sessions/customer-day-conflict'

export const GET = defineRoute({ auth: 'staff', input: customerDayConflictInputSchema, output: customerDayConflictOutputSchema }, async ({ db, input }) => checkCustomerDayConflict(db, input))

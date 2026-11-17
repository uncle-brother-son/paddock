import { paymentDateQuoteOutputSchema, paymentDateQuoteRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { paymentDateQuote } from '@/server/rules/memberships/payment-date'

/**
 * W41 (F-plan 4.4): getMembershipPaymentDateQuote, field for field: whether "Change payment date" is allowed, the
 * first and last new dates, and for a picked date (`newRenewalDate`) the extra days and the part-month charge
 * (server/rules/memberships/payment-date.ts). Read only; any active staff member; never asks the switch. No such
 * membership is NOT_FOUND (the old function answered null).
 */
export const GET = defineRoute({ auth: 'staff', input: paymentDateQuoteRouteInputSchema, output: paymentDateQuoteOutputSchema }, async ({ db, input }) =>
  paymentDateQuote(db, input.membershipId, input.newRenewalDate)
)

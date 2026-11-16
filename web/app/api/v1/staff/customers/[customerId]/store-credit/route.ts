import { adjustStoreCreditOutputSchema, adjustStoreCreditRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adjustStoreCredit } from '@/server/rules/customers/store-credit'

/**
 * W37 (F-plan 4.5; bug FB12): adjustCustomerStoreCredit, the manual adjustment on the customer's profile. The old
 * checks and words, then the database's store_credit_apply and a `customer.store_credit_adjusted` audit row in one
 * transaction. Issue refunds, refused by the rule in the old words. No Stripe, so no switch kind. Idempotent: the
 * same press key gets the first press's answer, so a lost answer pressed again never gives the credit twice.
 */
export const POST = defineRoute(
  { auth: 'staff', input: adjustStoreCreditRouteInputSchema, output: adjustStoreCreditOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId }) => {
    const { customerId, ...body } = input
    return adjustStoreCredit(db, customerId, body, { actor: { type: 'staff', id: staff.id, canIssueRefunds: staff.canIssueRefunds }, requestId })
  }
)

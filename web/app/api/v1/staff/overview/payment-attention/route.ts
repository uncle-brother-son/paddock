import { adminGetPaymentAttentionItemsOutputSchema, emptyInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listPaymentAttention } from '@/server/rules/bookings/admin'

/**
 * W50 (G-plan 4.3; bug GB14): getPaymentAttentionItems, Overview's "Needs attention: payments": bookings at Payment
 * needed (soonest deadline first, each a whole booking row) and memberships whose payment is overdue. Named fields.
 * Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: adminGetPaymentAttentionItemsOutputSchema }, async ({ db, staff }) =>
  listPaymentAttention(db, { channel: 'staff', actor: adminActor(staff) })
)

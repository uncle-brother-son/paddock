import { closeStuckInputSchema, closeStuckOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { closeStuckItem } from '@/server/rules/orders/close-stuck'

/**
 * W14b: the manual close for an item the stuck list shows for a person (close-stuck.ts): a held Worker order
 * (`changed_since`, or a membership's compensation finished by hand), a Worker order the old screens moved out of
 * pending, or a subscription left live. Needs Issue refunds and a reason (both checked here, whatever the screen
 * shows). Never calls Stripe. Idempotent: a lost answer is given again for the same key, and a second press with a
 * new key answers "already closed". Refusals are answered as data, with nothing changed.
 */
export const POST = defineRoute(
  { auth: 'staff', permission: 'issueRefunds', input: closeStuckInputSchema, output: closeStuckOutputSchema, idempotent: true },
  async ({ db, staff, requestId, input }) => closeStuckItem(db, input, { actor: { type: 'staff', id: staff.id }, requestId })
)

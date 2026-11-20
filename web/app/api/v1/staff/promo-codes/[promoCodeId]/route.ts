import { promoUpdateRouteInputSchema, promoUpdateRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { updatePromoCode } from '@/server/rules/promo/admin'

/**
 * W54 (G-plan 4.3; bug GB18): updatePromoCode, the Promo Codes page's edit dialog and its on/off switch. Manage
 * pricing (the rule, in the old words). One transaction under the code's row lock, the one an order using the code
 * takes: a used code's text can't change, decided under that lock; and a `promo.updated` audit row with the code
 * before and after. Idempotent: each press has its own key. W54a: the press sends the row's `stamp` as the list read
 * it; a code changed since then is refused `changed_since` and nothing is written (the switch and the dialog both send
 * every field as the page loaded it, so a stale page would put an old discount back). The answer carries the new stamp.
 */
export const POST = defineRoute({ auth: 'staff', input: promoUpdateRouteInputSchema, output: promoUpdateRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  updatePromoCode(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)

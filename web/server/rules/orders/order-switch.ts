// W14 (W03-plan 3.2, W03-decisions Q7): which kinds of order the Worker takes. The rest answer
// ORDER_PATH_OFF before anything is touched. W16: the old code is gone, so this is an emergency off switch:
// a kind switched off places nothing, and the staff app says so.
import 'server-only'
import type { PlaceOrderInput } from '@/contracts'
import { ApiError } from '@/server/http/errors'

/**
 * The kinds the ORDER_SWITCH secret can list, comma or space separated. Empty or unset means every
 * kind is off. W17 (D-plan 4.9): `booking_changes` (every step D booking change that moves money) and
 * `reader_flows` (Move, Settle and Add Guest on the reader) are checked by the booking routes as each
 * slice builds them (server/rules/bookings/booking-switch.ts); a card flow also needs `saved_card`, and
 * (W18) a reader flow also needs `reader`. Taking `reader` out stops New Order's reader now, and the booking
 * changes on the reader as W19 / W20 / W24 move them to the Worker (until then they are the old Retool code,
 * which reads no switch).
 */
export const ORDER_KINDS = ['no_stripe', 'saved_card', 'reader', 'membership', 'reader_flows', 'booking_changes'] as const
export type OrderKind = (typeof ORDER_KINDS)[number]

/**
 * The kind a basket is, decided from what was sent, before anything is read:
 * - any membership is `membership`, whatever the method (on the reader, on the saved card, or with
 *   gift card and store credit only: a membership always needs Stripe; cash is refused by the order);
 * - otherwise the reader is `reader` and the saved card `saved_card`, even when nothing is left for it
 *   to take (the order then refuses with its own reason, as placeOrder needs Stripe for either);
 * - anything else is `no_stripe`: cash, gift card or store credit alone, nothing owed, or no method.
 */
export function orderKind(input: Pick<PlaceOrderInput, 'membershipPlanId' | 'payment'>): Exclude<OrderKind, 'reader_flows' | 'booking_changes'> {
  if (input.membershipPlanId) return 'membership'
  const method = input.payment?.method
  if (method === 'reader') return 'reader'
  if (method === 'card') return 'saved_card'
  return 'no_stripe'
}

/** The kinds a switch value turns on. Unknown words are ignored, so a typo turns nothing on. */
export function kindsOn(switchValue: string | undefined | null): ReadonlySet<OrderKind> {
  const words = (switchValue ?? '').split(/[\s,]+/).map((word) => word.trim().toLowerCase())
  return new Set(ORDER_KINDS.filter((kind) => words.includes(kind)))
}

export const ORDER_PATH_OFF_MESSAGE = 'This kind of order is switched off in the booking system. Tell a manager.'

/** ORDER_PATH_OFF when the basket's kind is off, else null. The quote never asks. */
export function orderPathOff(input: Pick<PlaceOrderInput, 'membershipPlanId' | 'payment'>, switchValue: string | undefined | null): ApiError | null {
  const kind = orderKind(input)
  if (kindsOn(switchValue).has(kind)) return null
  return new ApiError('ORDER_PATH_OFF', ORDER_PATH_OFF_MESSAGE, { details: { kind } })
}

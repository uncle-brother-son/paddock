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
 *
 * W27 (E-plan 4.10, lead call L3): `order_refunds` (an order's lines refunded, and money owed on an order given) and
 * `event_cancels` (an event place, booking or whole event cancelled with money back) are step E's, checked by its
 * routes as W28 and W30 build them (server/rules/refunds/refund-switch.ts). Both are off until the lead adds them to
 * the secret, and neither turns any order or booking change on.
 *
 * W33 (E-plan 4.11, lead call L9): `customer_cancels` is the website's own cancels (/api/v1/customer/.../cancel and
 * their quotes), checked by server/rules/customer/cancel-switch.ts. Off until the website is built and the lead adds
 * it; it turns nothing else on, and no staff route asks for it.
 *
 * W36 (F-plan 4.11, lead call L3): `membership_changes` is step F's one kind, for its three actions that touch Stripe
 * (a membership's cancel and undo, a payment date change, and moving memberships to a replaced card), checked by
 * server/rules/memberships/membership-switch.ts as W40 to W42 build them. Off until the lead adds it to the secret;
 * it turns nothing else on. Step F's other actions (credits, Herd, store credit, gift cards, customers) are one
 * transaction with nothing to stop part way, and need no kind.
 *
 * W41a (lead call, 17 Nov 2026): `payment_date_changes` is the payment date change's own kind (the new press, and
 * the legacy change-payment-date route's guard), so it can be switched off, and the old way put back, without taking
 * W40's cancel and undo with it. `membership_changes` keeps the cancel, the undo and (W42) the replaced card. Off
 * until the lead adds it to the secret; it turns nothing else on.
 *
 * W42 (brief item 1): `card_moves` is the replaced card's own kind, as W41a's for the date change: on, saving a
 * customer's card also moves each of their live memberships' renewals to it (server/rules/customers/saved-card.ts).
 * Off, the card is saved as before W42 and no membership is moved, whatever `membership_changes` says (which keeps
 * the cancel and the undo only). Off until the lead adds it to the secret; it turns nothing else on.
 * W42a: on, an order's T2 that writes a membership or saves a card on the reader also leaves a card step for each of
 * the customer's live memberships against their saved card (finalise-order.ts); off, T2 is as it was.
 *
 * W43 (brief item 1; F-plan 4.8): `lapse_sweep` is the lapse sweep's own kind. On, each scheduled run cancels the
 * payment-needed bookings past their deadline (server/rules/bookings/lapse-sweep.ts) before it reconciles. Off, the
 * run's sweep does nothing and the database's hourly sweep stays in charge (until migration 028 takes it out of the
 * hourly job). No route asks for it, and it turns nothing else on.
 *
 * W47r (brief item 1): `payment_retries` is "Try the payment again now"'s own kind: a past-due member's open renewal
 * invoice paid from the desk on their saved card (server/rules/memberships/retry-payment.ts). Asked by its press and
 * its quote, and by nothing else. Off until the lead adds it to the secret; it turns nothing else on, and no other
 * kind turns it on. Reconcile never asks: a retry held when the kind is switched off is still settled.
 */
export const ORDER_KINDS = ['no_stripe', 'saved_card', 'reader', 'membership', 'reader_flows', 'booking_changes', 'order_refunds', 'event_cancels', 'customer_cancels', 'membership_changes', 'payment_date_changes', 'card_moves', 'lapse_sweep', 'payment_retries'] as const
export type OrderKind = (typeof ORDER_KINDS)[number]

/**
 * The kind a basket is, decided from what was sent, before anything is read:
 * - any membership is `membership`, whatever the method (on the reader, on the saved card, or with
 *   gift card and store credit only: a membership always needs Stripe; cash is refused by the order);
 * - otherwise the reader is `reader` and the saved card `saved_card`, even when nothing is left for it
 *   to take (the order then refuses with its own reason, as placeOrder needs Stripe for either);
 * - anything else is `no_stripe`: cash, gift card or store credit alone, nothing owed, or no method.
 */
export function orderKind(input: Pick<PlaceOrderInput, 'membershipPlanId' | 'payment'>): Exclude<OrderKind, 'reader_flows' | 'booking_changes' | 'order_refunds' | 'event_cancels' | 'customer_cancels' | 'membership_changes' | 'payment_date_changes' | 'card_moves' | 'lapse_sweep' | 'payment_retries'> {
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

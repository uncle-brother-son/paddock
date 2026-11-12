// New in W17 (D-plan 4.9, lead call L1): which booking changes the Worker takes. ORDER_SWITCH lists the kinds on;
// a booking change whose kinds aren't all on answers BOOKING_PATH_OFF before anything is touched. An emergency stop,
// not a fallback: the old bodies go slice by slice (L1), and switching back is a Retool rollback. As for orders, only
// starting a change is gated: a flow's finalise and cancel, and reconcile, still settle whatever is already held.
import 'server-only'
import { ApiError } from '@/server/http/errors'
import { kindsOn, type OrderKind } from '@/server/rules/orders/order-switch'
import { BOOKING_PATH_OFF_MESSAGE } from './failure-messages'

/**
 * How a booking change moves money, as its route knows before anything is read:
 * - `none`: nothing moves (special requests, status, a cancel that gives back only a credit);
 * - `cash`: money in or out with no Stripe call (cash, gift card, store credit, or money out to store credit);
 * - `card`: the saved card is charged, or money goes back to a card (a refund);
 * - `reader`: the card reader takes it (Move, Settle, Add Guest).
 */
export type BookingMoney = 'none' | 'cash' | 'card' | 'reader'

/**
 * The kinds a change needs on. Every change that moves money needs `booking_changes`; the reader also needs
 * `reader_flows`, and a saved-card charge `saved_card` (D-plan 4.9). Money back to a card is a refund, not a charge,
 * so it needs `booking_changes` alone. A change that moves no money needs nothing.
 */
export function bookingKindsNeeded(money: BookingMoney, direction: 'in' | 'out' = 'in'): OrderKind[] {
  if (money === 'none') return []
  if (money === 'reader') return ['booking_changes', 'reader_flows']
  if (money === 'card' && direction === 'in') return ['booking_changes', 'saved_card']
  return ['booking_changes']
}

/** BOOKING_PATH_OFF when a kind the change needs is off, else null. Quotes and reads never ask. */
export function bookingPathOff(money: BookingMoney, switchValue: string | undefined | null, direction: 'in' | 'out' = 'in'): ApiError | null {
  const on = kindsOn(switchValue)
  const off = bookingKindsNeeded(money, direction).filter((kind) => !on.has(kind))
  if (off.length === 0) return null
  return new ApiError('BOOKING_PATH_OFF', BOOKING_PATH_OFF_MESSAGE, { details: { reason: 'booking_path_off', message: BOOKING_PATH_OFF_MESSAGE, kinds: off } })
}

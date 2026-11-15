// New in W33 (E-plan 4.11, lead call L9; brief W33 item 4): the website's cancel routes are off unless ORDER_SWITCH
// names `customer_cancels`. They are built before the website exists, so the kind is off live and every one of the
// four routes (the two quotes included: nothing should read them yet) answers REFUND_PATH_OFF in the customer's words
// before any booking is read (the route has by then found the signed-in customer, and a cancel has stored its answer
// under its Idempotency-Key, so a key used while off answers "switched off" again once it is on: the website uses a
// fresh key). As the other switches: an emergency stop, never a fallback.
import 'server-only'
import { ApiError } from '@/server/http/errors'
import { kindsOn, type OrderKind } from '@/server/rules/orders/order-switch'
import { CUSTOMER_CANCEL_WORDS } from './cancel-words'

/**
 * REFUND_PATH_OFF when `customer_cancels` is off, or when the cancel gives money back and the kind staff need for the
 * same money is off (`moneyKind`: `booking_changes` for a session booking, `event_cancels` for event places), so
 * stopping staff refunds stops the website's too. Else null. The quotes pass no `moneyKind`.
 */
export function customerCancelPathOff(switchValue: string | undefined | null, moneyKind?: Extract<OrderKind, 'booking_changes' | 'event_cancels'>): ApiError | null {
  const on = kindsOn(switchValue)
  const needed: OrderKind[] = ['customer_cancels', ...(moneyKind ? [moneyKind] : [])]
  const off = needed.filter((kind) => !on.has(kind))
  if (off.length === 0) return null
  const message = CUSTOMER_CANCEL_WORDS.switchedOff
  return new ApiError('REFUND_PATH_OFF', message, { details: { reason: 'customer_cancels_off', message, kinds: off } })
}

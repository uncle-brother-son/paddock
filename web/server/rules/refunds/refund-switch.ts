// New in W27 (E-plan 4.10, lead call L3): which of step E's refunds the Worker takes. ORDER_SWITCH lists the kinds on;
// an order refund or an event cancel whose kind is off answers REFUND_PATH_OFF before anything is touched. As step D's
// switch (bookings/booking-switch.ts): an emergency stop, not a fallback (each slice deletes its old body, L4, and
// switching back is a Retool rollback), and only starting is gated: reconcile and the closes by hand still settle
// whatever is already held. No route calls this until W28 (orders) and W30 (events).
import 'server-only'
import { ApiError } from '@/server/http/errors'
import { kindsOn, type OrderKind } from '@/server/rules/orders/order-switch'
import { REFUND_PATH_OFF_MESSAGE } from './failure-messages'

/** Step E's two kinds. Both are off unless the ORDER_SWITCH secret names them. */
export const REFUND_KINDS = ['order_refunds', 'event_cancels'] as const satisfies readonly OrderKind[]
export type RefundKindSwitch = (typeof REFUND_KINDS)[number]

const off = (kind: RefundKindSwitch, switchValue: string | undefined | null): ApiError | null =>
  kindsOn(switchValue).has(kind)
    ? null
    : new ApiError('REFUND_PATH_OFF', REFUND_PATH_OFF_MESSAGE, { details: { reason: 'refund_path_off', message: REFUND_PATH_OFF_MESSAGE, kinds: [kind] } })

/**
 * REFUND_PATH_OFF when `order_refunds` is off, else null: an order's lines refunded, and money owed on an order given
 * (Refund the rest). The figures, It already arrived (no money moves) and reconcile never ask.
 */
export function orderRefundPathOff(switchValue: string | undefined | null): ApiError | null {
  return off('order_refunds', switchValue)
}

/**
 * REFUND_PATH_OFF when `event_cancels` is off and the cancel gives money back, else null. A cancel with no refund
 * moves no money and needs no kind (E-plan 4.10), as a booking change that moves none; the quotes and the overview
 * never ask.
 */
export function eventCancelPathOff(refund: 'card' | 'credit' | 'cash' | 'none', switchValue: string | undefined | null): ApiError | null {
  return refund === 'none' ? null : off('event_cancels', switchValue)
}

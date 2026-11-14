import { describe, expect, it } from 'vitest'
import { ERROR_HTTP_STATUS } from '@/server/http/errors'
import { bookingPathOff } from '@/server/rules/bookings/booking-switch'
import { kindsOn, ORDER_KINDS, orderPathOff } from '@/server/rules/orders/order-switch'
import { ALL_KINDS_ON } from '@/server/rules/testing/replay/order-side'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import { REFUND_PATH_OFF_MESSAGE } from './failure-messages'
import { eventCancelPathOff, orderRefundPathOff, REFUND_KINDS } from './refund-switch'

// Brief W27 item 6 (E-plan 4.10, lead call L3): ORDER_SWITCH gains `order_refunds` and `event_cancels`, both off by
// default, and a test that they are off. "Off by default" means three things here: with the secret unset or empty;
// with the value live runs today (CLAUDE.md, W19: the six kinds of steps C and D), so pushing this Worker switches
// nothing on; and with every other kind on, so no other word can turn one on by accident.

/** The secret's value on live since W19 (staff app CLAUDE.md, "ORDER_SWITCH now ..."). */
const LIVE_TODAY = 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows'

describe("step E's switch kinds (brief W27 item 6)", () => {
  it('ORDER_SWITCH knows both kinds, and only by their exact names', () => {
    expect(REFUND_KINDS).toEqual(['order_refunds', 'event_cancels'])
    for (const kind of REFUND_KINDS) expect(ORDER_KINDS).toContain(kind)
    expect([...kindsOn('order_refunds event_cancels')].sort()).toEqual(['event_cancels', 'order_refunds'])
    for (const typo of ['order_refund', 'orders_refunds', 'event_cancel', 'events_cancels', 'refunds', 'order-refunds']) expect([...kindsOn(typo)]).toEqual([])
  })

  it('off by default: unset, empty, the value live runs today, and every other kind on', () => {
    const everyOtherKind = ORDER_KINDS.filter((kind) => !(REFUND_KINDS as readonly string[]).includes(kind)).join(',')
    for (const value of [undefined, null, '', '   ', LIVE_TODAY, everyOtherKind, ALL_KINDS_ON, BOOKING_KINDS_ON]) {
      const on = kindsOn(value)
      expect(on.has('order_refunds'), String(value)).toBe(false)
      expect(on.has('event_cancels'), String(value)).toBe(false)
      expect(orderRefundPathOff(value), String(value)).toMatchObject({ code: 'REFUND_PATH_OFF', status: 501, details: { kinds: ['order_refunds'] } })
      for (const refund of ['card', 'credit', 'cash'] as const) {
        expect(eventCancelPathOff(refund, value), `${String(value)} ${refund}`).toMatchObject({ code: 'REFUND_PATH_OFF', details: { kinds: ['event_cancels'] } })
      }
    }
    // The value live runs today is the six kinds of steps C and D, exactly: adding the two here changed none of them.
    expect([...kindsOn(LIVE_TODAY)].sort()).toEqual(['booking_changes', 'membership', 'no_stripe', 'reader', 'reader_flows', 'saved_card'])
  })

  it('off answers the switched-off words with a reason, before anything is read (no database is passed)', () => {
    const refusal = orderRefundPathOff('')
    expect(refusal?.message).toBe(REFUND_PATH_OFF_MESSAGE)
    expect(refusal?.message).toBe('This is switched off in the booking system. Tell a manager.')
    expect(refusal?.details).toEqual({ reason: 'refund_path_off', message: REFUND_PATH_OFF_MESSAGE, kinds: ['order_refunds'] })
    expect(ERROR_HTTP_STATUS.REFUND_PATH_OFF).toBe(501)
  })

  it('each kind turns on only its own action', () => {
    expect(orderRefundPathOff('order_refunds')).toBeNull()
    expect(eventCancelPathOff('card', 'order_refunds')).not.toBeNull()
    expect(eventCancelPathOff('card', 'event_cancels')).toBeNull()
    expect(orderRefundPathOff('event_cancels')).not.toBeNull()
    expect(orderRefundPathOff(`${LIVE_TODAY},order_refunds,event_cancels`)).toBeNull()
    expect(eventCancelPathOff('cash', `${LIVE_TODAY},order_refunds,event_cancels`)).toBeNull()
  })

  it('a cancel with no refund needs no kind (E-plan 4.10)', () => {
    for (const value of [undefined, '', LIVE_TODAY, 'order_refunds']) expect(eventCancelPathOff('none', value)).toBeNull()
  })

  it('neither kind turns on any order or booking change', () => {
    const both = 'order_refunds,event_cancels'
    for (const payment of [{ method: 'cash' }, { method: 'card' }, { method: 'reader' }, {}]) expect(orderPathOff({ payment }, both)?.code).toBe('ORDER_PATH_OFF')
    expect(orderPathOff({ membershipPlanId: '10000000-0000-4000-8000-00000000000a', payment: { method: 'card' } }, both)?.code).toBe('ORDER_PATH_OFF')
    for (const money of ['cash', 'card', 'reader'] as const) {
      expect(bookingPathOff(money, both, 'in')?.code).toBe('BOOKING_PATH_OFF')
      expect(bookingPathOff(money, both, 'out')?.code).toBe('BOOKING_PATH_OFF')
    }
  })
})

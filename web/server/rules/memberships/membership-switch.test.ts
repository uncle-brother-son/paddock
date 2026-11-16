import { describe, expect, it } from 'vitest'
import { ERROR_CODES } from '@/contracts'
import { ERROR_HTTP_STATUS } from '@/server/http/errors'
import { bookingPathOff } from '@/server/rules/bookings/booking-switch'
import { customerCancelPathOff } from '@/server/rules/customer/cancel-switch'
import { kindsOn, ORDER_KINDS, orderKind, orderPathOff } from '@/server/rules/orders/order-switch'
import { eventCancelPathOff, orderRefundPathOff } from '@/server/rules/refunds/refund-switch'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import { ORDER_REFUND_KINDS_ON } from '@/server/rules/testing/replay/order-refund-side'
import { ALL_KINDS_ON } from '@/server/rules/testing/replay/order-side'
import { MEMBERSHIP_PATH_OFF_MESSAGE } from './failure-messages'
import { MEMBERSHIP_KINDS, membershipChangePathOff, membershipChangesOn } from './membership-switch'

// Brief W36 item 2 (F-plan 4.11, lead call L3): ORDER_SWITCH gains `membership_changes`, off by default, with a test
// that it is off with today's live value. "Off by default" means: with the secret unset or empty; with the value live
// runs today, so pushing this Worker switches nothing on; and with every other kind on, so no other word can turn it
// on by accident.

/** The secret's value on live since 15 Nov (staff app CLAUDE.md: W19's six kinds, `order_refunds` at W28/W29, `event_cancels` at W30/W31). */
const LIVE_TODAY = 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels'

describe("step F's switch kind (brief W36 item 2)", () => {
  it('ORDER_SWITCH knows the kind, and only by its exact name', () => {
    expect(MEMBERSHIP_KINDS).toEqual(['membership_changes'])
    expect(ORDER_KINDS).toContain('membership_changes')
    // Added at the end: the nine kinds before it are as they were, in their order.
    expect(ORDER_KINDS).toEqual(['no_stripe', 'saved_card', 'reader', 'membership', 'reader_flows', 'booking_changes', 'order_refunds', 'event_cancels', 'customer_cancels', 'membership_changes'])
    expect([...kindsOn('membership_changes')]).toEqual(['membership_changes'])
    expect([...kindsOn(' Membership_Changes ,')]).toEqual(['membership_changes'])
    for (const typo of ['membership_change', 'memberships_changes', 'membership-changes', 'membershipchanges', 'changes', 'membership']) expect(kindsOn(typo).has('membership_changes'), typo).toBe(false)
  })

  it('off by default: unset, empty, the value live runs today, and every other kind on', () => {
    const everyOtherKind = ORDER_KINDS.filter((kind) => kind !== 'membership_changes').join(',')
    for (const value of [undefined, null, '', '   ', LIVE_TODAY, everyOtherKind, ALL_KINDS_ON, BOOKING_KINDS_ON, ORDER_REFUND_KINDS_ON]) {
      expect(kindsOn(value).has('membership_changes'), String(value)).toBe(false)
      expect(membershipChangesOn(value), String(value)).toBe(false)
      expect(membershipChangePathOff(value), String(value)).toMatchObject({ code: 'MEMBERSHIP_PATH_OFF', status: 501, details: { kinds: ['membership_changes'] } })
    }
  })

  it('the value live runs today is the eight kinds of steps C to E, exactly: adding the kind changed none of them', () => {
    expect([...kindsOn(LIVE_TODAY)].sort()).toEqual(['booking_changes', 'event_cancels', 'membership', 'no_stripe', 'order_refunds', 'reader', 'reader_flows', 'saved_card'])
    // Each of today's kinds still answers as it did: on.
    expect(orderPathOff({ payment: { method: 'cash' } }, LIVE_TODAY)).toBeNull()
    expect(orderPathOff({ payment: { method: 'card' } }, LIVE_TODAY)).toBeNull()
    expect(orderPathOff({ payment: { method: 'reader' } }, LIVE_TODAY)).toBeNull()
    expect(orderPathOff({ membershipPlanId: '10000000-0000-4000-8000-00000000000a', payment: { method: 'card' } }, LIVE_TODAY)).toBeNull()
    for (const money of ['cash', 'card', 'reader'] as const) expect(bookingPathOff(money, LIVE_TODAY, 'in')).toBeNull()
    expect(orderRefundPathOff(LIVE_TODAY)).toBeNull()
    expect(eventCancelPathOff('card', LIVE_TODAY)).toBeNull()
    // And the website's cancels, which live doesn't name, are still off.
    expect(customerCancelPathOff(LIVE_TODAY)?.code).toBe('REFUND_PATH_OFF')
  })

  it('off answers the switched-off words with a reason, before anything is read (no database is passed)', () => {
    const refusal = membershipChangePathOff('')
    expect(refusal?.message).toBe(MEMBERSHIP_PATH_OFF_MESSAGE)
    expect(refusal?.message).toBe('This is switched off in the booking system. Tell a manager.')
    expect(refusal?.details).toEqual({ reason: 'membership_path_off', message: MEMBERSHIP_PATH_OFF_MESSAGE, kinds: ['membership_changes'] })
  })

  it('on only when the secret names it, alone or beside the others', () => {
    expect(membershipChangePathOff('membership_changes')).toBeNull()
    expect(membershipChangesOn('membership_changes')).toBe(true)
    expect(membershipChangePathOff(`${LIVE_TODAY},membership_changes`)).toBeNull()
    expect(membershipChangePathOff(`${LIVE_TODAY} membership_changes`)).toBeNull()
  })

  it('turns on nothing else: no order, booking change, refund, event cancel or website cancel', () => {
    const only = 'membership_changes'
    for (const payment of [{ method: 'cash' }, { method: 'card' }, { method: 'reader' }, {}]) expect(orderPathOff({ payment }, only)?.code).toBe('ORDER_PATH_OFF')
    // Buying a membership is the order's `membership` kind, not this one.
    expect(orderKind({ membershipPlanId: '10000000-0000-4000-8000-00000000000a', payment: { method: 'card' } })).toBe('membership')
    expect(orderPathOff({ membershipPlanId: '10000000-0000-4000-8000-00000000000a', payment: { method: 'card' } }, only)?.code).toBe('ORDER_PATH_OFF')
    for (const money of ['cash', 'card', 'reader'] as const) {
      expect(bookingPathOff(money, only, 'in')?.code).toBe('BOOKING_PATH_OFF')
      expect(bookingPathOff(money, only, 'out')?.code).toBe('BOOKING_PATH_OFF')
    }
    expect(orderRefundPathOff(only)?.code).toBe('REFUND_PATH_OFF')
    expect(eventCancelPathOff('card', only)?.code).toBe('REFUND_PATH_OFF')
    expect(customerCancelPathOff(only)?.code).toBe('REFUND_PATH_OFF')
    // And the order's `membership` kind doesn't turn this one on.
    expect(membershipChangePathOff('membership')?.code).toBe('MEMBERSHIP_PATH_OFF')
  })

  it('MEMBERSHIP_PATH_OFF is an error code with a status, added after the others (the screens branch on these: add, never rename)', () => {
    expect(ERROR_CODES.at(-1)).toBe('MEMBERSHIP_PATH_OFF')
    expect(ERROR_CODES.slice(-4)).toEqual(['ORDER_PATH_OFF', 'BOOKING_PATH_OFF', 'REFUND_PATH_OFF', 'MEMBERSHIP_PATH_OFF'])
    expect(ERROR_HTTP_STATUS.MEMBERSHIP_PATH_OFF).toBe(501)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})

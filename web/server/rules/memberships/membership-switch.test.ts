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
import { CARD_MOVE_KINDS, cardMovesOn, MEMBERSHIP_KINDS, membershipChangePathOff, membershipChangesOn, PAYMENT_DATE_KINDS, paymentDateChangesOn, paymentDatePathOff } from './membership-switch'

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
    // Added at the end: the nine kinds before it are as they were, in their order. W41a: the payment date's own kind after it. W42: the replaced card's after that.
    expect(ORDER_KINDS).toEqual(['no_stripe', 'saved_card', 'reader', 'membership', 'reader_flows', 'booking_changes', 'order_refunds', 'event_cancels', 'customer_cancels', 'membership_changes', 'payment_date_changes', 'card_moves'])
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

// Brief W41a item 1 (lead call, 17 Nov 2026): the payment date change has a kind of its own, so it can be switched
// off (and the old staff app put back for it) without taking W40's cancel and undo with it.
describe("the payment date change's own switch kind (brief W41a item 1)", () => {
  /** The secret's value on live since 17 Nov (W40: `membership_changes` on). */
  const LIVE_SINCE_W40 = `${LIVE_TODAY},membership_changes`

  it('ORDER_SWITCH knows the kind, and only by its exact name', () => {
    expect(PAYMENT_DATE_KINDS).toEqual(['payment_date_changes'])
    expect(ORDER_KINDS.at(-2)).toBe('payment_date_changes')
    expect([...kindsOn(' Payment_Date_Changes ,')]).toEqual(['payment_date_changes'])
    for (const typo of ['payment_date_change', 'payment_dates_changes', 'payment-date-changes', 'paymentdatechanges', 'payment_date', 'date_changes', 'membership_changes']) expect(kindsOn(typo).has('payment_date_changes'), typo).toBe(false)
  })

  it('off by default: unset, empty, the value live runs today (with `membership_changes` on), and every other kind on', () => {
    const everyOtherKind = ORDER_KINDS.filter((kind) => kind !== 'payment_date_changes').join(',')
    for (const value of [undefined, null, '', '   ', LIVE_TODAY, LIVE_SINCE_W40, everyOtherKind]) {
      expect(paymentDateChangesOn(value), String(value)).toBe(false)
      expect(paymentDatePathOff(value), String(value)).toMatchObject({ code: 'MEMBERSHIP_PATH_OFF', status: 501, details: { kinds: ['payment_date_changes'] } })
    }
    // Deploying this Worker changes nothing for the cancel and the undo: they are on as they were.
    expect(membershipChangePathOff(LIVE_SINCE_W40)).toBeNull()
  })

  it('off answers the same switched-off words as the other kinds, naming its own kind', () => {
    const refusal = paymentDatePathOff(LIVE_SINCE_W40)
    expect(refusal?.message).toBe('This is switched off in the booking system. Tell a manager.')
    expect(refusal?.details).toEqual({ reason: 'membership_path_off', message: MEMBERSHIP_PATH_OFF_MESSAGE, kinds: ['payment_date_changes'] })
  })

  it('the two kinds are independent: each turns on its own action and nothing of the other', () => {
    expect(paymentDatePathOff('payment_date_changes')).toBeNull()
    expect(paymentDatePathOff(`${LIVE_SINCE_W40},payment_date_changes`)).toBeNull()
    // The date change on, the cancel and undo off.
    expect(membershipChangesOn('payment_date_changes')).toBe(false)
    expect(membershipChangePathOff('payment_date_changes')?.code).toBe('MEMBERSHIP_PATH_OFF')
    // The cancel and undo on, the date change off.
    expect(paymentDateChangesOn('membership_changes')).toBe(false)
    expect(paymentDatePathOff('membership_changes')?.code).toBe('MEMBERSHIP_PATH_OFF')
  })

  it('turns on nothing else: no order, booking change, refund, event cancel or website cancel', () => {
    const only = 'payment_date_changes'
    for (const payment of [{ method: 'cash' }, { method: 'card' }, { method: 'reader' }, {}]) expect(orderPathOff({ payment }, only)?.code).toBe('ORDER_PATH_OFF')
    for (const money of ['cash', 'card', 'reader'] as const) expect(bookingPathOff(money, only, 'in')?.code).toBe('BOOKING_PATH_OFF')
    expect(orderRefundPathOff(only)?.code).toBe('REFUND_PATH_OFF')
    expect(eventCancelPathOff('card', only)?.code).toBe('REFUND_PATH_OFF')
    expect(customerCancelPathOff(only)?.code).toBe('REFUND_PATH_OFF')
  })
})

// Brief W42 item 1: the replaced card's own kind, `card_moves`, as W41a's for the date change. Off is not a refusal:
// the route saves the card as before W42 and moves no membership (customers/saved-card.test.ts holds the route).
describe("the replaced card's own switch kind (brief W42 item 1)", () => {
  /** The secret's value on live since 17 Nov (W41: `membership_changes` and `payment_date_changes` on). */
  const LIVE_SINCE_W41 = `${LIVE_TODAY},membership_changes,payment_date_changes`

  it('ORDER_SWITCH knows the kind, and only by its exact name', () => {
    expect(CARD_MOVE_KINDS).toEqual(['card_moves'])
    expect(ORDER_KINDS.at(-1)).toBe('card_moves')
    expect([...kindsOn(' Card_Moves ,')]).toEqual(['card_moves'])
    for (const typo of ['card_move', 'cards_moves', 'card-moves', 'cardmoves', 'card', 'moves', 'saved_card', 'membership_changes']) expect(kindsOn(typo).has('card_moves'), typo).toBe(false)
  })

  it('off by default: unset, empty, the value live runs today, and every other kind on', () => {
    const everyOtherKind = ORDER_KINDS.filter((kind) => kind !== 'card_moves').join(',')
    for (const value of [undefined, null, '', '   ', LIVE_TODAY, LIVE_SINCE_W41, everyOtherKind]) expect(cardMovesOn(value), String(value)).toBe(false)
    // Deploying this Worker changes nothing for the cancel, the undo or the date change: they are on as they were.
    expect(membershipChangePathOff(LIVE_SINCE_W41)).toBeNull()
    expect(paymentDatePathOff(LIVE_SINCE_W41)).toBeNull()
  })

  it('on only when the secret names it, and it turns nothing else on or off', () => {
    expect(cardMovesOn(`${LIVE_SINCE_W41},card_moves`)).toBe(true)
    expect(cardMovesOn('card_moves')).toBe(true)
    expect([...kindsOn('card_moves')]).toEqual(['card_moves'])
    // Each of step F's three kinds answers for itself alone.
    expect(membershipChangesOn('card_moves')).toBe(false)
    expect(paymentDateChangesOn('card_moves')).toBe(false)
    expect(cardMovesOn('membership_changes,payment_date_changes')).toBe(false)
    // A basket is never this kind: it gates no order.
    expect(orderKind({ payment: { method: 'card' } } as Parameters<typeof orderKind>[0])).toBe('saved_card')
  })
})

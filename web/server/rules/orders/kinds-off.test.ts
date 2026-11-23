import { describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { lapseSweep } from '@/server/rules/bookings/lapse-sweep'
import { bookingPathOff } from '@/server/rules/bookings/booking-switch'
import { planChangePathOff } from '@/server/rules/catalog/plan-switch'
import { cardMovePathOff, membershipChangePathOff, paymentDatePathOff, paymentRetryPathOff } from '@/server/rules/memberships/membership-switch'
import { customerCancelPathOff } from '@/server/rules/customer/cancel-switch'
import { eventCancelPathOff, orderRefundPathOff } from '@/server/rules/refunds/refund-switch'
import { ORDER_KINDS, orderPathOff, type OrderKind } from './order-switch'

// Brief W68 item 2 (H5; lead call L-H3; the W45 audit's rows 50 and 59): every switch kind is a stop. With one kind off and
// every other on, what it gates refuses (or, for the lapse sweep, pauses): nothing is done another way. One test per kind;
// the gates themselves, with their words, are held beside each, and the routes by their own tests. The two that had another
// way until W68 are held end to end in customers/saved-card.test.ts and bookings/lapse-sweep.test.ts.

/** What each kind gates, asked with the switch given: the refusal's code, or 'paused', or null when it goes ahead. */
const GATES: Readonly<Record<OrderKind, (switchValue: string) => Promise<string | null> | string | null>> = {
  no_stripe: (on) => orderPathOff({ payment: { method: 'cash' } } as Parameters<typeof orderPathOff>[0], on)?.code ?? null,
  saved_card: (on) => orderPathOff({ payment: { method: 'card' } } as Parameters<typeof orderPathOff>[0], on)?.code ?? null,
  reader: (on) => orderPathOff({ payment: { method: 'reader' } } as Parameters<typeof orderPathOff>[0], on)?.code ?? null,
  membership: (on) => orderPathOff({ membershipPlanId: 'plan', payment: { method: 'card' } } as Parameters<typeof orderPathOff>[0], on)?.code ?? null,
  reader_flows: (on) => bookingPathOff('reader', on)?.code ?? null,
  booking_changes: (on) => bookingPathOff('cash', on)?.code ?? null,
  order_refunds: (on) => orderRefundPathOff(on)?.code ?? null,
  event_cancels: (on) => eventCancelPathOff('card', on)?.code ?? null,
  customer_cancels: (on) => customerCancelPathOff(on)?.code ?? null,
  membership_changes: (on) => membershipChangePathOff(on)?.code ?? null,
  payment_date_changes: (on) => paymentDatePathOff(on)?.code ?? null,
  card_moves: (on) => cardMovePathOff(on)?.code ?? null,
  lapse_sweep: async (on) => {
    // A database that fails if it is asked anything: off, the sweep reads nothing.
    const asked: string[] = []
    const db = { query: async (sql: string) => (asked.push(sql), []) } as unknown as Db
    const run = await lapseSweep(db, { requestId: 'kinds-off', orderSwitch: on })
    return !run.ran && asked.length === 0 ? 'paused' : null
  },
  payment_retries: (on) => paymentRetryPathOff(on)?.code ?? null,
  plan_changes: (on) => planChangePathOff(on)?.code ?? null,
}
const EXPECTED: Readonly<Record<OrderKind, string>> = {
  no_stripe: 'ORDER_PATH_OFF',
  saved_card: 'ORDER_PATH_OFF',
  reader: 'ORDER_PATH_OFF',
  membership: 'ORDER_PATH_OFF',
  reader_flows: 'BOOKING_PATH_OFF',
  booking_changes: 'BOOKING_PATH_OFF',
  order_refunds: 'REFUND_PATH_OFF',
  event_cancels: 'REFUND_PATH_OFF',
  customer_cancels: 'REFUND_PATH_OFF',
  membership_changes: 'MEMBERSHIP_PATH_OFF',
  payment_date_changes: 'MEMBERSHIP_PATH_OFF',
  card_moves: 'MEMBERSHIP_PATH_OFF',
  lapse_sweep: 'paused',
  payment_retries: 'MEMBERSHIP_PATH_OFF',
  plan_changes: 'MEMBERSHIP_PATH_OFF',
}

describe('every switch kind off refuses or pauses (W68, H5)', () => {
  it.each(ORDER_KINDS)('%s off, every other kind on', async (kind) => {
    const others = ORDER_KINDS.filter((one) => one !== kind).join(',')
    expect(await GATES[kind](others)).toBe(EXPECTED[kind])
    // On, it goes ahead; and no other kind's gate is moved by this one.
    expect(await GATES[kind](ORDER_KINDS.join(','))).toBeNull()
    for (const other of ORDER_KINDS.filter((one) => one !== kind)) {
      // A reader flow needs the booking and reader kinds too (W17), so it stops with any of the three.
      const needsIt = other === 'reader_flows' && (kind === 'booking_changes' || kind === 'reader')
      expect(await GATES[other](others), `${other} with ${kind} off`).toBe(needsIt ? EXPECTED[other] : null)
    }
  })

  it('an unset switch is every kind off', async () => {
    for (const kind of ORDER_KINDS) expect(await GATES[kind](''), kind).toBe(EXPECTED[kind])
  })
})

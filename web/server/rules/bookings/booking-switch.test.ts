import { describe, expect, it } from 'vitest'
import { ERROR_HTTP_STATUS } from '@/server/http/errors'
import { kindsOn, ORDER_KINDS, orderPathOff } from '@/server/rules/orders/order-switch'
import { bookingKindsNeeded, bookingPathOff, type BookingMoney } from './booking-switch'
import { BOOKING_PATH_OFF_MESSAGE } from './failure-messages'

// W17 brief item 2 (D-plan 4.9, lead call L1): ORDER_SWITCH gains `booking_changes`, and `reader_flows` gates the
// reader flows; a booking change whose kinds aren't all on answers BOOKING_PATH_OFF before anything is touched. The
// routes that call it come with their slices (W18 to W24); this holds the decision itself.

const LIVE_NOW = 'no_stripe,saved_card,reader,membership'
const EVERYTHING = ORDER_KINDS.join(',')

describe('the booking switch', () => {
  it('ORDER_SWITCH lists booking_changes and reader_flows as kinds, and a typo turns nothing on', () => {
    expect(ORDER_KINDS).toContain('booking_changes')
    expect(ORDER_KINDS).toContain('reader_flows')
    expect([...kindsOn('booking_change, reader-flows')]).toEqual([])
  })

  it.each<[BookingMoney, 'in' | 'out', string[]]>([
    ['none', 'in', []],
    ['cash', 'in', ['booking_changes']],
    ['cash', 'out', ['booking_changes']],
    ['card', 'in', ['booking_changes', 'saved_card']],
    ['card', 'out', ['booking_changes']],
    ['reader', 'in', ['booking_changes', 'reader_flows', 'reader']],
  ])('%s money %s needs %j', (money, direction, needed) => {
    expect(bookingKindsNeeded(money, direction)).toEqual(needed)
  })

  it('as live today (no booking kinds on): every change that moves money answers BOOKING_PATH_OFF, with the words, and the kinds that are off', () => {
    for (const money of ['cash', 'card', 'reader'] as const) {
      const off = bookingPathOff(money, LIVE_NOW)
      expect(off?.code).toBe('BOOKING_PATH_OFF')
      expect(off?.status).toBe(501)
      expect(off?.message).toBe(BOOKING_PATH_OFF_MESSAGE)
      expect(off?.details).toMatchObject({ reason: 'booking_path_off', message: BOOKING_PATH_OFF_MESSAGE, kinds: expect.arrayContaining(['booking_changes']) })
    }
    expect(bookingPathOff('none', LIVE_NOW)).toBeNull()
  })

  it('booking_changes on: cash and refunds go; the saved card also needs saved_card; the reader also needs reader_flows and reader', () => {
    const on = `${LIVE_NOW},booking_changes`
    expect(bookingPathOff('cash', on)).toBeNull()
    expect(bookingPathOff('card', on, 'out')).toBeNull()
    expect(bookingPathOff('card', on)).toBeNull()
    expect(bookingPathOff('reader', on)?.details).toMatchObject({ kinds: ['reader_flows'] })
    expect(bookingPathOff('card', 'booking_changes')?.details).toMatchObject({ kinds: ['saved_card'] })
    expect(bookingPathOff('reader', 'booking_changes,reader_flows')?.details).toMatchObject({ kinds: ['reader'] })
    expect(bookingPathOff('reader', 'booking_changes')?.details).toMatchObject({ kinds: ['reader_flows', 'reader'] })
    expect(bookingPathOff('reader', EVERYTHING)).toBeNull()
  })

  // W18 (the W17 review's later 5, lead call): one emergency stop of the reader stops it for orders and booking
  // changes alike, and leaves everything else running.
  it('reader off alone stops the reader for orders and booking changes, and nothing else', () => {
    const noReader = ORDER_KINDS.filter((kind) => kind !== 'reader').join(',')
    expect(orderPathOff({ payment: { method: 'reader' } }, noReader)?.code).toBe('ORDER_PATH_OFF')
    expect(bookingPathOff('reader', noReader)?.details).toMatchObject({ reason: 'booking_path_off', kinds: ['reader'] })
    expect(orderPathOff({ payment: { method: 'card' } }, noReader)).toBeNull()
    expect(orderPathOff({ payment: { method: 'cash' } }, noReader)).toBeNull()
    expect(bookingPathOff('card', noReader)).toBeNull()
    expect(bookingPathOff('card', noReader, 'out')).toBeNull()
    expect(bookingPathOff('cash', noReader)).toBeNull()
    expect(bookingPathOff('none', noReader)).toBeNull()
  })

  it('reader_flows off alone stops only the reader', () => {
    const noReaderFlows = ORDER_KINDS.filter((kind) => kind !== 'reader_flows').join(',')
    expect(bookingPathOff('reader', noReaderFlows)?.code).toBe('BOOKING_PATH_OFF')
    expect(bookingPathOff('card', noReaderFlows)).toBeNull()
    expect(bookingPathOff('cash', noReaderFlows)).toBeNull()
  })

  it('the booking kinds never turn an order on, and the order kinds never a booking change', () => {
    expect(orderPathOff({ payment: { method: 'cash' } }, 'booking_changes,reader_flows')?.code).toBe('ORDER_PATH_OFF')
    expect(bookingPathOff('cash', LIVE_NOW)?.code).toBe('BOOKING_PATH_OFF')
  })

  it('BOOKING_PATH_OFF is an error code every client knows, at 501 as ORDER_PATH_OFF', () => {
    expect(ERROR_HTTP_STATUS.BOOKING_PATH_OFF).toBe(ERROR_HTTP_STATUS.ORDER_PATH_OFF)
  })
})

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cancelEventBookingOutcomeSchema,
  cancelEventInputSchema,
  cancelEventPlacesInputSchema,
  cancelEventPlacesOutputSchema,
  ERROR_CODES,
  eventCancelOverviewOutputSchema,
  eventCancelQuoteInputSchema,
  eventCancelQuoteOutputSchema,
  eventCancelRefusalDetailsSchema,
  orderOwedArrivedInputSchema,
  orderRefundFiguresSchema,
  orderRefundOwedInputSchema,
  orderRefundRefusalDetailsSchema,
  refundOrderInputSchema,
  refundOrderOutputSchema,
} from '@/contracts'
import { ERROR_HTTP_STATUS } from '@/server/http/errors'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide } from './harness'
import { scenarios, W27_PREFIX } from './scenarios'

// Brief W27 item 5: contracts/refunds.ts and contracts/events.ts, ahead of the routes that use them (W28 to W31).
// No route parses with them yet, so this holds them to the one thing that exists: the old functions. Every W27
// scenario is run through the frozen copy of the old code, and each call's own params and each answer, as the function
// gave it (before the recording labels its ids), must fit the contract for its route. So the thin wrappers W28 to W31
// write can hand the Worker what the screens send today and hand the screens back what they read today.

vi.setConfig({ testTimeout: 30_000 })

type Row = Record<string, unknown>
interface Call {
  scenario: string
  action: string
  params: Row
  result: unknown
}

const w27 = scenarios.filter((scenario) => scenario.name.startsWith(W27_PREFIX))
/** A call's params without the id that goes in the route's path. */
const body = (params: Row, inPath: string): Row => Object.fromEntries(Object.entries(params).filter(([key]) => key !== inPath))

describe("the step E contracts fit what the old functions take and give (brief W27 item 5)", () => {
  let environment: ReplayEnvironment
  const calls: Call[] = []

  beforeAll(async () => {
    environment = await startReplay()
    for (const scenario of w27) {
      await replay(environment, scenario, (db, stripe): ReplaySide => {
        const old = oldSide(db, stripe)
        return {
          name: old.name,
          async call(action, params) {
            try {
              const result = await old.call(action, params)
              calls.push({ scenario: scenario.name, action, params: params as Row, result })
              return result
            } catch (err) {
              calls.push({ scenario: scenario.name, action, params: params as Row, result: { thrown: err instanceof Error ? err.message : String(err) } })
              throw err
            }
          },
        }
      })
    }
  }, 600_000)
  afterAll(() => environment.stop())

  const of = (action: string) => calls.filter((call) => call.action === action)
  const problems = (schema: { safeParse(value: unknown): { success: boolean; error?: { message: string } } }, picked: Call[], value: (call: Call) => unknown): string[] =>
    picked.flatMap((call) => {
      const parsed = schema.safeParse(value(call))
      return parsed.success ? [] : [`${call.scenario}: ${parsed.error?.message ?? 'no fit'}`]
    })
  const answered = (call: Call) => call.result !== null && typeof call.result === 'object' && !('thrown' in (call.result as Row))
  const succeeded = (call: Call) => answered(call) && ((call.result as Row)['success'] === true || (call.result as Row)['ok'] === true)
  const refused = (call: Call) => answered(call) && ((call.result as Row)['success'] === false || (call.result as Row)['ok'] === false)

  it('every W27 scenario ran, and each of the five old functions was called', () => {
    expect(new Set(calls.map((call) => call.scenario)).size).toBe(137)
    for (const action of ['refundOrder', 'cancelEventPlaces', 'cancelEvent', 'getEventCancellationQuote', 'getEventCancellationOverview']) expect(of(action).length, action).toBeGreaterThan(5)
  })

  it("refundOrder: every call's params fit the input (the order's id goes in the path), loose where the old function answered for itself", () => {
    const picked = of('refundOrder')
    expect(picked.length).toBeGreaterThan(70)
    expect(problems(refundOrderInputSchema, picked, (call) => body(call.params, 'orderId'))).toEqual([])
    // What the old function refused itself still parses, so the rule answers the old reason, not a generic VALIDATION.
    expect(refundOrderInputSchema.safeParse({ lineItemIds: [], refundMethod: 'cash' }).success).toBe(true)
    expect(refundOrderInputSchema.safeParse({}).success).toBe(true)
    // The new part: the figure staff were shown (Q18).
    expect(refundOrderInputSchema.parse({ lineItemIds: ['a'], refundMethod: 'card', confirmed: { amount: 13.5 } }).confirmed).toEqual({ amount: 13.5 })
    expect(refundOrderInputSchema.safeParse({ confirmed: { amount: '13.50' } }).success).toBe(false)
  })

  it("refundOrder: every success fits the output, in the old function's fields", () => {
    const picked = of('refundOrder').filter(succeeded)
    expect(picked.length).toBeGreaterThan(40)
    expect(problems(refundOrderOutputSchema, picked, (call) => call.result)).toEqual([])
    // Nothing the screen reads is dropped: every field of every old success is a field of the contract.
    const fields = new Set(picked.flatMap((call) => Object.keys(call.result as Row)))
    fields.delete('success')
    expect([...fields].filter((field) => !(field in refundOrderOutputSchema.shape))).toEqual([])
  })

  it("refundOrder: every refusal's reason and words fit the refusal details (the one with no words gets the dialog's)", () => {
    const picked = of('refundOrder').filter(refused)
    expect(picked.length).toBeGreaterThan(25)
    const withWords = picked.filter((call) => typeof (call.result as Row)['message'] === 'string')
    expect(problems(orderRefundRefusalDetailsSchema, withWords, (call) => ({ reason: (call.result as Row)['reason'], message: (call.result as Row)['message'], action: 'refund' }))).toEqual([])
    // `order_not_found` is the only reason the old function gave no words for.
    expect([...new Set(picked.filter((call) => !withWords.includes(call)).map((call) => (call.result as Row)['reason']))]).toEqual(['order_not_found'])
  })

  it("cancelEventPlaces: every call's params fit the input (the booking's id goes in the path)", () => {
    const picked = of('cancelEventPlaces')
    expect(picked.length).toBeGreaterThan(80)
    expect(problems(cancelEventPlacesInputSchema, picked, (call) => body(call.params, 'eventBookingId'))).toEqual([])
    expect(cancelEventPlacesInputSchema.safeParse({ refund: 'cash', attendeeIds: [] }).success).toBe(true)
    expect(cancelEventPlacesInputSchema.parse({ refund: 'card', wholeEvent: true, confirmed: { refund: 80 } })).toMatchObject({ wholeEvent: true, confirmed: { refund: 80 } })
  })

  it('cancelEventPlaces: every success fits the output, the booking as the attendee list shows it included', () => {
    const picked = of('cancelEventPlaces').filter(succeeded)
    expect(picked.length).toBeGreaterThanOrEqual(45)
    expect(problems(cancelEventPlacesOutputSchema, picked, (call) => call.result)).toEqual([])
    expect(picked.some((call) => (call.result as Row)['booking'] !== null)).toBe(true)
    const fields = new Set(picked.flatMap((call) => Object.keys(call.result as Row)))
    fields.delete('ok')
    expect([...fields].filter((field) => !(field in cancelEventPlacesOutputSchema.shape))).toEqual([])
    // And every field of the booking and of each place.
    const bookings = picked.map((call) => (call.result as Row)['booking'] as Row | null).filter((booking): booking is Row => booking !== null)
    const bookingShape = cancelEventPlacesOutputSchema.shape.booking.unwrap().shape
    expect([...new Set(bookings.flatMap((booking) => Object.keys(booking)))].filter((field) => !(field in bookingShape))).toEqual([])
    const placeShape = bookingShape.attendees.element.shape
    expect([...new Set(bookings.flatMap((booking) => (booking['attendees'] as Row[]).flatMap((place) => Object.keys(place))))].filter((field) => !(field in placeShape))).toEqual([])
  })

  it('cancelEventPlaces and the quote: every refusal fits the refusal details', () => {
    const picked = [...of('cancelEventPlaces'), ...of('getEventCancellationQuote')].filter(refused)
    expect(picked.length).toBeGreaterThan(40)
    expect(problems(eventCancelRefusalDetailsSchema, picked, (call) => ({ reason: (call.result as Row)['reason'], message: (call.result as Row)['message'], action: call.action === 'cancelEventPlaces' ? 'cancel_places' : 'quote' }))).toEqual([])
  })

  it("the quote: every call's params fit the input, and every answer the output", () => {
    const picked = of('getEventCancellationQuote')
    expect(problems(eventCancelQuoteInputSchema, picked, (call) => body(call.params, 'eventBookingId'))).toEqual([])
    const quotes = picked.filter(succeeded)
    expect(quotes.length).toBeGreaterThanOrEqual(12)
    expect(problems(eventCancelQuoteOutputSchema, quotes, (call) => call.result)).toEqual([])
    const fields = new Set(quotes.flatMap((call) => Object.keys(call.result as Row)))
    fields.delete('ok')
    expect([...fields].filter((field) => !(field in eventCancelQuoteOutputSchema.shape))).toEqual([])
  })

  it('the overview: every answer fits the output (the old null, for an event that is gone, becomes NOT_FOUND)', () => {
    const picked = of('getEventCancellationOverview')
    const found = picked.filter((call) => call.result !== null)
    expect(found.length).toBeGreaterThanOrEqual(8)
    expect(problems(eventCancelOverviewOutputSchema, found, (call) => call.result)).toEqual([])
    expect(picked.some((call) => call.result === null)).toBe(true)
    const fields = new Set(found.flatMap((call) => Object.keys(call.result as Row)))
    expect([...fields].filter((field) => !(field in eventCancelOverviewOutputSchema.shape))).toEqual([])
  })

  it("the whole event: the reason fits the new input (the refund choice moves to each booking's own press, L5), and each booking's outcome fits", () => {
    const picked = of('cancelEvent')
    expect(problems(cancelEventInputSchema, picked, (call) => ({ reason: call.params['reason'] }))).toEqual([])
    const outcomes = picked.filter(succeeded).flatMap((call) => ((call.result as Row)['results'] as Row[]).map((result) => ({ ...call, result })))
    expect(outcomes.length).toBeGreaterThan(12)
    expect(problems(cancelEventBookingOutcomeSchema, outcomes, (call) => call.result)).toEqual([])
    const refusals = picked.filter(refused)
    expect(problems(eventCancelRefusalDetailsSchema, refusals, (call) => ({ reason: (call.result as Row)['reason'], message: (call.result as Row)['message'], action: 'cancel_event' }))).toEqual([])
  })
})

describe("step E's new inputs, figures and error code", () => {
  it('Refund the rest and It already arrived on an order: an amount, and a method or a reason', () => {
    expect(orderRefundOwedInputSchema.parse({ amount: 24, refundMethod: 'card' })).toEqual({ amount: 24, refundMethod: 'card' })
    expect(orderRefundOwedInputSchema.safeParse({ refundMethod: 'card' }).success).toBe(false)
    // Any method is a string, so the rule refuses a wrong one with its own words.
    expect(orderRefundOwedInputSchema.safeParse({ amount: 24, refundMethod: 'cheque' }).success).toBe(true)
    expect(orderOwedArrivedInputSchema.parse({ amount: 10, reason: 'Refunded in Stripe by hand' })).toEqual({ amount: 10, reason: 'Refunded in Stripe by hand' })
    // The reason is checked by the rule, with its own words: a missing or empty one still parses.
    expect(orderOwedArrivedInputSchema.safeParse({ amount: 10 }).success).toBe(true)
    expect(orderOwedArrivedInputSchema.safeParse({ amount: 10, reason: null }).success).toBe(true)
  })

  it("the figures the Refund Line Items dialog will show and send back (E1): each line's own figure, the card and cash left, and money owed", () => {
    const orderId = '10000000-0000-4000-8000-0000000000a1'
    const figures = {
      orderId,
      paymentStatus: 'paid',
      lines: [{ lineItemId: '10000000-0000-4000-8000-0000000000a2', itemType: 'product', lineTotal: 15, discount: 1.5, cardRefunded: 0, refundable: 13.5, refunded: false, blocked: null }],
      cardLeft: 13.5,
      cashLeft: 0,
      refundOwed: 0,
      blocked: null,
    }
    expect(orderRefundFiguresSchema.parse(figures)).toEqual(figures)
    expect(orderRefundFiguresSchema.safeParse({ ...figures, refundOwed: undefined }).success).toBe(false)
    expect(orderRefundRefusalDetailsSchema.parse({ reason: 'amount_changed', message: 'The figures have just changed.', action: 'refund', figures }).figures).toEqual(figures)
  })

  it('REFUND_PATH_OFF is an error code with a status, added to the end of the list (the screens branch on these: add, never rename)', () => {
    expect(ERROR_CODES.at(-1)).toBe('REFUND_PATH_OFF')
    expect(ERROR_CODES.indexOf('BOOKING_PATH_OFF')).toBe(ERROR_CODES.length - 2)
    expect(ERROR_HTTP_STATUS.REFUND_PATH_OFF).toBe(501)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})

import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { loadBooking, paymentOpen } from '@/server/rules/bookings/load-booking'
import { loadBookingMoneyLeft, orderPaymentStatusAfterRefunds, type BookingMoneyLeft } from '@/server/rules/bookings/money-left'
import { compareRecordings, type Recording } from './compare'
import { BOOKING_ACTIONS, BUILT_BOOKING_ACTIONS, GIFT_CARD_PART_WITHOUT_ORDER, newBookingSide } from './booking-side'
import { LEGACY_BOOKING_ACTIONS, oldFunctionPath, readGolden, replay, startReplay, type ReplayEnvironment } from './harness'
import { scenarios } from './scenarios'

// W17 (brief "Parity and tests"): step D's side of the replay, before any action has a route.
// 1. Every golden scenario runs through newBookingSide: setup and every step D action through the frozen copy of the
//    old functions, except the refund figures, which the Worker's money-left.ts answers. Each must still match its
//    golden file, the figures included; the one difference allowed is W05l later 1's (a gift card part with no order
//    is gift card money, not cash), and only where the rows show such a part.
// 2. At the end of every scenario, each booking and order is read by the Worker's loaders and by the frozen old code,
//    on the same rows: the figures, the open-payment guard and an order's status after refunds must agree.
// 3. A deliberate difference on the new side is caught.

type Figures = BookingMoneyLeft
type Loaded = { default: (req: { params: unknown; user: { email: string } }) => Promise<unknown> }

const results = (recording: Recording) => recording.results as unknown[]
const round = (n: number) => Math.round(n * 100) / 100

/** Bookings and orders the scenario left, in a fixed order. */
async function endState(db: Db) {
  const bookings = await db.query<{ id: string }>('SELECT id FROM bookings ORDER BY created_at, id')
  const orders = await db.query<{ id: string }>('SELECT id FROM orders ORDER BY created_at, id')
  return { bookings: bookings.map((row) => row.id), orders: orders.map((row) => row.id) }
}

/** A gift card part recorded against the booking with no order (Move, Settle, a flow's finalise). */
async function giftCardPartWithoutOrder(db: Db, bookingId: string): Promise<number> {
  const row = (
    await db.query<{ total: string }>(
      'SELECT COALESCE(SUM(amount_used), 0)::text AS total FROM gift_card_redemptions WHERE booking_id = $1 AND order_id IS NULL',
      [bookingId]
    )
  )[0]
  return Number.parseFloat(row?.total ?? '0')
}

/**
 * The new figures against the old: equal, or (W05l later 1) the same but for some of the cash moved to the gift card
 * part, never more than the gift card money recorded against the booking with no order.
 */
function sameButForGiftCardPart(oldFigures: Figures, newFigures: Figures, withoutOrder: number): boolean {
  const { parts: oldParts, ...oldRest } = oldFigures
  const { parts: newParts, ...newRest } = newFigures
  const total = (parts: Figures['parts']) => round(parts.card + parts.giftCard + parts.storeCredit + parts.cash)
  const moved = round(newParts.giftCard - oldParts.giftCard)
  return (
    JSON.stringify(oldRest) === JSON.stringify(newRest) &&
    oldParts.card === newParts.card &&
    total(oldParts) === total(newParts) &&
    moved > 0 &&
    moved <= round(withoutOrder) + 0.001 &&
    // Store credit is counted after the gift card, so it can only lose what the gift card part took.
    newParts.storeCredit <= oldParts.storeCredit
  )
}

describe("step D's side of the replay (W17)", () => {
  let environment: ReplayEnvironment
  const dScenarios = new Set<string>()
  const figuresScenarios = new Set<string>()
  const shifted: string[] = []
  const counts = { bookings: 0, orders: 0, figuresCompared: 0, guardsCompared: 0, statusesCompared: 0, giftCardShifted: 0 }

  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  it('the side sends only the built actions to the Worker, and every old step D action is a slice\'s', () => {
    expect([...BUILT_BOOKING_ACTIONS.keys()]).toEqual(['getBookingRefundFigures'])
    expect([...BOOKING_ACTIONS.keys()].sort()).toEqual([...LEGACY_BOOKING_ACTIONS].sort())
    expect(() => newBookingSide({ actions: new Map([['createOrder', async () => null]]) })).toThrow("createOrder isn't one of the old step D actions.")
  })

  describe.each(scenarios.map((scenario) => scenario.name))('%s', (name) => {
    it('matches its golden file with the figures from the Worker, and the Worker reads the end state as the old code does', async () => {
      const scenario = scenarios.find((s) => s.name === name)
      if (!scenario) throw new Error(`No scenario ${name}`)
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const recording = await replay(environment, scenario, newBookingSide({ calls }))
      if (calls.some((call) => LEGACY_BOOKING_ACTIONS.has(call.action))) dScenarios.add(name)
      const golden = readGolden(name) as Recording
      expect(golden, `No golden file for ${name}`).not.toBeNull()

      const { db } = environment.database
      const differences = compareRecordings(golden, recording)
      if (calls.some((call) => call.action === 'getBookingRefundFigures')) figuresScenarios.add(name)
      // The built action really went to the Worker; everything else to the old code.
      expect(calls.filter((call) => call.side === 'new').map((call) => call.action)).toEqual(
        calls.filter((call) => BUILT_BOOKING_ACTIONS.has(call.action)).map((call) => call.action)
      )
      expect(calls.filter((call) => call.action === 'getBookingRefundFigures').every((call) => call.side === 'new')).toBe(true)
      if (differences.length > 0) {
        // Only W05l later 1's split may differ, and only on a figures answer whose booking has such a part.
        expect(differences.every((difference) => GIFT_CARD_PART_WITHOUT_ORDER.path.test(difference.path)), JSON.stringify(differences)).toBe(true)
        for (const index of new Set(differences.map((difference) => Number(/\.results\[(\d+)\]/.exec(difference.path)?.[1])))) {
          const oldFigures = results(golden)[index] as Figures
          const newFigures = results(recording)[index] as Figures
          const bookings = await db.query<{ id: string }>('SELECT id FROM bookings WHERE customer_id = $1', [newFigures.customerId])
          const withoutOrder = Math.max(0, ...(await Promise.all(bookings.map((booking) => giftCardPartWithoutOrder(db, booking.id)))))
          expect(sameButForGiftCardPart(oldFigures, newFigures, withoutOrder), `${name} result ${index}`).toBe(true)
        }
        shifted.push(name)
      }
      expect(compareRecordings(golden, recording, differences.length > 0 ? [GIFT_CARD_PART_WITHOUT_ORDER] : [])).toEqual([])

      // The end state, read both ways. The old side's globals are still bound to this run's database.
      const oldFigures = (await import(/* @vite-ignore */ oldFunctionPath('getBookingRefundFigures'))) as Loaded
      const oldGuard = (await import(/* @vite-ignore */ oldFunctionPath('shared/readerPaymentOpen'))) as { anyReaderPaymentOpenOnBooking(id: string): Promise<boolean> }
      const oldStatus = (await import(/* @vite-ignore */ oldFunctionPath('shared/orderPaymentStatus'))) as { recomputeOrderPaymentStatus(id: string): Promise<string | null> }
      const state = await endState(db)
      counts.bookings += state.bookings.length
      counts.orders += state.orders.length
      for (const bookingId of state.bookings) {
        const before = (await oldFigures.default({ params: { bookingId }, user: { email: 'jo@example.com' } })) as Figures
        const after = await loadBookingMoneyLeft(db, bookingId)
        if (!after) throw new Error(`The Worker can't find ${bookingId}`)
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          expect(sameButForGiftCardPart(before, after, await giftCardPartWithoutOrder(db, bookingId)), `${name} ${JSON.stringify({ before, after })}`).toBe(true)
          counts.giftCardShifted += 1
        }
        counts.figuresCompared += 1

        const loaded = await loadBooking(db, bookingId)
        if (!loaded) throw new Error(`loadBooking can't find ${bookingId}`)
        expect(loaded.figures).toEqual(after)
        const row = (
          await db.query<{ status: string; party_size: number; price_paid: string; session_id: string; customer_id: string; seats: string[] }>(
            `SELECT b.status, b.party_size, b.price_paid::text AS price_paid, b.session_id, b.customer_id,
                    COALESCE((SELECT array_agg(g.id ORDER BY g.created_at, g.id) FROM booking_guests g WHERE g.booking_id = b.id), '{}') AS seats
             FROM bookings b WHERE b.id = $1`,
            [bookingId]
          )
        )[0]
        expect({ status: loaded.status, partySize: loaded.partySize, pricePaid: loaded.pricePaid, sessionId: loaded.sessionId, customerId: loaded.customerId }).toEqual({
          status: row?.status,
          partySize: row?.party_size,
          pricePaid: Number.parseFloat(row?.price_paid ?? 'NaN'),
          sessionId: row?.session_id,
          customerId: row?.customer_id,
        })
        expect(loaded.seats.map((seat) => seat.id)).toEqual(row?.seats)
        expect(paymentOpen(loaded), `${name}: the open-payment guard on ${bookingId}`).toBe(await oldGuard.anyReaderPaymentOpenOnBooking(bookingId))
        counts.guardsCompared += 1
      }
      for (const orderId of state.orders) {
        const worker = await orderPaymentStatusAfterRefunds(db, orderId)
        // The old one writes what it works out; this is the end of the run, so nothing reads the rows after it.
        expect(worker, `${name}: order ${orderId}`).toBe(await oldStatus.recomputeOrderPaymentStatus(orderId))
        counts.statusesCompared += 1
      }
    })
  })

  it('a deliberate difference is caught: a penny more card money left on the figures', async () => {
    const name = [...figuresScenarios][0]
    if (!name) throw new Error('No scenario asked for the refund figures.')
    const scenario = scenarios.find((s) => s.name === name)
    if (!scenario) throw new Error(`No scenario ${name}`)
    const planted = newBookingSide({
      adjust: (action, answer) => (action === 'getBookingRefundFigures' ? { ...(answer as Figures), left: round((answer as Figures).left + 0.01) } : answer),
    })
    const recording = await replay(environment, scenario, planted)
    const differences = compareRecordings(readGolden(name) as Recording, recording, [GIFT_CARD_PART_WITHOUT_ORDER])
    expect(differences.map((difference) => difference.path)).toEqual(expect.arrayContaining([expect.stringMatching(/^\.results\[\d+\]\.left$/)]))
  })

  it('a deliberate difference is caught: the gift card split with no gift card part to explain it', () => {
    const before: Figures = { status: 'confirmed', customerId: 'c', pricePaid: 40, refundOwed: 0, left: 40, cardLeft: 40, parts: { card: 30, giftCard: 0, storeCredit: 0, cash: 10 } }
    const after: Figures = { ...before, parts: { ...before.parts, giftCard: 5, cash: 5 } }
    expect(sameButForGiftCardPart(before, after, 5)).toBe(true)
    expect(sameButForGiftCardPart(before, after, 0)).toBe(false)
    expect(sameButForGiftCardPart(before, { ...after, cardLeft: 39 }, 5)).toBe(false)
  })

  it('covered what it says: the step D scenarios, the figures answers, and every booking and order at their ends', () => {
    // For the report: written where W17_COVERAGE_OUT says (vitest keeps a passing test's console quiet).
    const line =
      `W17 replay coverage: ${scenarios.length} scenarios, ${dScenarios.size} call an old step D action, ${figuresScenarios.size} ask for the refund figures; ` +
        `W05l later 1 shifted the figures in ${shifted.length} (${shifted.join(', ') || 'none'}); ` +
        `end states: ${counts.bookings} bookings (${counts.figuresCompared} figures, ${counts.giftCardShifted} of them W05l later 1's split, ${counts.guardsCompared} guards), ` +
        `${counts.orders} orders (${counts.statusesCompared} statuses)`
    if (process.env.W17_COVERAGE_OUT) appendFileSync(process.env.W17_COVERAGE_OUT, `${line}\n`)
    // 684 scenarios on 12 Nov: 256 call an old step D action, 7 ask for the figures (W17-logs/booking-replay-*.txt).
    expect(dScenarios.size).toBeGreaterThanOrEqual(256)
    expect(figuresScenarios.size).toBeGreaterThanOrEqual(7)
    // W05l later 1 is seen working on real end states, not only on the planted case.
    expect(counts.giftCardShifted).toBeGreaterThan(0)
    expect(counts.figuresCompared).toBe(counts.bookings)
    expect(counts.statusesCompared).toBe(counts.orders)
  })
})

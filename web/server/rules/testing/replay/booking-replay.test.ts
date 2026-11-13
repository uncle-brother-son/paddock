import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { loadBooking, paymentOpen } from '@/server/rules/bookings/load-booking'
import { loadBookingMoneyLeft, orderPaymentStatusAfterRefunds, type BookingMoneyLeft } from '@/server/rules/bookings/money-left'
import { compareRecordings, type Recording } from './compare'
import { invalidStatusMessage, STATUS_PAYMENT_NEEDED_MESSAGE } from '@/server/rules/bookings/failure-messages'
import { STAFF_STATUSES } from '@/server/rules/bookings/edits'
import {
  ADD_GUEST_DIFFERENCES,
  BOOKING_ACTIONS,
  CANCEL_DIFFERENCES,
  MOVE_DIFFERENCES,
  BUILT_BOOKING_ACTIONS,
  cardRecordProblems,
  claimLookProblems,
  PARTLY_BUILT,
  REFUND_DIFFERENCES,
  REMOVE_DIFFERENCES,
  REMOVE_GUEST_24_HOURS_DIFFERENCES,
  comparable,
  GIFT_CARD_PART_WITHOUT_ORDER,
  N3_DIFFERENCES,
  newAuditRowProblems,
  newBookingSide,
  SETTLE_DIFFERENCES,
  storedAnswerProblems,
} from './booking-side'
import { W12_FLOW_SCENARIOS } from './flow-side'
import { LEGACY_BOOKING_ACTIONS, oldFunctionPath, oldSide, readGolden, replay, startReplay, type ReplayEnvironment } from './harness'
import { sweepInvariants } from './invariants'
import { scenarios } from './scenarios'

// W21a (W21 review S2): one time limit for every test in this file. The sweeps grow each slice and a busy run took the
// Settle sweep past the 5 s default (and a timed-out sweep keeps writing into the next test's database). Each
// scenario is already bounded by its own Stripe deadlines; the 5 s default stays for every other file.
vi.setConfig({ testTimeout: 300_000 })

// W17 (brief "Parity and tests"): step D's side of the replay, before any action has a route.
// 1. Every golden scenario runs through newBookingSide: setup and every step D action through the frozen copy of the
//    old functions, except the refund figures, which the Worker's money-left.ts answers. Each must still match its
//    golden file, the figures included; the one difference allowed is W05l later 1's (a gift card part with no order
//    is gift card money, not cash), and only where the rows show such a part.
// 2. At the end of every scenario, each booking and order is read by the Worker's loaders and by the frozen old code,
//    on the same rows: the figures, the open-payment guard and an order's status after refunds must agree.
// 3. A deliberate difference on the new side is caught.
// W18: special requests and status go to the Worker too, through the staff app's thin wrappers and the real routes.
// The only scenarios that call them are W17's three N3 recordings, and N3 is their only named difference
// (N3_DIFFERENCES); the W05 invariants, which the old code breaks there, hold on the new side.
// W19: Settle and the reader flows' finalise and cancel go to the Worker too, through the staff app's wrappers (an old
// flow, from old Move or Add Guest, still reaches the wrappers' old body). Every scenario that calls Settle, W12's two
// reader Settle recordings included, matches with SETTLE_DIFFERENCES only, and the audit rows the Worker doesn't
// replace are exactly the golden file's.

/**
 * W20 (W19 review later 4): both sides compared as `comparable` has them: the swapped audit rows and the stored answers
 * set aside (each checked exactly on its own: newAuditRowProblems, storedAnswerProblems), the random refs and gone ids
 * numbered the same way on both. Everything else is compared exactly.
 */
const compareSides = (golden: Recording, recording: Recording, named: Parameters<typeof compareRecordings>[2]) =>
  compareRecordings(comparable(golden, 'golden'), comparable(recording, 'new'), named)

// W19: flow-side.ts (W12's Settle recordings) imports the flow routes when it loads, so the routes' database and Stripe
// client are the replay's from the start, as flow-replay.test.ts mocks them.
const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('./stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

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

/**
 * W24: the holds three Move scenarios end with, not end states (each named in MOVE_DIFFERENCES; move.test.ts runs
 * reconcile on the same holds and it finishes each): a cheaper move whose card part went and whose store credit write
 * failed (R2 held: the card part not yet on its line, price_paid as R1 left it), and a card move whose gift card row
 * failed in C2 (held: the booking moved and its £5 gift card claimed, the £6 card payment on no order yet).
 */
const MOVE_CREDIT_HELD_BREACHES = [
  'public-move-credit-fails-partway: price_paid £25.00, but £51.00 paid less £15.00 back',
  'public-move-credit-fails-partway: Stripe refunded £21.00, the rows say £15',
  'private-move-credit-fails-partway: price_paid £0.00, but £140.00 paid less £100.00 back',
  'private-move-credit-fails-partway: Stripe refunded £110.00, the rows say £100',
]
const MOVE_GIFT_CARD_ROW_HELD_BREACHES = [
  'w05l-move-gift-card-row-fails-then-cancel: price_paid £51.00, but £40.00 paid less £0.00 back',
  'w05l-move-gift-card-row-fails-then-cancel: gift card 10000000-0000-4000-8000-000000000009 lost £5.00, its redemptions say £0.00',
  'w05l-move-gift-card-row-fails-then-cancel: pi_fake_0004 is on 0 orders',
]

/** W22: the hold remove-guest-credit-fails-partway ends with (REMOVE_HELD_WHILE_STORE_CREDIT_FAILS), not an end state. */
const REMOVE_HELD_BREACHES = [
  'remove-guest-credit-fails-partway: Stripe refunded £10.00, the rows say £0',
  'remove-guest-credit-fails-partway: price_paid £40.00, but £60.00 paid less £0.00 back',
]

describe("step D's side of the replay (W17)", () => {
  let environment: ReplayEnvironment
  const dScenarios = new Set<string>()
  const figuresScenarios = new Set<string>()
  const w18Scenarios = new Set<string>()
  const settleScenarios = new Set<string>()
  const addGuestScenarios = new Set<string>()
  const refundScenarios = new Set<string>()
  const removeScenarios = new Set<string>()
  const cancelScenarios = new Set<string>()
  const moveScenarios = new Set<string>()
  const moveSetupScenarios = new Set<string>()
  const shifted: string[] = []
  const counts = { bookings: 0, orders: 0, figuresCompared: 0, guardsCompared: 0, statusesCompared: 0, giftCardShifted: 0 }

  beforeAll(async () => {
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  it('the side sends only the built actions to the Worker, and every old step D action is a slice\'s', () => {
    expect([...BUILT_BOOKING_ACTIONS.keys()]).toEqual([
      'setBookingSpecialRequests',
      'setBookingStatus',
      'settleLapsedBooking',
      'addBookingGuest',
      'finaliseReaderPayment',
      'cancelReaderPayment',
      'getBookingRefundFigures',
      'refundBooking',
      'removeBookingGuest',
      'removeBookingAddon',
      'cancelCreditBooking',
      'moveBooking',
    ])
    // W23: refundBooking's Cancel & Refund moved too, so no action is partly built.
    expect([...PARTLY_BUILT.keys()]).toEqual([])
    expect([...BOOKING_ACTIONS.keys()].sort()).toEqual([...LEGACY_BOOKING_ACTIONS].sort())
    expect(() => newBookingSide({ actions: new Map([['createOrder', async () => null]]) })).toThrow("createOrder isn't one of the old step D actions.")
  })

  describe.each(scenarios.map((scenario) => scenario.name))('%s', (name) => {
    it('matches its golden file with the figures from the Worker, and the Worker reads the end state as the old code does', async () => {
      const scenario = scenarios.find((s) => s.name === name)
      if (!scenario) throw new Error(`No scenario ${name}`)
      const calls: Array<{ action: string; side: 'new' | 'old'; cancel?: boolean; setup?: boolean }> = []
      const recording = await replay(environment, scenario, newBookingSide({ calls }))
      if (calls.some((call) => LEGACY_BOOKING_ACTIONS.has(call.action))) dScenarios.add(name)
      // W23: Cancel & Refund and Cancel & return credit, through the Worker.
      if (calls.some((call) => call.cancel === true && call.side === 'new')) cancelScenarios.add(name)
      // W24: Move, through the Worker; and the scenarios whose owed-money setup ran on the old side (onTheOldSide).
      if (calls.some((call) => call.action === 'moveBooking' && call.side === 'new')) moveScenarios.add(name)
      if (calls.some((call) => call.setup === true)) moveSetupScenarios.add(name)
      const golden = readGolden(name) as Recording
      expect(golden, `No golden file for ${name}`).not.toBeNull()

      const { db } = environment.database
      // W18: N3's, for its three scenarios only; W19: Settle's, for its scenarios only. Each must still be seen
      // (compareRecordings says so if not).
      const named = [
        ...(N3_DIFFERENCES.get(name) ?? []),
        ...(SETTLE_DIFFERENCES.get(name) ?? []),
        ...(ADD_GUEST_DIFFERENCES.get(name) ?? []),
        ...(REFUND_DIFFERENCES.get(name) ?? []),
        ...(REMOVE_DIFFERENCES.get(name) ?? []),
        ...(REMOVE_GUEST_24_HOURS_DIFFERENCES.get(name) ?? []),
        ...(CANCEL_DIFFERENCES.get(name) ?? []),
        ...(MOVE_DIFFERENCES.get(name) ?? []),
      ]
      // W21: the refund amount actions and the figures, through the Worker.
      if (calls.some((call) => call.side === 'new' && (call.action === 'refundBooking' || call.action === 'getBookingRefundFigures'))) refundScenarios.add(name)
      if (calls.some((call) => call.action === 'settleLapsedBooking')) settleScenarios.add(name)
      // W22: Remove Guest and Remove add-on, through the Worker.
      if (calls.some((call) => call.action === 'removeBookingGuest' || call.action === 'removeBookingAddon')) removeScenarios.add(name)
      if (calls.some((call) => call.action === 'addBookingGuest')) addGuestScenarios.add(name)
      // W20: the rows set aside from the comparison, each exactly what it should be.
      expect(newAuditRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(storedAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(cardRecordProblems(recording), `${name}: the Worker's card flow records`).toEqual([])
      expect(claimLookProblems(recording), `${name}: reconcile's looks for a held refund`).toEqual([])
      const differences = compareSides(golden, recording, named)
      if (calls.some((call) => call.action === 'getBookingRefundFigures')) figuresScenarios.add(name)
      if (calls.some((call) => call.action === 'setBookingStatus' || call.action === 'setBookingSpecialRequests')) w18Scenarios.add(name)
      // The built action really went to the Worker; everything else to the old code. W21: refundBooking's Cancel & Refund
      // calls (no amount) still go to the old function.
      expect(calls.filter((call) => call.side === 'new').every((call) => BUILT_BOOKING_ACTIONS.has(call.action))).toBe(true)
      // W24: but a setup step a scenario runs on the old side (onTheOldSide).
      expect(calls.filter((call) => BUILT_BOOKING_ACTIONS.has(call.action) && !PARTLY_BUILT.has(call.action) && call.setup !== true).every((call) => call.side === 'new')).toBe(true)
      if (process.env.W21_DIFFERENCES_OUT) {
        const all = compareSides(golden, recording, [])
        appendFileSync(process.env.W21_DIFFERENCES_OUT, `${JSON.stringify({ name, calls: calls.filter((call) => call.side === 'new').map((call) => call.action), differences: all, unnamed: differences })}\n`)
      }
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
      expect(compareSides(golden, recording, [...named, ...(differences.length > 0 ? [GIFT_CARD_PART_WITHOUT_ORDER] : [])])).toEqual([])

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

  // W19: W12's two reader Settle recordings (flow-side.ts), through the new side as the screen now drives them.
  describe.each(W12_FLOW_SCENARIOS.filter((scenario) => SETTLE_DIFFERENCES.has(scenario.name)).map((scenario) => scenario.name))('%s', (name) => {
    it("matches W12's recording with Settle's named differences only", async () => {
      const scenario = W12_FLOW_SCENARIOS.find((s) => s.name === name)
      if (!scenario) throw new Error(`No scenario ${name}`)
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const recording = await replay(environment, scenario, newBookingSide({ calls }))
      const golden = readGolden(name) as Recording
      expect(calls.filter((call) => call.side === 'new').map((call) => call.action)).toEqual(['settleLapsedBooking', name.endsWith('cancelled') ? 'cancelReaderPayment' : 'finaliseReaderPayment'])
      expect(newAuditRowProblems(recording)).toEqual([])
      expect(storedAnswerProblems(recording)).toEqual([])
      expect(cardRecordProblems(recording)).toEqual([])
      expect(compareSides(golden, recording, SETTLE_DIFFERENCES.get(name) ?? [])).toEqual([])
      settleScenarios.add(name)
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

  describe('N3 on the new side (W18): exactly what the Worker does instead', () => {
    const byName = (name: string) => {
      const scenario = scenarios.find((s) => s.name === name)
      if (!scenario) throw new Error(`No scenario ${name}`)
      return scenario
    }
    const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
    const bookingRow = (recording: Recording) => added(recording, 'bookings')[0]

    it('cancelled is refused with the words, nothing is written, and the figures still show the booking confirmed with its £40', async () => {
      const name = 'w17-n3-status-set-to-cancelled-on-a-paid-booking'
      const recording = await replay(environment, byName(name), newBookingSide())
      const golden = readGolden(name) as Recording
      expect(results(recording)[1]).toEqual({ thrown: invalidStatusMessage('cancelled', STAFF_STATUSES) })
      expect(bookingRow(recording)).toMatchObject({ status: 'confirmed', cancelled_at: null, price_paid: '40.00' })
      // W21: the figures route adds Q26's cash and the line of what is left to refund (W21a).
      expect(results(recording)[2]).toEqual({ ...(results(golden)[2] as Figures), status: 'confirmed', cashLeft: 0, paidLine: 'Left to refund: £40.00 card money.' })
      expect(added(recording, 'audit_log')).toEqual([])
      // Only the order's own charge, as before: no refund, then or since.
      expect(recording.stripeCalls).toEqual(golden.stripeCalls)
    })

    it('payment needed is refused, so Settle then refuses too and nothing is charged twice', async () => {
      const name = 'w17-n3-status-set-to-payment-needed-then-settled-again'
      const recording = await replay(environment, byName(name), newBookingSide())
      const golden = readGolden(name) as Recording
      expect(results(recording)[1]).toEqual({ thrown: invalidStatusMessage('payment_needed', STAFF_STATUSES) })
      expect(results(recording)[2]).toMatchObject({ settled: false, reason: 'booking_not_payment_needed' })
      expect(bookingRow(recording)).toMatchObject({ status: 'confirmed', price_paid: '40.00' })
      expect(added(recording, 'audit_log')).toEqual([])
      expect(added(recording, 'store_credit_transactions')).toEqual([])
      // Only the order's own charge: Settle's £20 in cash was never taken a second time.
      expect(recording.stripeCalls).toEqual(golden.stripeCalls)
    })

    it('a booking awaiting payment is not confirmed: refused with the words, and it stays payment needed', async () => {
      const name = 'w17-n3-status-set-to-confirmed-from-payment-needed'
      const recording = await replay(environment, byName(name), newBookingSide())
      expect(results(recording)[1]).toEqual({ thrown: STATUS_PAYMENT_NEEDED_MESSAGE })
      expect(bookingRow(recording)).toMatchObject({ status: 'payment_needed', price_paid: '0.00' })
      expect(added(recording, 'audit_log')).toEqual([])
    })

    it('the W05 invariants the old code breaks in these three hold on the new side (D-plan 4.11 item 3)', async () => {
      const n3 = [...N3_DIFFERENCES.keys()].map(byName)
      const old = await sweepInvariants(environment, n3, oldSide)
      expect(old.wrong).toEqual([
        'w17-n3-status-set-to-cancelled-on-a-paid-booking: cancelled with £0.00 back on £40.00 paid',
        'w17-n3-status-set-to-payment-needed-then-settled-again: price_paid £60.00, but £40.00 paid less £0.00 back',
      ])
      const fresh = await sweepInvariants(environment, n3, newBookingSide())
      expect(fresh.wrong).toEqual([])
      expect(fresh.bookingsChecked).toBe(3)
    })
  })

  describe('Settle on the new side (W19): exactly what the Worker does instead', () => {
    const byName = (name: string) => {
      const scenario = [...scenarios, ...W12_FLOW_SCENARIOS].find((s) => s.name === name)
      if (!scenario) throw new Error(`No scenario ${name}`)
      return scenario
    }
    const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []

    it('the W05 invariants hold on the new side for every Settle scenario (D-plan 4.11 item 3); the old side keeps R1a\'s two', async () => {
      const settles = [...SETTLE_DIFFERENCES.keys()].map(byName)
      const old = await sweepInvariants(environment, settles, oldSide)
      expect(old.wrong).toEqual([
        'w17-r1a-settle-store-credit-and-gift-card-statement-lands-late: price_paid £20.00, but £5.00 paid less £0.00 back',
        'w17-r1a-settle-store-credit-and-gift-card-statement-lands-late: gift card 10000000-0000-4000-8000-000000000009 lost £0.00, its redemptions say £5.00',
      ])
      const fresh = await sweepInvariants(environment, settles, newBookingSide())
      // The one held change (the gift card's row failing after the card paid) is left for reconcile, as named: until
      // then the booking is confirmed with its parts claimed and the payment is on no order. Those three lines are the
      // hold itself, not an end state; settle.test.ts runs reconcile on the same state and every one is put right.
      expect(fresh.wrong.sort()).toEqual(
        [
          'w05l-settle-gift-card-row-fails: price_paid £20.00, but £0.00 paid less £0.00 back',
          'w05l-settle-gift-card-row-fails: gift card 10000000-0000-4000-8000-000000000009 lost £5.00, its redemptions say £0.00',
          'w05l-settle-gift-card-row-fails: pi_fake_0002 is on 0 orders',
        ].sort()
      )
      expect(fresh.bookingsChecked).toBeGreaterThanOrEqual(settles.length)
    })

    it('R1a: settled once with the £15 store credit and £5 gift card it took; nothing given back on a settled booking', async () => {
      const recording = await replay(environment, byName('w17-r1a-settle-store-credit-and-gift-card-statement-lands-late'), newBookingSide())
      expect(results(recording)[1]).toMatchObject({ settled: true, amountCharged: 20, booking: { status: 'confirmed', price_paid: '20.00' } })
      expect(added(recording, 'store_credit_transactions').map((row) => [row['amount'], row['reason']])).toEqual([['-15.00', 'redemption']])
      expect(added(recording, 'gift_card_redemptions').map((row) => [row['amount_used'], row['order_id'], row['booking_id']])).toEqual([['5.00', null, 'bookings#1']])
      expect(recording.tables['gift_cards']?.changed).toEqual([{ id: '10000000-0000-4000-8000-000000000009', remaining_balance: ['40.00', '35.00'] }])
      expect(recording.stripeCalls).toEqual([])
      // Q36: no order for the store credit or gift card part (orders#1 is the booking's own).
      expect(added(recording, 'orders').map((row) => row['id'])).toEqual(['orders#1'])
    })

    it('R2c: each declined press is undone, so both £5 store credit claims go back and the booking still awaits payment', async () => {
      const recording = await replay(environment, byName('w17-r2c-settle-press-dies-after-a-decline-then-declined-again'), newBookingSide())
      expect(results(recording)[1]).toEqual({ thrown: 'Failed to charge saved card: Your card was declined.' })
      expect(added(recording, 'store_credit_transactions').map((row) => [row['amount'], row['reason']])).toEqual([
        ['-5.00', 'redemption'],
        ['5.00', 'redemption_reversal'],
        ['-5.00', 'redemption'],
        ['5.00', 'redemption_reversal'],
      ])
      expect(added(recording, 'store_credit_transactions').at(-1)?.['balance_after']).toBe('10.00')
      expect(added(recording, 'bookings')[0]).toMatchObject({ status: 'payment_needed', price_paid: '0.00' })
      expect(added(recording, 'pending_reader_payments').map((row) => [row['status'], (row['snapshot'] as { method: string }).method])).toEqual([
        ['cancelled', 'card'],
        ['cancelled', 'card'],
      ])
      // A new record, so a new key, for the second press: the decline is never replayed from the first.
      expect(recording.stripeCalls.map((call) => call.idempotencyKey)).toEqual(['pending_reader_payments#1:charge', 'pending_reader_payments#2:charge'])
    })

    it('a card Settle records the card part as today (its own order and booking line, Q36) and nothing for the gift card part but its row', async () => {
      const recording = await replay(environment, byName('w05l-settle-gift-card-and-card-then-cancel'), newBookingSide())
      const card = added(recording, 'orders')[1]
      expect(card).toMatchObject({ order_total: '15.00', stripe_payment_intent_id: 'pi_fake_0002', order_source: 'staff_created', payment_method: 'card' })
      expect(added(recording, 'order_line_items')[1]).toMatchObject({ order_id: 'orders#2', booking_id: 'bookings#1', item_type: 'booking', unit_price: '15.00', line_total: '15.00' })
      expect(added(recording, 'gift_card_redemptions').map((row) => [row['amount_used'], row['order_id']])).toEqual([['5.00', null]])
      expect(added(recording, 'pending_reader_payments').map((row) => [row['status'], row['payment_intent_id'], row['expected_amount']])).toEqual([['finalised', 'pi_fake_0002', '15.00']])
    })
  })

  describe('Add Guest on the new side (W20): exactly what the Worker does instead', () => {
    const byName = (name: string) => {
      const scenario = scenarios.find((s) => s.name === name)
      if (!scenario) throw new Error(`No scenario ${name}`)
      return scenario
    }
    const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
    const charges = (recording: Recording) => recording.stripeCalls.filter((call) => call.method === 'paymentIntents.create')

    it('the W05 invariants hold on the new side for every Add Guest scenario (D-plan 4.11 item 3), but for R2d\'s hold', async () => {
      // Every scenario seen calling Add Guest above (140 in a full run), and at least every named one.
      const adds = scenarios.filter((scenario) => addGuestScenarios.has(scenario.name) || ADD_GUEST_DIFFERENCES.has(scenario.name))
      expect(adds.length).toBeGreaterThanOrEqual(ADD_GUEST_DIFFERENCES.size)
      const fresh = await sweepInvariants(environment, adds, newBookingSide())
      // R2d: the card paid and its order couldn't be written, so the change is held for reconcile; until then the £15 card
      // payment is on no order (so price_paid counts £15 no order shows). add-guest.test.ts runs reconcile on the same hold and it writes the order.
      // W22: remove-guest-credit-fails-partway (it adds its guest first) ends with Remove Guest's refund held (its card
      // part went, its store credit write failed): until reconcile finishes it, the £10 is on no line and price_paid is
      // R1's. The next scenario, and remove-guest.test.ts, run reconcile on the same hold, and it records both.
      expect(fresh.wrong.sort()).toEqual(
        [
          'w17-r2d-add-guest-press-dies-while-the-worker-charges-and-writes-no-order: price_paid £60.00, but £45.00 paid less £0.00 back',
          'w17-r2d-add-guest-press-dies-while-the-worker-charges-and-writes-no-order: pi_fake_0004 is on 0 orders',
          ...REMOVE_HELD_BREACHES,
        ].sort()
      )
      expect(fresh.bookingsChecked).toBeGreaterThanOrEqual(adds.length)
    })

    it('R1c: the guest added once, with the place, the £15 store credit and the £5 gift card it took; nothing given away', async () => {
      const recording = await replay(environment, byName('w17-r1c-add-guest-store-credit-and-gift-card-statement-lands-late'), newBookingSide())
      expect(results(recording)[2]).toMatchObject({ added: true, guest: { guest_name: 'Bea Guest' } })
      expect(added(recording, 'store_credit_transactions').map((row) => [row['amount'], row['reason']])).toEqual([['-15.00', 'redemption']])
      expect(recording.tables['gift_cards']?.changed).toEqual([{ id: '10000000-0000-4000-8000-000000000009', remaining_balance: ['40.00', '35.00'] }])
      expect(added(recording, 'booking_guests')).toHaveLength(3)
    })

    it('R2a: the dead press added the guest and took £5 store credit and £15 on the card once; the next press is refused, nothing taken twice', async () => {
      const recording = await replay(environment, byName('w17-r2a-add-guest-press-dies-after-the-charge-then-paid-on-the-card'), newBookingSide())
      expect(results(recording)[2]).toMatchObject({ added: false, reason: 'no_answer' })
      expect(results(recording)[3]).toMatchObject({ added: false, reason: 'pressed_after_no_answer' })
      expect(charges(recording).map((call) => (call.params as { amount: number }).amount)).toEqual([4000, 1500])
      expect(added(recording, 'booking_guests')).toHaveLength(3)
      expect(added(recording, 'store_credit_transactions').map((row) => [row['amount'], row['reason']])).toEqual([['-5.00', 'redemption']])
      expect(added(recording, 'bookings')[0]).toMatchObject({ party_size: 3 })
    })

    it('R4a: the same press again gets the stored answer: £15 store credit taken once, one guest, one place', async () => {
      const recording = await replay(environment, byName('w17-r4a-add-guest-store-credit-claim-answer-lost-then-pressed-again'), newBookingSide())
      expect(results(recording)[2]).toMatchObject({ added: false, reason: 'no_answer' })
      expect(results(recording)[3]).toMatchObject({ added: true })
      expect(added(recording, 'store_credit_transactions').map((row) => [row['amount'], row['reason']])).toEqual([['-15.00', 'redemption']])
      expect(added(recording, 'booking_guests')).toHaveLength(3)
    })

    // W20a (W20 review later 1): R2b and p4 had no exact replay assertion (only their named differences).
    it('R2b: the dead press added the guest and took £5 store credit and £15 on the card once; the next press, with a gift card, is refused and the gift card is never touched', async () => {
      const recording = await replay(environment, byName('w17-r2b-add-guest-press-dies-after-the-charge-then-resumed-with-a-gift-card'), newBookingSide())
      expect(results(recording)[2]).toMatchObject({ added: false, reason: 'no_answer' })
      expect(results(recording)[3]).toMatchObject({ added: false, reason: 'pressed_after_no_answer' })
      expect(charges(recording).map((call) => (call.params as { amount: number }).amount)).toEqual([4000, 1500])
      expect(added(recording, 'booking_guests')).toHaveLength(3)
      expect(added(recording, 'store_credit_transactions').map((row) => [row['amount'], row['reason']])).toEqual([['-5.00', 'redemption']])
      expect(recording.tables['gift_cards']).toBeUndefined()
      expect(recording.tables['gift_card_redemptions']).toBeUndefined()
      expect(added(recording, 'bookings')[0]).toMatchObject({ party_size: 3 })
      expect(added(recording, 'orders').map((row) => [row['order_total'], row['payment_method']])).toEqual([['40.00', 'card'], ['15.00', 'card']])
    })

    it('p4: the charge landed after the press gave up; the same press again gets the stored answer: one guest charge, £5 store credit taken once and never given back', async () => {
      const recording = await replay(environment, byName('p4-charge-lands-after-the-press-gave-up'), newBookingSide())
      expect(results(recording)[1]).toMatchObject({ added: false, reason: 'no_answer' })
      expect(results(recording)[2]).toMatchObject({ added: true, guest: { guest_name: 'Bea Guest' } })
      expect(charges(recording).map((call) => (call.params as { amount: number }).amount)).toEqual([4000, 1500])
      expect(added(recording, 'store_credit_transactions').map((row) => [row['amount'], row['reason']])).toEqual([['-5.00', 'redemption']])
      expect(added(recording, 'booking_guests').map((row) => row['guest_name'])).toEqual(['Sam Test', 'Alex Guest', 'Bea Guest'])
      expect(added(recording, 'orders').map((row) => [row['order_total'], row['payment_method']])).toEqual([['40.00', 'card'], ['15.00', 'card']])
    })

    it('a dead press then the same press again: one charge, one guest', async () => {
      const recording = await replay(environment, byName('dies-after-the-charge-add-guest'), newBookingSide())
      expect(results(recording)[1]).toMatchObject({ reason: 'no_answer' })
      expect(results(recording)[2]).toMatchObject({ added: true })
      expect(charges(recording)).toHaveLength(2)
      expect(added(recording, 'booking_guests')).toHaveLength(3)
    })

    it('W05c N5: a guest and an add-on on the card: the seat on the booking line, the add-on on its own line of the same order', async () => {
      const recording = await replay(environment, byName('addon-with-guest-public-card-ticked'), newBookingSide())
      const golden = readGolden('addon-with-guest-public-card-ticked') as Recording
      const order = added(recording, 'orders')[1]
      const line = added(recording, 'order_line_items').find((row) => row['order_id'] === order?.['id'])
      expect(order).toMatchObject({ order_total: '25.00', payment_method: 'card' })
      expect(line).toMatchObject({ item_type: 'booking', unit_price: '20.00', line_total: '20.00' })
      expect(added(golden, 'order_line_items').find((row) => row['order_id'] === order?.['id'])).toMatchObject({ unit_price: '25.00' })
      expect(added(recording, 'addon_order_lines')[0]).toMatchObject({ order_id: order?.['id'] })
    })
  })

  describe('the refunds on the new side (W21): exactly what the Worker does instead', () => {
    const byName = (name: string) => {
      const scenario = scenarios.find((s) => s.name === name)
      if (!scenario) throw new Error(`No scenario ${name}`)
      return scenario
    }
    const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
    const refunds = (recording: Recording) => recording.stripeCalls.filter((call) => call.method === 'refunds.create')

    it('the W05 invariants hold on the new side for every refund scenario (D-plan 4.11 item 3): money back never above what was paid', async () => {
      const named = scenarios.filter((scenario) => refundScenarios.has(scenario.name) || REFUND_DIFFERENCES.has(scenario.name))
      expect(named.length).toBeGreaterThanOrEqual(REFUND_DIFFERENCES.size)
      const old = await sweepInvariants(environment, named, oldSide)
      const fresh = await sweepInvariants(environment, named, newBookingSide())
      // Nothing the old code doesn't break too: the new side's breaches are a subset of the old side's. W24: but the
      // holds Move's scenarios end with (MOVE_CREDIT_HELD_BREACHES, MOVE_GIFT_CARD_ROW_HELD_BREACHES), each named.
      expect(fresh.wrong.filter((line) => !old.wrong.includes(line)).sort()).toEqual([...MOVE_CREDIT_HELD_BREACHES, ...MOVE_GIFT_CARD_ROW_HELD_BREACHES].sort())
      expect(fresh.bookingsChecked).toBeGreaterThanOrEqual(named.length)
      if (process.env.W17_COVERAGE_OUT) appendFileSync(process.env.W17_COVERAGE_OUT, `W21 invariants: ${named.length} scenarios, old ${old.wrong.length} breaches, new ${fresh.wrong.length}: ${JSON.stringify(fresh.wrong)}\n`)
    })

    it("a later card part refused, then R2's store credit write fails: held; reconcile ends it as the old code did (£50 on the card recorded, £70 owed), and nothing is sent twice", async () => {
      const name = 'part-refund-fails-partway'
      const recording = await replay(environment, byName(name), newBookingSide())
      const golden = readGolden(name) as Recording
      expect(results(recording)[3]).toEqual({ unsure: { message: "£50.00 went back to the card, but the refund couldn't be finished on the booking yet. It's on hold: don't refund it again. Check the Orders page in a few minutes." } })
      // Newest order first: Bea's £50, then the first order's £70 (refused); each sent once.
      expect(refunds(recording).map((call) => [(call.params as { amount: number }).amount, call.idempotencyKey])).toEqual([
        [5000, 'audit_log#2:refund:orders#2'],
        [7000, 'audit_log#2:refund:orders#1'],
      ])
      expect(added(recording, 'bookings')).toEqual(added(golden, 'bookings'))
      expect(added(recording, 'order_line_items')).toEqual(added(golden, 'order_line_items'))
      const finished = added(recording, 'audit_log').find((row) => row['action'] === 'booking.refund_finished')
      expect(finished?.['details']).toMatchObject({ outcome: 'owed', cardRefunded: 50, storeCreditRefunded: 0, owed: 70, by: { how: 'reconcile' } })
    })

    it('a Part refund across two orders, newest first, each capped at its card money (q25-part-refund-then-a-guest)', async () => {
      const recording = await replay(environment, byName('figures-after-a-part-refund'), newBookingSide())
      const claim = added(recording, 'audit_log').find((row) => row['action'] === 'booking.refund_claimed')
      expect(claim?.['details']).toMatchObject({ worker: true, kind: 'part_refund' })
      const plan = (claim?.['details'] as { plan: { card: Array<{ amount: number }>; storeCredit: number } }).plan
      expect(refunds(recording).map((call) => (call.params as { amount: number }).amount)).toEqual(plan.card.map((part) => Math.round(part.amount * 100)))
    })
  })

  describe('Remove Guest and Remove add-on on the new side (W22): exactly what the Worker does instead', () => {
    const byName = (name: string) => {
      const scenario = scenarios.find((s) => s.name === name)
      if (!scenario) throw new Error(`No scenario ${name}`)
      return scenario
    }
    const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
    const refunds = (recording: Recording) => recording.stripeCalls.filter((call) => call.method === 'refunds.create')
    const auditRows = (recording: Recording, action: string) => added(recording, 'audit_log').filter((row) => row['action'] === action)

    it('the W05 invariants hold on the new side for every Remove Guest and Remove add-on scenario (D-plan 4.11 item 3), but for the one hold', async () => {
      const named = scenarios.filter((scenario) => removeScenarios.has(scenario.name) || REMOVE_DIFFERENCES.has(scenario.name))
      expect(named.length).toBeGreaterThanOrEqual(REMOVE_DIFFERENCES.size)
      const old = await sweepInvariants(environment, named, oldSide)
      const fresh = await sweepInvariants(environment, named, newBookingSide())
      // Nothing the old code doesn't break too, but the hold named above (reconcile finishes it).
      expect(fresh.wrong.filter((line) => !old.wrong.includes(line)).sort()).toEqual([...REMOVE_HELD_BREACHES].sort())
      expect(fresh.bookingsChecked).toBeGreaterThanOrEqual(named.length)
      if (process.env.W17_COVERAGE_OUT) appendFileSync(process.env.W17_COVERAGE_OUT, `W22 invariants: ${named.length} scenarios, old ${old.wrong.length} breaches, new ${fresh.wrong.length}: ${JSON.stringify(fresh.wrong)}\n`)
    })

    it('a paid public guest to the card: one refund on the guest\'s own order, keyed from the claim; the guest deleted, the place released, the line stamped', async () => {
      const recording = await replay(environment, byName('remove-guest-on-the-card'), newBookingSide())
      expect(refunds(recording).map((call) => [(call.params as { amount: number }).amount, call.idempotencyKey])).toEqual([[2000, 'audit_log#3:refund:orders#2']])
      const claim = auditRows(recording, 'booking.refund_claimed').find((row) => (row['details'] as { kind?: string }).kind === 'remove_guest')
      expect(claim?.['details']).toMatchObject({ kind: 'remove_guest', amount: 20, method: 'card', worker: true, guest: { name: 'Bea Guest', seatPrice: 20, placeReleased: true } })
      expect(auditRows(recording, 'booking.guest_remove').map((row) => row['details'])).toEqual([
        expect.objectContaining({ refundAmount: 20, method: 'card', cardRefunded: 20, storeCreditRefunded: 0, owed: 0 }),
      ])
      // Bea, added on the card, is gone; the booking's own two seats stay.
      expect(added(recording, 'booking_guests').map((row) => row['guest_name'])).toEqual(['Sam Test', 'Alex Guest'])
      expect(added(recording, 'order_line_items')[1]).toMatchObject({ card_refunded_amount: '20.00', refund_method: 'card', refunded_at: '<set>' })
    })

    it('an add-on paid with a guest goes back to its own order\'s card (W05c N5), keyed from its claim, and its line says so', async () => {
      const recording = await replay(environment, byName('addon-with-guest-removed-to-the-card-then-cancel'), newBookingSide())
      const claim = auditRows(recording, 'booking.refund_claimed').find((row) => (row['details'] as { kind?: string }).kind === 'remove_addon')
      expect(claim?.['details']).toMatchObject({ kind: 'remove_addon', amount: 5, method: 'card', addon: { described: '1× Towel', refund: 'card' } })
      const addonRefund = refunds(recording).find((call) => String(call.idempotencyKey).startsWith(String(claim?.['id'])))
      expect(addonRefund).toMatchObject({ params: { amount: 500 }, idempotencyKey: `${String(claim?.['id'])}:refund:orders#2` })
      expect(added(recording, 'addon_order_lines')[0]).toMatchObject({ removed_at: '<set>', refunded_amount: '5.00', card_refunded_amount: '5.00', refund_method: 'card' })
    })

    it('the store credit held while its write fails, then reconciled before the next step: £10 card and £10 store credit, each once', async () => {
      const recording = await replay(environment, byName('remove-guest-credit-fails-partway-then-retried'), newBookingSide())
      expect(refunds(recording).filter((call) => String(call.idempotencyKey).endsWith(':refund:orders#1')).map((call) => (call.params as { amount: number }).amount)).toEqual([1000])
      const finished = auditRows(recording, 'booking.refund_finished').find((row) => (row['details'] as { by?: { how?: string } }).by?.how === 'reconcile')
      expect(finished?.['details']).toMatchObject({ outcome: 'given', cardRefunded: 10, storeCreditRefunded: 10, owed: 0 })
    })
  })

  describe('Cancel & Refund and Cancel & return credit on the new side (W23): exactly what the Worker does instead', () => {
    const byName = (name: string) => {
      const scenario = scenarios.find((s) => s.name === name)
      if (!scenario) throw new Error(`No scenario ${name}`)
      return scenario
    }
    const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
    const refunds = (recording: Recording) => recording.stripeCalls.filter((call) => call.method === 'refunds.create')
    const auditRows = (recording: Recording, action: string) => added(recording, 'audit_log').filter((row) => row['action'] === action)

    it("the W05 invariants hold on the new side for every cancel scenario (D-plan 4.11 item 3): nothing the old code doesn't break", async () => {
      const named = scenarios.filter((scenario) => cancelScenarios.has(scenario.name) || CANCEL_DIFFERENCES.has(scenario.name))
      expect(named.length).toBeGreaterThanOrEqual(CANCEL_DIFFERENCES.size)
      const old = await sweepInvariants(environment, named, oldSide)
      const fresh = await sweepInvariants(environment, named, newBookingSide())
      // remove-guest-credit-fails-partway's hold (W22) isn't a cancel scenario; anything else new would be W23's. W24: but
      // the Move hold whose cancel is then refused (MOVE_GIFT_CARD_ROW_HELD_BREACHES).
      expect(fresh.wrong.filter((line) => !old.wrong.includes(line)).sort()).toEqual([...MOVE_GIFT_CARD_ROW_HELD_BREACHES].sort())
      expect(fresh.bookingsChecked).toBeGreaterThanOrEqual(named.length)
      if (process.env.W17_COVERAGE_OUT) appendFileSync(process.env.W17_COVERAGE_OUT, `W23 invariants: ${named.length} scenarios, old ${old.wrong.length} breaches, new ${fresh.wrong.length}: ${JSON.stringify(fresh.wrong)}\n`)
    })

    it('item 1: the seat and a ticked towel on one order go back in ONE £45 card refund, keyed from the claim; each line stamped with its share', async () => {
      const recording = await replay(environment, byName('addon-on-the-first-order-public-ticked'), newBookingSide())
      const claim = auditRows(recording, 'booking.refund_claimed').find((row) => (row['details'] as { kind?: string }).kind === 'cancel')
      expect(refunds(recording).map((call) => [(call.params as { amount: number }).amount, call.idempotencyKey])).toEqual([[4500, `${String(claim?.['id'])}:refund:orders#1`]])
      expect((claim?.['details'] as { plan: { card: Array<{ lines: Array<{ amount: number; addon?: boolean }> }> } }).plan.card).toHaveLength(1)
      expect(added(recording, 'order_line_items')[0]).toMatchObject({ card_refunded_amount: '40.00', refund_method: 'card', refunded_at: '<set>' })
      expect(added(recording, 'addon_order_lines')[0]).toMatchObject({ removed_at: '<set>', refunded_amount: '5.00', card_refunded_amount: '5.00', refund_method: 'card' })
      expect(auditRows(recording, 'booking.cancel').map((row) => row['details'])).toEqual([expect.objectContaining({ seatRefund: 40, addonsRefund: 5, cardRefunded: 45, storeCreditRefunded: 0, owed: 0 })])
    })

    it('N4: the places write failing rolls Cancel & return credit back: still confirmed, its place still held, the words say nothing was cancelled', async () => {
      const recording = await replay(environment, byName('w17-n4-cancel-credit-places-write-fails-after-the-cancel'), newBookingSide())
      expect(results(recording)[1]).toMatchObject({ cancelled: false, reason: 'cancel_not_saved' })
      expect(added(recording, 'bookings')[0]).toMatchObject({ status: 'confirmed', cancelled_at: null })
      expect(auditRows(recording, 'booking.cancel_credit')).toEqual([])
    })
  })

  describe('Move on the new side (W24): exactly what the Worker does instead', () => {
    const byName = (name: string) => {
      const scenario = scenarios.find((s) => s.name === name)
      if (!scenario) throw new Error(`No scenario ${name}`)
      return scenario
    }
    const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
    const created = (recording: Recording, method: string) => recording.stripeCalls.filter((call) => call.method === method)

    it('the W05 invariants hold on the new side for every Move scenario (D-plan 4.11 item 3): nothing the old code doesn\'t break but the named holds', async () => {
      const named = scenarios.filter((scenario) => moveScenarios.has(scenario.name) || MOVE_DIFFERENCES.has(scenario.name))
      expect(named.length).toBeGreaterThanOrEqual(MOVE_DIFFERENCES.size)
      const old = await sweepInvariants(environment, named, oldSide)
      const fresh = await sweepInvariants(environment, named, newBookingSide())
      expect(fresh.wrong.filter((line) => !old.wrong.includes(line)).sort()).toEqual([...MOVE_CREDIT_HELD_BREACHES, ...MOVE_GIFT_CARD_ROW_HELD_BREACHES].sort())
      expect(fresh.bookingsChecked).toBeGreaterThanOrEqual(named.length)
      if (process.env.W17_COVERAGE_OUT) appendFileSync(process.env.W17_COVERAGE_OUT, `W24 invariants: ${named.length} scenarios, old ${old.wrong.length} breaches, new ${fresh.wrong.length}: ${JSON.stringify(fresh.wrong)}\n`)
    })

    it('a dearer move on the card: one £11 charge keyed from its flow record, the card part on its own order, the old places given back', async () => {
      const recording = await replay(environment, byName('q28-public-dearer-on-the-card'), newBookingSide())
      const charges = created(recording, 'paymentIntents.create')
      expect(charges.map((call) => (call.params as { amount: number }).amount)).toEqual([4000, 1100])
      expect(charges[1]?.idempotencyKey).toBe('pending_reader_payments#1:charge')
      expect(added(recording, 'orders')[1]).toMatchObject({ order_total: '11.00', payment_method: 'card' })
      expect(added(recording, 'pending_reader_payments').map((row) => [row['status'], (row['snapshot'] as { method: string }).method])).toEqual([['finalised', 'card']])
      expect(added(recording, 'audit_log').filter((row) => row['action'] === 'booking.move').map((row) => (row['details'] as { method: string }).method)).toEqual(['card'])
    })

    it('a cheaper move to the card: one refund per order, keyed from its claim, never the old figure-built key', async () => {
      const recording = await replay(environment, byName('q28-private-cheaper-to-the-card'), newBookingSide())
      const keys = created(recording, 'refunds.create').map((call) => call.idempotencyKey)
      expect(keys.every((key) => /^audit_log#\d+:refund:orders#\d+$/.test(String(key)))).toBe(true)
      expect(new Set(keys).size).toBe(keys.length)
      const claims = added(recording, 'audit_log').filter((row) => row['action'] === 'booking.refund_claimed' && (row['details'] as { kind?: string }).kind === 'move')
      expect(claims).toHaveLength(1)
    })

    it('R3: with the new session full, nothing is charged at all (the old presses each charged £11 and refunded it)', async () => {
      const recording = await replay(environment, byName('w17-r3-move-two-presses-the-new-session-full-for-both'), newBookingSide())
      expect(results(recording)[2]).toMatchObject({ moved: false, reason: 'insufficient_capacity' })
      expect(created(recording, 'paymentIntents.create')).toHaveLength(1)
      expect(created(recording, 'refunds.create')).toEqual([])
    })

    it('N1: refused with New Order\'s words before any money moves; no charge, no refund', async () => {
      const recording = await replay(environment, byName('w17-n1-dearer-move-on-the-card-to-a-day-with-another-booking'), newBookingSide())
      expect(results(recording)[2]).toMatchObject({ moved: false, reason: 'duplicate_day_booking' })
      expect(created(recording, 'paymentIntents.create')).toHaveLength(1)
      expect(created(recording, 'refunds.create')).toEqual([])
    })

    it('the owed-money setups run on the old side, and only those: everything after them on the Worker', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old'; setup?: boolean }> = []
      await replay(environment, byName('owed-then-a-dearer-move'), newBookingSide({ calls }))
      expect(calls.filter((call) => call.setup === true).map((call) => call.action)).toEqual(['moveBooking', 'moveBooking'])
      expect(calls.filter((call) => call.setup !== true && call.action === 'moveBooking').every((call) => call.side === 'new')).toBe(true)
    })
  })

  it('covered what it says: the step D scenarios, the figures answers, and every booking and order at their ends', () => {
    // For the report: written where W17_COVERAGE_OUT says (vitest keeps a passing test's console quiet).
    const line =
      `W17 replay coverage: ${scenarios.length} scenarios, ${dScenarios.size} call an old step D action, ${figuresScenarios.size} ask for the refund figures, ${w18Scenarios.size} call special requests or status; ` +
        `W05l later 1 shifted the figures in ${shifted.length} (${shifted.join(', ') || 'none'}); ` +
        `end states: ${counts.bookings} bookings (${counts.figuresCompared} figures, ${counts.giftCardShifted} of them W05l later 1's split, ${counts.guardsCompared} guards), ` +
        `${counts.orders} orders (${counts.statusesCompared} statuses); W19: ${settleScenarios.size} call Settle`
    if (process.env.W17_COVERAGE_OUT) appendFileSync(process.env.W17_COVERAGE_OUT, `${line}\n`)
    // 684 scenarios on 12 Nov: 256 call an old step D action, 7 ask for the figures (W17-logs/booking-replay-*.txt).
    expect(dScenarios.size).toBeGreaterThanOrEqual(256)
    expect(figuresScenarios.size).toBeGreaterThanOrEqual(7)
    // W05l later 1 is seen working on real end states, not only on the planted case.
    expect(counts.giftCardShifted).toBeGreaterThan(0)
    expect(counts.figuresCompared).toBe(counts.bookings)
    expect(counts.statusesCompared).toBe(counts.orders)
    // W18: the scenarios that call special requests or status are exactly N3's three (none sets special requests).
    expect([...w18Scenarios].sort()).toEqual([...N3_DIFFERENCES.keys()].sort())
    // W19: every scenario that calls Settle is named (with its differences), and nothing named goes unrun; N3's
    // settle-again step is the one with N3's difference only.
    expect([...settleScenarios].sort()).toEqual([...SETTLE_DIFFERENCES.keys(), 'w17-n3-status-set-to-payment-needed-then-settled-again'].sort())
    // W20: every scenario named for Add Guest calls it (an unused name would fail here); the rest of the Add Guest
    // scenarios match their golden files exactly (cash, gift card, store credit, or free).
    expect([...ADD_GUEST_DIFFERENCES.keys()].filter((name) => !addGuestScenarios.has(name))).toEqual([])
    // W21: every scenario named for the refunds calls a Part refund, Refund the rest, It already arrived or the figures
    // on the Worker; the rest of them match their golden files exactly (store credit, and refusals before any money).
    expect([...REFUND_DIFFERENCES.keys()].filter((name) => !refundScenarios.has(name))).toEqual([])
    if (process.env.W17_COVERAGE_OUT) {
      appendFileSync(process.env.W17_COVERAGE_OUT, `W21: ${refundScenarios.size} call a refund amount action or the figures on the Worker, ${REFUND_DIFFERENCES.size} with named differences, ${refundScenarios.size - REFUND_DIFFERENCES.size} exact\n`)
    }
    // W22: every scenario named for Remove Guest or Remove add-on calls one of them on the Worker.
    expect([...REMOVE_DIFFERENCES.keys()].filter((name) => !removeScenarios.has(name))).toEqual([])
    if (process.env.W17_COVERAGE_OUT) {
      appendFileSync(process.env.W17_COVERAGE_OUT, `W22: ${removeScenarios.size} call Remove Guest or Remove add-on on the Worker, ${REMOVE_DIFFERENCES.size} with W22's named differences (more with W20's and W21's only), ${[...removeScenarios].filter((name) => !REMOVE_DIFFERENCES.has(name) && !ADD_GUEST_DIFFERENCES.has(name) && !REFUND_DIFFERENCES.has(name) && !REMOVE_GUEST_24_HOURS_DIFFERENCES.has(name)).length} exact\n`)
    }
    // W23: every scenario named for the cancels calls Cancel & Refund or Cancel & return credit on the Worker.
    expect([...CANCEL_DIFFERENCES.keys()].filter((name) => !cancelScenarios.has(name))).toEqual([])
    if (process.env.W17_COVERAGE_OUT) {
      const earlier = (name: string) => [ADD_GUEST_DIFFERENCES, REFUND_DIFFERENCES, REMOVE_DIFFERENCES, REMOVE_GUEST_24_HOURS_DIFFERENCES, SETTLE_DIFFERENCES].some((map) => map.has(name))
      appendFileSync(
        process.env.W17_COVERAGE_OUT,
        `W23: ${cancelScenarios.size} call Cancel & Refund or Cancel & return credit on the Worker, ${CANCEL_DIFFERENCES.size} with W23's named differences, ${[...cancelScenarios].filter((name) => !CANCEL_DIFFERENCES.has(name) && !earlier(name)).length} exact, ${[...cancelScenarios].filter((name) => !CANCEL_DIFFERENCES.has(name) && earlier(name)).length} with earlier slices' only\n`
      )
    }
    // W22a: every scenario named for the 24-hour rule calls Remove Guest on the Worker (an unused allowance fails in
    // compareRecordings as well).
    expect([...REMOVE_GUEST_24_HOURS_DIFFERENCES.keys()].filter((name) => !removeScenarios.has(name))).toEqual([])
    if (process.env.W17_COVERAGE_OUT) {
      appendFileSync(process.env.W17_COVERAGE_OUT, `W22a: ${REMOVE_GUEST_24_HOURS_DIFFERENCES.size} with the 24-hour rule's named differences (1 inside the 24 hours)\n`)
    }
    if (process.env.W17_COVERAGE_OUT) {
      appendFileSync(process.env.W17_COVERAGE_OUT, `W20: ${addGuestScenarios.size} call Add Guest, ${ADD_GUEST_DIFFERENCES.size} with named differences, ${addGuestScenarios.size - ADD_GUEST_DIFFERENCES.size} exact\n`)
    }
    // W24: every scenario named for Move calls it on the Worker; the owed-money setups that ran on the old side are W05g's
    // and W05h's (onTheOldSide), and only those.
    expect([...MOVE_DIFFERENCES.keys()].filter((name) => !moveScenarios.has(name))).toEqual([])
    expect([...moveSetupScenarios].every((name) => name.startsWith('owed-') || name.startsWith('refund-the-rest-') || name === 'figures-with-money-owed')).toBe(true)
    if (process.env.W17_COVERAGE_OUT) {
      const earlier = (name: string) => [ADD_GUEST_DIFFERENCES, REFUND_DIFFERENCES, REMOVE_DIFFERENCES, REMOVE_GUEST_24_HOURS_DIFFERENCES, SETTLE_DIFFERENCES, CANCEL_DIFFERENCES].some((map) => map.has(name))
      appendFileSync(
        process.env.W17_COVERAGE_OUT,
        `W24: ${moveScenarios.size} call Move on the Worker, ${MOVE_DIFFERENCES.size} with W24's named differences, ${[...moveScenarios].filter((name) => !MOVE_DIFFERENCES.has(name) && !earlier(name)).length} exact, ${[...moveScenarios].filter((name) => !MOVE_DIFFERENCES.has(name) && earlier(name)).length} with earlier slices' only; ${moveSetupScenarios.size} run an owed-money setup on the old side: ${[...moveSetupScenarios].sort().join(', ')}\n`
      )
    }
  })
})

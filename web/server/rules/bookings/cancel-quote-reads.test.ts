import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db, SqlParam } from '@/server/db'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { ID, mo, paidSeat, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { quoteCancel } from './cancel'

// Brief W50 item 12 (step D's close list: "the cancel-credit quote takes about 10 seconds"): the quote's reads, one by
// one. Measured first, as it was (briefs/W50-logs/08-quote-timings-before.txt in the staff app repo), then again
// with its independent reads run together. A read here is one statement: one round trip from the Worker to the
// database. Locally a round trip takes well under a millisecond, which shows nothing, so each is given the same fixed
// wait before it is sent (ROUND_TRIP_MS), as a stand-in for the distance to the real database: what is measured is
// how many round trips the quote waits for one after another, which is what its time on live is made of.
vi.setConfig({ testTimeout: 120_000 })

vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const ROUND_TRIP_MS = 40
const creditTowel = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5, redemptionSource: 'membership_credit', membershipId: ID.membership }
/** A pass booking with a membership-credit towel, then a £5 towel paid on the member's saved card: Cancel & return credit's fullest quote. */
const passWithTwoTowels = { customerId: ID.member, booking: { ...paidSeat([mo]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass, addons: [creditTowel] }, payment: {} }

let environment: ReplayEnvironment
beforeAll(async () => {
  environment = await startReplay()
})
afterAll(() => environment.stop())

interface Read {
  /** What the statement reads: its first FROM. */
  from: string
  startedAt: number
  endedAt: number
}

/** A client that waits ROUND_TRIP_MS before each statement, and notes when each started and ended. */
function timing(db: Db): { db: Db; reads: Read[] } {
  const reads: Read[] = []
  const timed = new Proxy(db, {
    get(inner, property, receiver) {
      if (property !== 'query') return Reflect.get(inner, property, receiver) as unknown
      return async (sql: string, params?: readonly SqlParam[]) => {
        const read: Read = { from: /\bFROM\s+(?:\(\s*SELECT[^]*?\bFROM\s+)?([a-z_]+)/i.exec(sql)?.[1] ?? sql.trim().slice(0, 30), startedAt: performance.now(), endedAt: 0 }
        reads.push(read)
        await new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_MS))
        try {
          return await inner.query(sql, params)
        } finally {
          read.endedAt = performance.now()
        }
      }
    },
  })
  return { db: timed, reads }
}

/**
 * How many times the quote waited for the database: reads sent at the same moment (within a quarter of a round trip
 * of each other) are one wait. Thirteen reads one after another are thirteen waits.
 */
function waves(reads: readonly Read[]): number {
  let count = 0
  let waveStarted = -Infinity
  for (const read of [...reads].sort((a, b) => a.startedAt - b.startedAt)) {
    if (read.startedAt - waveStarted > ROUND_TRIP_MS / 4) {
      count += 1
      waveStarted = read.startedAt
    }
  }
  return count
}

async function onThePassBooking(work: (context: ScenarioContext & { bookingId: string; lineIds: string[] }) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w50 quote timings',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        // The pass is the member's own, with sessions on it.
        await seedDb.query('UPDATE customer_session_passes SET customer_id = $1, sessions_remaining = 5 WHERE id = $2', [ID.member, ID.ownedPass])
      },
      async run(context) {
        replayStripe.current = context.stripe
        try {
          const placed = (await context.call('createOrder', passWithTwoTowels)) as { bookingId?: string }
          if (!placed.bookingId) throw new Error(`The booking was not placed: ${JSON.stringify(placed)}`)
          await context.call('addBookingGuest', { bookingId: placed.bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { method: 'card' } })
          const lines = await context.db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1 ORDER BY created_at, id', [placed.bookingId])
          // The replay freezes only the date (the session is still two days off); timers and performance.now() are real.
          await work({ ...context, bookingId: placed.bookingId, lineIds: lines.map((line) => line.id) })
        } finally {
          replayStripe.current = null
        }
      },
    },
    oldSide
  )
}

describe("Cancel & return credit's quote: its reads (brief W50 item 12)", () => {
  it('answers the same quote as before, with every read it made before and no other; reads that do not depend on each other are sent together', async () => {
    await onThePassBooking(async ({ db, bookingId, lineIds }) => {
      const plain = await quoteCancel(db, 'cancel_credit', bookingId, lineIds)
      expect(plain).toMatchObject({ bookingId, status: 'confirmed', refund: 0, addonsRefund: 5, parts: { card: 5, storeCredit: 0 }, cardRefundAvailable: true, blocked: null })

      const { db: timed, reads } = timing(db)
      const startedAt = performance.now()
      const quote = await quoteCancel(timed, 'cancel_credit', bookingId, lineIds)
      const took = performance.now() - startedAt
      expect(quote).toEqual(plain)

      const summary = { reads: reads.length, waves: waves(reads), tookMs: Math.round(took), ifOneAfterAnotherMs: reads.length * ROUND_TRIP_MS, from: reads.map((read) => read.from) }
      if (process.env.W50_QUOTE_TIMINGS_OUT) {
        const lines = reads.map((read, i) => `${String(i + 1).padStart(2)}  ${read.from.padEnd(28)} started ${Math.round(read.startedAt - startedAt).toString().padStart(5)} ms  ended ${Math.round(read.endedAt - startedAt).toString().padStart(5)} ms`)
        appendFileSync(process.env.W50_QUOTE_TIMINGS_OUT, `Cancel & return credit quote, ${ROUND_TRIP_MS} ms added to each round trip\n${lines.join('\n')}\n${JSON.stringify(summary)}\n\n`)
      }
      // The same reads as before the change, and no other (by the table each reads first), whatever order they were sent in.
      // W58b (W50 "For later" 4; a named difference): the money left's four reads are one statement now (READS_NOW).
      expect([...summary.from].sort()).toEqual([...READS_NOW].sort())
      expect(summary.reads).toBe(10)
      expect(READS_BEFORE.length - READS_NOW.length).toBe(3)
      // Before W50: 13 waits, one for each read. W50: 6, the money left's own reads following each other (three more
      // waits). W58b: 3. The six reads that need only the booking's id go together (the money left is one of them); then
      // the refusal, the card plan's first read and the cash figure go together; then the card plan's second.
      expect(summary.waves).toBe(3)
      // The time is the waits', not the reads': with room for a slow machine, still well under one after another.
      expect(took).toBeLessThan(10 * ROUND_TRIP_MS)
      expect(summary.ifOneAfterAnotherMs).toBe(10 * ROUND_TRIP_MS)
    })
  })

  it("inside a change's transaction nothing is sent together: R1's own read of the booking is still one read after another", async () => {
    await onThePassBooking(async ({ db, bookingId }) => {
      const { loadBooking } = await import('./load-booking')
      const { db: timed, reads } = timing(db)
      const inTurn = await loadBooking(timed, bookingId)
      expect(waves(reads)).toBe(reads.length)
      const firstCount = reads.length
      const together = await loadBooking(timed, bookingId, 'together')
      expect(together).toEqual(inTurn)
      // The same number of reads either way.
      expect(reads.length).toBe(firstCount * 2)
      expect(waves(reads.slice(firstCount))).toBeLessThan(firstCount)
    })
  })
})

/** The quote's reads for this booking as they were before W50 (briefs/W50-logs/08-quote-timings-before.txt), by the table each reads first. */
const READS_BEFORE = [
  'orders', // the booking with its session and type (its first FROM is the "order still being paid" check)
  'booking_guests', // its seats
  'pending_reader_payments', // its open payment flows
  'bookings', // the money left: the booking's price and what is owed
  'order_line_items', // the money left: its lines
  'gift_card_redemptions', // the money left: what its order's card can still take back
  'gift_card_redemptions', // the money left: what was paid by gift card and store credit
  'addon_order_lines', // the ticked add-on lines
  'bookings', // where the session's start stands (the 24 hours)
  'audit_log', // whether a refund on the booking is still being checked
  'order_line_items', // the card plan: the booking's lines
  'gift_card_redemptions', // the card plan: what the add-on's order's card can still take back
  'order_line_items', // the cash that can be handed back
]

/** W58b (W50 "For later" 4): the same, with the money left's four reads (bookings, its lines, two of gift cards) one statement. */
const READS_NOW = [
  'orders',
  'booking_guests',
  'pending_reader_payments',
  'order_line_items', // the money left, one statement (its first FROM is its lines)
  'addon_order_lines',
  'bookings',
  'audit_log',
  'order_line_items',
  'gift_card_redemptions',
  'order_line_items',
]

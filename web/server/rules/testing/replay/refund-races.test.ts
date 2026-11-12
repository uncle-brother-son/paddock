import { AsyncLocalStorage } from 'node:async_hooks'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db, SqlParam, Tx } from '@/server/db'
import { FakeStripe } from '@/server/stripe/fake'
import { makeRace, Refused, type Race } from '../race'
import { startRealPostgres, type RealPostgres } from '../real-postgres'
import { TABLES } from './compare'
import { oldFunctionPath, REPLAY_USER } from './harness'
import { bindLegacyRoutes, bindStaffRoutes } from './legacy-routes'
import { ID, noPromoOnCard, publicOnCard, seed, sessionsToMoveBetween } from './scenarios'

// The old functions on real Postgres, with two connections. PGlite is one session, so nothing in
// replay/ can show two refunds meeting. Three kinds of test: `race` fixes the timing inside Postgres
// and proves a statement waited; `whileHeld` stops one whole function at its Stripe call, with the
// money on its way, and runs another to the end; and free-running ones race the two functions.
// Each claim has a control beside it, showing the unguarded version going wrong.

type Runner = Pick<Db, 'query'>
type Answer = Record<string, unknown>

const OPEN = 'A card reader payment is still open on this booking. Finish or cancel it first, or use Resolve now on the Orders page after 15 minutes.'
const goodwill = { reason: 'Goodwill' }

describe('refunds at the same moment, on real Postgres', () => {
  let pg: RealPostgres
  let first: Db
  let second: Db
  let race: Race
  let stripe: FakeStripe
  /** Which connection this call's statements go to. */
  const connection = new AsyncLocalStorage<Runner>()
  /** Runs once, just before the first statement that matches: another staff member getting in. */
  let beforeStatement: { matches: RegExp; run: () => Promise<void> } | null = null
  /** Holds the next card refund open until released. */
  let refundGate: { reached: () => void; released: Promise<void> } | null = null

  // W16: the old order functions the races start from run from the test-only copy (harness.ts, LEGACY_ORDER_ACTIONS).
  // W17: the old booking functions and their modules from the booking copy (harness.ts, oldFunctionPath).
  const load = async <T>(file: string) => (await import(/* @vite-ignore */ oldFunctionPath(file))) as T

  async function query(sql: string, params: unknown[] = []) {
    // Retool maps $N to params[N-1] only if they ascend and none repeats.
    const used = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
    if (used.some((n, i) => n !== i + 1)) throw new Error(`Placeholders out of order, which Retool would swap: ${sql}`)
    if (beforeStatement?.matches.test(sql)) {
      const { run } = beforeStatement
      beforeStatement = null
      await run()
    }
    const runner = connection.getStore() ?? first
    return { data: await runner.query<Answer>(sql, params.map((value) => value ?? null) as SqlParam[]) }
  }

  /** One staff member's call, on its own connection. A function that throws answers what it said. */
  async function call(action: string, params: unknown, on: Db = first): Promise<Answer> {
    const loaded = await load<{ default: (req: { params: unknown; user: typeof REPLAY_USER }) => Promise<Answer> }>(`${action}.ts`)
    return connection.run(on, () => loaded.default({ params, user: REPLAY_USER }).catch((err: Error) => ({ thrown: err.message })))
  }

  beforeAll(async () => {
    pg = await startRealPostgres()
    first = pg.connect()
    second = pg.connect()
    race = makeRace(pg, first, second)
  }, 60_000)

  afterAll(async () => {
    await pg.stop()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  beforeEach(async () => {
    const names = [...TABLES.keys()].map((table) => `public.${table}`).join(', ')
    await pg.admin.unsafe(`TRUNCATE ${names} CASCADE`)
    stripe = new FakeStripe()
    beforeStatement = null
    refundGate = null
    await seed(first, stripe)
    await sessionsToMoveBetween(first)
    // Far off, so neither the 24-hour rule nor Postgres's real clock ever reaches them. With triggers
    // off, as one works the band out again from the new date.
    await pg.admin.unsafe(`
      SET session_replication_role = replica;
      UPDATE sessions SET start_time = start_time + interval '20 years', end_time = end_time + interval '20 years';
      SET session_replication_role = origin;
    `)
    const legacy = bindLegacyRoutes(first, stripe)
    // The wrappers that ask the Worker (W14a) find its staff routes here; every kind of order is off.
    vi.stubGlobal('paddockWorkerV1', { rawRequest: bindStaffRoutes() })
    vi.stubEnv('ORDER_SWITCH', '')
    vi.stubGlobal('paddockData', { query })
    vi.stubGlobal('paddockBackendApi2', {
      async rawRequest(request: { path: string }) {
        if (request.path === '/api/payments/refund-order' && refundGate) {
          const gate = refundGate
          refundGate = null
          gate.reached()
          await gate.released
        }
        return legacy(request as never)
      },
    })
  })

  const booking = async (id: string) =>
    (await first.query<{ status: string; price_paid: string; part_refunded_amount: string; refund_owed_amount: string; party_size: number }>(
      'SELECT status, price_paid, part_refunded_amount, refund_owed_amount, party_size FROM bookings WHERE id = $1',
      [id]
    ))[0]
  const cardBack = () =>
    stripe.calls.filter((c) => c.method === 'refunds.create').reduce((sum, c) => sum + (c.params as { amount: number }).amount, 0) / 100
  const creditBack = async () =>
    Number((await first.query<{ total: string }>(`SELECT COALESCE(SUM(amount), 0) AS total FROM store_credit_transactions WHERE reason = 'refund'`))[0]?.total)
  const moneyBack = async () => cardBack() + (await creditBack())
  const placeOrder = async (order: Record<string, unknown> = noPromoOnCard) => {
    const placed = await call('createOrder', { customerId: ID.customer, ...order })
    if (!placed['bookingId']) throw new Error(`The order failed: ${JSON.stringify(placed)}`)
    return placed as { bookingId: string }
  }

  /** Runs `held` until its card refund is on its way, runs `other` to the end, then lets it finish. */
  async function whileHeld(held: () => Promise<Answer>, other: () => Promise<Answer>) {
    let reached = () => {}
    let release = () => {}
    const atStripe = new Promise<void>((resolve) => {
      reached = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    refundGate = { reached, released }
    const running = held()
    await atStripe
    const second = await other()
    release()
    return { held: await running, other: second }
  }

  /** Inside a transaction, a claim that touches no row is refused so that it rolls back. */
  const claiming = async <T>(tx: Tx, claim: () => Promise<unknown>, won: T): Promise<T> => {
    if (!(await connection.run(tx, claim))) throw new Refused('claim_refused')
    return won
  }

  interface Claims {
    claimPartRefund(args: { bookingId: string; amount: number; seenPricePaid: number }): Promise<boolean>
    claimOwedMoney(args: { bookingId: string; amount: number; seenPricePaid: number }): Promise<boolean>
    claimGuestRefund(args: { bookingId: string; guestId: string; seenUnitPrice: number; amount: number; seenPricePaid: number }): Promise<boolean>
    claimCancel(args: { bookingId: string; seenStatus: string; seenPricePaid: number }): Promise<boolean>
  }
  /** The claims, as "did it work": each answers its audit row's id, and a cancel says separately. */
  const claims = async (): Promise<Claims> => {
    type Real = { [K in keyof Claims]: (args: never) => Promise<string | null | { claimed: boolean }> }
    const real = await load<Real>('shared/bookingMoneyClaim.ts')
    const worked = (name: keyof Claims) => async (args: never) => {
      const answer = await real[name](args)
      return typeof answer === 'object' && answer !== null ? answer.claimed : answer !== null
    }
    return { claimPartRefund: worked('claimPartRefund'), claimOwedMoney: worked('claimOwedMoney'), claimGuestRefund: worked('claimGuestRefund'), claimCancel: worked('claimCancel') } as Claims
  }

  const openReaderMove = (runner: Runner, bookingId: string, raiseBy: number) =>
    runner.query(
      `WITH bk AS (UPDATE bookings SET price_paid = price_paid + $1::numeric WHERE id = $2 RETURNING id)
       INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status)
       SELECT 'move', bk.id, 'pi_open', $3::numeric, '{}'::jsonb, 'pending' FROM bk`,
      [raiseBy, bookingId, raiseBy]
    )

  describe('the claim, one statement waiting on another', () => {
    it('two part refunds of £70 on £100: the second waited, then was refused', async () => {
      const { bookingId } = await placeOrder()
      const { claimPartRefund } = await claims()
      const result = await race((tx) => claiming(tx, () => claimPartRefund({ bookingId, amount: 70, seenPricePaid: 100 }), 'claimed'), 'commit')
      expect(result.first).toEqual({ won: 'claimed' })
      expect(result.second).toMatchObject({ refused: { reason: 'claim_refused' } })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00', part_refunded_amount: '70.00' })
    })

    it('if the first rolls back, the second gets it', async () => {
      const { bookingId } = await placeOrder()
      const { claimPartRefund } = await claims()
      const result = await race((tx) => claiming(tx, () => claimPartRefund({ bookingId, amount: 70, seenPricePaid: 100 }), 'claimed'), 'rollback')
      expect(result.second).toEqual({ won: 'claimed' })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00', part_refunded_amount: '70.00' })
    })

    it('control: with no guard both take it, so the race is real', async () => {
      const { bookingId } = await placeOrder()
      const result = await race(async (tx) => {
        await tx.query('UPDATE bookings SET price_paid = price_paid - 70 WHERE id = $1', [bookingId])
        return 'claimed'
      }, 'commit')
      expect(result.second).toEqual({ won: 'claimed' })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '-40.00' })
    })

    it('with enough left for both, the second is still refused, and asked to confirm the new figures', async () => {
      const { bookingId } = await placeOrder()
      const { claimPartRefund } = await claims()
      const result = await race((tx) => claiming(tx, () => claimPartRefund({ bookingId, amount: 30, seenPricePaid: 100 }), 'claimed'), 'commit')
      expect(result.second).toMatchObject({ refused: { reason: 'claim_refused' } })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '70.00' })
    })

    it('Refund the rest twice: the second waited, and finds nothing owed', async () => {
      const { bookingId } = await placeOrder()
      await pg.admin.unsafe(`UPDATE bookings SET refund_owed_amount = 40 WHERE id = '${bookingId}'`)
      const { claimOwedMoney } = await claims()
      const result = await race((tx) => claiming(tx, () => claimOwedMoney({ bookingId, amount: 40, seenPricePaid: 100 }), 'claimed'), 'commit')
      expect(result.first).toEqual({ won: 'claimed' })
      expect(result.second).toMatchObject({ refused: { reason: 'claim_refused' } })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '0.00' })
    })

    it('the same seat twice: the second waited on the seat, and took nothing off the booking', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const guest = (await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })) as { guest: { id: string } }
      const { claimGuestRefund } = await claims()
      const claim = { bookingId, guestId: guest.guest.id, seenUnitPrice: 20, amount: 20, seenPricePaid: 60 }
      const result = await race((tx) => claiming(tx, () => claimGuestRefund(claim), 'claimed'), 'commit')
      expect(result.first).toEqual({ won: 'claimed' })
      expect(result.second).toMatchObject({ refused: { reason: 'claim_refused' } })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00' })
    })

    it('two cancels: the second waited, and finds it cancelled', async () => {
      const { bookingId } = await placeOrder()
      const { claimCancel } = await claims()
      const result = await race((tx) => claiming(tx, () => claimCancel({ bookingId, seenStatus: 'confirmed', seenPricePaid: 100 }), 'claimed'), 'commit')
      expect(result.first).toEqual({ won: 'claimed' })
      expect(result.second).toMatchObject({ refused: { reason: 'claim_refused' } })
    })

    it('a cancel and a part refund: whoever waited is refused', async () => {
      const { bookingId } = await placeOrder()
      const { claimCancel, claimPartRefund } = await claims()
      const result = await race(
        (tx, who) =>
          who === 'first'
            ? claiming(tx, () => claimCancel({ bookingId, seenStatus: 'confirmed', seenPricePaid: 100 }), 'cancelled')
            : claiming(tx, () => claimPartRefund({ bookingId, amount: 10, seenPricePaid: 100 }), 'part refunded'),
        'commit'
      )
      expect(result.second).toMatchObject({ refused: { reason: 'claim_refused' } })
      expect(await booking(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '100.00' })
    })
  })

  describe('each guard on its own, with price_paid as read so that only it can refuse', () => {
    const withOwed = async () => {
      const placed = await placeOrder()
      await pg.admin.unsafe(`UPDATE bookings SET refund_owed_amount = 40 WHERE id = '${placed.bookingId}'`)
      return placed
    }

    it('a part refund for more than is left', async () => {
      const { bookingId } = await withOwed()
      const { claimPartRefund } = await claims()
      expect(await claimPartRefund({ bookingId, amount: 61, seenPricePaid: 100 })).toBe(false)
      expect(await claimPartRefund({ bookingId, amount: 60, seenPricePaid: 100 })).toBe(true)
    })

    it('Refund the rest for a figure that is not what is owed, either way', async () => {
      const { bookingId } = await withOwed()
      const { claimOwedMoney } = await claims()
      expect(await claimOwedMoney({ bookingId, amount: 39, seenPricePaid: 100 })).toBe(false)
      expect(await claimOwedMoney({ bookingId, amount: 41, seenPricePaid: 100 })).toBe(false)
      expect(await claimOwedMoney({ bookingId, amount: 40, seenPricePaid: 100 })).toBe(true)
    })

    it('Refund the rest for more than the booking holds', async () => {
      const { bookingId } = await placeOrder()
      await pg.admin.unsafe(`UPDATE bookings SET refund_owed_amount = 120 WHERE id = '${bookingId}'`)
      const { claimOwedMoney } = await claims()
      expect(await claimOwedMoney({ bookingId, amount: 120, seenPricePaid: 100 })).toBe(false)
    })

    it('a guest refund for more than is left', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const { guest } = (await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })) as { guest: { id: string } }
      await pg.admin.unsafe(`UPDATE bookings SET refund_owed_amount = 45 WHERE id = '${bookingId}'`)
      const { claimGuestRefund } = await claims()
      expect(await claimGuestRefund({ bookingId, guestId: guest.id, seenUnitPrice: 20, amount: 20, seenPricePaid: 60 })).toBe(false)
      const seat = await first.query<{ unit_price: string }>('SELECT unit_price FROM booking_guests WHERE id = $1', [guest.id])
      expect(seat[0]?.unit_price).toBe('20.00')
    })

    it.each<[string, (c: Claims, bookingId: string) => Promise<boolean>]>([
      ['a part refund', (c, bookingId) => c.claimPartRefund({ bookingId, amount: 10, seenPricePaid: 100 })],
      ['Refund the rest', (c, bookingId) => c.claimOwedMoney({ bookingId, amount: 40, seenPricePaid: 100 })],
    ])('%s on a cancelled booking', async (_name, claim) => {
      const { bookingId } = await withOwed()
      await pg.admin.unsafe(`UPDATE bookings SET status = 'cancelled' WHERE id = '${bookingId}'`)
      expect(await claim(await claims(), bookingId)).toBe(false)
    })

    it('a guest refund on a cancelled booking', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const { guest } = (await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })) as { guest: { id: string } }
      await pg.admin.unsafe(`UPDATE bookings SET status = 'cancelled' WHERE id = '${bookingId}'`)
      const { claimGuestRefund } = await claims()
      expect(await claimGuestRefund({ bookingId, guestId: guest.id, seenUnitPrice: 20, amount: 20, seenPricePaid: 60 })).toBe(false)
    })

    it('It already arrived on a cancelled booking', async () => {
      const { bookingId } = await withOwed()
      await pg.admin.unsafe(`UPDATE bookings SET status = 'cancelled' WHERE id = '${bookingId}'`)
      const { clearOwedMoneyThatArrived } = await load<{ clearOwedMoneyThatArrived(args: Record<string, unknown>): Promise<boolean> }>('shared/bookingMoneyClaim.ts')
      expect(await clearOwedMoneyThatArrived({ bookingId, amount: 40, seenPricePaid: 100, staffId: null, reason: 'Found it' })).toBe(false)
      expect(await first.query('SELECT id FROM audit_log')).toEqual([])
    })

    it.each<[string, (c: Claims, bookingId: string) => Promise<boolean>]>([
      ['a stale price_paid on a part refund', (c, bookingId) => c.claimPartRefund({ bookingId, amount: 10, seenPricePaid: 99 })],
      ['a stale price_paid on Refund the rest', (c, bookingId) => c.claimOwedMoney({ bookingId, amount: 40, seenPricePaid: 99 })],
      ['a stale price_paid on a cancel', (c, bookingId) => c.claimCancel({ bookingId, seenStatus: 'confirmed', seenPricePaid: 99 })],
      ['a stale status on a cancel', (c, bookingId) => c.claimCancel({ bookingId, seenStatus: 'pending', seenPricePaid: 100 })],
    ])('%s', async (_name, claim) => {
      const { bookingId } = await withOwed()
      expect(await claim(await claims(), bookingId)).toBe(false)
    })

    it('a stale seat on a guest refund, and a guest who has gone', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const { guest } = (await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })) as { guest: { id: string } }
      const { claimGuestRefund } = await claims()
      expect(await claimGuestRefund({ bookingId, guestId: guest.id, seenUnitPrice: 19, amount: 19, seenPricePaid: 60 })).toBe(false)
      await pg.admin.unsafe(`DELETE FROM booking_guests WHERE id = '${guest.id}'`)
      expect(await claimGuestRefund({ bookingId, guestId: guest.id, seenUnitPrice: 20, amount: 20, seenPricePaid: 60 })).toBe(false)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00' })
    })

    it('a stale price_paid on a guest refund', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const { guest } = (await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })) as { guest: { id: string } }
      const { claimGuestRefund } = await claims()
      expect(await claimGuestRefund({ bookingId, guestId: guest.id, seenUnitPrice: 20, amount: 20, seenPricePaid: 59 })).toBe(false)
    })
  })

  describe('a reader opened with no change to price_paid, so only NOT EXISTS can refuse', () => {
    const open = (bookingId: string) => openReaderMove(second, bookingId, 0)
    const arrivedClaim = () => load<{ clearOwedMoneyThatArrived(args: Record<string, unknown>): Promise<boolean> }>('shared/bookingMoneyClaim.ts')

    it.each<[string, (c: Claims, bookingId: string) => Promise<boolean>]>([
      ['a part refund', (c, bookingId) => c.claimPartRefund({ bookingId, amount: 10, seenPricePaid: 100 })],
      ['Refund the rest', (c, bookingId) => c.claimOwedMoney({ bookingId, amount: 40, seenPricePaid: 100 })],
      ['a cancel', (c, bookingId) => c.claimCancel({ bookingId, seenStatus: 'confirmed', seenPricePaid: 100 })],
    ])('%s', async (_name, claim) => {
      const { bookingId } = await placeOrder()
      await pg.admin.unsafe(`UPDATE bookings SET refund_owed_amount = 40 WHERE id = '${bookingId}'`)
      await open(bookingId)
      expect(await claim(await claims(), bookingId)).toBe(false)
    })

    it('It already arrived', async () => {
      const { bookingId } = await placeOrder()
      await pg.admin.unsafe(`UPDATE bookings SET refund_owed_amount = 40 WHERE id = '${bookingId}'`)
      await open(bookingId)
      const { clearOwedMoneyThatArrived } = await arrivedClaim()
      expect(await clearOwedMoneyThatArrived({ bookingId, amount: 40, seenPricePaid: 100, staffId: null, reason: 'Found it' })).toBe(false)
    })

    it('a guest refund', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const { guest } = (await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })) as { guest: { id: string } }
      await open(bookingId)
      const { claimGuestRefund } = await claims()
      expect(await claimGuestRefund({ bookingId, guestId: guest.id, seenUnitPrice: 20, amount: 20, seenPricePaid: 60 })).toBe(false)
    })

    it('a move: its statement refuses, and its charge goes back', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      beforeStatement = { matches: /WITH bk AS[\s\S]*SET session_id/, run: async () => void (await open(bookingId)) }
      const answer = await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card' } })
      expect(answer).toEqual({ moved: false, reason: 'reader_payment_open', message: OPEN })
      expect(cardBack()).toBe(11)
    })

    it('a guest: the statement refuses, and their charge goes back', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      beforeStatement = { matches: /WITH p AS[\s\S]*seen_price_paid/, run: async () => void (await open(bookingId)) }
      const answer = await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })
      expect(answer).toEqual({ added: false, reason: 'reader_payment_open', message: OPEN })
      expect(cardBack()).toBe(20)
    })
  })

  describe('cancelled between check and act, which leaves price_paid as it was', () => {
    const cancelled = (bookingId: string) => async () => {
      await pg.admin.unsafe(`UPDATE bookings SET status = 'cancelled' WHERE id = '${bookingId}'`)
    }

    it('a move gives its charge back and moves nothing', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      beforeStatement = { matches: /WITH bk AS[\s\S]*SET session_id/, run: cancelled(bookingId) }
      const answer = await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card' } })
      expect(answer).toMatchObject({ moved: false, reason: 'booking_changed' })
      expect(cardBack()).toBe(11)
    })

    it('a guest gets their charge back, and no row is left on the cancelled booking', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      beforeStatement = { matches: /WITH p AS[\s\S]*seen_price_paid/, run: cancelled(bookingId) }
      const answer = await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })
      expect(answer).toMatchObject({ added: false, reason: 'booking_changed' })
      expect(cardBack()).toBe(20)
      expect(await first.query('SELECT id FROM booking_guests WHERE booking_id = $1', [bookingId])).toHaveLength(2)
    })
  })

  describe('beaten to the claim, after every check had passed', () => {
    it('Refund the rest moves nothing, and answers with the new figures', async () => {
      const { bookingId } = await placeOrder()
      await pg.admin.unsafe(`UPDATE bookings SET refund_owed_amount = 40 WHERE id = '${bookingId}'`)
      const { claimOwedMoney } = await claims()
      beforeStatement = {
        matches: /SET price_paid = b\.price_paid - \$1::numeric, refund_owed_amount/,
        run: async () => void (await connection.run(second, () => claimOwedMoney({ bookingId, amount: 40, seenPricePaid: 100 }))),
      }
      const answer = await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
      expect(answer).toMatchObject({ refused: { figures: { refundOwed: 0, pricePaid: 60 } } })
      expect(await moneyBack()).toBe(0)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '0.00' })
    })

    it('Remove Guest moves nothing, keeps the guest, and answers with the new quote', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const { guest } = (await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })) as { guest: { id: string } }
      const { claimGuestRefund } = await claims()
      beforeStatement = {
        matches: /WITH seat AS \(\s+SELECT/,
        run: async () => void (await connection.run(second, () => claimGuestRefund({ bookingId, guestId: guest.id, seenUnitPrice: 20, amount: 20, seenPricePaid: 60 }))),
      }
      const answer = await call('removeBookingGuest', { guestId: guest.id, confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(answer).toMatchObject({ removed: false, reason: 'refund_amount_mismatch', quote: { refundAmount: 0 } })
      expect(await moneyBack()).toBe(0)
      expect(await first.query('SELECT id FROM booking_guests WHERE id = $1', [guest.id])).toHaveLength(1)
    })

    it('a move finds the party changed with price_paid the same, and gives its charge back', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      beforeStatement = {
        matches: /WITH bk AS[\s\S]*SET session_id/,
        run: async () => void (await pg.admin.unsafe(`UPDATE bookings SET party_size = 1 WHERE id = '${bookingId}'`)),
      }
      const answer = await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card' } })
      expect(answer).toMatchObject({ moved: false, reason: 'booking_changed' })
      expect(cardBack()).toBe(11)
    })
  })

  describe('a reader payment opened between check and act', () => {
    it('opened after the check and before the claim: the claim sees it, and no money moves', async () => {
      const { bookingId } = await placeOrder()
      beforeStatement = { matches: /part_refunded_amount = b\.part_refunded_amount/, run: async () => void (await openReaderMove(second, bookingId, 40)) }
      const answer = await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      expect(answer).toEqual({ thrown: OPEN })
      expect(await moneyBack()).toBe(0)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '140.00', part_refunded_amount: '0.00' })
    })

    it('committed while the claim waited on the row: refused, on the price_paid it read', async () => {
      const { bookingId } = await placeOrder()
      const { claimPartRefund } = await claims()
      const result = await race(
        (tx, who) =>
          who === 'first'
            ? openReaderMove(tx, bookingId, 40).then(() => 'reader open')
            : claiming(tx, () => claimPartRefund({ bookingId, amount: 30, seenPricePaid: 100 }), 'claimed'),
        'commit'
      )
      expect(result.second).toMatchObject({ refused: { reason: 'claim_refused' } })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '140.00', part_refunded_amount: '0.00' })
    })

    it('control: NOT EXISTS alone misses that one, as a statement that waited sees other tables from before', async () => {
      const { bookingId } = await placeOrder()
      const { NO_READER_PAYMENT_OPEN } = await load<{ NO_READER_PAYMENT_OPEN: string }>('shared/readerPaymentOpen.ts')
      const result = await race(async (tx, who) => {
        if (who === 'first') {
          await openReaderMove(tx, bookingId, 40)
          return 0
        }
        const rows = await tx.query(
          // eslint-disable-next-line no-restricted-syntax -- a fixed fragment of the staff app's SQL, not a value
          `UPDATE bookings b SET price_paid = b.price_paid - 30
           WHERE b.id = $1 AND b.price_paid - b.refund_owed_amount >= 30 AND ${NO_READER_PAYMENT_OPEN}
           RETURNING b.id`,
          [bookingId]
        )
        return rows.length
      }, 'commit')
      expect(result.second).toEqual({ won: 1 })
    })

    it('a refund claimed first: a move on the reader finds price_paid changed, opens nothing and moves nothing', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const { claimPartRefund } = await claims()
      beforeStatement = {
        matches: /WITH bk AS[\s\S]*SET session_id/,
        run: async () => void (await connection.run(second, () => claimPartRefund({ bookingId, amount: 10, seenPricePaid: 40 }))),
      }
      const answer = await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } })
      expect(answer).toMatchObject({ moved: false, reason: 'booking_changed' })
      expect(await first.query('SELECT id FROM pending_reader_payments')).toEqual([])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00', part_refunded_amount: '10.00' })
      const places = await first.query<{ total_booked: number }>('SELECT total_booked FROM sessions WHERE id = $1', [ID.peakSession])
      expect(places[0]?.total_booked).toBe(0)
    })

    it('a refund claimed first: a move on the card gives its charge back', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const { claimPartRefund } = await claims()
      beforeStatement = {
        matches: /WITH bk AS[\s\S]*SET session_id/,
        run: async () => void (await connection.run(second, () => claimPartRefund({ bookingId, amount: 10, seenPricePaid: 40 }))),
      }
      const answer = await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card' } })
      expect(answer).toMatchObject({ moved: false, reason: 'booking_changed' })
      expect(cardBack()).toBe(11)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00' })
    })

    it('a refund claimed first: a guest on the card gets their charge back and is not added', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const { claimPartRefund } = await claims()
      beforeStatement = {
        matches: /WITH p AS[\s\S]*seen_price_paid/,
        run: async () => void (await connection.run(second, () => claimPartRefund({ bookingId, amount: 10, seenPricePaid: 40 }))),
      }
      const answer = await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })
      expect(answer).toMatchObject({ added: false, reason: 'booking_changed' })
      expect(cardBack()).toBe(20)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00', party_size: 2 })
      const guests = await first.query('SELECT id FROM booking_guests WHERE booking_id = $1', [bookingId])
      expect(guests).toHaveLength(2)
    })

    it('a move on the reader: its pending row is there the moment price_paid rises', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '51.00' })
      expect(await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 5, ...goodwill })).toEqual({ thrown: OPEN })
    })
  })

  describe('whole refunds, one held at its Stripe call with the money on its way', () => {
    it('two part refunds of £70 on £100: £70 goes, once', async () => {
      const { bookingId } = await placeOrder()
      const refund = () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 70, ...goodwill })
      const { held, other } = await whileHeld(refund, () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 70, ...goodwill }, second))
      expect(held).toMatchObject({ cardRefundedAmount: 70, pricePaid: 30 })
      expect(other).toMatchObject({ refused: { message: 'Only £30.00 is left on this booking. Check the amount and confirm again.', figures: { left: 30 } } })
      expect(await moneyBack()).toBe(70)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00', part_refunded_amount: '70.00' })
    })

    it('two Cancel & Refunds: £100 goes, once', async () => {
      const { bookingId } = await placeOrder()
      const cancel = (on: Db) => () => call('refundBooking', { bookingId, refundMethod: 'card' }, on)
      const { held, other } = await whileHeld(cancel(first), cancel(second))
      expect(held).toMatchObject({ cardRefundedAmount: 100 })
      expect(other).toMatchObject({ thrown: 'This booking is already cancelled.' })
      expect(await moneyBack()).toBe(100)
      expect(await booking(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '100.00' })
    })

    it('a part refund meeting a Cancel & Refund on its way: nothing past what was paid', async () => {
      const { bookingId } = await placeOrder()
      const { held, other } = await whileHeld(
        () => call('refundBooking', { bookingId, refundMethod: 'card' }),
        () => call('refundBooking', { bookingId, refundMethod: 'credit', amount: 50, ...goodwill }, second)
      )
      expect(held).toMatchObject({ cardRefundedAmount: 100 })
      expect(other).toEqual({ thrown: 'This booking is already cancelled.' })
      expect(await moneyBack()).toBe(100)
    })

    it('a Cancel & Refund meeting a part refund on its way: it gives only what is left', async () => {
      const { bookingId } = await placeOrder()
      const { held, other } = await whileHeld(
        () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill }),
        () => call('refundBooking', { bookingId, refundMethod: 'card' }, second)
      )
      expect(held).toMatchObject({ cardRefundedAmount: 30 })
      expect(other).toMatchObject({ cardRefundedAmount: 70 })
      expect(await moneyBack()).toBe(100)
    })

    it('Remove Guest twice on the same guest: their £20 goes, once', async () => {
      const { bookingId } = await placeOrder(publicOnCard)
      const guest = (await call('addBookingGuest', { bookingId, guestName: 'Bea', guestEmail: 'b@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })) as { guest: { id: string } }
      const removal = { guestId: guest.guest.id, confirmedRefundAmount: 20, refundMethod: 'card' }
      const { held, other } = await whileHeld(() => call('removeBookingGuest', removal), () => call('removeBookingGuest', removal, second))
      expect(held).toMatchObject({ removed: true, refundedAmount: 20 })
      expect(other).toMatchObject({ removed: false, reason: 'refund_amount_mismatch', quote: { refundAmount: 0 } })
      expect(await moneyBack()).toBe(20)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', party_size: 2 })
    })

    it('Refund the rest twice: what is owed goes, once', async () => {
      const { bookingId } = await placeOrder()
      await pg.admin.unsafe(`UPDATE bookings SET refund_owed_amount = 40 WHERE id = '${bookingId}'`)
      const rest = (on: Db) => () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true }, on)
      const { held, other } = await whileHeld(rest(first), rest(second))
      expect(held).toMatchObject({ cardRefundedAmount: 40 })
      expect(other).toMatchObject({ refused: { message: 'Nothing is owed on this booking any more.' } })
      expect(await moneyBack()).toBe(40)
    })

    it('It already arrived while Refund the rest is on its way: refused, so the money is not written off', async () => {
      const { bookingId } = await placeOrder()
      await pg.admin.unsafe(`UPDATE bookings SET refund_owed_amount = 40 WHERE id = '${bookingId}'`)
      const { held, other } = await whileHeld(
        () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true }),
        () => call('refundBooking', { bookingId, refundMethod: 'credit', amount: 40, owedArrived: true, reason: 'Found it' }, second)
      )
      expect(held).toMatchObject({ cardRefundedAmount: 40 })
      expect(other).toMatchObject({ refused: { message: 'Nothing is owed on this booking any more.' } })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '0.00' })
    })

    it('a cheaper move while a part refund is on its way: the move counts it, and nothing is given twice', async () => {
      const { bookingId } = await placeOrder({ ...noPromoOnCard, booking: { ...(noPromoOnCard as { booking: object }).booking, sessionId: ID.peakPrivateSession } })
      await call('moveBooking', { bookingId, newSessionId: ID.privateSession })
      const { held, other } = await whileHeld(
        () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill }),
        () => call('moveBooking', { bookingId, newSessionId: ID.privateSession, confirmed: true, refundMethod: 'card' }, second)
      )
      expect(held).toMatchObject({ cardRefundedAmount: 30 })
      expect(other).toMatchObject({ moved: true })
      expect(await moneyBack()).toBeLessThanOrEqual(140)
      const left = await booking(bookingId)
      expect(Number(left?.price_paid) + (await moneyBack())).toBe(140)
    })
  })

  describe('free-running: the two functions at once, with no timing fixed', () => {
    it.each<[string, (bookingId: string, on: Db) => Promise<Answer>]>([
      ['part refunds', (bookingId, on) => call('refundBooking', { bookingId, refundMethod: 'card', amount: 60, ...goodwill }, on)],
      ['Cancel & Refunds', (bookingId, on) => call('refundBooking', { bookingId, refundMethod: 'card' }, on)],
    ])('%s: never more back than was paid, in ten rounds', async (_name, refund) => {
      for (let round = 0; round < 10; round += 1) {
        const { bookingId } = await placeOrder()
        const before = await moneyBack()
        await Promise.all([refund(bookingId, first), refund(bookingId, second)])
        expect((await moneyBack()) - before).toBeLessThanOrEqual(100)
        await pg.admin.unsafe(`UPDATE sessions SET total_booked = 0`)
        await pg.admin.unsafe(`UPDATE bookings SET status = 'cancelled' WHERE id = '${bookingId}'`)
      }
    }, 60_000)

    it('two moves: the booking ends on one session, and the places add up, in ten rounds', async () => {
      const elsewhere = ['10000000-0000-4000-8000-0000000000f1', '10000000-0000-4000-8000-0000000000f2']
      for (const [i, id] of elsewhere.entries()) {
        await pg.admin.unsafe(`
          INSERT INTO sessions (id, service_type_id, start_time, end_time, type, capacity, band_id)
          VALUES ('${id}', '${ID.serviceType}', '2046-12-0${i + 1} 10:00:00+00', '2046-12-0${i + 1} 11:00:00+00', 'public', 10, '${ID.band}')`)
      }
      for (let round = 0; round < 10; round += 1) {
        const { bookingId } = await placeOrder(publicOnCard)
        await Promise.all(elsewhere.map((newSessionId, i) => call('moveBooking', { bookingId, newSessionId, confirmed: true }, i === 0 ? first : second)))
        const sessions = [ID.session, ...elsewhere]
        const places = await first.query<{ id: string; total_booked: number }>('SELECT id, total_booked FROM sessions WHERE id = ANY($1::uuid[])', [sessions])
        const [row] = await first.query<{ session_id: string }>('SELECT session_id FROM bookings WHERE id = $1', [bookingId])
        expect(places.filter((session) => session.total_booked !== 0)).toEqual([{ id: row?.session_id, total_booked: 2 }])
        await pg.admin.unsafe(`UPDATE sessions SET total_booked = 0`)
        await pg.admin.unsafe(`UPDATE bookings SET status = 'cancelled' WHERE id = '${bookingId}'`)
      }
    }, 60_000)

    it('two free guests: one comes in free and the other is asked to pay, in ten rounds', async () => {
      const guest = (guestName: string) => ({ guestName, guestEmail: 'g@example.com', guestsOver18Confirmed: true })
      for (let round = 0; round < 10; round += 1) {
        const { bookingId } = await placeOrder()
        await call('addBookingGuest', { bookingId, ...guest('Bea'), payment: { method: 'card' } })
        await Promise.all([call('addBookingGuest', { bookingId, ...guest('Cy') }, first), call('addBookingGuest', { bookingId, ...guest('Di') }, second)])
        expect(await booking(bookingId)).toMatchObject({ party_size: 4, price_paid: '150.00' })
        await pg.admin.unsafe(`UPDATE sessions SET total_booked = 0`)
        await pg.admin.unsafe(`UPDATE bookings SET status = 'cancelled' WHERE id = '${bookingId}'`)
      }
    }, 60_000)
  })
})

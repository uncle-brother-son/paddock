import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET as figuresRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refund-figures/route'
import type { Db } from '@/server/db'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { bea, ID, memberCredit, mo, noPromoOnCard, paidSeat, PROMO, sam, seed, sessionsToMoveBetween, tieredPrivatePrices } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { insert } from '@/server/rules/testing/database'
import { READER_PAYMENT_OPEN_MESSAGE } from './failure-messages'

// Brief W70a item 1 (the W70 audit's S1): decided rules of the bookings' money (Q24, Q25, Q29, and W05a to W05g) that the
// old code and the Worker agreed on, so W64's decisions table (which lists where they differ) had no row for them, and
// since W65 only a sweep recording held them. A recording would accept a change; these are the rule tests. Each press
// goes through the Worker's routes as its screen sends it (sweep/worker.ts), on the replay's live schema; Stripe is only
// ever the fake. Seats £20, private £100 for 1-2 (£150 for 3-4 where tiered), towel £5, soap £12, ALLTEN is 10% off.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const KEY = 'test-staff-api-key'
let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

const alex = { name: 'Alex Guest', email: 'alex@example.com' }
const cash = (amount: number) => ({ method: 'cash', confirmedCashAmount: amount })
const card = { method: 'card' }
const goodwill = { reason: 'Goodwill' }
const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5, redemptionSource: 'paid' }
const privateSeats = { ...paidSeat([sam, alex]), sessionId: ID.privateSession }
const promo = (payment: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ booking: privateSeats, promoCode: PROMO.percent, payment, ...extra })
const publicOnCard = { booking: paidSeat([sam, alex]), payment: card }
const creditAndPaidSeat = { customerId: ID.member, booking: { ...paidSeat([mo, alex]), ...memberCredit }, payment: card }

type Steps = ScenarioContext & { bookingId: string; orderId: string }

/** A booking placed through New Order's route, then `work` on it, each press a second after the one before. */
async function withBooking(order: Record<string, unknown>, work: (steps: Steps) => Promise<void>, prepare?: (seedDb: Db) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w70a w05 rules',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await prepare?.(seedDb)
      },
      async run(context) {
        replayStripe.current = context.stripe
        const call: ScenarioContext['call'] = async (action, params) => {
          const answer = await context.call(action, params)
          vi.setSystemTime(Date.now() + 1000)
          return answer
        }
        try {
          const placed = (await call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string; orderId: string }
          await work({ ...context, call, bookingId: placed.bookingId, orderId: placed.orderId })
        } finally {
          replayStripe.current = null
        }
      },
    },
    workerSide()
  )
}

const booking = async (bookingId: string) =>
  (
    await db.query<{ status: string; price_paid: string; part_refunded_amount: string; party_size: number }>(
      'SELECT status, price_paid::text AS price_paid, part_refunded_amount::text AS part_refunded_amount, party_size FROM bookings WHERE id = $1',
      [bookingId]
    )
  )[0]
/** The booking's lines, oldest first: what went back to the card, and how the line is stamped. */
const lines = async (bookingId: string) =>
  (
    await db.query<{ order_id: string; card: string; refunded: boolean; method: string | null }>(
      `SELECT order_id, trim_scale(card_refunded_amount)::text AS card, refunded_at IS NOT NULL AS refunded, refund_method AS method
       FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking' ORDER BY created_at`,
      [bookingId]
    )
  ).map((line) => ({ orderId: line.order_id, card: line.card, stamp: line.refunded ? line.method : null }))
const status = async (orderId: string | undefined) => (await db.query<{ s: string }>('SELECT payment_status AS s FROM orders WHERE id = $1', [orderId ?? null]))[0]?.s
const credit = async () =>
  (await db.query<{ amount: string }>("SELECT amount::text AS amount FROM store_credit_transactions WHERE reason = 'refund' ORDER BY created_at, ctid")).map((row) => row.amount)
const towelLine = async (bookingId: string) => (await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1', [bookingId]))[0]?.id as string
const cardBack = (steps: Pick<Steps, 'stripe'>) => steps.stripe.refundsSent.map((sent) => sent.amount)
async function figures(bookingId: string): Promise<Record<string, unknown>> {
  const response = await figuresRoute(
    new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/refund-figures`, { headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email } }),
    { params: Promise.resolve({ bookingId }) }
  )
  return ((await response.json()) as { data: Record<string, unknown> }).data
}

describe('Q24 (W05a): a refund of a private booking with a promo gives back what was paid, £90 of £100', () => {
  const GIFT_AND_CREDIT = { ...card, giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } }
  it.each([
    ['paid by card, to the card', promo(card), 'card', [9000], []],
    ['paid by card, to store credit', promo(card), 'credit', [], ['90.00']],
    ['paid in cash: store credit, whichever staff choose', promo(cash(90)), 'card', [], ['90.00']],
    ['paid £60 card, £20 gift card, £10 store credit: £60 to the card, the rest store credit', promo(GIFT_AND_CREDIT), 'card', [6000], ['30.00']],
    ['beside a soap: the soap\'s £10.80 stays', promo(card, { products: [{ productVariantId: ID.variant, quantity: 1 }] }), 'card', [9000], []],
    ['made free by a code: nothing to give back', { booking: privateSeats, promoCode: PROMO.big, payment: {} }, 'credit', [], []],
  ] as const)('%s', async (_name, order, refundMethod, toCard, toCredit) => {
    await withBooking(order, async (steps) => {
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod })
      expect(cardBack(steps)).toEqual(toCard)
      expect(await credit()).toEqual(toCredit)
      expect(await booking(steps.bookingId)).toMatchObject({ status: 'cancelled' })
    })
  })

  it('a £30 part refund, then the rest: £30 then £60; a part refund of £95 is refused though it is under the list price', async () => {
    await withBooking(promo(card), async (steps) => {
      const { bookingId, call, attempt } = steps
      expect(await attempt('refundBooking', { bookingId, refundMethod: 'card', amount: 95, ...goodwill })).toMatchObject({ refused: { figures: { left: 90 } } })
      expect(cardBack(steps)).toEqual([])
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
      expect(cardBack(steps)).toEqual([3000, 6000])
    })
  })

  it('T1 keeps the list price on the line with the share beside it, and price_paid what was paid', async () => {
    await withBooking(promo(card), async ({ bookingId, orderId }) => {
      expect(await booking(bookingId)).toMatchObject({ price_paid: '90.00' })
      const [line] = await db.query<Record<string, string>>("SELECT line_total::text AS line_total, discount_amount::text AS discount_amount FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking'", [bookingId])
      expect(line).toEqual({ line_total: '100.00', discount_amount: '10.00' })
      const [order] = await db.query<Record<string, string>>('SELECT order_total::text AS order_total, discount_amount::text AS discount_amount FROM orders WHERE id = $1', [orderId])
      expect(order).toEqual({ order_total: '100.00', discount_amount: '10.00' })
    })
  })
})

describe('Q25, Q27 (W05b, W05c): Add Guest', () => {
  type Quote = { priceImpact: { guestAmount: number; amountDue: number } }
  /** The guest's seat as the dialog's first call shows it. With a £5 towel, so a £0 seat is still a quote and nothing is added. */
  const guestQuote = async ({ call, bookingId }: Pick<Steps, 'call' | 'bookingId'>) =>
    ((await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }] })) as Quote).priceImpact.guestAmount

  it('the tier difference is worked out to the penny: £9.27 paid and £1.03 of promo on a £10.30 tier is £0, never a hair over', async () => {
    await withBooking(
      promo(card),
      async (steps) => {
        expect(await booking(steps.bookingId)).toMatchObject({ price_paid: '9.27' })
        // 10.3 - (9.27 + 1.03) is 1.8e-15 in floats.
        expect(await guestQuote(steps)).toBe(0)
      },
      (seedDb) => seedDb.query("UPDATE service_type_price_tiers SET price = '10.30' WHERE id = $1", [ID.privateTier]).then(() => undefined)
    )
  })

  it('the promo share is counted once however many lines the booking has: a second guest into the same tier is £0, and a public guest takes none of it', async () => {
    await withBooking(
      promo(card),
      async (steps) => {
        const { call, bookingId } = steps
        expect(await guestQuote(steps)).toBe(50)
        await call('addBookingGuest', { bookingId, ...bea, payment: card })
        expect(await guestQuote(steps)).toBe(0)
      },
      tieredPrivatePrices
    )
    await withBooking({ ...publicOnCard, promoCode: PROMO.percent }, async (steps) => {
      expect(await booking(steps.bookingId)).toMatchObject({ price_paid: '36.00' })
      expect(await guestQuote(steps)).toBe(20)
    })
  })

  it('a public guest pays the full seat after a part refund (Q27 is the private tier\'s)', async () => {
    await withBooking(publicOnCard, async (steps) => {
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'card', amount: 10, ...goodwill })
      expect(await guestQuote(steps)).toBe(20)
    })
  })
})

describe('Q29: nearly or all of it part refunded, the booking is kept', () => {
  it('£100 of £100 part refunded: still confirmed for two at £0 with its session, a guest in the same tier is £0, and a cancel then gives nothing more', async () => {
    await withBooking(noPromoOnCard, async (steps) => {
      const { call, bookingId } = steps
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
      expect(await booking(bookingId)).toEqual({ status: 'confirmed', price_paid: '0.00', part_refunded_amount: '100.00', party_size: 2 })
      // A £0 guest is added straight away: nothing to pay.
      expect(await call('addBookingGuest', { bookingId, ...bea })).toMatchObject({ added: true })
      expect(await booking(bookingId)).toEqual({ status: 'confirmed', price_paid: '0.00', part_refunded_amount: '100.00', party_size: 3 })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
      expect(cardBack(steps)).toEqual([10000])
      expect(await credit()).toEqual([])
    })
  })
})

describe('W05c: an add-on paid with a guest goes back to the card it was paid on', () => {
  it('as the Worker writes it (W05c N5): seat and towel on separate lines of one card order; Cancel & Refund with the towel ticked gives that card £25 and the first £40, no store credit', async () => {
    await withBooking(publicOnCard, async (steps) => {
      const { call, bookingId } = steps
      await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }] })
      await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }], payment: card })
      await call('refundBooking', { bookingId, refundMethod: 'card', addonLineIds: [await towelLine(bookingId)] })
      expect(cardBack(steps)).toEqual([2500, 4000])
      expect(await credit()).toEqual([])
    })
  })

  it('as the old code wrote it (the towel inside the booking line of a £25 order): the line\'s seat money is £20, so the towel\'s £5 is still on its card when the seats have gone back', async () => {
    await withBooking(publicOnCard, async (steps) => {
      const { call, bookingId, orderId } = steps
      await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }] })
      await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }], payment: card })
      // Test data: the old Add Guest wrote the whole £25 on the booking line.
      await db.query("UPDATE order_line_items SET line_total = 25, unit_price = 25 WHERE booking_id = $1 AND item_type = 'booking' AND order_id <> $2", [bookingId, orderId])
      expect(await figures(bookingId)).toMatchObject({ left: 60, cardLeft: 60 })
      // A £30 part refund, newest first: the guest's £20 seat and £10 of the first order, never the £5 for the towel.
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      expect((await lines(bookingId)).map((line) => line.card)).toEqual(['10', '20'])
      await call('refundBooking', { bookingId, refundMethod: 'card', addonLineIds: [await towelLine(bookingId)] })
      expect([...cardBack(steps)].sort((a, b) => a - b)).toEqual([500, 1000, 2000, 3000])
      expect(await credit()).toEqual([])
    })
  })

  it('a New Order add-on is outside the booking line, so nothing comes off the seats for it; nor for one on a credit', async () => {
    await withBooking({ booking: { ...paidSeat([sam, alex]), addons: [towel] }, payment: card }, async (steps) => {
      expect(await figures(steps.bookingId)).toMatchObject({ left: 40, cardLeft: 40 })
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'card' })
      expect(cardBack(steps)).toEqual([4000])
    })
    const creditTowel = { ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }
    await withBooking({ customerId: ID.member, booking: { ...paidSeat([mo, alex]), addons: [creditTowel] }, payment: card }, async (steps) => {
      // Test data: as an old line might add up (its order total short by the towel), a credit towel still takes nothing.
      await db.query('UPDATE orders SET order_total = order_total - 5 WHERE id = $1', [steps.orderId])
      await insert(db, 'store_credit_transactions', { customer_id: ID.member, amount: '-5.00', balance_after: '0.00', reason: 'redemption', booking_id: steps.bookingId })
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'card', amount: 35, ...goodwill })
      expect((await lines(steps.bookingId)).map((line) => line.card)).toEqual(['35'])
    })
  })
})

describe('W05d: part_refunded_amount is what staff agreed to give, and nothing else raises it', () => {
  it('a card part refund and a store credit one add to it; Remove Guest, a cheaper Move and an add-on refund add nothing', async () => {
    await withBooking(noPromoOnCard, async ({ call, bookingId }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 15, ...goodwill })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '55.00', part_refunded_amount: '45.00' })
    })
    await withBooking({ booking: { ...paidSeat([sam, alex]), addons: [towel] }, payment: card }, async ({ call, bookingId }) => {
      await call('removeBookingAddon', { addonLineId: await towelLine(bookingId), refund: 'card' })
      const [guest] = await db.query<{ id: string }>("SELECT id FROM booking_guests WHERE booking_id = $1 AND guest_type = 'additional_guest'", [bookingId])
      await call('removeBookingGuest', { guestId: guest?.id })
      await call('removeBookingGuest', { guestId: guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '20.00', part_refunded_amount: '0.00' })
    })
    await withBooking(
      { booking: { ...privateSeats, sessionId: ID.peakPrivateSession }, payment: card },
      async ({ call, bookingId }) => {
        await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession })
        await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession, confirmed: true, refundMethod: 'card' })
        expect(await booking(bookingId)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00' })
      },
      sessionsToMoveBetween
    )
  })
})

describe('W05d item 2, W05e item 2: a booking line is stamped refunded when its seat money went back, and only then', () => {
  it('a free booking cancelled: nothing was paid, so its line has no stamp and its order stays paid', async () => {
    await withBooking({ booking: privateSeats, promoCode: PROMO.big, payment: {} }, async ({ call, bookingId, orderId }) => {
      await call('refundBooking', { bookingId, refundMethod: 'credit' })
      expect(await lines(bookingId)).toEqual([{ orderId, card: '0', stamp: null }])
      expect(await status(orderId)).toBe('paid')
    })
  })

  it('a first line made free by a code holds no seat money: a cancel that gives a guest\'s £50 back stamps their line and not it, and its order stays paid', async () => {
    await withBooking(
      { booking: privateSeats, promoCode: PROMO.big, payment: {} },
      async (steps) => {
        const { call, bookingId, orderId } = steps
        await call('addBookingGuest', { bookingId, ...bea })
        await call('addBookingGuest', { bookingId, ...bea, payment: card })
        await call('refundBooking', { bookingId, refundMethod: 'card' })
        expect(cardBack(steps)).toEqual([5000])
        const [free, guests] = await lines(bookingId)
        expect([free?.stamp, guests?.stamp]).toEqual([null, 'card'])
        expect([await status(orderId), await status(guests?.orderId)]).toEqual(['paid', 'refunded'])
      },
      tieredPrivatePrices
    )
  })

  it.each(['card', 'credit'] as const)('a same-tier guest\'s line holds only their towel: not stamped by a cancel to %s that leaves the towel, so their order stays paid', async (refundMethod) => {
    await withBooking(promo(card), async ({ call, bookingId, orderId }) => {
      await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }] })
      await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }], payment: card })
      await call('refundBooking', { bookingId, refundMethod })
      const [own, guests] = await lines(bookingId)
      expect(own).toMatchObject({ orderId, stamp: refundMethod })
      expect(guests).toMatchObject({ stamp: null })
      expect([await status(orderId), await status(guests?.orderId)]).toEqual(['refunded', 'paid'])
    })
  })

  it.each([
    ['all of it part refunded to the card', [['card', 100]], 'card'],
    ['all of it part refunded to store credit', [['credit', 100]], 'credit'],
    ['all of it part refunded, some each way', [['card', 60], ['credit', 40]], 'card'],
  ] as const)('%s, then cancelled with nothing left to give: stamped, and the order refunded', async (_name, parts, stamp) => {
    await withBooking(noPromoOnCard, async ({ call, bookingId, orderId }) => {
      for (const [refundMethod, amount] of parts) await call('refundBooking', { bookingId, refundMethod, amount, ...goodwill })
      expect(await status(orderId)).toBe('partially_refunded')
      await call('refundBooking', { bookingId, refundMethod: 'card' })
      expect((await lines(bookingId)).map((line) => line.stamp)).toEqual([stamp])
      expect(await status(orderId)).toBe('refunded')
    })
  })

  // price_paid forced to £0 by the test, so only the refunds themselves can say what went back.
  it.each([
    ['nothing back', [], 'paid'],
    ['half of it back', [50], 'partially_refunded'],
  ] as const)('%s on a booking with nothing left to give: not stamped, the order %j', async (_name, parts, orderStatus) => {
    await withBooking(noPromoOnCard, async ({ call, bookingId, orderId }) => {
      for (const amount of parts) await call('refundBooking', { bookingId, refundMethod: 'card', amount, ...goodwill })
      await db.query('UPDATE bookings SET price_paid = 0 WHERE id = $1', [bookingId])
      await call('refundBooking', { bookingId, refundMethod: 'card' })
      expect((await lines(bookingId)).map((line) => line.stamp)).toEqual([null])
      expect(await status(orderId)).toBe(orderStatus)
    })
  })

  it("an add-on's store credit is not seat money: £95 of £100 back and the towel's £5 as store credit is not all of it, so the line is not stamped", async () => {
    await withBooking({ booking: { ...privateSeats, addons: [towel] }, payment: card }, async ({ call, bookingId }) => {
      await call('removeBookingAddon', { addonLineId: await towelLine(bookingId), refund: 'credit' })
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 95, ...goodwill })
      await db.query('UPDATE bookings SET price_paid = 0 WHERE id = $1', [bookingId])
      await call('refundBooking', { bookingId, refundMethod: 'card' })
      expect((await lines(bookingId)).map((line) => line.stamp)).toEqual([null])
    })
  })
})

describe('W05f: the order of a live booking, and Cancel & return credit', () => {
  it('a part refund to store credit, and a cheaper move to store credit, each leave the order part refunded (nothing on the line says so)', async () => {
    await withBooking(noPromoOnCard, async ({ call, bookingId, orderId }) => {
      await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 30, ...goodwill })
      expect(await status(orderId)).toBe('partially_refunded')
      expect((await lines(bookingId)).map((line) => [line.card, line.stamp])).toEqual([['0', null]])
    })
    await withBooking(
      { booking: { ...privateSeats, sessionId: ID.peakPrivateSession }, payment: card },
      async ({ call, bookingId, orderId }) => {
        await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession })
        await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession, confirmed: true, refundMethod: 'credit' })
        expect(await status(orderId)).toBe('partially_refunded')
      },
      sessionsToMoveBetween
    )
  })

  it.each(['card', 'credit'] as const)('a credit booking whose paid guest seat was all part refunded to %s, then Cancel & return credit: the line stamped by how, the order refunded', async (refundMethod) => {
    await withBooking(creditAndPaidSeat, async ({ call, bookingId, orderId }) => {
      await call('refundBooking', { bookingId, refundMethod, amount: 20, ...goodwill })
      await call('cancelCreditBooking', { bookingId })
      expect((await lines(bookingId)).map((line) => line.stamp)).toEqual([refundMethod])
      expect(await status(orderId)).toBe('refunded')
    })
  })

  it('…and with the guest\'s money never given back, or no money at all: no stamp, the order stays paid', async () => {
    await withBooking(creditAndPaidSeat, async ({ call, bookingId, orderId }) => {
      await db.query('UPDATE bookings SET price_paid = 0 WHERE id = $1', [bookingId])
      await call('cancelCreditBooking', { bookingId })
      expect((await lines(bookingId)).map((line) => line.stamp)).toEqual([null])
      expect(await status(orderId)).toBe('paid')
    })
    await withBooking({ customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} }, async ({ call, bookingId, orderId }) => {
      await call('cancelCreditBooking', { bookingId })
      expect((await lines(bookingId)).map((line) => line.stamp)).toEqual([null])
      expect(await status(orderId)).toBe('paid')
    })
  })
})

describe("W05g: where the money left came from (the Part refund dialog's figures)", () => {
  it('£70 card, £20 gift card, £10 store credit: each way shown, adding up to what is left; a part refund to the card comes off the card alone', async () => {
    const order = { booking: privateSeats, payment: { ...card, giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } } }
    await withBooking(order, async ({ call, bookingId }) => {
      expect(await figures(bookingId)).toMatchObject({ left: 100, cardLeft: 70, parts: { card: 70, giftCard: 20, storeCredit: 10, cash: 0 } })
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 50, ...goodwill })
      expect(await figures(bookingId)).toMatchObject({ left: 50, cardLeft: 20, parts: { card: 20, giftCard: 20, storeCredit: 10, cash: 0 } })
    })
  })

  it('cash and a gift card: no card money, and a gift card with no order (a Settle, a Move: Q36) counts as gift card money, not cash (W05l later 1)', async () => {
    await withBooking({ booking: privateSeats, payment: { ...cash(75), giftCard: { giftCardId: ID.giftCard, amount: 25 } } }, async ({ bookingId }) => {
      expect(await figures(bookingId)).toMatchObject({ left: 100, cardLeft: 0, parts: { card: 0, giftCard: 25, storeCredit: 0, cash: 75 } })
      await db.query('UPDATE gift_card_redemptions SET order_id = NULL, booking_id = $1', [bookingId])
      expect(await figures(bookingId)).toMatchObject({ parts: { card: 0, giftCard: 25, storeCredit: 0, cash: 75 } })
    })
  })

  it("only store credit the order used counts (W05i finding 8): a refund or a manual adjustment linked to the order changes neither the card figure nor the parts", async () => {
    await withBooking({ booking: privateSeats, payment: { ...card, storeCredit: { amount: 10 } } }, async ({ bookingId, orderId }) => {
      const before = await figures(bookingId)
      expect(before).toMatchObject({ left: 100, cardLeft: 90, parts: { card: 90, storeCredit: 10 } })
      for (const [reason, amount] of [['refund', '10.00'], ['manual_adjustment', '-25.00']] as const) {
        await insert(db, 'store_credit_transactions', { customer_id: ID.customer, amount, balance_after: '0.00', reason, order_id: orderId, booking_id: bookingId })
      }
      expect(await figures(bookingId)).toMatchObject({ left: 100, cardLeft: 90, parts: { card: 90, giftCard: 0, storeCredit: 10, cash: 0 } })
    })
    // With cash beside it, so a wrong store credit figure would show as less cash.
    await withBooking({ booking: privateSeats, payment: { ...cash(80), storeCredit: { amount: 20 } } }, async ({ bookingId, orderId }) => {
      expect(await figures(bookingId)).toMatchObject({ left: 100, parts: { card: 0, giftCard: 0, storeCredit: 20, cash: 80 } })
      for (const [reason, amount] of [['refund', '10.00'], ['manual_adjustment', '-25.00']] as const) {
        await insert(db, 'store_credit_transactions', { customer_id: ID.customer, amount, balance_after: '0.00', reason, order_id: orderId, booking_id: bookingId })
      }
      expect(await figures(bookingId)).toMatchObject({ left: 100, parts: { card: 0, giftCard: 0, storeCredit: 20, cash: 80 } })
    })
  })
})

describe('W05f, W05g, W05h: no refund of any kind while a payment is still being taken on the booking', () => {
  it('a guest still on the reader (their £20 already in price_paid): Part refund, Refund the rest and It already arrived are refused with the reader words and nothing moves; once it is cancelled the part refund goes', async () => {
    await withBooking(publicOnCard, async (steps) => {
      const { call, attempt, bookingId } = steps
      const started = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string } }
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00' })
      const presses = [
        { amount: 10, refundMethod: 'card', ...goodwill },
        { refundOwed: true, amount: 10, refundMethod: 'credit' },
        { owedArrived: true, amount: 10, ...goodwill },
      ]
      for (const press of presses) expect(JSON.stringify(await attempt('refundBooking', { bookingId, ...press })), JSON.stringify(press)).toContain(READER_PAYMENT_OPEN_MESSAGE)
      expect(cardBack(steps)).toEqual([])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', part_refunded_amount: '0.00' })
      await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment.pendingId })
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, ...goodwill })
      expect(cardBack(steps)).toEqual([1000])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00', part_refunded_amount: '10.00' })
    })
  })
})

describe('W05g: the part refund\'s reason', () => {
  it('200 characters are enough, counted after trimming, and kept whole on its row', async () => {
    await withBooking(noPromoOnCard, async ({ call, bookingId }) => {
      const reason = 'x'.repeat(200)
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, reason: `  ${reason}  ` })
      const rows = await db.query<{ details: { reason: string } }>("SELECT details FROM audit_log WHERE action = 'booking.part_refund' AND entity_id = $1 ORDER BY at, ctid", [bookingId])
      expect(rows.map((row) => row.details.reason)).toEqual([reason])
    })
  })
})

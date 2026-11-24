import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET as figuresRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refund-figures/route'
import type { Db } from '@/server/db'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { bea, ID, laterPublicSession, memberCredit, mo, noPromoOnCard, paidSeat, PROMO, sam, seed, sessionsToMoveBetween, settle, tieredPrivatePrices } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { insert } from '@/server/rules/testing/database'
import { reconcile } from '@/server/rules/orders/reconcile'
import { fakeStripeErrors } from '@/server/stripe/fake'
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

// Brief W70b item 1 (the step H QA run's QA1 and QA4): what a gift card and store credit count for is what they paid of
// the booking's seats, order by order, as the card's is; what they paid for an add-on or a product is not seat money.
// Until then an order's whole store credit and gift card counted, so a guest's cash read as less than they paid.
describe('W70b (QA1, QA4): only the gift card and store credit that paid for seats count, so the cash left is right', () => {
  const guestInCash = (bookingId: string) => ({ bookingId, ...bea, payment: cash(20) })
  const twoSeats = paidSeat([sam, alex])
  const withTowel = { ...twoSeats, addons: [towel] }
  const soap = { products: [{ productVariantId: ID.variant, quantity: 1 }] }
  const gift = (amount: number) => ({ giftCard: { giftCardId: ID.giftCard, amount } })
  const storeCredit = (amount: number) => ({ storeCredit: { amount } })
  /** £100 of store credit and £100 on the gift card, so any part of the order can be paid either way. */
  const plenty = async (seedDb: Db): Promise<void> => {
    await laterPublicSession(seedDb)
    await seedDb.query("UPDATE customers SET store_credit_balance = 100 WHERE id = $1", [ID.customer])
    await seedDb.query("UPDATE gift_cards SET original_value = 100, remaining_balance = 100 WHERE id = $1", [ID.giftCard])
  }
  /** The booking's figures: the parts, what they add up to and the cash a Part refund can hand back. */
  const money = async (bookingId: string) => {
    const shown = (await figures(bookingId)) as { pricePaid: number; refundOwed: number; left: number; cashLeft: number; paidWords: string; paidLine: string; parts: { card: number; giftCard: number; storeCredit: number; cash: number } }
    const { parts } = shown
    // Always: the parts add up to what is left, which is the price paid less what is owed, and the two lines name that.
    expect(Math.round((parts.card + parts.giftCard + parts.storeCredit + parts.cash) * 100) / 100).toBe(shown.left)
    expect(shown.left).toBe(Math.round((Number((await booking(bookingId))?.price_paid) - shown.refundOwed) * 100) / 100)
    const said = [...shown.paidWords.matchAll(/£([\d.]+)/g)].reduce((total, match) => total + Number(match[1]), 0)
    expect(said).toBe(shown.left)
    return shown
  }

  it("the QA run's booking: seats £40 and a £5 add-on on store credit, a guest's £20 in cash: £40 and £20, so £20 of cash can be handed back, then £15 after £5 of it; the paid line matches the price paid after the part refund and after the guest goes", async () => {
    await withBooking(
      { booking: withTowel, payment: storeCredit(45) },
      async (steps) => {
        const { call, attempt, bookingId } = steps
        expect(await money(bookingId)).toMatchObject({ pricePaid: 40, parts: { card: 0, giftCard: 0, storeCredit: 40, cash: 0 }, cashLeft: 0 })
        const added = (await call('addBookingGuest', guestInCash(bookingId))) as { guest: { id: string } }
        const whole = { pricePaid: 60, parts: { card: 0, giftCard: 0, storeCredit: 40, cash: 20 }, cashLeft: 20, paidWords: 'Paid £40.00 by gift card / store credit and £20.00 in cash.', paidLine: 'Left to refund: £40.00 gift card / store credit and £20.00 cash.' }
        expect(await money(bookingId)).toMatchObject(whole)
        // A same-price Move changes nothing.
        await call('moveBooking', { bookingId, newSessionId: ID.laterPublicSession })
        await call('moveBooking', { bookingId, newSessionId: ID.laterPublicSession, confirmed: true })
        expect(await money(bookingId)).toMatchObject(whole)

        expect(JSON.stringify(await attempt('refundBooking', { bookingId, refundMethod: 'cash', amount: 20.01, ...goodwill }))).toContain('Only £20.00 of cash')
        await call('refundBooking', { bookingId, refundMethod: 'cash', amount: 5, ...goodwill })
        expect(await money(bookingId)).toMatchObject({ pricePaid: 55, parts: { card: 0, giftCard: 0, storeCredit: 40, cash: 15 }, cashLeft: 15, paidWords: 'Paid £40.00 by gift card / store credit and £15.00 in cash.' })
        expect(JSON.stringify(await attempt('refundBooking', { bookingId, refundMethod: 'cash', amount: 15.01, ...goodwill }))).toContain('Only £15.00 of cash')

        await call('removeBookingGuest', { guestId: added.guest.id, confirmedRefundAmount: 20, refundMethod: 'credit' })
        // W70c (Q63), a named difference: the £20 to store credit comes off the store credit part (it read £35 and no cash).
        expect(await money(bookingId)).toMatchObject({ pricePaid: 35, parts: { card: 0, giftCard: 0, storeCredit: 20, cash: 15 }, cashLeft: 15, paidWords: 'Paid £20.00 by gift card / store credit and £15.00 in cash.' })
        // Cancel & Refund: the £35 and the add-on's £5, to store credit.
        await call('refundBooking', { bookingId, refundMethod: 'credit', addonLineIds: [await towelLine(bookingId)] })
        expect((await credit()).reduce((total, amount) => total + Number(amount), 0)).toBe(60)
      },
      plenty
    )
  })

  it("all £20 of the guest's cash can be handed back in one press, and no more", async () => {
    await withBooking(
      { booking: withTowel, payment: storeCredit(45) },
      async ({ call, attempt, bookingId }) => {
        await call('addBookingGuest', guestInCash(bookingId))
        await call('refundBooking', { bookingId, refundMethod: 'cash', amount: 20, ...goodwill })
        expect(await money(bookingId)).toMatchObject({ pricePaid: 40, parts: { storeCredit: 40, cash: 0 }, cashLeft: 0 })
        expect(JSON.stringify(await attempt('refundBooking', { bookingId, refundMethod: 'cash', amount: 1, ...goodwill }))).toContain('No cash')
      },
      plenty
    )
  })

  it.each([
    ['a gift card, seats and an add-on', { booking: withTowel, payment: gift(45) }, { card: 0, giftCard: 40, storeCredit: 0, cash: 20 }],
    ['a gift card and store credit, seats and an add-on (the gift card first, as the order took it on the seats)', { booking: withTowel, payment: { ...gift(25), ...storeCredit(20) } }, { card: 0, giftCard: 25, storeCredit: 15, cash: 20 }],
    ['store credit, seats and a product', { booking: twoSeats, ...soap, payment: storeCredit(52) }, { card: 0, giftCard: 0, storeCredit: 40, cash: 20 }],
    ['a gift card, seats, an add-on and a product', { booking: withTowel, ...soap, payment: gift(57) }, { card: 0, giftCard: 40, storeCredit: 0, cash: 20 }],
    ['the card and store credit, seats and an add-on: the card is seat money first, as it is refunded', { booking: withTowel, payment: { ...card, ...storeCredit(25) } }, { card: 20, giftCard: 0, storeCredit: 20, cash: 20 }],
    ['the card and a gift card, seats and a product', { booking: twoSeats, ...soap, payment: { ...card, ...gift(32) } }, { card: 20, giftCard: 20, storeCredit: 0, cash: 20 }],
    ['store credit and cash, seats and an add-on', { booking: withTowel, payment: { ...cash(15), ...storeCredit(30) } }, { card: 0, giftCard: 0, storeCredit: 30, cash: 30 }],
    ['a promo on the order: the seats are £36', { booking: withTowel, promoCode: PROMO.percent, payment: storeCredit(41) }, { card: 0, giftCard: 0, storeCredit: 36, cash: 20 }],
    ['nothing else on the order: as before', { booking: twoSeats, payment: storeCredit(40) }, { card: 0, giftCard: 0, storeCredit: 40, cash: 20 }],
  ] as const)("%s; and a guest's £20 in cash", async (name, order, parts) => {
    await withBooking(
      order,
      async ({ call, bookingId }) => {
        await call('addBookingGuest', guestInCash(bookingId))
        // W70e (Q26 amended), a named difference on one row: an order paid £15 in cash and £30 store credit for seats £40
        // and a £5 add-on. The parts read £10 of that cash as seat money (store credit pays the seats first), so with the
        // guest's £20 it read £30 to hand back; the cash paid on the booking is £35, and that is the bound now.
        const cashLeft = name === 'store credit and cash, seats and an add-on' ? 35 : parts.cash
        expect(await money(bookingId)).toMatchObject({ parts, cashLeft })
      },
      plenty
    )
  })

  it("an add-on's card money given back leaves less card for the seats, and more of the store credit: still all of it", async () => {
    await withBooking(
      { booking: withTowel, payment: { ...card, ...storeCredit(25) } },
      async ({ call, bookingId }) => {
        await call('addBookingGuest', guestInCash(bookingId))
        await call('removeBookingAddon', { addonLineId: await towelLine(bookingId), refund: 'card' })
        expect(await money(bookingId)).toMatchObject({ cardLeft: 15, parts: { card: 15, giftCard: 0, storeCredit: 25, cash: 20 }, cashLeft: 20 })
      },
      plenty
    )
  })

  it('two lines of the booking on one order share its store credit once', async () => {
    await withBooking(
      { booking: withTowel, payment: storeCredit(45) },
      async ({ call, bookingId, orderId }) => {
        await call('addBookingGuest', guestInCash(bookingId))
        // Test data: the order's £40 (£45 with the towel inside, as New Order writes it) on two lines.
        await db.query("UPDATE order_line_items SET line_total = line_total - 15, unit_price = unit_price - 15 WHERE order_id = $1 AND item_type = 'booking'", [orderId])
        await insert(db, 'order_line_items', { order_id: orderId, item_type: 'booking', quantity: 1, unit_price: '15.00', line_total: '15.00', booking_id: bookingId })
        expect(await money(bookingId)).toMatchObject({ parts: { storeCredit: 40, cash: 20 }, cashLeft: 20 })
      },
      plenty
    )
  })

  it('seats paid in cash, an add-on added on its own with store credit: no seat money was store credit', async () => {
    await withBooking(
      { booking: twoSeats, payment: cash(40) },
      async ({ call, bookingId }) => {
        await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: storeCredit(5) })
        expect(await towelLine(bookingId)).toBeDefined()
        expect(await money(bookingId)).toMatchObject({ pricePaid: 40, parts: { card: 0, giftCard: 0, storeCredit: 0, cash: 40 }, cashLeft: 40 })
      },
      plenty
    )
  })

  it.each([
    ['a gift card', gift(20), { card: 0, giftCard: 20, storeCredit: 0, cash: 40 }],
    ['store credit', storeCredit(20), { card: 0, giftCard: 0, storeCredit: 20, cash: 40 }],
  ] as const)("seats paid in cash, a guest's £20 by %s: counted once, on the guest's own order", async (_name, other, parts) => {
    await withBooking(
      { booking: twoSeats, payment: cash(40) },
      async ({ call, bookingId }) => {
        await call('addBookingGuest', { bookingId, ...bea, payment: other })
        expect(await money(bookingId)).toMatchObject({ pricePaid: 60, parts, cashLeft: 40 })
      },
      plenty
    )
  })

  it('an add-on on a credit took none of the store credit', async () => {
    await withBooking(
      { booking: twoSeats, payment: cash(40) },
      async ({ call, bookingId }) => {
        await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { ...card, ...storeCredit(22) } })
        expect(await money(bookingId)).toMatchObject({ parts: { storeCredit: 20, cash: 40 } })
        // Test data: the £5 add-on on a membership credit instead, so the £3 card and all of the store credit was the rest's.
        await db.query("UPDATE addon_order_lines SET redemption_source = 'membership_credit' WHERE booking_id = $1", [bookingId])
        expect(await money(bookingId)).toMatchObject({ parts: { storeCredit: 22, cash: 38 } })
      },
      plenty
    )
  })

  // The order of a card Add Guest holds only its card money, so its store credit and gift card are on the booking with
  // no order. The card pays the add-ons first; what it doesn't reach of them came from the other two.
  it.each([
    ['an add-on alone, £2 of it on the card, £3 store credit', {}, storeCredit(3), { card: 0, giftCard: 0, storeCredit: 0, cash: 40 }],
    ['an add-on alone, £2 of it on the card, £3 gift card', {}, gift(3), { card: 0, giftCard: 0, storeCredit: 0, cash: 40 }],
    ['a guest and an add-on (£25), £3 on the card, £22 store credit', bea, storeCredit(22), { card: 0, giftCard: 0, storeCredit: 20, cash: 40 }],
    ['a guest and an add-on (£25), £2 on the card, £2 gift card, £21 store credit: the add-on takes the gift card and £1', bea, { ...gift(2), ...storeCredit(21) }, { card: 0, giftCard: 0, storeCredit: 20, cash: 40 }],
    ['a guest and an add-on (£25), £15 on the card, £10 store credit: the add-on is all on the card', bea, storeCredit(10), { card: 10, giftCard: 0, storeCredit: 10, cash: 40 }],
  ] as const)('seats paid in cash, then %s', async (_name, guest, other, parts) => {
    await withBooking(
      { booking: twoSeats, payment: cash(40) },
      async ({ call, bookingId }) => {
        await call('addBookingGuest', { bookingId, ...guest, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { ...card, ...other } })
        expect(await towelLine(bookingId)).toBeDefined()
        expect(await money(bookingId)).toMatchObject({ parts, cashLeft: parts.cash })
      },
      plenty
    )
  })

  it('a dearer Move paid with store credit (no order) is seat money; a reader guest cancelled puts theirs back, and counts for nothing', async () => {
    await withBooking(
      { booking: twoSeats, payment: cash(40) },
      async ({ call, bookingId }) => {
        await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
        await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: storeCredit(11) })
        expect(await money(bookingId)).toMatchObject({ pricePaid: 51, parts: { card: 0, giftCard: 0, storeCredit: 11, cash: 40 }, cashLeft: 40 })
        const started = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'reader', ...storeCredit(5) } })) as { pendingReaderPayment: { pendingId: string } }
        await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment.pendingId })
        expect(await money(bookingId)).toMatchObject({ pricePaid: 51, parts: { card: 0, giftCard: 0, storeCredit: 11, cash: 40 }, cashLeft: 40 })
      },
      plenty
    )
  })

  it("store credit put back on an order no longer counts as the order's", async () => {
    await withBooking(
      { booking: withTowel, payment: { ...cash(15), ...storeCredit(30) } },
      async ({ bookingId, orderId }) => {
        // Test data: no route puts part of an order's store credit back and keeps the order.
        await insert(db, 'store_credit_transactions', { customer_id: ID.customer, amount: '10.00', balance_after: '0.00', reason: 'redemption_reversal', order_id: orderId })
        expect(await money(bookingId)).toMatchObject({ parts: { storeCredit: 20, cash: 20 } })
      },
      plenty
    )
  })

  // Brief W70c item 1 (Wayne's Q63, 23 Nov): money given back as store credit comes off the store credit part first, then
  // the gift card, so the cash paid stays available to hand back as cash. Never more cash out than cash in (Q26, Q42).
  describe('W70c (Q63): money given back as store credit comes off the store credit part first, then the gift card, so the cash stays', () => {
    const cy = { guestName: 'Cy Guest', guestEmail: 'cy@example.com', guestsOver18Confirmed: true }
    const added = async (steps: Steps, who: typeof cy, payment: Record<string, unknown>): Promise<string> =>
      ((await steps.call('addBookingGuest', { bookingId: steps.bookingId, ...who, payment })) as { guest: { id: string } }).guest.id
    const toCredit = (bookingId: string, amount: number) => ({ bookingId, refundMethod: 'credit', amount, ...goodwill })
    /** Two seats (£40) and the towel on store credit; with Bea's £20 in cash, the QA run's booking. */
    const qaBooking = { booking: withTowel, payment: storeCredit(45) }
    /** A card refund that never reaches Stripe, settled by reconcile past its window: its money ends owed on the booking. */
    async function neverArrives({ stripe }: Steps, press: () => Promise<unknown>): Promise<void> {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      await press()
      vi.setSystemTime(Date.now() + 16 * 60_000)
      await reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
    }

    it("seats £40 in cash and a guest's £20 on store credit: the guest removed to store credit leaves £40 cash, all of it to hand back, and no more", async () => {
      await withBooking(
        { booking: twoSeats, payment: cash(40) },
        async (steps) => {
          const { call, attempt, bookingId } = steps
          const guest = await added(steps, bea, storeCredit(20))
          expect(await money(bookingId)).toMatchObject({ pricePaid: 60, parts: { card: 0, giftCard: 0, storeCredit: 20, cash: 40 }, cashLeft: 40 })
          await call('removeBookingGuest', { guestId: guest, confirmedRefundAmount: 20, refundMethod: 'credit' })
          expect(await money(bookingId)).toMatchObject({ pricePaid: 40, parts: { card: 0, giftCard: 0, storeCredit: 0, cash: 40 }, cashLeft: 40, paidWords: 'Paid £40.00 in cash.' })
          await call('refundBooking', { bookingId, refundMethod: 'cash', amount: 40, ...goodwill })
          expect(await money(bookingId)).toMatchObject({ pricePaid: 0, parts: { storeCredit: 0, cash: 0 }, cashLeft: 0 })
          expect(JSON.stringify(await attempt('refundBooking', { bookingId, refundMethod: 'cash', amount: 1, ...goodwill }))).toContain('nothing left')
        },
        plenty
      )
    })

    it("the QA run's booking, £20 part refunded to store credit: £20 store credit and £20 cash, so £20 of cash can be handed back (£20.01 is refused); then no cash is left, whatever store credit is", async () => {
      await withBooking(
        qaBooking,
        async (steps) => {
          const { call, attempt, bookingId } = steps
          await added(steps, bea, cash(20))
          await call('refundBooking', toCredit(bookingId, 20))
          expect(await money(bookingId)).toMatchObject({
            pricePaid: 40,
            parts: { card: 0, giftCard: 0, storeCredit: 20, cash: 20 },
            cashLeft: 20,
            paidLine: 'Left to refund: £20.00 gift card / store credit and £20.00 cash.',
          })
          expect(JSON.stringify(await attempt('refundBooking', { bookingId, refundMethod: 'cash', amount: 20.01, ...goodwill }))).toContain('Only £20.00 of cash')
          await call('refundBooking', { bookingId, refundMethod: 'cash', amount: 20, ...goodwill })
          expect(await money(bookingId)).toMatchObject({ pricePaid: 20, parts: { storeCredit: 20, cash: 0 }, cashLeft: 0 })
          expect(JSON.stringify(await attempt('refundBooking', { bookingId, refundMethod: 'cash', amount: 1, ...goodwill }))).toContain('No cash')
        },
        plenty
      )
    })

    it.each([
      ['£10: off the store credit alone', 10, { card: 0, giftCard: 25, storeCredit: 5, cash: 20 }],
      ['£15: all of the store credit', 15, { card: 0, giftCard: 25, storeCredit: 0, cash: 20 }],
      ['£30: the store credit, then £15 of the gift card', 30, { card: 0, giftCard: 10, storeCredit: 0, cash: 20 }],
      ['£40: both, and the cash is whole', 40, { card: 0, giftCard: 0, storeCredit: 0, cash: 20 }],
      ['£45: both, and £5 of the cash', 45, { card: 0, giftCard: 0, storeCredit: 0, cash: 15 }],
    ] as const)("seats £25 gift card and £15 store credit, a guest's £20 in cash, part refunded to store credit %s", async (_name, amount, parts) => {
      await withBooking(
        { booking: twoSeats, payment: { ...gift(25), ...storeCredit(15) } },
        async (steps) => {
          await added(steps, bea, cash(20))
          await steps.call('refundBooking', toCredit(steps.bookingId, amount))
          expect(await money(steps.bookingId)).toMatchObject({ pricePaid: 60 - amount, parts, cashLeft: parts.cash })
        },
        plenty
      )
    })

    it('two refunds to store credit are counted together, with cash handed back between them: cash out never passes cash in', async () => {
      await withBooking(
        qaBooking,
        async (steps) => {
          const { call, attempt, bookingId } = steps
          await added(steps, bea, cash(20))
          await call('refundBooking', toCredit(bookingId, 25))
          expect(await money(bookingId)).toMatchObject({ pricePaid: 35, parts: { storeCredit: 15, cash: 20 }, cashLeft: 20 })
          await call('refundBooking', { bookingId, refundMethod: 'cash', amount: 8, ...goodwill })
          expect(await money(bookingId)).toMatchObject({ pricePaid: 27, parts: { storeCredit: 15, cash: 12 }, cashLeft: 12 })
          await call('refundBooking', toCredit(bookingId, 20))
          expect(await money(bookingId)).toMatchObject({ pricePaid: 7, parts: { storeCredit: 0, cash: 7 }, cashLeft: 7 })
          expect(JSON.stringify(await attempt('refundBooking', { bookingId, refundMethod: 'cash', amount: 7.01, ...goodwill }))).toContain('£7.00')
          await call('refundBooking', { bookingId, refundMethod: 'cash', amount: 7, ...goodwill })
          expect(await money(bookingId)).toMatchObject({ pricePaid: 0, cashLeft: 0 })
        },
        plenty
      )
    })

    it("the card's part is as before: card, store credit and cash, part refunded to store credit", async () => {
      await withBooking(
        { booking: twoSeats, payment: { ...card, ...storeCredit(15) } },
        async (steps) => {
          await added(steps, bea, cash(20))
          expect(await money(steps.bookingId)).toMatchObject({ parts: { card: 25, giftCard: 0, storeCredit: 15, cash: 20 }, cashLeft: 20 })
          await steps.call('refundBooking', toCredit(steps.bookingId, 10))
          expect(await money(steps.bookingId)).toMatchObject({ cardLeft: 25, parts: { card: 25, giftCard: 0, storeCredit: 5, cash: 20 }, cashLeft: 20 })
          await steps.call('refundBooking', toCredit(steps.bookingId, 10))
          // W70e (Q26 amended), a named difference: all £20 of the cash paid can still be handed back (it read £15, the cash part).
          expect(await money(steps.bookingId)).toMatchObject({ cardLeft: 25, parts: { card: 25, giftCard: 0, storeCredit: 0, cash: 15 }, cashLeft: 20 })
        },
        plenty
      )
    })

    it("Remove Guest to the card, of which the card can take only part: the rest, given as store credit, comes off the store credit part", async () => {
      await withBooking(
        { booking: twoSeats, payment: { ...card, ...storeCredit(30) } },
        async (steps) => {
          const guest = await added(steps, bea, cash(20))
          expect(await money(steps.bookingId)).toMatchObject({ pricePaid: 60, parts: { card: 10, giftCard: 0, storeCredit: 30, cash: 20 }, cashLeft: 20 })
          const answer = (await steps.call('removeBookingGuest', { guestId: guest, confirmedRefundAmount: 20, refundMethod: 'card' })) as Record<string, unknown>
          expect(answer).toMatchObject({ cardRefundedAmount: 10, storeCreditRefundedAmount: 10 })
          expect(await money(steps.bookingId)).toMatchObject({ pricePaid: 40, parts: { card: 0, giftCard: 0, storeCredit: 20, cash: 20 }, cashLeft: 20 })
        },
        plenty
      )
    })

    it("a cheaper Move's refund to store credit: seats £51 on store credit and a guest's £25.50 in cash, moved to £20 seats", async () => {
      await withBooking(
        { booking: { ...twoSeats, sessionId: ID.peakSession }, payment: storeCredit(51) },
        async (steps) => {
          const { call, bookingId } = steps
          await added(steps, bea, cash(25.5))
          expect(await money(bookingId)).toMatchObject({ pricePaid: 76.5, parts: { storeCredit: 51, cash: 25.5 }, cashLeft: 25.5 })
          await call('moveBooking', { bookingId, newSessionId: ID.laterPublicSession })
          await call('moveBooking', { bookingId, newSessionId: ID.laterPublicSession, confirmed: true, refundMethod: 'credit' })
          expect(await money(bookingId)).toMatchObject({ pricePaid: 60, parts: { card: 0, giftCard: 0, storeCredit: 34.5, cash: 25.5 }, cashLeft: 25.5 })
        },
        plenty
      )
    })

    it("Refund the rest to store credit: a card guest's £20 that never reached the card, given as store credit, comes off the store credit part", async () => {
      await withBooking(
        { booking: twoSeats, payment: cash(40) },
        async (steps) => {
          const { call, bookingId } = steps
          await added(steps, cy, storeCredit(20))
          const guest = await added(steps, bea, card)
          expect(await money(bookingId)).toMatchObject({ pricePaid: 80, parts: { card: 20, storeCredit: 20, cash: 40 }, cashLeft: 40 })
          await neverArrives(steps, () => call('removeBookingGuest', { guestId: guest, confirmedRefundAmount: 20, refundMethod: 'card' }))
          expect(await money(bookingId)).toMatchObject({ pricePaid: 80, refundOwed: 20, left: 60 })
          await call('refundBooking', { bookingId, refundOwed: true, refundMethod: 'credit', amount: 20 })
          expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, parts: { card: 20, giftCard: 0, storeCredit: 0, cash: 40 }, cashLeft: 40 })
        },
        plenty
      )
    })

    it("an add-on's money given as store credit is not seat money: by Remove add-on, and by Refund the rest after its card refund never arrived; with a seat's £20 owed beside it, only that £20 counts", async () => {
      await withBooking(
        qaBooking,
        async (steps) => {
          const { call, bookingId } = steps
          const before = { parts: { card: 0, giftCard: 0, storeCredit: 40, cash: 20 }, cashLeft: 20 }
          await added(steps, bea, cash(20))
          await call('removeBookingAddon', { addonLineId: await towelLine(bookingId), refund: 'credit' })
          expect(await money(bookingId)).toMatchObject({ pricePaid: 60, ...before })
          // A second towel on the card, its refund owed, then given as store credit.
          await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: card })
          const second = (await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1 AND removed_at IS NULL', [bookingId]))[0]?.id
          await neverArrives(steps, () => call('removeBookingAddon', { addonLineId: second, refund: 'card' }))
          expect(await money(bookingId)).toMatchObject({ pricePaid: 65, refundOwed: 5, ...before })
          await call('refundBooking', { bookingId, refundOwed: true, refundMethod: 'credit', amount: 5 })
          expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, ...before })
          // A third, and a card guest's £20, both owed: £25 given together, £20 of it seat money.
          await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: card })
          const third = (await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1 AND removed_at IS NULL', [bookingId]))[0]?.id
          const guest = await added(steps, cy, card)
          await neverArrives(steps, () => call('removeBookingAddon', { addonLineId: third, refund: 'card' }))
          await neverArrives(steps, () => call('removeBookingGuest', { guestId: guest, confirmedRefundAmount: 20, refundMethod: 'card' }))
          // W70d: while it is owed, the seat's £20 is off the store credit already; the third towel's £5 is not, and the
          // two towels removed before (one to store credit, one owed and since given) are short of nothing.
          expect(await money(bookingId)).toMatchObject({ pricePaid: 85, refundOwed: 25, left: 60, parts: { card: 20, giftCard: 0, storeCredit: 20, cash: 20 }, cashLeft: 20 })
          await call('refundBooking', { bookingId, refundOwed: true, refundMethod: 'credit', amount: 25 })
          expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, parts: { card: 20, giftCard: 0, storeCredit: 20, cash: 20 }, cashLeft: 20 })
        },
        plenty
      )
    })

    it("another booking's refunds to store credit, a seat's and an add-on's, change nothing on this one", async () => {
      await withBooking(
        qaBooking,
        async (steps) => {
          const { call, bookingId } = steps
          await added(steps, bea, cash(20))
          const guest = await added(steps, cy, card)
          await neverArrives(steps, () => call('removeBookingGuest', { guestId: guest, confirmedRefundAmount: 20, refundMethod: 'card' }))
          await call('refundBooking', { bookingId, refundOwed: true, refundMethod: 'credit', amount: 20 })
          const before = { pricePaid: 60, parts: { card: 20, giftCard: 0, storeCredit: 20, cash: 20 }, cashLeft: 20 }
          expect(await money(bookingId)).toMatchObject(before)
          const other = (await call('createOrder', { customerId: ID.customer, booking: { ...withTowel, sessionId: ID.laterPublicSession }, payment: storeCredit(45) })) as { bookingId: string }
          await call('refundBooking', toCredit(other.bookingId, 10))
          await call('removeBookingAddon', { addonLineId: await towelLine(other.bookingId), refund: 'credit' })
          expect(await money(other.bookingId)).toMatchObject({ pricePaid: 30, parts: { storeCredit: 30, cash: 0 } })
          expect(await money(bookingId)).toMatchObject(before)
        },
        plenty
      )
    })

    it('a refund Stripe refused, put back, has given nothing', async () => {
      await withBooking(
        { booking: twoSeats, payment: storeCredit(40) },
        async (steps) => {
          const { stripe, attempt, bookingId } = steps
          const guest = await added(steps, cy, card)
          await added(steps, bea, cash(20))
          const before = { pricePaid: 80, parts: { card: 20, giftCard: 0, storeCredit: 40, cash: 20 }, cashLeft: 20 }
          expect(await money(bookingId)).toMatchObject(before)
          stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge has been charged back.') })
          await attempt('removeBookingGuest', { guestId: guest, confirmedRefundAmount: 20, refundMethod: 'card' })
          expect(await money(bookingId)).toMatchObject(before)
        },
        plenty
      )
    })

    it("a cancelled booking keeps its price paid, so its figures stay as they were: the cancel's own store credit (seats and a ticked add-on) is not taken off, nor is Refund the rest after it", async () => {
      // A part refund first, then Cancel & Refund of everything to store credit.
      await withBooking(
        qaBooking,
        async (steps) => {
          const { call, bookingId } = steps
          await added(steps, bea, cash(20))
          await call('refundBooking', toCredit(bookingId, 20))
          const before = { pricePaid: 40, parts: { card: 0, giftCard: 0, storeCredit: 20, cash: 20 } }
          expect(await money(bookingId)).toMatchObject(before)
          await call('refundBooking', { bookingId, refundMethod: 'credit', addonLineIds: [await towelLine(bookingId)] })
          expect(await booking(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '40.00' })
          expect(await money(bookingId)).toMatchObject(before)
        },
        plenty
      )
      // Refund the rest before the cancel counts after it too, with a ticked add-on's store credit beside it.
      await withBooking(
        qaBooking,
        async (steps) => {
          const { call, bookingId } = steps
          await added(steps, bea, cash(20))
          const guest = await added(steps, cy, card)
          await neverArrives(steps, () => call('removeBookingGuest', { guestId: guest, confirmedRefundAmount: 20, refundMethod: 'card' }))
          await call('refundBooking', { bookingId, refundOwed: true, refundMethod: 'credit', amount: 20 })
          const before = { pricePaid: 60, parts: { card: 20, giftCard: 0, storeCredit: 20, cash: 20 } }
          expect(await money(bookingId)).toMatchObject(before)
          await call('refundBooking', { bookingId, refundMethod: 'credit', addonLineIds: [await towelLine(bookingId)] })
          expect(await booking(bookingId)).toMatchObject({ status: 'cancelled' })
          expect(await money(bookingId)).toMatchObject(before)
        },
        plenty
      )
      // The cancel's card refund owed, then given as store credit on the cancelled booking.
      await withBooking(
        { booking: twoSeats, payment: storeCredit(40) },
        async (steps) => {
          const { call, bookingId } = steps
          await added(steps, cy, card)
          await added(steps, bea, cash(20))
          const before = { pricePaid: 80, parts: { card: 20, giftCard: 0, storeCredit: 40, cash: 20 } }
          expect(await money(bookingId)).toMatchObject(before)
          await neverArrives(steps, () => call('refundBooking', { bookingId, refundMethod: 'card' }))
          expect(await booking(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '80.00' })
          await call('refundBooking', { bookingId, refundOwed: true, refundMethod: 'credit', amount: 20 })
          expect(await money(bookingId)).toMatchObject({ refundOwed: 0, ...before })
        },
        plenty
      )
    })

    // Brief W70d item 1 (W70c noticed 1): seat money that is owed (a card refund that never arrived, not yet given or
    // found) comes off the store credit part first too, then the gift card, so the cash that can be handed back is right
    // while it is owed. The add-ons' share of what is owed is not seat money. Never more cash out than cash in (Q26, Q42).
    describe('W70d: seat money owed comes off the store credit part first while it is owed, so the cash stays', () => {
      const toCard = (guestId: string) => ({ guestId, confirmedRefundAmount: 20, refundMethod: 'card' })
      const cashBack = (bookingId: string, amount: number) => ({ bookingId, refundMethod: 'cash', amount, ...goodwill })
      const restAsCredit = (bookingId: string, amount: number) => ({ bookingId, refundOwed: true, refundMethod: 'credit', amount })
      /** On seats paid £40 in cash: Cy's £20 on store credit and Bea's £20 on a card; Bea removed to the card, and the refund never arrives. */
      async function cardGuestOwed(steps: Steps): Promise<void> {
        await added(steps, cy, storeCredit(20))
        const guest = await added(steps, bea, card)
        expect(await money(steps.bookingId)).toMatchObject({ pricePaid: 80, parts: { card: 20, giftCard: 0, storeCredit: 20, cash: 40 }, cashLeft: 40 })
        await neverArrives(steps, () => steps.call('removeBookingGuest', toCard(guest)))
      }
      /** While the £20 is owed (it read £20 card, £20 store credit and £20 cash, and £20 of cash to hand back). */
      const owed = { pricePaid: 80, refundOwed: 20, left: 60, parts: { card: 20, giftCard: 0, storeCredit: 0, cash: 40 }, cashLeft: 40 }

      it("W70c's example: seats £40 in cash, a guest's £20 on store credit, a card guest's £20 owed: £40 of cash can be handed back (£40.01 is refused), and still £40 once Refund the rest has given the £20", async () => {
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, attempt, bookingId } = steps
            await cardGuestOwed(steps)
            expect(await money(bookingId)).toMatchObject(owed)
            expect(JSON.stringify(await attempt('refundBooking', cashBack(bookingId, 40.01)))).toContain('Only £40.00 of cash')
            await call('refundBooking', restAsCredit(bookingId, 20))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, left: 60, parts: owed.parts, cashLeft: 40 })
            expect(JSON.stringify(await attempt('refundBooking', cashBack(bookingId, 40.01)))).toContain('Only £40.00 of cash')
            await call('refundBooking', cashBack(bookingId, 40))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 20, parts: { card: 20, giftCard: 0, storeCredit: 0, cash: 0 }, cashLeft: 0 })
            expect(JSON.stringify(await attempt('refundBooking', cashBack(bookingId, 1)))).toContain('No cash')
          },
          plenty
        )
      })

      it('the cash handed back while the £20 is owed: £25, then the last £15, and no more, before or after it is settled: never more cash out than cash in', async () => {
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, attempt, bookingId } = steps
            await cardGuestOwed(steps)
            await call('refundBooking', cashBack(bookingId, 25))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 55, refundOwed: 20, left: 35, parts: { card: 20, giftCard: 0, storeCredit: 0, cash: 15 }, cashLeft: 15 })
            expect(JSON.stringify(await attempt('refundBooking', cashBack(bookingId, 15.01)))).toContain('Only £15.00 of cash')
            await call('refundBooking', cashBack(bookingId, 15))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 40, refundOwed: 20, left: 20, parts: { card: 20, giftCard: 0, storeCredit: 0, cash: 0 }, cashLeft: 0 })
            expect(JSON.stringify(await attempt('refundBooking', cashBack(bookingId, 1)))).toContain('No cash')
            await call('refundBooking', restAsCredit(bookingId, 20))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 20, refundOwed: 0, parts: { card: 20, giftCard: 0, storeCredit: 0, cash: 0 }, cashLeft: 0 })
            expect(JSON.stringify(await attempt('refundBooking', cashBack(bookingId, 1)))).toContain('No cash')
          },
          plenty
        )
      })

      it.each([
        ['Refund the rest to the card', { refundOwed: true, refundMethod: 'card', amount: 20 }],
        ['It already arrived, on the card', { owedArrived: true, amount: 20, arrivedOn: 'card', reason: 'Seen in Stripe' }],
      ] as const)('settled by %s: the £20 is on the card guest\'s line, the store credit part is whole again, and the cash is still £40', async (_name, press) => {
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await cardGuestOwed(steps)
            expect(await money(bookingId)).toMatchObject(owed)
            await call('refundBooking', { bookingId, ...press })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, cardLeft: 0, parts: { card: 0, giftCard: 0, storeCredit: 20, cash: 40 }, cashLeft: 40 })
          },
          plenty
        )
      })

      it('more owed than store credit paid for seats: the rest of it comes off the gift card, and the cash is whole', async () => {
        await withBooking(
          { booking: twoSeats, payment: { ...gift(25), ...storeCredit(15) } },
          async (steps) => {
            const { call, attempt, bookingId } = steps
            await added(steps, bea, cash(20))
            const guest = await added(steps, cy, card)
            expect(await money(bookingId)).toMatchObject({ pricePaid: 80, parts: { card: 20, giftCard: 25, storeCredit: 15, cash: 20 }, cashLeft: 20 })
            await neverArrives(steps, () => call('removeBookingGuest', toCard(guest)))
            // It read £25 gift card, £15 store credit and no cash.
            const now = { parts: { card: 20, giftCard: 20, storeCredit: 0, cash: 20 }, cashLeft: 20 }
            expect(await money(bookingId)).toMatchObject({ pricePaid: 80, refundOwed: 20, left: 60, ...now })
            expect(JSON.stringify(await attempt('refundBooking', cashBack(bookingId, 20.01)))).toContain('Only £20.00 of cash')
            await call('refundBooking', restAsCredit(bookingId, 20))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, ...now })
          },
          plenty
        )
      })

      it("an add-on on the owed order: a card guest's £20 and their towel's £5 on one £25 card payment. The towel's £5 owed is not seat money and changes nothing; with the guest's £20 owed beside it, only that £20 comes off the store credit", async () => {
        await withBooking(
          { booking: twoSeats, payment: { ...cash(20), ...storeCredit(20) } },
          async (steps) => {
            const { call, attempt, bookingId } = steps
            await added(steps, cy, storeCredit(20))
            const guest = ((await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }], payment: card })) as { guest: { id: string } }).guest.id
            const paid = { parts: { card: 20, giftCard: 0, storeCredit: 40, cash: 20 }, cashLeft: 20 }
            expect(await money(bookingId)).toMatchObject({ pricePaid: 80, ...paid })
            const towelId = await towelLine(bookingId)
            await neverArrives(steps, () => call('removeBookingAddon', { addonLineId: towelId, refund: 'card' }))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 85, refundOwed: 5, left: 80, ...paid })
            await neverArrives(steps, () => call('removeBookingGuest', toCard(guest)))
            // It read £40 store credit and no cash.
            const now = { parts: { card: 20, giftCard: 0, storeCredit: 20, cash: 20 }, cashLeft: 20 }
            expect(await money(bookingId)).toMatchObject({ pricePaid: 85, refundOwed: 25, left: 60, ...now })
            expect(JSON.stringify(await attempt('refundBooking', cashBack(bookingId, 20.01)))).toContain('Only £20.00 of cash')
            // Refund the rest gives the £25 as store credit, £20 of it seat money (W70c): as it read while it was owed.
            await call('refundBooking', restAsCredit(bookingId, 25))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, ...now })
          },
          plenty
        )
      })

      it("an add-on's owed £5, £3 of which arrived another way: the £2 still owed is less than the add-on line is short of, so nothing comes off the seats' store credit, then or once the rest arrives", async () => {
        await withBooking(
          { booking: twoSeats, payment: { ...cash(20), ...storeCredit(20) } },
          async (steps) => {
            const { call, bookingId } = steps
            await added(steps, cy, storeCredit(20))
            await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }], payment: card })
            const paid = { parts: { card: 20, giftCard: 0, storeCredit: 40, cash: 20 }, cashLeft: 20 }
            const towelId = await towelLine(bookingId)
            await neverArrives(steps, () => call('removeBookingAddon', { addonLineId: towelId, refund: 'card' }))
            await call('refundBooking', { bookingId, owedArrived: true, amount: 3, reason: 'Found on their balance' })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 82, refundOwed: 2, left: 80, ...paid })
            await call('refundBooking', { bookingId, owedArrived: true, amount: 2, reason: 'Found on their balance' })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 80, refundOwed: 0, left: 80, ...paid })
          },
          plenty
        )
      })

      it("a cancelled booking with its cancel's card refund owed reads the same way, and as it was once the £20 is given", async () => {
        await withBooking(
          { booking: twoSeats, payment: storeCredit(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await added(steps, cy, card)
            await added(steps, bea, cash(20))
            const before = { pricePaid: 80, parts: { card: 20, giftCard: 0, storeCredit: 40, cash: 20 } }
            expect(await money(bookingId)).toMatchObject(before)
            await neverArrives(steps, () => call('refundBooking', { bookingId, refundMethod: 'card' }))
            expect(await booking(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '80.00' })
            // It read £40 store credit and no cash.
            expect(await money(bookingId)).toMatchObject({ pricePaid: 80, refundOwed: 20, left: 60, parts: { card: 20, giftCard: 0, storeCredit: 20, cash: 20 } })
            await call('refundBooking', restAsCredit(bookingId, 20))
            expect(await money(bookingId)).toMatchObject({ refundOwed: 0, ...before })
          },
          plenty
        )
      })
    })

    // Brief W70e (Wayne, 24 Nov; W70d noticed 1, 2 and 4). Q26 amended: the cash a Part refund may hand back is the lower
    // of (a) what is left on the booking and (b) the cash paid on the booking less the cash already handed back. It is no
    // longer held to the cash part of what is left. It already arrived asks card / cash / another way, and cash counts as
    // cash handed back. A dearer Move's cash (no order) is cash paid on the booking. Never more cash out than cash in.
    describe('W70e (Q26 amended): cash back up to what is left and the cash paid less the cash handed back', () => {
      const toCard = (guestId: string) => ({ guestId, confirmedRefundAmount: 20, refundMethod: 'card' })
      const cashBack = (bookingId: string, amount: number) => ({ bookingId, refundMethod: 'cash', amount, ...goodwill })
      const restAsCredit = (bookingId: string, amount: number) => ({ bookingId, refundOwed: true, refundMethod: 'credit', amount })
      const arrived = (bookingId: string, amount: number, arrivedOn?: string) => ({ bookingId, owedArrived: true, amount, reason: 'Checked with the customer', ...(arrivedOn ? { arrivedOn } : {}) })
      const refusal = async (steps: Steps, params: Record<string, unknown>): Promise<string> => JSON.stringify(await steps.attempt('refundBooking', params))
      /** The It already arrived rows of the booking, oldest first: what each says about where the money was seen. */
      const arrivedRows = async (bookingId: string) =>
        (
          await db.query<{ details: Record<string, unknown> }>(
            "SELECT details FROM audit_log WHERE action = 'booking.refund_owed_arrived' AND entity_id = $1 ORDER BY at, ctid",
            [bookingId]
          )
        ).map((row) => row.details)
      /** Bea's £20 on a card, removed to the card, and the refund never arrives: £20 owed. */
      async function cardGuestOwed(steps: Steps): Promise<void> {
        const guest = await added(steps, bea, card)
        await neverArrives(steps, () => steps.call('removeBookingGuest', toCard(guest)))
      }
      /** W70c's example: seats £40 in cash, Cy's £20 on store credit, and Bea's £20 card refund owed. */
      async function w70cExample(steps: Steps): Promise<void> {
        await added(steps, cy, storeCredit(20))
        await cardGuestOwed(steps)
        expect(await money(steps.bookingId)).toMatchObject({ pricePaid: 80, refundOwed: 20, left: 60, parts: { card: 20, giftCard: 0, storeCredit: 0, cash: 40 }, cashLeft: 40 })
      }

      it("W70d noticed 2: seats £40 in cash and a card guest's £20 owed, no store credit or gift card: all £40 of the cash can be handed back while it is owed (it read £20), and after Refund the rest gives the £20 as store credit; £40.01 is refused, £40 goes, then £0.01 is refused", async () => {
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await cardGuestOwed(steps)
            // The parts are as they were (the card payment still holds the guest's £20), and add up to what is left.
            const parts = { card: 20, giftCard: 0, storeCredit: 0, cash: 20 }
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 20, left: 40, parts, cashLeft: 40 })
            expect(await refusal(steps, cashBack(bookingId, 40.01))).toContain('Only £40.00 is left')
            await call('refundBooking', restAsCredit(bookingId, 20))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 40, refundOwed: 0, left: 40, parts, cashLeft: 40 })
            expect(await refusal(steps, cashBack(bookingId, 40.01))).toContain('Only £40.00 is left')
            expect(await call('refundBooking', cashBack(bookingId, 40))).toMatchObject({ cashRefundedAmount: 40, pricePaid: 0 })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 0, left: 0, cashLeft: 0 })
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('nothing left')
          },
          plenty
        )
      })

      it('the same booking, the £40 handed back while the £20 is still owed: nothing is left, no more cash goes, and Refund the rest still sends the £20 to the card', async () => {
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await cardGuestOwed(steps)
            await call('refundBooking', cashBack(bookingId, 40))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 20, refundOwed: 20, left: 0, cashLeft: 0 })
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('nothing left')
            expect(await call('refundBooking', { bookingId, refundOwed: true, refundMethod: 'card', amount: 20 })).toMatchObject({ cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 0, refundOwed: 0, left: 0, cashLeft: 0 })
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('nothing left')
          },
          plenty
        )
      })

      it("money that isn't cash given back leaves the cash paid to hand back: seats £25 card and £15 store credit, a guest's £20 in cash, £20 part refunded to store credit: £20 of cash (it read £15), and no more than that", async () => {
        await withBooking(
          { booking: twoSeats, payment: { ...card, ...storeCredit(15) } },
          async (steps) => {
            const { call, bookingId } = steps
            await added(steps, bea, cash(20))
            await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 20, ...goodwill })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 40, parts: { card: 25, giftCard: 0, storeCredit: 0, cash: 15 }, cashLeft: 20 })
            expect(await refusal(steps, cashBack(bookingId, 20.01))).toContain('Only £20.00 of cash recorded on this booking can be handed back')
            await call('refundBooking', cashBack(bookingId, 20))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 20, parts: { card: 20, giftCard: 0, storeCredit: 0, cash: 0 }, cashLeft: 0 })
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('No cash recorded on this booking can be handed back')
          },
          plenty
        )
      })

      it('what is left bounds it too: £45 of £60 given back as store credit leaves £15, so £15 of the £20 cash paid, and £15.01 is refused', async () => {
        await withBooking(
          { booking: twoSeats, payment: { ...gift(25), ...storeCredit(15) } },
          async (steps) => {
            const { call, bookingId } = steps
            await added(steps, bea, cash(20))
            await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 45, ...goodwill })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 15, left: 15, cashLeft: 15 })
            expect(await refusal(steps, cashBack(bookingId, 15.01))).toContain('Only £15.00 is left')
            await call('refundBooking', cashBack(bookingId, 15))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 0, left: 0, cashLeft: 0 })
          },
          plenty
        )
      })

      it("It already arrived in cash (W70c's example): the £20 handed over counts as cash handed back, so £20 of the £40 can still be handed back; the row says cash, and nothing is recorded on a line", async () => {
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await w70cExample(steps)
            expect(await call('refundBooking', arrived(bookingId, 20, 'cash'))).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, pricePaid: 60 })
            expect(await arrivedRows(bookingId)).toEqual([{ amount: 20, reason: 'Checked with the customer', arrivedOn: 'cash' }])
            expect((await lines(bookingId)).map((line) => line.card)).toEqual(['0', '0', '0'])
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, left: 60, cardLeft: 20, cashLeft: 20 })
            expect(await refusal(steps, cashBack(bookingId, 20.01))).toContain('Only £20.00 of cash')
            await call('refundBooking', cashBack(bookingId, 20))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 40, cashLeft: 0 })
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('No cash')
          },
          plenty
        )
      })

      it.each([
        ['another way', 'other', { amount: 20, reason: 'Checked with the customer' }],
        ['no choice sent (a row as it was written before W70e)', undefined, { amount: 20, reason: 'Checked with the customer' }],
      ] as const)("It already arrived, %s (W70c's example): not cash, so all £40 can still be handed back (W70d noticed 1: it read £20), and no more", async (_name, arrivedOn, row) => {
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await w70cExample(steps)
            await call('refundBooking', arrived(bookingId, 20, arrivedOn))
            expect(await arrivedRows(bookingId)).toEqual([row])
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, left: 60, cashLeft: 40 })
            expect(await refusal(steps, cashBack(bookingId, 40.01))).toContain('Only £40.00 of cash')
            await call('refundBooking', cashBack(bookingId, 40))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 20, cashLeft: 0 })
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('No cash')
          },
          plenty
        )
      })

      it("It already arrived on the card (W70c's example): unchanged, £40; and a part in cash beside a part another way counts only the cash part", async () => {
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await w70cExample(steps)
            await call('refundBooking', arrived(bookingId, 20, 'card'))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, cardLeft: 0, parts: { card: 0, giftCard: 0, storeCredit: 20, cash: 40 }, cashLeft: 40 })
          },
          plenty
        )
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await w70cExample(steps)
            await call('refundBooking', arrived(bookingId, 5, 'cash'))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 75, refundOwed: 15, left: 60, cashLeft: 35 })
            await call('refundBooking', arrived(bookingId, 15, 'other'))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 0, left: 60, cashLeft: 35 })
            expect(await refusal(steps, cashBack(bookingId, 35.01))).toContain('Only £35.00 of cash')
          },
          plenty
        )
      })

      it("cash handed over for money owed on a booking with no cash paid is recorded, never refused, and comes off cash paid later: a cash guest's £20 added afterwards can't be handed back; another booking's cash rows change nothing", async () => {
        await withBooking(
          { booking: twoSeats, payment: storeCredit(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await cardGuestOwed(steps)
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, refundOwed: 20, left: 40, cashLeft: 0 })
            await call('refundBooking', arrived(bookingId, 20, 'cash'))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 40, refundOwed: 0, left: 40, cashLeft: 0 })
            await added(steps, cy, cash(20))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, left: 60, cashLeft: 0 })
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('No cash')
            // Another booking of the customer's, £40 in cash: its cash is its own, whatever this one handed back.
            const other = (await call('createOrder', { customerId: ID.customer, booking: { ...twoSeats, sessionId: ID.laterPublicSession }, payment: cash(40) })) as { bookingId: string }
            expect(await money(other.bookingId)).toMatchObject({ pricePaid: 40, cashLeft: 40 })
            await call('refundBooking', cashBack(other.bookingId, 10))
            expect(await money(other.bookingId)).toMatchObject({ pricePaid: 30, cashLeft: 30 })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, cashLeft: 0 })
          },
          plenty
        )
      })

      // Item 3 (W70d noticed 4): Q26's cash-paid bound. A dearer Move's cash has no order (Q36), so the cash on the booking
      // is more than the cash on its orders; the Move's own row says what it took in cash.
      it("a dearer Move paid in cash (no order) is cash paid on the booking: seats £40 in cash moved to £51 seats for £11 in cash: £51 can be handed back (it read £40), £51.01 is refused", async () => {
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
            await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: cash(11) })
            expect(await db.query("SELECT 1 FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking'", [bookingId])).toHaveLength(1)
            expect(await money(bookingId)).toMatchObject({ pricePaid: 51, parts: { card: 0, giftCard: 0, storeCredit: 0, cash: 51 }, cashLeft: 51 })
            expect(await refusal(steps, cashBack(bookingId, 51.01))).toContain('Only £51.00 is left')
            await call('refundBooking', cashBack(bookingId, 51))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 0, cashLeft: 0 })
          },
          plenty
        )
      })

      it("the Move's cash is the bound where no other cash was paid: seats £40 on store credit moved for £11 in cash: £11 of cash, £11.01 is refused, and after it none; a Move's gift card part beside its cash is not cash", async () => {
        await withBooking(
          { booking: twoSeats, payment: storeCredit(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
            await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: cash(11) })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 51, parts: { card: 0, giftCard: 0, storeCredit: 40, cash: 11 }, cashLeft: 11 })
            expect(await refusal(steps, cashBack(bookingId, 11.01))).toContain('Only £11.00 of cash')
            // The Move's cash is its own booking's: another booking of the customer's, on store credit, has none.
            const other = (await call('createOrder', { customerId: ID.customer, booking: { ...twoSeats, sessionId: ID.laterPublicSession }, payment: storeCredit(40) })) as { bookingId: string }
            expect(await money(other.bookingId)).toMatchObject({ pricePaid: 40, cashLeft: 0 })
            await call('refundBooking', cashBack(bookingId, 11))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 40, parts: { storeCredit: 40, cash: 0 }, cashLeft: 0 })
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('No cash')
          },
          plenty
        )
        await withBooking(
          { booking: twoSeats, payment: storeCredit(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
            await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { ...cash(6), ...gift(5) } })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 51, parts: { card: 0, giftCard: 5, storeCredit: 40, cash: 6 }, cashLeft: 6 })
            expect(await refusal(steps, cashBack(bookingId, 6.01))).toContain('Only £6.00 of cash')
          },
          plenty
        )
      })

      it('a dearer Move paid on the card is not cash: seats £40 in cash moved for £11 on the saved card: £40 of cash as before, £40.01 is refused', async () => {
        await withBooking(
          { booking: twoSeats, payment: cash(40) },
          async (steps) => {
            const { call, bookingId } = steps
            await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
            await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: card })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 51, cashLeft: 40 })
            expect(await refusal(steps, cashBack(bookingId, 40.01))).toContain('Only £40.00 of cash')
          },
          plenty
        )
      })
    })

    // Brief W70f (Wayne, 24 Nov; W70e unsure 1, noticed 1 and 2). Cash collected with Take Payment (Settle) is cash paid on
    // the booking, as a Move's. An order's It already arrived asks card / cash / another way too, and cash counts as cash
    // handed back on that order. A booking's cash and its order's cash are one pot, whichever is pressed first; and an
    // order takes off a booking's cash only up to that booking's cash that came through the order.
    describe("W70f: a Settle's cash is cash paid on the booking; cash handed over for money owed is one pot with the order's cash", () => {
      const toCard = (guestId: string) => ({ guestId, confirmedRefundAmount: 20, refundMethod: 'card' })
      const cashBack = (bookingId: string, amount: number) => ({ bookingId, refundMethod: 'cash', amount, ...goodwill })
      const refusal = async (steps: Steps, params: Record<string, unknown>): Promise<string> => JSON.stringify(await steps.attempt('refundBooking', params))
      const handedOver = (bookingId: string, amount: number) => ({ bookingId, owedArrived: true, amount, reason: 'Handed over at the desk', arrivedOn: 'cash' })

      // Item 1: the Settle.
      /** Mo's seat on a membership credit and Alex's £20 in cash, on Mo's account. */
      const creditSeatAndCashGuest = { customerId: ID.member, booking: { ...paidSeat([mo, alex]), ...memberCredit }, payment: cash(20) }
      /** `plenty`, and £100 of store credit for Mo too. */
      const plentyForMo = async (seedDb: Db): Promise<void> => {
        await plenty(seedDb)
        await seedDb.query('UPDATE customers SET store_credit_balance = 100 WHERE id = $1', [ID.member])
      }
      /** The membership lapsed: Mo's £20 seat is awaiting payment. The guest's £20 of cash is all the cash there is. */
      async function awaitingPayment({ bookingId }: Steps): Promise<void> {
        await db.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1", [bookingId])
        expect(await money(bookingId)).toMatchObject({ pricePaid: 20, parts: { card: 0, giftCard: 0, storeCredit: 0, cash: 20 }, cashLeft: 20 })
      }
      /** The Settle rows of the booking: what each says it took, and how. */
      const settleRows = async (bookingId: string) =>
        (await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'booking.settle' AND entity_id = $1 ORDER BY at, ctid", [bookingId])).map(
          ({ details }) => ({ method: details['method'], toCollect: details['toCollect'] })
        )

      it("a Payment needed booking settled £20 in cash (no order): £40 of cash can be handed back, £20 more than before; with a store credit guest beside it £40.01 is refused, £40 goes, and no more", async () => {
        await withBooking(
          creditSeatAndCashGuest,
          async (steps) => {
            const { call, bookingId } = steps
            await awaitingPayment(steps)
            const orders = async () => (await db.query('SELECT 1 FROM orders')).length
            const before = await orders()
            expect(await call('settleLapsedBooking', { bookingId, payment: cash(20) })).toMatchObject({ settled: true })
            // Q36: the Settle wrote no order; its own row says what it took in cash.
            expect(await orders()).toBe(before)
            expect(await settleRows(bookingId)).toEqual([{ method: 'cash', toCollect: 20 }])
            expect(await money(bookingId)).toMatchObject({ pricePaid: 40, parts: { card: 0, giftCard: 0, storeCredit: 0, cash: 40 }, cashLeft: 40 })
            // The Settle's cash is its own booking's: another customer's booking, on store credit, has none.
            const other = (await call('createOrder', { customerId: ID.customer, booking: { ...twoSeats, sessionId: ID.laterPublicSession }, payment: storeCredit(40) })) as { bookingId: string }
            expect(await money(other.bookingId)).toMatchObject({ pricePaid: 40, cashLeft: 0 })
            // The cash paid is the bound, not what is left: Cy's £20 on store credit makes £60 left.
            await added(steps, cy, storeCredit(20))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 60, parts: { card: 0, giftCard: 0, storeCredit: 20, cash: 40 }, cashLeft: 40 })
            expect(await refusal(steps, cashBack(bookingId, 40.01))).toContain('Only £40.00 of cash recorded on this booking can be handed back')
            expect(await call('refundBooking', cashBack(bookingId, 40))).toMatchObject({ cashRefundedAmount: 40, pricePaid: 20 })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 20, cashLeft: 0 })
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('No cash recorded on this booking can be handed back')
          },
          plentyForMo
        )
      })

      it.each([
        ['on the saved card', card, 'card', { card: 20, giftCard: 0, storeCredit: 0, cash: 20 }],
        ['on the reader', { method: 'reader' }, 'reader', { card: 20, giftCard: 0, storeCredit: 0, cash: 20 }],
        ['all on a gift card', gift(20), null, { card: 0, giftCard: 20, storeCredit: 0, cash: 20 }],
        ['all on store credit', storeCredit(20), null, { card: 0, giftCard: 0, storeCredit: 20, cash: 20 }],
      ] as const)("a Settle %s is not cash: the guest's £20 as before, and £20.01 is refused", async (_name, payment, method, parts) => {
        await withBooking(
          creditSeatAndCashGuest,
          async (steps) => {
            const { call, stripe, bookingId } = steps
            await awaitingPayment(steps)
            await settle(call, stripe, bookingId, payment)
            expect((await settleRows(bookingId)).map((row) => row.method)).toEqual([method])
            expect(await money(bookingId)).toMatchObject({ pricePaid: 40, parts, cashLeft: 20 })
            expect(await refusal(steps, cashBack(bookingId, 20.01))).toContain('Only £20.00 of cash')
          },
          plentyForMo
        )
      })

      it.each([
        ['store credit', storeCredit(5), { card: 0, giftCard: 0, storeCredit: 5, cash: 35 }],
        ['a gift card', gift(5), { card: 0, giftCard: 5, storeCredit: 0, cash: 35 }],
      ] as const)("a Settle part paid by %s: only the £15 that was cash counts: £35, and £35.01 is refused", async (_name, part, parts) => {
        await withBooking(
          creditSeatAndCashGuest,
          async (steps) => {
            const { call, bookingId } = steps
            await awaitingPayment(steps)
            await call('settleLapsedBooking', { bookingId, payment: { ...cash(15), ...part } })
            expect(await settleRows(bookingId)).toEqual([{ method: 'cash', toCollect: 15 }])
            expect(await money(bookingId)).toMatchObject({ pricePaid: 40, parts, cashLeft: 35 })
            expect(await refusal(steps, cashBack(bookingId, 35.01))).toContain('Only £35.00 of cash')
            await call('refundBooking', cashBack(bookingId, 35))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 5, cashLeft: 0 })
          },
          plentyForMo
        )
      })

      // Items 2 and 3: the order's side. The Orders page's presses, through the staff app's own files.
      const orderCash = async ({ call }: Steps, orderId: string) => ((await call('getOrderRefundFigures', { orderId })) as { cashLeft: number }).cashLeft
      const productLines = async (orderId: string) => (await db.query<{ id: string }>("SELECT id FROM order_line_items WHERE order_id = $1 AND item_type = 'product' ORDER BY created_at, id", [orderId])).map((row) => row.id)
      /** The order's products refunded in cash, as the Refund Line Items dialog presses it. */
      async function productsInCash({ call }: Steps, orderId: string): Promise<Record<string, unknown>> {
        const lineItemIds = await productLines(orderId)
        return (await call('refundOrder', { orderId, lineItemIds, refundMethod: 'cash', restock: Object.fromEntries(lineItemIds.map((id) => [id, false])) })) as Record<string, unknown>
      }
      /** An order's It already arrived, as its window presses it; with no `arrivedOn`, as a staff app from before W47 sent it. */
      const orderArrived = ({ call }: Steps, orderId: string, amount: number, arrivedOn?: string) =>
        call('refundOrderOwed', { orderId, amount, arrived: true, reason: 'Handed over at the desk', ...(arrivedOn ? { arrivedOn } : {}) })
      /** All the cash the Worker's refund records say went out, and what It already arrived says was handed over in cash. */
      const cashOut = async () =>
        Number(
          (
            await db.query<{ cash: string }>(
              `SELECT (COALESCE((SELECT SUM((details->'plan'->>'cash')::numeric) FROM audit_log WHERE action IN ('order.refund_claimed', 'booking.refund_claimed')), 0)
                     + COALESCE((SELECT SUM((details->>'amount')::numeric) FROM audit_log
                                 WHERE action IN ('order.owed_arrived', 'booking.refund_owed_arrived') AND details->>'arrivedOn' = 'cash'), 0))::text AS cash`
            )
          )[0]?.cash
        )
      /** W70e's order: a £20 seat and £24 of soap, £10 on a gift card and £34 in cash. */
      const seatAndSoap = { booking: paidSeat([sam]), products: [{ productVariantId: ID.variant, quantity: 2 }], payment: { ...cash(34), ...gift(10) } }
      /** Bea's £20 on a card (an order of her own), removed to the card, and the refund never arrives: £20 owed on the booking. */
      async function cardGuestOwed(steps: Steps): Promise<void> {
        const guest = await added(steps, bea, card)
        await neverArrives(steps, () => steps.call('removeBookingGuest', toCard(guest)))
        expect(await money(steps.bookingId)).toMatchObject({ pricePaid: 40, refundOwed: 20, left: 20, cashLeft: 20 })
      }

      it("a booking's In cash lowers its order's cash, the booking first: the owed £20 handed over in cash leaves £14 of the order's £34, so the £24 soap gets £14 in cash and £10 as store credit: £34 out, never more", async () => {
        await withBooking(
          seatAndSoap,
          async (steps) => {
            const { call, bookingId, orderId } = steps
            await cardGuestOwed(steps)
            expect(await orderCash(steps, orderId)).toBe(34)
            await call('refundBooking', handedOver(bookingId, 20))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 20, refundOwed: 0, left: 20, cashLeft: 0 })
            // Until W70f the order still read £34, and all £24 of the soap could go back in cash: £44 out for £34 in.
            expect(await orderCash(steps, orderId)).toBe(14)
            expect(await productsInCash(steps, orderId)).toMatchObject({ refundedAmount: 24, cashRefundedAmount: 14, storeCreditRefundedAmount: 10 })
            expect(await orderCash(steps, orderId)).toBe(0)
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('No cash')
            expect(await cashOut()).toBe(34)
          },
          plenty
        )
      })

      it("a booking's In cash and its order's cash, the order first: the soap's £24 in cash leaves £10 for the seat; the owed £20 handed over in cash is recorded all the same (it is what happened), and then neither has cash left", async () => {
        await withBooking(
          seatAndSoap,
          async (steps) => {
            const { call, bookingId, orderId } = steps
            await cardGuestOwed(steps)
            expect(await productsInCash(steps, orderId)).toMatchObject({ cashRefundedAmount: 24 })
            expect(await orderCash(steps, orderId)).toBe(10)
            expect(await money(bookingId)).toMatchObject({ left: 20, cashLeft: 10 })
            expect(await call('refundBooking', handedOver(bookingId, 20))).toMatchObject({ pricePaid: 20 })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 20, refundOwed: 0, left: 20, cashLeft: 0 })
            expect(await orderCash(steps, orderId)).toBe(0)
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('No cash')
          },
          plenty
        )
      })

      // Money owed on an order comes from a card refund that never arrived, so today's cash orders have none: the £24 is
      // test data standing in for money an old screen left owed on a cash order (as orders/refund-lines.test.ts does).
      const owedOnTheOrder = (orderId: string, owed: number) => db.query('UPDATE orders SET refund_owed_amount = $1 WHERE id = $2', [owed, orderId])

      it("an order's In cash lowers the cash its booking can hand back, the order first: £24 handed over in cash leaves £10 of the order's £34, so £10 of the £20 seat (it read £20): £10.01 is refused, £10 goes, and no more: £34 out", async () => {
        await withBooking(
          seatAndSoap,
          async (steps) => {
            const { call, bookingId, orderId } = steps
            await owedOnTheOrder(orderId, 24)
            expect(await money(bookingId)).toMatchObject({ pricePaid: 20, left: 20, cashLeft: 20 })
            expect(await orderArrived(steps, orderId, 24, 'cash')).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 0 })
            expect(await orderCash(steps, orderId)).toBe(10)
            expect(await money(bookingId)).toMatchObject({ pricePaid: 20, left: 20, cashLeft: 10 })
            expect(await refusal(steps, cashBack(bookingId, 10.01))).toContain('Only £10.00 of cash')
            await call('refundBooking', cashBack(bookingId, 10))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 10, left: 10, cashLeft: 0 })
            expect(await orderCash(steps, orderId)).toBe(0)
            expect(await refusal(steps, cashBack(bookingId, 0.01))).toContain('No cash')
            expect(await cashOut()).toBe(34)
          },
          plenty
        )
      })

      it("an order's In cash and its booking's cash, the booking first: £5 of the seat in cash, then the order's £24 handed over in cash leaves £5 for both: £5.01 is refused on the booking, £5 goes, and the order has none: £34 out", async () => {
        await withBooking(
          seatAndSoap,
          async (steps) => {
            const { call, bookingId, orderId } = steps
            await owedOnTheOrder(orderId, 24)
            await call('refundBooking', cashBack(bookingId, 5))
            expect(await orderCash(steps, orderId)).toBe(29)
            expect(await money(bookingId)).toMatchObject({ left: 15, cashLeft: 15 })
            await orderArrived(steps, orderId, 24, 'cash')
            expect(await orderCash(steps, orderId)).toBe(5)
            expect(await money(bookingId)).toMatchObject({ left: 15, cashLeft: 5 })
            expect(await refusal(steps, cashBack(bookingId, 5.01))).toContain('Only £5.00 of cash')
            await call('refundBooking', cashBack(bookingId, 5))
            expect(await money(bookingId)).toMatchObject({ left: 10, cashLeft: 0 })
            expect(await orderCash(steps, orderId)).toBe(0)
            expect(await cashOut()).toBe(34)
          },
          plenty
        )
      })

      it.each([
        ['another way', 'other'],
        ['with no choice sent (a row as it was written before W70f)', undefined],
        ['on the card', 'card'],
      ] as const)("an order's It already arrived %s is not cash: the order's £34 and the seat's £20 are as they were", async (_name, arrivedOn) => {
        await withBooking(
          seatAndSoap,
          async (steps) => {
            const { bookingId, orderId } = steps
            await owedOnTheOrder(orderId, 24)
            await orderArrived(steps, orderId, 24, arrivedOn)
            expect((await db.query<{ owed: string }>('SELECT refund_owed_amount::text AS owed FROM orders WHERE id = $1', [orderId]))[0]?.owed).toBe('0.00')
            expect(await orderCash(steps, orderId)).toBe(34)
            expect(await money(bookingId)).toMatchObject({ left: 20, cashLeft: 20 })
          },
          plenty
        )
      })

      // Item 3 (W70e noticed 2). Seats £40 and a £12 soap on one £52 cash order; the booking moved for £11 more in cash.
      const seatsAndSoap = { booking: twoSeats, ...soap, payment: cash(52) }
      async function movedForCash({ call, bookingId }: Steps): Promise<void> {
        await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
        await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: cash(11) })
        expect(await money(bookingId)).toMatchObject({ pricePaid: 51, left: 51, cashLeft: 51 })
      }

      it("W70e's row 10 on an order with a product: all £51 of the booking handed back in cash, £11 of it the Move's (no order): the order takes off only the £40 that came through it, so the soap reads its own £12 of cash (it read £1) and goes back in cash: £63 in, £63 out", async () => {
        await withBooking(
          seatsAndSoap,
          async (steps) => {
            const { call, bookingId, orderId } = steps
            await movedForCash(steps)
            expect(await orderCash(steps, orderId)).toBe(52)
            await call('refundBooking', cashBack(bookingId, 51))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 0, left: 0, cashLeft: 0 })
            expect(await orderCash(steps, orderId)).toBe(12)
            expect(await productsInCash(steps, orderId)).toMatchObject({ refundedAmount: 12, cashRefundedAmount: 12 })
            expect(await orderCash(steps, orderId)).toBe(0)
            expect(await cashOut()).toBe(63)
          },
          plenty
        )
      })

      it("the same, the soap first: £12 in cash leaves £40 on the order, and the booking's £51 (the order's £40 and the Move's £11) still goes back in cash; less than the Move's cash handed back comes off the order all the same, never more than the £40", async () => {
        await withBooking(
          seatsAndSoap,
          async (steps) => {
            const { call, bookingId, orderId } = steps
            await movedForCash(steps)
            expect(await productsInCash(steps, orderId)).toMatchObject({ cashRefundedAmount: 12 })
            expect(await orderCash(steps, orderId)).toBe(40)
            expect(await money(bookingId)).toMatchObject({ left: 51, cashLeft: 51 })
            // The booking's cash counts against its order first: £10 handed back takes £10 off the order.
            await call('refundBooking', cashBack(bookingId, 10))
            expect(await orderCash(steps, orderId)).toBe(30)
            expect(await refusal(steps, cashBack(bookingId, 41.01))).toContain('Only £41.00 is left')
            await call('refundBooking', cashBack(bookingId, 41))
            expect(await money(bookingId)).toMatchObject({ pricePaid: 0, cashLeft: 0 })
            expect(await orderCash(steps, orderId)).toBe(0)
            expect(await cashOut()).toBe(63)
          },
          plenty
        )
      })

      it("an add-on on the order is not seat money: seats £40, a £5 towel and a £12 soap on one £57 cash order, moved for £11 in cash and all £51 handed back: the order takes off the £40 of seats, so £17 of its cash is left (the soap's and the towel's), and the same where the towel's £5 is inside the booking line (an order from before the Worker)", async () => {
        for (const insideTheLine of [false, true]) {
          await withBooking(
            { booking: withTowel, ...soap, payment: cash(57) },
            async (steps) => {
              const { call, bookingId, orderId } = steps
              await movedForCash(steps)
              // Test data: the Worker keeps an add-on off the booking line; the old createOrder put its money inside it.
              if (insideTheLine) await db.query("UPDATE order_line_items SET line_total = line_total + 5 WHERE order_id = $1 AND item_type = 'booking'", [orderId])
              expect(await money(bookingId)).toMatchObject({ pricePaid: 51, left: 51, cashLeft: 51 })
              expect(await orderCash(steps, orderId)).toBe(57)
              await call('refundBooking', cashBack(bookingId, 51))
              expect(await orderCash(steps, orderId)).toBe(17)
            },
            plenty
          )
        }
      })

      it("a Settle's cash has no order either: handed back with the guest's £20, only the £20 that came through the order comes off it, so the order's soap reads its own cash", async () => {
        await withBooking(
          { ...creditSeatAndCashGuest, ...soap, payment: cash(32) },
          async (steps) => {
            const { call, bookingId, orderId } = steps
            await db.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1", [bookingId])
            await call('settleLapsedBooking', { bookingId, payment: cash(20) })
            expect(await money(bookingId)).toMatchObject({ pricePaid: 40, cashLeft: 40 })
            expect(await orderCash(steps, orderId)).toBe(32)
            await call('refundBooking', cashBack(bookingId, 40))
            expect(await orderCash(steps, orderId)).toBe(12)
            expect(await productsInCash(steps, orderId)).toMatchObject({ cashRefundedAmount: 12 })
            expect(await cashOut()).toBe(52)
          },
          plentyForMo
        )
      })
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

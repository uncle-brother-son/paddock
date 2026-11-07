import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BasketQuoteInput } from '@/contracts'
import type { Db } from '@/server/db'
import { insert } from '@/server/rules/testing/database'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { ID, PROMO, seed } from '@/server/rules/testing/replay/scenarios'
import { FakeStripe } from '@/server/stripe/fake'
import { priceBasket } from './price-basket'

// The other suites run on PGlite, which is Postgres 18. This is the one read on the live version,
// because it leans on how Postgres plans: quote_booking and quote_event must stay behind their CASE.
// No fixed clock here, so these check figures and errors, not whether a session is still bookable.

let pg: RealPostgres
let db: Db

beforeAll(async () => {
  pg = await startRealPostgres()
  db = pg.connect()
  await seed(db, new FakeStripe())
})
afterAll(async () => {
  await db.close()
  await pg.stop()
})

const sam = { name: 'Sam Test', dateOfBirth: '1990-01-01' }

describe('the one read, on real Postgres', () => {
  it('prices a basket with every kind of line', async () => {
    const result = await priceBasket(db, {
      customerId: ID.customer,
      booking: { sessionId: ID.session, guests: [sam, { name: 'Alex' }], guestsOver18Confirmed: true, redemptionSource: 'paid', addons: [{ addonId: ID.addon, quantity: 1 }] },
      standaloneAddons: [{ addonId: ID.robe, quantity: 1 }],
      products: [{ productVariantId: ID.candleVariant, quantity: 1 }],
      sessionPassTypeId: ID.passType,
      membershipPlanId: ID.plan,
      membershipBillingFrequency: 'monthly',
      giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' },
      event: { eventId: ID.event, accountHolderAttending: true, attendees: [{ ...sam, isAccountHolder: true }] },
      promoCode: PROMO.percent,
      shippingAddress: { name: 'Sam', line1: '1 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 1AA' },
      postageMethod: 'standard',
      payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 10 }, storeCredit: { amount: 5 } },
    })
    // Seats 40, towel 5, robe 10, candle 20, pass 50, membership 40, gift card 60, event 30, postage 4.95.
    expect(result.totals.orderTotal).toBe(259.95)
    expect(result.lines).toHaveLength(8)
  })

  it('an empty basket reads with every id null and every list empty', async () => {
    const result = await priceBasket(db, {} as BasketQuoteInput)
    expect(result.problems.map((p) => p.reason)).toEqual(['empty_order'])
  })

  it('quote_booking is held back from a session it would raise on', async () => {
    const noBand = await insert(db, 'sessions', {
      service_type_id: ID.serviceType,
      start_time: '2099-11-20 10:00:00+00',
      end_time: '2099-11-20 11:00:00+00',
      type: 'public',
      capacity: 10,
    })
    const result = await priceBasket(db, { customerId: ID.customer, booking: { sessionId: noBand, guests: [sam], redemptionSource: 'paid' } })
    expect(result.problems.map((p) => p.reason)).toEqual(['band_unpriced'])
  })

  it('quote_event is held back from an event it would raise on', async () => {
    const unpriced = await insert(db, 'events', { name: 'Unpriced', capacity: 10, access: 'public', active: false })
    const result = await priceBasket(db, {
      customerId: ID.customer,
      event: { eventId: unpriced, accountHolderAttending: true, attendees: [{ ...sam, isAccountHolder: true }] },
    })
    expect(result.problems.map((p) => p.reason)).toEqual(['event_not_on_sale'])
  })
})

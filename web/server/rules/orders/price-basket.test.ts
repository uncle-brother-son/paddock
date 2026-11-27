import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BasketQuoteInput, BasketQuoteOutput } from '@/contracts'
import type { Db, Queryable, SqlParam } from '@/server/db'
import { insert } from '@/server/rules/testing/database'
import { startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { ID, lastDayIs, PROMO, seed, seedCorePass, seedExhaustedMembership, seedOverlappingBooking } from '@/server/rules/testing/replay/scenarios'
import { listShopAddons } from '@/server/rules/shop/booking'
import { listShopProducts } from '@/server/rules/shop/reads'
import { FakeStripe } from '@/server/stripe/fake'
import {
  ADDON_MEMBER_PRICE_ONLY_MESSAGE,
  ADDON_PRICE_NOT_SET_MESSAGE,
  PASS_TYPE_NOT_SET_UP_MESSAGE,
  PRODUCT_MEMBER_PRICE_ONLY_MESSAGE,
  PRODUCT_PRICE_NOT_SET_MESSAGE,
} from './failure-messages'
import { priceBasket, STORE_CREDIT_CHOICE_CONFLICT_MESSAGE } from './price-basket'

// Prices on the shared replay seed, at its fixed date: seat £20 (Peak £25.50), towel £5, robe £10
// (member £8), soap £12, candle £20 shipped, mug £15, pass £50, membership £40 or £400, event £40,
// £30 or £20, postage £4.95 or £9.95, free Standard from £50.

let environment: ReplayEnvironment
let db: Db

const sam = { name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01' }
const alex = { name: 'Alex Guest', email: 'alex@example.com' }
const address = { name: 'Sam Test', line1: '1 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 1AA' }
const shipped = { shippingAddress: address, postageMethod: 'standard' }
const monthly = { membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly' }
const towel = { addonId: ID.addon, quantity: 1 }
const soap = { productVariantId: ID.variant, quantity: 2 }
const candle = { productVariantId: ID.candleVariant, quantity: 1 }
const seat = (extra: Record<string, unknown> = {}) => ({ sessionId: ID.session, guests: [sam], redemptionSource: 'paid', ...extra })
const twoSeats = (extra: Record<string, unknown> = {}) => seat({ guests: [sam, alex], guestsOver18Confirmed: true, ...extra })
const buyNew = (extra: Record<string, unknown> = {}) => seat({ redemptionSource: 'buy_new_membership', ...extra })
const eventPlaces = {
  eventId: ID.event,
  accountHolderAttending: true,
  guestsOver18Confirmed: true,
  attendees: [
    { ...sam, isAccountHolder: true },
    { ...alex, isAccountHolder: false },
  ],
}

const quote = (input: Partial<BasketQuoteInput> & Record<string, unknown>, options = {}): Promise<BasketQuoteOutput> =>
  priceBasket(db, { customerId: ID.customer, ...input } as BasketQuoteInput, options)
const reasons = (result: BasketQuoteOutput) => result.problems.map((p) => p.reason)

class Undo extends Error {}

/** Runs `work` with a change to the seed, inside a transaction that is then rolled back. */
async function during<T>(change: () => Promise<unknown>, work: () => Promise<T>): Promise<T> {
  const outer = db
  let outcome: { value: T } | null = null
  try {
    await outer.transaction(async (tx) => {
      db = tx as unknown as Db
      await change()
      outcome = { value: await work() }
      throw new Undo()
    })
  } catch (err) {
    if (!(err instanceof Undo)) throw err
  } finally {
    db = outer
  }
  return (outcome as unknown as { value: T }).value
}
const privateSeats = (extra: Record<string, unknown> = {}) => twoSeats({ sessionId: ID.privateSession, ...extra })

beforeAll(async () => {
  environment = await startReplay()
  db = environment.database.db
  await seed(db, new FakeStripe())
})
afterAll(() => environment.stop())

describe('every line kind', () => {
  it('a public booking with a guest and a paid add-on', async () => {
    const result = await quote({ booking: twoSeats({ addons: [towel] }) })
    expect(result.problems).toEqual([])
    expect(result.booking).toMatchObject({ bookingType: 'public', redemptionSource: 'paid', price: 40, discount: 0 })
    expect(result.booking?.seats.map((s) => [s.seatNo, s.kind, s.payBy, s.unitPrice])).toEqual([
      [1, 'account_holder', 'paid', 20],
      [2, 'guest', 'paid', 20],
    ])
    expect(result.booking?.addons).toEqual([
      { addonId: ID.addon, name: 'Towel', quantity: 1, unitPrice: 5, systemUnitPrice: 5, redemptionSource: 'paid', membershipId: null, charged: 5 },
    ])
    expect(result.totals).toMatchObject({ orderTotal: 45, amountDue: 45, toCollect: { card: 45, reader: 45, cash: 45 } })
  })

  it('a private booking is priced as a whole and has no seat prices', async () => {
    const result = await quote({ booking: twoSeats({ sessionId: ID.privateSession }) })
    expect(result.problems).toEqual([])
    expect(result.booking).toMatchObject({ bookingType: 'private', price: 100 })
    expect(result.booking?.seats.map((s) => s.unitPrice)).toEqual([null, null])
    expect(result.totals.amountDue).toBe(100)
  })

  it('a membership credit covers seat 1 and an add-on credit covers the add-on, and only the guest pays', async () => {
    const result = await quote({
      customerId: ID.member,
      booking: twoSeats({
        redemptionSource: 'membership_credit',
        membershipId: ID.membership,
        addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }],
      }),
    })
    expect(result.problems).toEqual([])
    expect(result.booking?.seats.map((s) => s.payBy)).toEqual(['membership_credit', 'paid'])
    expect(result.booking?.addons[0]).toMatchObject({ redemptionSource: 'membership_credit', membershipId: ID.membership, charged: 0 })
    expect(result.totals).toMatchObject({ orderTotal: 20, amountDue: 20 })
  })

  it('a Core member on Peak falls back to a paid booking at the discounted price', async () => {
    const result = await quote({ customerId: ID.member, booking: seat({ sessionId: ID.peakSession, redemptionSource: 'membership_credit', membershipId: ID.membership }) })
    expect(result.booking).toMatchObject({ redemptionSource: 'paid', price: 21.68, band: { code: 'peak', name: 'Peak' } })
    expect(result.booking?.seats[0]).toMatchObject({ listPrice: 25.5, unitPrice: 21.68, discountPercent: 15, creditEligible: false })
  })

  it('a pass credit covers seat 1', async () => {
    const result = await quote({ booking: twoSeats({ redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }) })
    expect(result.booking?.seats.map((s) => s.payBy)).toEqual(['session_pass_credit', 'paid'])
    expect(result.totals.amountDue).toBe(20)
  })

  it('a standalone add-on at the member price', async () => {
    const result = await quote({ customerId: ID.member, standaloneAddons: [{ addonId: ID.robe, quantity: 2 }] })
    expect(result.lines).toMatchObject([{ kind: 'addon', name: 'Robe', quantity: 2, unitPrice: 8, lineTotal: 16, systemUnitPrice: 8 }])
  })

  it('a non-member pays the add-on base price', async () => {
    const result = await quote({ standaloneAddons: [{ addonId: ID.robe, quantity: 1 }] })
    expect(result.totals.amountDue).toBe(10)
  })

  it('products: picked-up items pay no postage', async () => {
    const result = await quote({ products: [soap] })
    expect(result.postage).toBeNull()
    expect(result.totals.amountDue).toBe(24)
  })

  it('products: a mug only ships when staff choose to', async () => {
    const pickup = await quote({ products: [{ productVariantId: ID.mugVariant, quantity: 1 }] })
    const ship = await quote({ products: [{ productVariantId: ID.mugVariant, quantity: 1, fulfillmentChoice: 'shipping' }], ...shipped })
    expect(pickup.postage).toBeNull()
    expect(ship.postage).toEqual({ method: 'standard', amount: 4.95, shippedValue: 15 })
    expect(ship.totals.amountDue).toBe(19.95)
  })

  it('postage: free Standard from the threshold, Express always charged', async () => {
    const free = await quote({ products: [{ ...candle, quantity: 3 }], ...shipped })
    const express = await quote({ products: [{ ...candle, quantity: 3 }], ...shipped, postageMethod: 'express' })
    expect(free.postage).toEqual({ method: 'standard', amount: 0, shippedValue: 60 })
    expect(free.lines.map((l) => l.kind)).toEqual(['product', 'postage'])
    expect(express.postage?.amount).toBe(9.95)
  })

  it('a pass bought on its own', async () => {
    const result = await quote({ sessionPassTypeId: ID.passType })
    expect(result.lines).toMatchObject([{ kind: 'session_pass', name: 'Five Sessions', lineTotal: 50 }])
  })

  it('a membership: billed apart from the card charge, and in the reader tap', async () => {
    const result = await quote({ ...monthly, booking: undefined, products: [soap] })
    expect(result.totals).toMatchObject({
      orderTotal: 64,
      nonMembershipDue: 24,
      membershipFirstPayment: 40,
      amountDue: 64,
      toCollect: { card: 24, reader: 64, cash: 24 },
      firstInvoice: 40,
    })
  })

  it('a yearly membership uses the yearly price', async () => {
    const result = await quote({ ...monthly, membershipBillingFrequency: 'yearly' })
    expect(result.totals.firstInvoice).toBe(400)
  })

  it('a gift card bought: a preset, and a custom amount in range', async () => {
    const preset = await quote({ giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' } })
    const custom = await quote({ giftCard: { giftCardTypeId: ID.giftCardType, amount: 25, fulfillmentMethod: 'pickup' } })
    const tooBig = await quote({ giftCard: { giftCardTypeId: ID.giftCardType, amount: 500, fulfillmentMethod: 'pickup' } })
    expect(preset.totals.amountDue).toBe(60)
    expect(custom.totals.amountDue).toBe(25)
    expect(reasons(tooBig)).toEqual(['gift_card_amount_out_of_range'])
  })

  it('an event: place 1 is the account holder, every other place the public price', async () => {
    const result = await quote({ event: eventPlaces })
    expect(result.event?.places.map((p) => [p.attendeeType, p.priceLevel, p.unitPrice])).toEqual([
      ['account_holder', 'public', 40],
      ['guest', 'public', 40],
    ])
    expect(result.lines).toMatchObject([{ kind: 'event', quantity: 2, unitPrice: 40, lineTotal: 80 }])
  })

  it('an event: a membership in the same basket gives its member price straight away', async () => {
    const result = await quote({ event: eventPlaces, ...monthly })
    expect(result.event?.places.map((p) => [p.priceLevel, p.unitPrice])).toEqual([['pre_herd', 30], ['public', 40]])
  })
})

describe('promo on each kind', () => {
  const withPromo = (input: Record<string, unknown>) => quote({ ...input, promoCode: PROMO.percent })

  it.each([
    ['booking', { booking: twoSeats() }, 4, 36],
    ['standalone add-on', { standaloneAddons: [towel] }, 0.5, 4.5],
    ['product', { products: [soap] }, 2.4, 21.6],
    ['pass', { sessionPassTypeId: ID.passType }, 5, 45],
    ['membership', monthly, 4, 36],
    ['event', { event: eventPlaces }, 8, 72],
  ])('%s', async (_, input, discount, due) => {
    const result = await withPromo(input)
    expect(result.problems).toEqual([])
    expect(result.totals.promoDiscount).toBe(discount)
    expect(result.totals.amountDue).toBe(due)
  })

  it('a code is matched whatever its case', async () => {
    expect((await quote({ products: [soap], promoCode: PROMO.percent.toLowerCase() })).promo?.code).toBe(PROMO.percent)
  })

  it('a gift card, postage and an attached add-on are never discounted', async () => {
    const result = await withPromo({
      booking: seat({ addons: [towel] }),
      products: [candle],
      giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' },
      ...shipped,
    })
    expect(result.promo?.perLine.map((l) => l.key)).toEqual(['seat:1', 'product:0'])
    expect(result.totals.promoDiscount).toBe(4)
  })

  it('a member-priced line is left out unless the code says otherwise', async () => {
    const result = await quote({ customerId: ID.member, standaloneAddons: [{ addonId: ID.robe, quantity: 1 }], promoCode: PROMO.percent })
    expect(result.problems[0]?.message).toBe(`Promo code "${PROMO.percent}" cannot be used: Nothing in this basket is eligible for that promo code.`)
  })


  it('a fixed code is spread to the penny and shown on each seat', async () => {
    const result = await quote({ booking: twoSeats(), products: [soap], promoCode: PROMO.fixed })
    expect(result.totals.promoDiscount).toBe(5)
    expect(result.booking?.seats.map((s) => s.discount)).toEqual([1.56, 1.56])
    expect(result.lines.find((l) => l.kind === 'product')?.discount).toBe(1.88)
  })

  it('an unknown code', async () => {
    const result = await quote({ products: [soap], promoCode: 'nope' })
    expect(result.problems).toEqual([{ stage: 'validation', reason: 'promo_code_invalid', message: 'Promo code "NOPE" does not exist.' }])
  })
})

describe('payment parts, in the agreed order', () => {
  it('store credit and gift card come off the remainder, which is what each method would take', async () => {
    const result = await quote({
      booking: twoSeats(),
      products: [soap],
      payment: { method: 'card', storeCredit: { amount: 15 }, giftCard: { giftCardId: ID.giftCard, amount: 10 } },
    })
    expect(result.totals).toMatchObject({ amountDue: 64, giftCardApplied: 10, storeCreditApplied: 15, toCollect: { card: 39, reader: 39, cash: 39 } })
  })

  it('an exact cover leaves nothing to pay, with no noise from the sum', async () => {
    const result = await quote({ products: [{ productVariantId: ID.variant, quantity: 1, unitPrice: 6.95 }], payment: { storeCredit: { amount: 2.9 }, giftCard: { giftCardId: ID.giftCard, amount: 4.05 } } }, { allowPriceOverrides: true })
    expect(result.totals.toCollect.card).toBe(0)
    expect(reasons(result)).toEqual(['price_override_reason_required'])
  })

  // W58 (Wayne's Q55): the store credit choice. Sam has £30.00 of store credit; the soap is £24.00, two seats and the
  // soap £64.00.
  it.each([
    ['ticked, covering it all: £24.00 of the £30.00, nothing to collect', { products: [soap], payment: { useStoreCredit: true } }, 24, 0],
    ['ticked, partly covering: all £30.00, £34.00 left for the card', { booking: twoSeats(), products: [soap], payment: { method: 'card', useStoreCredit: true } }, 30, 34],
    ['ticked with a £40.00 gift card: the £24.00 the gift card leaves', { booking: twoSeats(), products: [soap], payment: { method: 'card', useStoreCredit: true, giftCard: { giftCardId: ID.giftCard, amount: 40 } } }, 24, 0],
    ['unticked: none, the whole £24.00 to collect', { products: [soap], payment: { method: 'cash', useStoreCredit: false } }, 0, 24],
  ] as const)('Q55 %s', async (_, input, applied, toCollect) => {
    const result = await quote(input as unknown as Partial<BasketQuoteInput>)
    expect(result.totals.storeCreditApplied).toBe(applied)
    expect(result.totals.toCollect.card).toBe(toCollect)
    expect(reasons(result).filter((reason) => reason !== 'payment_method_required')).toEqual([])
  })

  it('Q55: the choice and an amount sent together are refused, whichever way the choice goes; a website guest uses none', async () => {
    for (const useStoreCredit of [true, false]) {
      const both = await quote({ products: [soap], payment: { method: 'cash', useStoreCredit, storeCredit: { amount: 10 } } })
      expect(both.problems).toContainEqual(expect.objectContaining({ stage: 'validation', reason: 'store_credit_choice_conflict', message: STORE_CREDIT_CHOICE_CONFLICT_MESSAGE }))
    }
    const guest = await priceBasket(db, { products: [soap], payment: { method: 'card', useStoreCredit: true } } as BasketQuoteInput, {})
    expect(guest.totals.storeCreditApplied).toBe(0)
  })

  it('more credit than the customer has', async () => {
    expect(reasons(await quote({ products: [soap], payment: { storeCredit: { amount: 31 } } }))).toContain('store_credit_insufficient')
  })

  it('more gift card than its balance, and gift cards that cannot be used', async () => {
    const over = await quote({ products: [soap], payment: { giftCard: { giftCardId: ID.giftCard, amount: 41 } } })
    const missing = await quote({ products: [soap], payment: { giftCard: { giftCardId: ID.customer, amount: 1 } } })
    expect(reasons(over)).toContain('gift_card_insufficient_or_invalid')
    expect(reasons(missing)).toContain('gift_card_not_found')
  })

  it('more than the total, split by which part goes over', async () => {
    const gift = await quote({ products: [soap], payment: { giftCard: { giftCardId: ID.giftCard, amount: 25 } } })
    const both = await quote({ products: [soap], payment: { giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 5 } } })
    expect(gift.problems).toEqual([{ stage: 'payment', reason: 'gift_card_amount_exceeds_total', amountDueTotal: 24 }])
    expect(both.problems).toEqual([{ stage: 'payment', reason: 'store_credit_amount_exceeds_total', amountDueTotal: 24 }])
  })

  it('a method is needed once a payment is being made, but not for a price check', async () => {
    expect(reasons(await quote({ products: [soap], payment: {} }))).toEqual(['payment_method_required'])
    expect(reasons(await quote({ products: [soap] }))).toEqual([])
  })

  it('an unknown method, and cash for a membership', async () => {
    expect(reasons(await quote({ products: [soap], payment: { method: 'cheque' } }))).toEqual(['invalid_payment_method'])
    expect(reasons(await quote({ ...monthly, payment: { method: 'cash' } }))).toEqual(['membership_cash_not_accepted'])
  })

  it('the reader needs something to charge, and consent for a membership', async () => {
    const covered = await quote({ products: [soap], payment: { method: 'reader', storeCredit: { amount: 24 } } })
    const noConsent = await quote({ ...monthly, payment: { method: 'reader' } })
    expect(covered.problems).toEqual([
      { stage: 'payment', reason: 'reader_nothing_to_charge', message: 'The amount due has changed. Check it with the customer and confirm again.', amountDueTotal: 24 },
    ])
    expect(reasons(noConsent)).toEqual(['reader_save_card_required'])
  })

  it('on the reader the first invoice is nothing, because the tap takes it', async () => {
    const result = await quote({ ...monthly, payment: { method: 'reader', readerSaveCard: true } })
    expect(result.totals).toMatchObject({ firstInvoice: 0, toCollect: { reader: 40 } })
  })
})

describe('spill onto a membership (Q1, Q2)', () => {
  it('credit pays everything else first, then comes off the first invoice', async () => {
    const result = await quote({ products: [soap], ...monthly, payment: { method: 'card', storeCredit: { amount: 30 } } })
    expect(result.totals).toMatchObject({ nonMembershipDue: 24, spillToMembership: 6, firstInvoice: 34, toCollect: { card: 0, reader: 34 } })
  })

  it('Q1: postage is paid before credit spills, so the customer pays what the screen shows', async () => {
    const result = await quote({ products: [candle], ...shipped, ...monthly, payment: { method: 'card', storeCredit: { amount: 30 } } })
    expect(result.totals).toMatchObject({ nonMembershipDue: 24.95, spillToMembership: 5.05, firstInvoice: 34.95, toCollect: { card: 0 } })
    expect(result.totals.amountDue - result.totals.storeCreditApplied).toBeCloseTo(result.totals.firstInvoice, 2)
  })

  it('Q2: a standalone add-on on a buy-new booking is paid before credit spills', async () => {
    const result = await quote({ booking: buyNew(), standaloneAddons: [towel], ...monthly, payment: { method: 'card', storeCredit: { amount: 20 } } })
    expect(result.totals).toMatchObject({ nonMembershipDue: 5, spillToMembership: 15, firstInvoice: 25 })
  })

  it('the spill is split the way the screen shows it, store credit first', async () => {
    const result = await quote({ ...monthly, payment: { method: 'reader', readerSaveCard: true, storeCredit: { amount: 10 }, giftCard: { giftCardId: ID.giftCard, amount: 5 } } })
    expect(result.totals).toMatchObject({ spillToMembership: 15, spillFromStoreCredit: 10, spillFromGiftCard: 5, membershipToPay: 25, firstInvoice: 0, toCollect: { reader: 25 } })
  })

  it('the spill never passes the first payment', async () => {
    const result = await quote({ ...monthly, promoCode: PROMO.percent, payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 36 } } })
    expect(result.totals).toMatchObject({ membershipFirstPayment: 36, spillToMembership: 36, firstInvoice: 0 })
  })
})

describe('a membership bought in the basket', () => {
  it('needs a saved card on the card path', async () => {
    const noCard = await insert(db, 'customers', { first_name: 'No', last_name: 'Card', email: 'nocard@example.com', date_of_birth: '1990-01-01' })
    const result = await quote({ customerId: noCard, ...monthly, payment: { method: 'card' } })
    expect(reasons(result)).toEqual(['membership_no_saved_card'])
  })

  it('needs a known plan, a frequency and a price', async () => {
    expect(reasons(await quote({ membershipPlanId: ID.plan }))).toEqual(['membership_billing_frequency_required'])
    expect(reasons(await quote({ membershipPlanId: ID.customer, membershipBillingFrequency: 'monthly' }))).toEqual(['membership_plan_not_found'])
  })

  it('covers seat 1 of a buy-new booking, leaving the guest to pay', async () => {
    const result = await quote({ booking: twoSeats({ redemptionSource: 'buy_new_membership' }), ...monthly })
    expect(result.booking).toMatchObject({ redemptionSource: 'membership_credit', price: 20 })
    expect(result.lines.map((l) => l.kind)).toEqual(['membership', 'booking'])
    expect(result.totals).toMatchObject({ orderTotal: 60, nonMembershipDue: 20, firstInvoice: 40 })
  })

  it('pays seat 1 at the member price where the plan has no credit for that band', async () => {
    const result = await quote({ booking: buyNew({ sessionId: ID.peakSession }), ...monthly })
    expect(result.booking).toMatchObject({ redemptionSource: 'paid', price: 21.68 })
  })

  it('an attached add-on on a credit draws on the new membership, which is not Herd yet when monthly', async () => {
    const line = { ...towel, redemptionSource: 'membership_credit' }
    expect(reasons(await quote({ booking: buyNew({ addons: [line] }), ...monthly }))).toEqual(['addon_membership_too_new'])
  })

  it('buying a membership can replace only an exhausted one', async () => {
    const result = await quote({ booking: seat({ cancelExhaustedMembershipId: ID.membership }) })
    const stillHasCredit = await quote({ customerId: ID.member, booking: buyNew({ guests: [{ ...sam }], cancelExhaustedMembershipId: ID.membership }), ...monthly })
    expect(reasons(result)).toContain('cancel_membership_requires_buy_new_membership')
    expect(reasons(stillHasCredit)).toContain('exhausted_membership_still_has_credit')
  })
})

describe('the other decisions', () => {
  it('Q3: buy-new with a pass as well: both are real lines', async () => {
    const result = await quote({ booking: buyNew(), sessionPassTypeId: ID.passType, ...monthly })
    expect(result.lines.map((l) => l.kind)).toEqual(['membership', 'session_pass', 'booking'])
    expect(result.totals).toMatchObject({ orderTotal: 90, nonMembershipDue: 50, firstInvoice: 40 })
  })

  it('Q3: a buy-new pass with a membership as well: both are real lines', async () => {
    const result = await quote({ booking: seat({ redemptionSource: 'buy_new_session_pass' }), sessionPassTypeId: ID.passType, ...monthly })
    expect(result.lines.map((l) => l.kind)).toEqual(['membership', 'session_pass', 'booking'])
    expect(result.booking?.seats[0]?.payBy).toBe('session_pass_credit')
    expect(result.totals).toMatchObject({ nonMembershipDue: 50, firstInvoice: 40 })
  })

  it('Q4: a shipped gift card counts towards free postage', async () => {
    const shippedCard = await quote({ giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'shipping' }, ...shipped })
    expect(shippedCard.postage).toEqual({ method: 'standard', amount: 0, shippedValue: 60 })
    expect(shippedCard.totals.amountDue).toBe(60)
  })

  it('Q4: under the threshold it still pays, and a digital gift card never counts', async () => {
    const under = await quote({ giftCard: { giftCardTypeId: ID.giftCardType, amount: 20, fulfillmentMethod: 'shipping' }, ...shipped })
    const digital = await quote({ giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' }, products: [candle], ...shipped })
    expect(under.postage?.amount).toBe(4.95)
    expect(digital.postage).toEqual({ method: 'standard', amount: 4.95, shippedValue: 20 })
  })

  it('Q5: a buy-new order keeps its address and special requests', async () => {
    const result = await quote({
      booking: buyNew({ specialRequests: '  Step-free access  ' }),
      products: [candle],
      ...shipped,
      ...monthly,
      saveShippingAddressToCustomer: true,
    })
    expect(result.booking?.specialRequests).toBe('Step-free access')
    expect(result.delivery).toEqual({
      address: { name: 'Sam Test', line1: '1 Mill Lane', line2: null, city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' },
      saveToCustomer: true,
    })
  })

  it('Q6: a promo discounts the paid seats of a buy-new booking, and the quote shows it', async () => {
    const result = await quote({ booking: twoSeats({ redemptionSource: 'buy_new_membership' }), ...monthly, promoCode: PROMO.percent })
    expect(result.promo?.perLine).toEqual([
      { key: 'seat:2', discount: 2 },
      { key: 'membership', discount: 4 },
    ])
    expect(result.booking).toMatchObject({ price: 20, discount: 2 })
    expect(result.totals).toMatchObject({ promoDiscount: 6, nonMembershipDue: 18, firstInvoice: 36 })
  })
})

describe('Q6, the buy-new seat 1 (W70a, the W70 audit\'s S1)', () => {
  it('a paid seat 1 on a buy-new booking counts as member-priced, so a promo leaves it out: on Peak the £21.68 seat keeps its price, and the guest and the membership get 10% off; a code for member prices takes it too', async () => {
    const basket = { booking: twoSeats({ sessionId: ID.peakSession, redemptionSource: 'buy_new_membership' }), ...monthly, promoCode: PROMO.percent }
    const result = await quote(basket)
    expect(result.booking?.seats.map((s) => [s.payBy, s.unitPrice])).toEqual([['paid', 21.68], ['paid', 25.5]])
    expect(result.promo?.perLine).toEqual([
      { key: 'seat:2', discount: 2.55 },
      { key: 'membership', discount: 4 },
    ])
    expect(result.booking).toMatchObject({ price: 47.18, discount: 2.55 })
    const both = await during(() => db.query('UPDATE promo_codes SET applies_on_member_prices = true WHERE id = $1', [ID.promoPercent]), () => quote(basket))
    expect(both.promo?.perLine.map((line) => line.key)).toEqual(['seat:1', 'seat:2', 'membership'])
  })

  it('an ordinary booking\'s member-discounted seat 1 is left out the same way, and a seat at the list price never is', async () => {
    const member = await quote({ customerId: ID.member, booking: twoSeats({ sessionId: ID.peakSession, guests: [{ ...sam, name: 'Mo Member' }, alex] }), promoCode: PROMO.percent })
    expect(member.promo?.perLine).toEqual([{ key: 'seat:2', discount: 2.55 }])
    const listed = await quote({ booking: twoSeats({ sessionId: ID.peakSession }), promoCode: PROMO.percent })
    expect(listed.promo?.perLine.map((line) => line.key)).toEqual(['seat:1', 'seat:2'])
  })
})

describe('price overrides', () => {
  const sent = { products: [{ ...soap, unitPrice: 1 }], standaloneAddons: [{ ...towel, unitPrice: 1 }] }

  it('without permission a sent price is ignored, silently', async () => {
    const result = await quote(sent, { allowPriceOverrides: false })
    expect(result.problems).toEqual([])
    expect(result.lines.map((l) => [l.unitPrice, l.systemUnitPrice, l.priceOverrideReason])).toEqual([[5, 5, null], [12, 12, null]])
    expect(result.totals.amountDue).toBe(29)
  })

  it('leaving the option out means no permission', async () => {
    expect((await quote(sent)).totals.amountDue).toBe(29)
  })

  it('with permission a changed price needs a reason', async () => {
    const result = await quote(sent, { allowPriceOverrides: true })
    expect(result.problems[0]).toMatchObject({ stage: 'validation', reason: 'price_override_reason_required' })
  })

  it('with permission and a reason the price stands and the system price is kept beside it', async () => {
    const result = await quote({ products: [{ ...soap, unitPrice: 10, priceOverrideReason: '  Damaged box ' }] }, { allowPriceOverrides: true })
    expect(result.problems).toEqual([])
    expect(result.lines).toMatchObject([{ unitPrice: 10, lineTotal: 20, systemUnitPrice: 12, priceOverrideReason: 'Damaged box' }])
  })

  it('a reason on an unchanged price is not kept', async () => {
    const result = await quote({ products: [{ ...soap, unitPrice: 12, priceOverrideReason: 'No change' }] }, { allowPriceOverrides: true })
    expect(result.lines[0]?.priceOverrideReason).toBeNull()
  })

  it('without permission a sent price can not earn free postage', async () => {
    const result = await quote({ products: [{ ...candle, unitPrice: 500 }], ...shipped })
    expect(result.postage).toEqual({ method: 'standard', amount: 4.95, shippedValue: 20 })
  })
})

describe('a guest with no customer', () => {
  const guest = (input: Record<string, unknown>, options = {}) => priceBasket(db, input as BasketQuoteInput, options)

  it('prices seats, add-ons, products and postage at public prices', async () => {
    const result = await guest({ booking: seat(), standaloneAddons: [{ addonId: ID.robe, quantity: 1 }], products: [candle], ...shipped })
    expect(result.problems).toEqual([])
    expect(result.totals.amountDue).toBe(54.95)
  })

  it('prices an event, and a membership gives its member price straight away', async () => {
    const result = await guest({ event: eventPlaces, ...monthly })
    expect(result.event?.places.map((p) => p.priceLevel)).toEqual(['pre_herd', 'public'])
  })

  it('takes a promo code', async () => {
    expect((await guest({ products: [soap], promoCode: PROMO.percent })).totals.amountDue).toBe(21.6)
  })

  it('has no credits to spend', async () => {
    expect(reasons(await guest({ products: [soap], payment: { method: 'card', storeCredit: { amount: 1 } } }))).toEqual(['customer_not_found'])
    expect(reasons(await guest({ booking: seat({ redemptionSource: 'membership_credit', membershipId: ID.membership }) }))).toEqual(['membership_not_found'])
  })

  it("doesn't see someone's add-on credits", async () => {
    const result = await guest({ booking: seat({ addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] }) })
    expect(reasons(result)).toEqual(['addon_membership_not_found'])
  })
})

describe('refusals, in the old order', () => {
  it('an empty basket and an unknown customer', async () => {
    expect(reasons(await quote({}))).toEqual(['empty_order'])
    expect(reasons(await quote({ customerId: ID.band, products: [soap] }))).toEqual(['customer_not_found'])
  })

  it('the removed gift card source, with its words', async () => {
    const result = await quote({ booking: seat({ redemptionSource: 'gift_card' }) })
    expect(result.problems).toEqual([
      { stage: 'validation', reason: 'gift_card_source_removed', message: 'Gift Card is no longer a booking option. Choose Paid and apply the gift card at payment.' },
    ])
  })

  it('a booking: session, guests, credits and capacity', async () => {
    const reason = async (booking: unknown) => (await quote({ booking } as Record<string, unknown>))?.problems[0]
    expect(await reason(seat({ sessionId: ID.band }))).toMatchObject({ stage: 'booking', reason: 'session_not_found', bookingFailureReason: 'session_not_found' })
    expect(await reason(seat({ guests: [] }))).toMatchObject({ reason: 'no_guests' })
    expect(await reason(seat({ guests: Array.from({ length: 7 }, () => sam), guestsOver18Confirmed: true }))).toMatchObject({ reason: 'too_many_guests' })
    expect(await reason(seat({ guests: [sam, { name: ' ' }] }))).toMatchObject({ reason: 'guest_name_required', guestIndex: 1 })
    expect(await reason(seat({ guests: [{ name: 'Sam' }] }))).toMatchObject({ reason: 'guest_dob_required', guestIndex: 0 })
    expect(await reason(seat({ redemptionSource: 'nonsense' }))).toMatchObject({ reason: 'invalid_redemption_source' })
    expect(await reason(seat({ redemptionSource: 'membership_credit' }))).toMatchObject({ reason: 'membership_id_required' })
    expect(await reason(seat({ redemptionSource: 'session_pass_credit' }))).toMatchObject({ reason: 'session_pass_id_required' })
  })

  it('a credit on a private booking, before anything else about it', async () => {
    const result = await quote({ booking: seat({ sessionId: ID.privateSession, redemptionSource: 'membership_credit' }) })
    expect(result.problems).toEqual([{ stage: 'booking', reason: 'private_booking_requires_real_payment' }])
  })

  it('the first problem of several is the one the order would give', async () => {
    const result = await quote({ products: [{ ...soap, quantity: 6 }], promoCode: 'NOPE', booking: seat({ guests: [] }) })
    expect(reasons(result)).toEqual(['no_guests', 'insufficient_stock', 'promo_code_invalid'])
  })

  it('a buy-new booking works its promo out first', async () => {
    const result = await quote({ booking: buyNew({ guests: [] }), ...monthly, promoCode: 'NOPE' })
    expect(reasons(result).slice(0, 2)).toEqual(['promo_code_invalid', 'no_guests'])
  })

  it('stock is shared between two lines of one variant', async () => {
    const result = await quote({ products: [{ ...soap, quantity: 3 }, { ...soap, quantity: 3 }] })
    expect(result.problems).toEqual([{ stage: 'product', reason: 'insufficient_stock', productVariantId: ID.variant }])
  })

  it('add-on credits are shared between two lines', async () => {
    const line = { ...towel, quantity: 2, redemptionSource: 'membership_credit', membershipId: ID.membership }
    const result = await quote({ customerId: ID.member, booking: seat({ guests: [sam], addons: [line, line] }) })
    expect(reasons(result)).toEqual(['insufficient_addon_membership_credit'])
  })

  it('an event: who may book, attendees and places', async () => {
    const reason = async (event: unknown) => (await quote({ event } as Record<string, unknown>))?.problems[0]
    expect(await reason({ ...eventPlaces, eventId: ID.band })).toMatchObject({ stage: 'event', reason: 'event_not_found', message: 'That event no longer exists.' })
    expect(await reason({ ...eventPlaces, attendees: [] })).toMatchObject({ reason: 'event_places_invalid' })
    expect(await reason({ ...eventPlaces, accountHolderAttending: false })).toMatchObject({ reason: 'event_account_holder_invalid' })
    expect(await reason({ ...eventPlaces, guestsOver18Confirmed: false })).toMatchObject({ reason: 'guests_over_18_not_confirmed' })
    expect(await reason({ ...eventPlaces, attendees: [{ name: 'Young', dateOfBirth: '2015-01-01', isAccountHolder: true }] })).toMatchObject({
      reason: 'event_attendee_under_18',
      message: 'Young must be 18 or over on the event date.',
    })
  })

  it('an event with too few places left', async () => {
    const event = await insert(db, 'events', {
      name: 'Nearly full',
      starts_at: '2026-12-02 19:00:00+00',
      ends_at: '2026-12-02 21:00:00+00',
      refund_cutoff_at: '2026-12-01 19:00:00+00',
      capacity: 1,
      access: 'public',
      active: true,
      price_public: '40.00',
      price_pre_herd: '30.00',
      price_herd: '20.00',
    })
    const result = await quote({ event: { ...eventPlaces, eventId: event } })
    expect(result.problems).toEqual([{ stage: 'event', reason: 'event_full', message: 'Not enough places are left on this event (or it has just gone off sale).' }])
  })

  it('an event with no prices reads without an error: it can only be off sale', async () => {
    // quote_event raises on missing prices, and events_on_sale_complete keeps them off an active event.
    const event = await insert(db, 'events', { name: 'Unpriced', capacity: 10, access: 'public', active: false })
    const result = await quote({ event: { ...eventPlaces, eventId: event } })
    expect(result.problems).toEqual([{ stage: 'event', reason: 'event_not_on_sale', message: 'That event is not on sale.' }])
  })

  it('a session with no band reads without an error, as a problem', async () => {
    const session = await insert(db, 'sessions', {
      id: '10000000-0000-4000-8000-0000000000f1',
      service_type_id: ID.serviceType,
      start_time: '2026-11-20 10:00:00+00',
      end_time: '2026-11-20 11:00:00+00',
      type: 'public',
      capacity: 10,
    })
    const result = await quote({ booking: seat({ sessionId: session }) })
    expect(reasons(result)).toEqual(['band_unpriced'])
  })

  it('delivery: an address and a postage method are required', async () => {
    const none = await quote({ products: [candle] })
    const part = await quote({ products: [candle], shippingAddress: { name: 'Sam' }, postageMethod: 'standard' })
    expect(reasons(none)).toEqual(['shipping_address_required', 'postage_method_required'])
    expect(part.problems[0]?.message).toBe('The delivery address is incomplete — address line 1, town/city, postcode are required.')
  })
})

describe('Q24: a promo on a private booking', () => {
  it('a percentage comes off the whole price, and shows on the booking and its line', async () => {
    const result = await quote({ booking: privateSeats(), promoCode: PROMO.percent })
    expect(result.problems).toEqual([])
    expect(result.promo?.perLine).toEqual([{ key: 'booking', discount: 10 }])
    expect(result.booking).toMatchObject({ price: 100, discount: 10 })
    expect(result.lines).toMatchObject([{ kind: 'booking', key: 'booking', lineTotal: 100, discount: 10 }])
    expect(result.totals).toMatchObject({ orderTotal: 100, promoDiscount: 10, amountDue: 90, toCollect: { card: 90, reader: 90, cash: 90 } })
  })

  it('seats carry no share, as they have no price', async () => {
    const result = await quote({ booking: privateSeats(), promoCode: PROMO.percent })
    expect(result.booking?.seats.map((s) => [s.unitPrice, s.discount])).toEqual([
      [null, 0],
      [null, 0],
    ])
  })

  it('a fixed code', async () => {
    const result = await quote({ booking: privateSeats(), promoCode: PROMO.fixed })
    expect(result.totals).toMatchObject({ promoDiscount: 5, amountDue: 95 })
  })

  it('a fixed code bigger than the price stops at the price, and no method is needed', async () => {
    const result = await quote({ booking: privateSeats(), promoCode: PROMO.big, payment: {} })
    expect(result.problems).toEqual([])
    expect(result.totals).toMatchObject({ promoDiscount: 100, amountDue: 0, toCollect: { card: 0, reader: 0, cash: 0 } })
  })

  it('a fixed code is spread over the other items by their prices', async () => {
    const result = await quote({ booking: privateSeats(), standaloneAddons: [towel], products: [soap], promoCode: PROMO.fixed })
    expect(result.promo?.perLine).toEqual([
      { key: 'booking', discount: 3.87 },
      { key: 'addon:0', discount: 0.19 },
      { key: 'product:0', discount: 0.94 },
    ])
    expect(result.totals.amountDue).toBe(124)
  })

  it('an attached add-on stays out of it', async () => {
    const result = await quote({ booking: privateSeats({ addons: [towel] }), promoCode: PROMO.percent })
    expect(result.totals).toMatchObject({ orderTotal: 105, promoDiscount: 10, amountDue: 95 })
  })

  it('the member-prices flag does not apply: a private price is not a member price', async () => {
    const result = await quote({ customerId: ID.member, booking: privateSeats(), promoCode: PROMO.percent })
    expect(result.problems).toEqual([])
    expect(result.totals.promoDiscount).toBe(10)
  })

  it('a code not for bookings finds nothing', async () => {
    const result = await quote({ booking: privateSeats(), promoCode: PROMO.productsOnly })
    expect(result.problems[0]).toMatchObject({ reason: 'promo_code_invalid', message: `Promo code "${PROMO.productsOnly}" cannot be used: Nothing in this basket is eligible for that promo code.` })
  })

  it('min spend counts the private price', async () => {
    expect((await quote({ booking: privateSeats(), promoCode: PROMO.spend80 })).totals.promoDiscount).toBe(10)
    expect((await quote({ booking: privateSeats(), promoCode: PROMO.spend150 })).problems[0]?.message).toContain('minimum spend')
  })

  it('expiry, max uses and one per customer are unchanged', async () => {
    expect((await quote({ booking: privateSeats(), promoCode: PROMO.expired })).problems[0]?.message).toContain('has expired')
    const used = async () => {
      const order = await insert(db, 'orders', { customer_id: ID.customer, order_total: '10.00', payment_status: 'paid', order_source: 'staff_created' })
      await insert(db, 'promo_code_redemptions', { promo_code_id: ID.promoPercent, order_id: order, customer_id: ID.customer, discount_amount: '1.00' })
    }
    const once = await during(
      async () => {
        await used()
        await db.query('UPDATE promo_codes SET one_use_per_customer = true WHERE id = $1', [ID.promoPercent])
      },
      () => quote({ booking: privateSeats(), promoCode: PROMO.percent })
    )
    expect(once.problems[0]?.message).toContain('already used')
    const full = await during(
      async () => {
        await used()
        await db.query('UPDATE promo_codes SET max_total_uses = 1 WHERE id = $1', [ID.promoPercent])
      },
      () => quote({ booking: privateSeats(), promoCode: PROMO.percent })
    )
    expect(full.problems[0]?.message).toContain('maximum number of uses')
  })

  it('a private session with no price yet has nothing to discount', async () => {
    const result = await during(
      () => db.query('UPDATE service_type_price_tiers SET price = NULL WHERE id = $1', [ID.privateTier]),
      () => quote({ booking: privateSeats(), products: [soap], promoCode: PROMO.percent })
    )
    expect(result.promo?.perLine.map((line) => line.key)).toEqual(['product:0'])
    expect(reasons(result)).toEqual(['price_pending'])
  })

  it('credit pays the discounted booking first, then spills onto the membership', async () => {
    const result = await quote({ booking: privateSeats(), ...monthly, promoCode: PROMO.big, payment: { method: 'card' } })
    expect(result.totals).toMatchObject({ promoDiscount: 140, nonMembershipDue: 0, membershipFirstPayment: 0 })
  })
})

describe('Q23: free postage is judged on the corrected price', () => {
  const sent = (unitPrice: number, quantity = 1) => ({ products: [{ ...candle, quantity, unitPrice, priceOverrideReason: 'Sent' }], ...shipped })

  it('without permission a sent price can not lose free postage either', async () => {
    const result = await quote(sent(1, 3))
    expect(result.postage).toMatchObject({ amount: 0, shippedValue: 60 })
  })

  it('with permission the price set is the one that counts, both ways', async () => {
    expect((await quote(sent(60), { allowPriceOverrides: true })).postage).toMatchObject({ amount: 0, shippedValue: 60 })
    expect((await quote(sent(1, 3), { allowPriceOverrides: true })).postage).toMatchObject({ amount: 4.95, shippedValue: 3 })
  })
})

describe('a standalone add-on on a credit', () => {
  const words = 'An add-on credit can only pay for an add-on on a booking. Charge this add-on, or add it to the booking.'

  it('is refused with a membership named', async () => {
    const result = await quote({ customerId: ID.member, standaloneAddons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] })
    expect(result.problems).toEqual([{ stage: 'validation', reason: 'standalone_addon_credit_not_allowed', message: words }])
  })

  it('is refused with none named', async () => {
    const result = await quote({ customerId: ID.member, standaloneAddons: [{ ...towel, redemptionSource: 'membership_credit' }] })
    expect(reasons(result)).toEqual(['standalone_addon_credit_not_allowed'])
  })

  it('an add-on on a booking can still use one', async () => {
    const line = { ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }
    const result = await quote({ customerId: ID.member, booking: seat({ guests: [sam], addons: [line] }) })
    expect(reasons(result)).toEqual([])
  })
})

describe('every createBooking reason', () => {
  const firstProblem = async (input: Parameters<typeof quote>[0], change: () => Promise<unknown> = async () => undefined) => {
    const result = await during(change, () => quote(input))
    return result.problems[0]
  }
  const asReason = (reason: string, extra: Record<string, unknown> = {}) => ({ stage: 'booking', reason, bookingFailureReason: reason, ...extra })

  it('session_blocked', async () => {
    const problem = await firstProblem({ booking: seat() }, () => db.query(`UPDATE sessions SET status = 'blocked' WHERE id = $1`, [ID.session]))
    expect(problem).toEqual(asReason('session_blocked'))
  })

  it('session_already_started', async () => {
    const problem = await firstProblem({ booking: seat() }, () =>
      db.query(`UPDATE sessions SET start_time = '2026-11-10 08:00:00+00', end_time = '2026-11-10 09:30:00+00' WHERE id = $1`, [ID.session])
    )
    expect(problem).toEqual(asReason('session_already_started'))
  })

  it('time_conflict', async () => {
    expect(await firstProblem({ booking: seat() }, () => seedOverlappingBooking(db))).toEqual(asReason('time_conflict'))
  })

  it('private_price_not_set', async () => {
    const problem = await firstProblem({ booking: privateSeats() }, () => db.query('UPDATE service_type_price_tiers SET min_people = 5 WHERE id = $1', [ID.privateTier]))
    expect(problem).toEqual(asReason('private_price_not_set'))
  })

  it('price_pending', async () => {
    const problem = await firstProblem({ booking: privateSeats() }, () => db.query('UPDATE service_type_price_tiers SET price = NULL WHERE id = $1', [ID.privateTier]))
    expect(problem).toEqual(asReason('price_pending'))
  })

  it("membership_not_found: someone else's", async () => {
    expect(await firstProblem({ booking: seat({ redemptionSource: 'membership_credit', membershipId: ID.membership }) })).toEqual(asReason('membership_not_found'))
  })

  it('insufficient_membership_credit', async () => {
    const problem = await firstProblem({ customerId: ID.member, booking: seat({ redemptionSource: 'membership_credit', membershipId: ID.membership }) }, () =>
      db.query('UPDATE membership_credit_periods SET credits_allocated = 0 WHERE id = $1', [ID.creditPeriod])
    )
    expect(problem).toEqual(asReason('insufficient_membership_credit'))
  })

  it("session_pass_not_found: someone else's", async () => {
    const problem = await firstProblem({ customerId: ID.member, booking: seat({ redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }) })
    expect(problem).toEqual(asReason('session_pass_not_found'))
  })

  it('insufficient_session_pass_credit: none left, and expired', async () => {
    const booking = seat({ redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass })
    expect(await firstProblem({ booking }, () => db.query('UPDATE customer_session_passes SET sessions_remaining = 0 WHERE id = $1', [ID.ownedPass]))).toEqual(asReason('insufficient_session_pass_credit'))
    expect(await firstProblem({ booking }, () => db.query(`UPDATE customer_session_passes SET expiry_date = '2026-11-09' WHERE id = $1`, [ID.ownedPass]))).toEqual(asReason('insufficient_session_pass_credit'))
  })

  it('a pass is good through its expiry date', async () => {
    const booking = seat({ redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass })
    expect(await firstProblem({ booking }, () => db.query(`UPDATE customer_session_passes SET expiry_date = '2026-11-10' WHERE id = $1`, [ID.ownedPass]))).toBeUndefined()
  })

  it('session_pass_not_valid_for_band', async () => {
    const problem = await firstProblem({ booking: seat({ sessionId: ID.peakSession, redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedCorePass }) }, () => seedCorePass(db))
    expect(problem).toEqual(asReason('session_pass_not_valid_for_band', { message: "This is a Core pass, which can't be used for Peak sessions. Choose another way to pay." }))
  })
})

describe('replacing an exhausted membership', () => {
  const replacing = (id: string) => buyNew({ cancelExhaustedMembershipId: id })
  const withExhausted = (extra?: string) => async () => {
    await seedExhaustedMembership(db, new FakeStripe())
    if (extra) await db.query(extra, [ID.exhausted])
  }

  it('goes through, with the new plan on the booking', async () => {
    const result = await during(withExhausted(), () => quote({ booking: replacing(ID.exhausted), ...monthly, payment: { method: 'card' } }))
    expect(result.problems).toEqual([])
    expect(result.booking?.seats[0]).toMatchObject({ payBy: 'membership_credit' })
    expect(result.totals.firstInvoice).toBe(40)
  })

  it("exhausted_membership_not_found: someone else's", async () => {
    expect(reasons(await quote({ booking: replacing(ID.membership), ...monthly }))).toEqual(['exhausted_membership_not_found'])
  })

  it('exhausted_membership_not_active: cancelled', async () => {
    const result = await during(withExhausted(`UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1`), () => quote({ booking: replacing(ID.exhausted), ...monthly }))
    expect(reasons(result)).toEqual(['exhausted_membership_not_active'])
  })

  it('exhausted_membership_not_active: past its last day, but not on it', async () => {
    const pastIt = await during(withExhausted(`UPDATE customer_memberships SET cancel_effective_date = '2026-11-09' WHERE id = $1`), () => quote({ booking: replacing(ID.exhausted), ...monthly }))
    expect(reasons(pastIt)).toEqual(['exhausted_membership_not_active'])
    const onIt = await during(withExhausted(`UPDATE customer_memberships SET cancel_effective_date = '2026-11-10' WHERE id = $1`), () => quote({ booking: replacing(ID.exhausted), ...monthly }))
    expect(reasons(onIt)).toEqual([])
  })
})

describe('migration 018: a membership past its last day', () => {
  const peak = () => quote({ customerId: ID.member, booking: seat({ sessionId: ID.peakSession }) })
  const core = () => quote({ customerId: ID.member, booking: seat() })

  it('the last day: member price on Peak, and a credit on Core', async () => {
    const [onPeak, onCore] = await during(() => lastDayIs('2026-11-10')(db), async () => [await peak(), await core()])
    expect(onPeak?.booking?.seats[0]).toMatchObject({ unitPrice: 21.68, discountPercent: 15 })
    expect(onCore?.booking?.seats[0]).toMatchObject({ creditEligible: true })
  })

  it('the day after: list price, and no credit', async () => {
    const [onPeak, onCore] = await during(() => lastDayIs('2026-11-09')(db), async () => [await peak(), await core()])
    expect(onPeak?.booking?.seats[0]).toMatchObject({ unitPrice: 25.5, discountPercent: 0 })
    expect(onCore?.booking?.seats[0]).toMatchObject({ creditEligible: false })
  })

  it('the seat, the add-ons and the credit all stop on the same day', async () => {
    const result = await during(() => lastDayIs('2026-11-09')(db), () =>
      quote({ customerId: ID.member, booking: seat({ redemptionSource: 'membership_credit', membershipId: ID.membership }), standaloneAddons: [{ addonId: ID.robe, quantity: 1 }] })
    )
    expect(reasons(result)).toEqual(['membership_not_found'])
    expect(result.lines.find((line) => line.kind === 'addon')).toMatchObject({ unitPrice: 10 })
  })

  it('the date is London, not UTC: 00:30 in summer is already the next day', async () => {
    const discountAt = async (now: string) => {
      vi.setSystemTime(new Date(now))
      const result = await during(() => lastDayIs('2026-09-01')(db), peak)
      return result.booking?.seats[0]?.discountPercent
    }
    const clock = Date.now()
    try {
      expect(await discountAt('2026-09-01T22:30:00Z')).toBe(15)
      expect(await discountAt('2026-09-01T23:30:00Z')).toBe(0)
    } finally {
      vi.setSystemTime(clock)
    }
  })
})

describe('Q3 on the reader', () => {
  const reader = { method: 'reader', readerSaveCard: true }

  it('buy-new membership with a pass: both lines, and the one tap takes both', async () => {
    const result = await quote({ booking: buyNew(), sessionPassTypeId: ID.passType, ...monthly, payment: reader })
    expect(result.problems).toEqual([])
    expect(result.lines.map((l) => l.kind)).toEqual(['membership', 'session_pass', 'booking'])
    expect(result.totals).toMatchObject({ orderTotal: 90, firstInvoice: 0, membershipToPay: 40, toCollect: { reader: 90 } })
  })

  it('buy-new pass with a membership: both lines, and the one tap takes both', async () => {
    const result = await quote({ booking: seat({ redemptionSource: 'buy_new_session_pass' }), sessionPassTypeId: ID.passType, ...monthly, payment: reader })
    expect(result.problems).toEqual([])
    expect(result.lines.map((l) => l.kind)).toEqual(['membership', 'session_pass', 'booking'])
    expect(result.totals).toMatchObject({ orderTotal: 90, firstInvoice: 0, toCollect: { reader: 90 } })
  })
})

describe('round trips', () => {
  function counting(inner: Queryable): Queryable & { count: number } {
    const counter = {
      count: 0,
      query<Row>(sql: string, params?: readonly SqlParam[]) {
        counter.count++
        return inner.query<Row>(sql, params)
      },
    }
    return counter as Queryable & { count: number }
  }

  const everything = {
    customerId: ID.member,
    booking: twoSeats({
      guests: [sam, alex],
      redemptionSource: 'buy_new_membership',
      addons: [towel, { ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }],
      specialRequests: 'Step-free access',
    }),
    standaloneAddons: [towel, { addonId: ID.robe, quantity: 1 }],
    products: [soap, candle, { productVariantId: ID.mugVariant, quantity: 1, fulfillmentChoice: 'shipping' }],
    ...monthly,
    sessionPassTypeId: ID.passType,
    giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'shipping' },
    event: eventPlaces,
    promoCode: PROMO.percent,
    ...shipped,
    payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 10 }, storeCredit: { amount: 5 } },
  }

  it.each([
    ['a typical booking', { customerId: ID.customer, booking: twoSeats({ addons: [towel] }), payment: { method: 'cash' } }],
    ['one of everything', everything],
    ['an empty basket', { customerId: ID.customer }],
  ])('%s is one round trip', async (_, input) => {
    const q = counting(db)
    await priceBasket(q, input as BasketQuoteInput)
    expect(q.count).toBe(1)
  })

  it('one of everything really was priced', async () => {
    const result = await priceBasket(db, everything as BasketQuoteInput)
    expect(result.lines.map((l) => l.kind)).toEqual(['membership', 'session_pass', 'booking', 'event', 'addon', 'addon', 'product', 'product', 'product', 'gift_card', 'postage'])
    expect(result.totals.promoDiscount).toBeGreaterThan(0)
  })
})

describe('W55a (W55 + W56 review S4): an item on sale with nothing to charge for it is refused, never sold free', () => {
  const unpriceProduct = () => db.query('UPDATE products SET base_price = NULL, member_price = NULL, sale_price = NULL WHERE id = $1', [ID.product])
  const unpriceTowel = () => db.query('UPDATE addons SET base_price = NULL, member_price = NULL, sale_price = NULL WHERE id = $1', [ID.addon])
  // Test data only: `set` is one of this block's fixed strings.
  const passType = (set: string) => () => {
    const sql = `UPDATE session_pass_types SET ${set} WHERE id = $1`
    return db.query(sql, [ID.passType])
  }

  it('a product with no price set at all, in its words, naming the variant', async () => {
    const result = await during(unpriceProduct, () => quote({ products: [soap] }))
    expect(result.problems).toEqual([{ stage: 'validation', reason: 'product_price_not_set', productVariantId: ID.variant, message: PRODUCT_PRICE_NOT_SET_MESSAGE }])
  })

  it('a product with any one price set is sold at it, as before', async () => {
    const saleOnly = await during(
      () => db.query('UPDATE products SET base_price = NULL, member_price = NULL, sale_price = 9 WHERE id = $1', [ID.product]),
      () => quote({ products: [soap] })
    )
    expect(saleOnly.problems).toEqual([])
    expect(saleOnly.lines[0]).toMatchObject({ kind: 'product', unitPrice: 9 })
    // A variant's own price override is a price too (nothing sets one any more; New Order charges it first).
    const override = await during(
      async () => {
        await unpriceProduct()
        await db.query('UPDATE product_variants SET price_override = 7 WHERE id = $1', [ID.variant])
      },
      () => quote({ products: [soap] })
    )
    expect(override.problems).toEqual([])
    expect(override.lines[0]).toMatchObject({ kind: 'product', unitPrice: 7 })
  })

  it('an add-on with no price set at all: on its own, on a booking, and on a booking paid with an add-on credit', async () => {
    for (const input of [{ standaloneAddons: [towel] }, { booking: seat({ addons: [towel] }) }, { customerId: ID.member, booking: seat({ addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] }) }]) {
      const result = await during(unpriceTowel, () => quote(input))
      expect(result.problems.find((problem) => problem.reason === 'addon_price_not_set'), JSON.stringify(input)).toEqual({ stage: 'validation', reason: 'addon_price_not_set', message: ADDON_PRICE_NOT_SET_MESSAGE })
    }
  })

  it.each([
    ['no price', 'price = NULL'],
    ['no sessions', 'sessions_included = NULL'],
    ['0 sessions', 'sessions_included = 0'],
  ])('a pass bought on its own with %s', async (_label, set) => {
    const result = await during(passType(set), () => quote({ sessionPassTypeId: ID.passType }))
    expect(result.problems).toEqual([{ stage: 'validation', reason: 'session_pass_type_not_set_up', message: PASS_TYPE_NOT_SET_UP_MESSAGE }])
    expect(result.lines).toEqual([])
  })

  it('a pass bought for a booking: no price refused in the new words; no sessions keeps its older refusal', async () => {
    const buyNewPass = { booking: seat({ redemptionSource: 'buy_new_session_pass' }), sessionPassTypeId: ID.passType }
    expect(reasons(await during(passType('price = NULL'), () => quote(buyNewPass)))).toContain('session_pass_type_not_set_up')
    const noSessions = reasons(await during(passType('sessions_included = 0'), () => quote(buyNewPass)))
    expect(noSessions).toContain('booking_session_pass_type_grants_no_sessions')
    expect(noSessions).not.toContain('session_pass_type_not_set_up')
  })

  it('a pass at £0 with sessions is a price set, and sold as before', async () => {
    const result = await during(passType('price = 0'), () => quote({ sessionPassTypeId: ID.passType }))
    expect(result.problems).toEqual([])
    expect(result.lines).toEqual([expect.objectContaining({ kind: 'session_pass', unitPrice: 0 })])
  })
})

describe('W55b (W55a noticed 1): a member price only is not a free price for a non-member', () => {
  const soapMemberOnly = () => db.query('UPDATE products SET base_price = NULL, sale_price = NULL, member_price = 9 WHERE id = $1', [ID.product])
  const towelMemberOnly = () => db.query('UPDATE addons SET base_price = NULL, sale_price = NULL, member_price = 4 WHERE id = $1', [ID.addon])

  it('a product: a member buys it at the member price; a non-member and a walk-in are refused in its words, naming the variant', async () => {
    const member = await during(soapMemberOnly, () => quote({ customerId: ID.member, products: [soap] }))
    expect(member.problems).toEqual([])
    expect(member.lines[0]).toMatchObject({ kind: 'product', unitPrice: 9 })
    for (const customerId of [ID.customer, undefined]) {
      const result = await during(soapMemberOnly, () => quote({ customerId, products: [soap] }))
      expect(result.problems, String(customerId)).toEqual([
        { stage: 'validation', reason: 'product_price_not_set', productVariantId: ID.variant, message: PRODUCT_MEMBER_PRICE_ONLY_MESSAGE },
      ])
    }
  })

  it("a product's variant override still sells to a non-member; no price at all keeps W55a's words", async () => {
    const override = await during(
      async () => {
        await soapMemberOnly()
        await db.query('UPDATE product_variants SET price_override = 7 WHERE id = $1', [ID.variant])
      },
      () => quote({ products: [soap] })
    )
    expect(override.problems).toEqual([])
    expect(override.lines[0]).toMatchObject({ kind: 'product', unitPrice: 7 })
    const none = await during(
      () => db.query('UPDATE products SET base_price = NULL, sale_price = NULL, member_price = NULL WHERE id = $1', [ID.product]),
      () => quote({ products: [soap] })
    )
    expect(none.problems[0]?.message).toBe(PRODUCT_PRICE_NOT_SET_MESSAGE)
  })

  it('an add-on, on its own and on a booking: a member buys it at the member price; a non-member is refused in its words', async () => {
    for (const lines of [{ standaloneAddons: [towel] }, { booking: seat({ addons: [towel] }) }]) {
      const member = await during(towelMemberOnly, () => quote({ customerId: ID.member, ...lines }))
      expect(member.problems, JSON.stringify(lines)).toEqual([])
      // An add-on on a booking is priced on the booking's quote; one on its own is its own line.
      const sold = 'booking' in lines ? member.booking?.addons[0] : member.lines.find((line) => line.kind === 'addon')
      expect(sold, JSON.stringify(lines)).toMatchObject({ unitPrice: 4 })
      const result = await during(towelMemberOnly, () => quote(lines))
      expect(
        result.problems.find((problem) => problem.reason === 'addon_price_not_set'),
        JSON.stringify(lines)
      ).toEqual({ stage: 'validation', reason: 'addon_price_not_set', message: ADDON_MEMBER_PRICE_ONLY_MESSAGE })
    }
  })

  it('a sale price alone is a price for a non-member, as before', async () => {
    const result = await during(
      () => db.query('UPDATE addons SET base_price = NULL, sale_price = 3, member_price = 4 WHERE id = $1', [ID.addon]),
      () => quote({ standaloneAddons: [towel] })
    )
    expect(result.problems).toEqual([])
    expect(result.lines[0]).toMatchObject({ kind: 'addon', unitPrice: 3 })
  })
})

// Test data only: each statement is one of these tests' own. The towel's and the soap's prices: base, sale, member,
// and for the soap its one variant's own price.
const towelAt = (base: number | null, sale: number | null, member: number | null) => () =>
  db.query('UPDATE addons SET base_price = $1, sale_price = $2, member_price = $3 WHERE id = $4', [base, sale, member, ID.addon])
const soapAt = (base: number | null, sale: number | null, member: number | null, override: number | null = null) => async () => {
  await db.query('UPDATE products SET base_price = $1, sale_price = $2, member_price = $3 WHERE id = $4', [base, sale, member, ID.product])
  await db.query('UPDATE product_variants SET price_override = $1 WHERE id = $2', [override, ID.variant])
}

// Brief W74b (Wayne's WQ46, 24 Nov 2026). Before it a member was charged the member price even when the sale price
// (or the size's own price) was lower: £24 against a non-member's £21 in W74a's example.
describe('WQ46 (W74b): a member pays the lower of the member price and what a non-member pays', () => {
  const unit = (result: BasketQuoteOutput, kind: 'product' | 'addon') => {
    const line = result.lines.find((one) => one.kind === kind)
    return [line?.unitPrice, line?.systemUnitPrice]
  }
  const everyone = [ID.customer, undefined] as const

  it('a product: the sale price when it is below the member price (£21, not £24); the member price when that is lower; one price when they are the same; a non-member as before', async () => {
    // Sale lower: base £28, sale £21, member £24.
    const saleLower = soapAt(28, 21, 24)
    const member = await during(saleLower, () => quote({ customerId: ID.member, products: [soap] }))
    expect(member.problems).toEqual([])
    expect(unit(member, 'product')).toEqual([21, 21])
    expect(member.totals.amountDue).toBe(42)
    for (const customerId of everyone) expect(unit(await during(saleLower, () => quote({ customerId, products: [soap] })), 'product'), String(customerId)).toEqual([21, 21])
    // Member lower: sale £26, member £24.
    const memberLower = soapAt(28, 26, 24)
    expect(unit(await during(memberLower, () => quote({ customerId: ID.member, products: [soap] })), 'product')).toEqual([24, 24])
    for (const customerId of everyone) expect(unit(await during(memberLower, () => quote({ customerId, products: [soap] })), 'product'), String(customerId)).toEqual([26, 26])
    // Equal.
    for (const customerId of [ID.member, ...everyone]) expect(unit(await during(soapAt(28, 24, 24), () => quote({ customerId, products: [soap] })), 'product'), String(customerId)).toEqual([24, 24])
    // No sale, and the base below the member price: the base.
    expect(unit(await during(soapAt(20, null, 24), () => quote({ customerId: ID.member, products: [soap] })), 'product')).toEqual([20, 20])
    // A member price only, and no member price.
    expect(unit(await during(soapAt(null, null, 9), () => quote({ customerId: ID.member, products: [soap] })), 'product')).toEqual([9, 9])
    expect(unit(await during(soapAt(12, 9, null), () => quote({ customerId: ID.member, products: [soap] })), 'product')).toEqual([9, 9])
  })

  it("a size with its own price and a sale: the member pays the size's price when it is below the member price (£7, not £8), and the member price when it is above (£8, not £10); never the sale, which nobody pays for that size", async () => {
    const below = soapAt(12, 9, 8, 7)
    expect(unit(await during(below, () => quote({ customerId: ID.member, products: [soap] })), 'product')).toEqual([7, 7])
    expect(unit(await during(below, () => quote({ products: [soap] })), 'product')).toEqual([7, 7])
    const above = soapAt(12, 9, 8, 10)
    expect(unit(await during(above, () => quote({ customerId: ID.member, products: [soap] })), 'product')).toEqual([8, 8])
    expect(unit(await during(above, () => quote({ products: [soap] })), 'product')).toEqual([10, 10])
    // The sale (£9) is below the member price (£20) but this size sells at £35: the member pays £20.
    expect(unit(await during(soapAt(30, 9, 20, 35), () => quote({ customerId: ID.member, products: [soap] })), 'product')).toEqual([20, 20])
  })

  it('an add-on, on its own and on a booking: the same', async () => {
    for (const lines of [{ standaloneAddons: [towel] }, { booking: seat({ addons: [towel] }) }]) {
      const sold = (result: BasketQuoteOutput) => {
        expect(result.problems, JSON.stringify(lines)).toEqual([])
        const line = 'booking' in lines ? result.booking?.addons[0] : result.lines.find((one) => one.kind === 'addon')
        return [line?.unitPrice, line?.systemUnitPrice]
      }
      // Sale lower: base £5, sale £3, member £4. Before W74b the member paid £4.
      expect(sold(await during(towelAt(5, 3, 4), () => quote({ customerId: ID.member, ...lines }))), JSON.stringify(lines)).toEqual([3, 3])
      expect(sold(await during(towelAt(5, 3, 4), () => quote(lines))), JSON.stringify(lines)).toEqual([3, 3])
      // Member lower: sale £4.50, member £4.
      expect(sold(await during(towelAt(5, 4.5, 4), () => quote({ customerId: ID.member, ...lines }))), JSON.stringify(lines)).toEqual([4, 4])
      expect(sold(await during(towelAt(5, 4.5, 4), () => quote(lines))), JSON.stringify(lines)).toEqual([4.5, 4.5])
      // Equal; the base below the member price; a member price only; no member price.
      expect(sold(await during(towelAt(5, 4, 4), () => quote({ customerId: ID.member, ...lines }))), JSON.stringify(lines)).toEqual([4, 4])
      expect(sold(await during(towelAt(5, null, 6), () => quote({ customerId: ID.member, ...lines }))), JSON.stringify(lines)).toEqual([5, 5])
      expect(sold(await during(towelAt(null, null, 4), () => quote({ customerId: ID.member, ...lines }))), JSON.stringify(lines)).toEqual([4, 4])
      expect(sold(await during(towelAt(5, 3, null), () => quote({ customerId: ID.member, ...lines }))), JSON.stringify(lines)).toEqual([3, 3])
    }
  })

  it('the price a screen sends: the lower price is the system price (no reason asked for); the member price sent instead is a changed price and needs one', async () => {
    const saleLower = soapAt(28, 21, 24)
    const right = await during(saleLower, () => quote({ customerId: ID.member, products: [{ ...soap, unitPrice: 21 }] }, { allowPriceOverrides: true }))
    expect(right.problems).toEqual([])
    expect(right.lines[0]).toMatchObject({ unitPrice: 21, systemUnitPrice: 21, priceOverrideReason: null })
    const old = await during(saleLower, () => quote({ customerId: ID.member, products: [{ ...soap, unitPrice: 24 }] }, { allowPriceOverrides: true }))
    expect(reasons(old)).toEqual(['price_override_reason_required'])
    // Without Manage pricing a sent price is ignored: the member is charged £21 whatever the screen showed.
    const ignored = await during(saleLower, () => quote({ customerId: ID.member, products: [{ ...soap, unitPrice: 24 }] }))
    expect(ignored.problems).toEqual([])
    expect(unit(ignored, 'product')).toEqual([21, 21])
    const towelRight = await during(towelAt(5, 3, 4), () => quote({ customerId: ID.member, standaloneAddons: [{ ...towel, unitPrice: 3 }] }, { allowPriceOverrides: true }))
    expect(towelRight.problems).toEqual([])
    expect(reasons(await during(towelAt(5, 3, 4), () => quote({ customerId: ID.member, standaloneAddons: [{ ...towel, unitPrice: 4 }] }, { allowPriceOverrides: true })))).toEqual(['price_override_reason_required'])
  })

  it('a code that skips member prices: a member at the sale price gets it, as a non-member does (£18.90 each); a member at the member price does not', async () => {
    // Sale £21 below the member price £24: both pay £21, and 10% comes off both.
    const saleLower = soapAt(28, 21, 24)
    for (const customerId of [ID.member, ID.customer]) {
      const result = await during(saleLower, () => quote({ customerId, products: [soap], promoCode: PROMO.percent }))
      expect(result.problems, customerId).toEqual([])
      expect([result.totals.promoDiscount, result.totals.amountDue], customerId).toEqual([4.2, 37.8])
    }
    // The member price £24 below the sale £26: the member's line is member-priced, and the code has nothing to come off.
    const memberLower = await during(soapAt(28, 26, 24), () => quote({ customerId: ID.member, products: [soap], promoCode: PROMO.percent }))
    expect(memberLower.problems[0]?.message).toBe(`Promo code "${PROMO.percent}" cannot be used: Nothing in this basket is eligible for that promo code.`)
    expect(memberLower.totals.amountDue).toBe(48)
    // The add-on the same.
    const towelSale = await during(towelAt(5, 3, 4), () => quote({ customerId: ID.member, standaloneAddons: [towel], promoCode: PROMO.percent }))
    expect([towelSale.problems, towelSale.totals.promoDiscount, towelSale.totals.amountDue]).toEqual([[], 0.3, 2.7])
  })

  // Wayne, 27 Nov 2026 (on W74b's review). Before, the member's line counted as member-priced at a tie, the code was
  // refused, and the member paid £48 against a non-member's £43.20.
  it('the member price the same as what everyone pays is not a member price: the code comes off the member\'s line as it does a non-member\'s (£43.20 each, not £48); a member-only item is still member-priced', async () => {
    // [base, sale, member, the size's own price]: the same as the sale; as the base with no sale; as the size's own price.
    for (const [base, sale, member, override] of [[28, 24, 24, null], [24, null, 24, null], [30, 26, 24, 24]] as const) {
      const tie = soapAt(base, sale, member, override)
      for (const customerId of [ID.member, ID.customer]) {
        const result = await during(tie, () => quote({ customerId, products: [soap], promoCode: PROMO.percent }))
        const label = JSON.stringify({ base, sale, member, override, customerId })
        expect(result.problems, label).toEqual([])
        expect([unit(result, 'product')[0], result.totals.promoDiscount, result.totals.amountDue], label).toEqual([24, 4.8, 43.2])
      }
    }
    // An add-on: sale £4, member £4.
    for (const customerId of [ID.member, ID.customer]) {
      const result = await during(towelAt(5, 4, 4), () => quote({ customerId, standaloneAddons: [towel], promoCode: PROMO.percent }))
      expect([result.problems, result.totals.promoDiscount, result.totals.amountDue], customerId).toEqual([[], 0.4, 3.6])
    }
    // A penny below what everyone pays is a member price again: the code has nothing to come off.
    const pennyBelow = await during(soapAt(28, 24.01, 24), () => quote({ customerId: ID.member, products: [soap], promoCode: PROMO.percent }))
    expect(pennyBelow.problems[0]?.message).toBe(`Promo code "${PROMO.percent}" cannot be used: Nothing in this basket is eligible for that promo code.`)
    // Only a member can buy it (no other price): a member price.
    const memberOnly = await during(soapAt(null, null, 9), () => quote({ customerId: ID.member, products: [soap], promoCode: PROMO.percent }))
    expect(memberOnly.problems[0]?.message).toBe(`Promo code "${PROMO.percent}" cannot be used: Nothing in this basket is eligible for that promo code.`)
    expect(memberOnly.totals.amountDue).toBe(18)
    const towelOnly = await during(towelAt(null, null, 4), () => quote({ customerId: ID.member, standaloneAddons: [towel], promoCode: PROMO.percent }))
    expect(towelOnly.problems[0]?.message).toBe(`Promo code "${PROMO.percent}" cannot be used: Nothing in this basket is eligible for that promo code.`)
    // A code set to apply on member prices takes the member's lower price too, as before.
    const onMemberPrices = await during(
      async () => {
        await soapAt(28, 26, 24)()
        await db.query('UPDATE promo_codes SET applies_on_member_prices = true WHERE id = $1', [ID.promoPercent])
      },
      () => quote({ customerId: ID.member, products: [soap], promoCode: PROMO.percent })
    )
    expect([onMemberPrices.problems, onMemberPrices.totals.promoDiscount, onMemberPrices.totals.amountDue]).toEqual([[], 4.8, 43.2])
  })

  it('the shop shows what the quote charges: each size\'s price is a non-member\'s line, and its member price (or, with none shown, its price) a member\'s', async () => {
    // [base, sale, member, the size's own price]: member lower, sale lower, equal, an override either side, one price only.
    const settings: Array<[number | null, number | null, number | null, number | null]> = [
      [28, 26, 24, null],
      [28, 21, 24, null],
      [28, 24, 24, null],
      [20, null, 24, null],
      [28, null, 24, null],
      [12, 9, 8, 7],
      [12, 9, 8, 10],
      [30, 9, 20, 35],
      [28, 21, null, null],
      [null, null, 9, null],
    ]
    for (const [base, sale, member, override] of settings) {
      const label = JSON.stringify({ base, sale, member, override })
      const shown = await during(
        async () => {
          await soapAt(base, sale, member, override)()
          await db.query("UPDATE products SET sanity_product_id = 'w74b-soap' WHERE id = $1", [ID.product])
        },
        async () => {
          const product = (await listShopProducts(db)).find((one) => one.sanityId === 'w74b-soap')
          return { product, forMember: await quote({ customerId: ID.member, products: [soap] }), forVisitor: await quote({ products: [soap] }) }
        }
      )
      const size = shown.product?.sizes[0]
      expect(size, label).toBeDefined()
      const pounds = (money: string | null | undefined) => (money === null || money === undefined ? null : Number(money))
      // A member's line is the member price shown, or the one price shown when a member pays no less.
      expect(unit(shown.forMember, 'product')[0], label).toBe(pounds(size?.memberPrice ?? size?.price))
      // A visitor's line is the price shown; with none shown (members only) the quote refuses the line.
      if (size?.price === null) expect(reasons(shown.forVisitor), label).toEqual(['product_price_not_set'])
      else expect(unit(shown.forVisitor, 'product')[0], label).toBe(pounds(size?.price))
      // "Member from" is only ever less than the price beside it, on the size and on the product.
      for (const prices of [size, shown.product]) if (prices?.memberPrice != null && prices.price !== null) expect(Number(prices.memberPrice), label).toBeLessThan(Number(prices.price))
    }
  })

  it("the booking panel's add-on price is what a visitor's quote charges, at a sale below the member price too", async () => {
    for (const [base, sale, member] of [[5, 3, 4], [5, 4.5, 4], [5, null, 4]] as const) {
      const shown = await during(
        async () => {
          await towelAt(base, sale, member)()
          await db.query("UPDATE addons SET sanity_addon_id = 'w74b-towel' WHERE id = $1", [ID.addon])
        },
        async () => ({ addon: (await listShopAddons(db)).find((one) => one.sanityId === 'w74b-towel'), forVisitor: await quote({ standaloneAddons: [towel] }) })
      )
      expect(Number(shown.addon?.price), JSON.stringify({ base, sale, member })).toBe(unit(shown.forVisitor, 'addon')[0])
    }
  })
})

describe("W70a (the W70 audit's S1): rules only a recording, or nothing, held", () => {

  it('S1 a: an add-on\'s sale price beats its base price (on its own and on a booking, £4 not £5); a member pays the member price, and the sale price when there is none', async () => {
    const onSale = towelAt(5, 4, 3)
    for (const [customerId, price] of [[ID.customer, 4], [undefined, 4], [ID.member, 3]] as const) {
      const alone = await during(onSale, () => quote({ customerId, standaloneAddons: [towel] }))
      expect(alone.problems, String(customerId)).toEqual([])
      expect(alone.lines[0], String(customerId)).toMatchObject({ kind: 'addon', unitPrice: price, systemUnitPrice: price })
    }
    const onBooking = await during(onSale, () => quote({ booking: seat({ addons: [towel] }) }))
    expect(onBooking.booking?.addons[0]).toMatchObject({ unitPrice: 4, charged: 4 })
    expect(onBooking.totals.amountDue).toBe(24)
    // No member price: a member pays the sale price too, never the base.
    expect((await during(towelAt(5, 4, null), () => quote({ customerId: ID.member, standaloneAddons: [towel] }))).totals.amountDue).toBe(4)
    // A sale price above the base is still the price set.
    expect((await during(towelAt(5, 6, null), () => quote({ standaloneAddons: [towel] }))).totals.amountDue).toBe(6)
  })

  it('S1 a: a product\'s sale price beats its base price (£9 not £12); a member pays the member price', async () => {
    const onSale = soapAt(12, 9, 8)
    expect((await during(onSale, () => quote({ products: [soap] }))).totals.amountDue).toBe(18)
    expect((await during(onSale, () => quote({ customerId: undefined, products: [soap] }))).totals.amountDue).toBe(18)
    expect((await during(onSale, () => quote({ customerId: ID.member, products: [soap] }))).totals.amountDue).toBe(16)
  })

  it('S1 b: a variant\'s own price beats the product\'s sale price (£7 not £9) and its base; a member pays the lower of it and the member price (WQ46, W74b: £7, not £8 as before), and the override when there is no member price', async () => {
    const all = soapAt(12, 9, 8, 7)
    expect((await during(all, () => quote({ products: [soap] }))).totals.amountDue).toBe(14)
    expect((await during(all, () => quote({ customerId: ID.member, products: [soap] }))).totals.amountDue).toBe(14)
    // The variant's own price above the member price: the member price.
    expect((await during(soapAt(12, 9, 8, 10), () => quote({ customerId: ID.member, products: [soap] }))).totals.amountDue).toBe(16)
    expect((await during(soapAt(12, 9, null, 7), () => quote({ customerId: ID.member, products: [soap] }))).totals.amountDue).toBe(14)
    expect((await during(soapAt(12, null, null, 7), () => quote({ products: [soap] }))).totals.amountDue).toBe(14)
    // Dearer than the sale price: it is still the variant's own price.
    expect((await during(soapAt(12, 9, null, 10), () => quote({ products: [soap] }))).totals.amountDue).toBe(20)
  })

  it('S1 g: free Standard postage starts at exactly the threshold, to the penny: £60.00 of candles is free at £60.00 and at £59.99, and £4.95 at £60.01; pennies that don\'t add up in floats still reach it', async () => {
    const threshold = (amount: string) => () => db.query('UPDATE postage_settings SET free_shipping_threshold = $1', [amount])
    const candles = (quantity: number) => quote({ products: [{ ...candle, quantity }], ...shipped })
    for (const [at, postage] of [['60.00', 0], ['59.99', 0], ['60.01', 4.95]] as const) {
      const result = await during(threshold(at), () => candles(3))
      expect(result.postage, at).toEqual({ method: 'standard', amount: postage, shippedValue: 60 })
    }
    // W14 (W7-6): £16.65 three times is 49.949999999999996 in floats, and £49.95 in pounds and pence.
    const pennies = await during(
      async () => {
        await threshold('49.95')()
        await db.query('UPDATE products SET base_price = 16.65 WHERE id = $1', [ID.candle])
      },
      () => candles(3)
    )
    expect(pennies.postage).toMatchObject({ amount: 0 })
    // Express is charged at and past it.
    expect((await during(threshold('60.00'), () => quote({ products: [{ ...candle, quantity: 3 }], ...shipped, postageMethod: 'express' }))).postage?.amount).toBe(9.95)
  })

  it('S1 h: a gift card works on its last day and not the day after', async () => {
    const pay = { products: [soap], payment: { giftCard: { giftCardId: ID.giftCard, amount: 24 } } }
    const expires = (day: string) => () => db.query('UPDATE gift_cards SET expiry_date = $1 WHERE id = $2', [day, ID.giftCard])
    const lastDay = await during(expires('2026-11-10'), () => quote(pay))
    expect(lastDay.problems).toEqual([])
    expect(lastDay.totals).toMatchObject({ giftCardApplied: 24, toCollect: { card: 0 } })
    expect(reasons(await during(expires('2026-11-09'), () => quote(pay)))).toEqual(['gift_card_expired'])
  })

  it('S1 i: a promo skips a place already at a member price: the member\'s own £30 place keeps it, the guest\'s £40 public place gets 10% off; a code for member prices takes both', async () => {
    const result = await quote({ event: eventPlaces, ...monthly, promoCode: PROMO.percent })
    expect(result.event?.places.map((p) => [p.priceLevel, p.unitPrice])).toEqual([['pre_herd', 30], ['public', 40]])
    expect(result.promo?.perLine).toEqual([
      { key: 'membership', discount: 4 },
      { key: 'event:2', discount: 4 },
    ])
    expect(result.totals.promoDiscount).toBe(8)
    // On its own, a Herd member's place has nothing the code may come off.
    const alone = await quote({ customerId: ID.member, event: { ...eventPlaces, attendees: [{ name: 'Mo Member', email: 'mo@example.com', dateOfBirth: '1985-05-05', isAccountHolder: true }] }, promoCode: PROMO.percent })
    expect(alone.event?.places.map((p) => [p.priceLevel, p.unitPrice])).toEqual([['herd', 20]])
    expect(alone.problems[0]?.message).toBe(`Promo code "${PROMO.percent}" cannot be used: Nothing in this basket is eligible for that promo code.`)
    const both = await during(
      () => db.query('UPDATE promo_codes SET applies_on_member_prices = true WHERE id = $1', [ID.promoPercent]),
      () => quote({ event: eventPlaces, ...monthly, promoCode: PROMO.percent })
    )
    expect(both.promo?.perLine).toEqual([
      { key: 'membership', discount: 4 },
      { key: 'event:1', discount: 3 },
      { key: 'event:2', discount: 4 },
    ])
  })
})

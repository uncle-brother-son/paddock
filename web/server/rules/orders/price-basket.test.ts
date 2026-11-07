import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BasketQuoteInput, BasketQuoteOutput } from '@/contracts'
import type { Db, Queryable, SqlParam } from '@/server/db'
import { insert } from '@/server/rules/testing/database'
import { startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { ID, lastDayIs, PROMO, seed, seedCorePass, seedExhaustedMembership, seedOverlappingBooking } from '@/server/rules/testing/replay/scenarios'
import { FakeStripe } from '@/server/stripe/fake'
import { priceBasket } from './price-basket'

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

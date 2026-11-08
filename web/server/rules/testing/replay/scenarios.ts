import { vi } from 'vitest'
import type { Db } from '@/server/db'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { insert } from '../database'
import type { Scenario, ScenarioContext } from './harness'

/** Fixed ids, so a recording can name what it was seeded with. */
export const ID = {
  staff: '10000000-0000-4000-8000-000000000001',
  serviceType: '10000000-0000-4000-8000-000000000002',
  band: '10000000-0000-4000-8000-000000000003',
  session: '10000000-0000-4000-8000-000000000004',
  customer: '10000000-0000-4000-8000-000000000005',
  addon: '10000000-0000-4000-8000-000000000006',
  product: '10000000-0000-4000-8000-000000000007',
  variant: '10000000-0000-4000-8000-000000000008',
  giftCard: '10000000-0000-4000-8000-000000000009',
  plan: '10000000-0000-4000-8000-00000000000a',
  terms: '10000000-0000-4000-8000-00000000000b',
  peakBand: '10000000-0000-4000-8000-00000000000c',
  peakTerms: '10000000-0000-4000-8000-00000000000d',
  peakSession: '10000000-0000-4000-8000-00000000000e',
  member: '10000000-0000-4000-8000-00000000000f',
  membership: '10000000-0000-4000-8000-000000000010',
  robe: '10000000-0000-4000-8000-000000000011',
  candle: '10000000-0000-4000-8000-000000000012',
  candleVariant: '10000000-0000-4000-8000-000000000013',
  mug: '10000000-0000-4000-8000-000000000014',
  mugVariant: '10000000-0000-4000-8000-000000000015',
  passType: '10000000-0000-4000-8000-000000000016',
  ownedPass: '10000000-0000-4000-8000-000000000017',
  event: '10000000-0000-4000-8000-000000000018',
  giftCardType: '10000000-0000-4000-8000-000000000019',
  giftCardPreset: '10000000-0000-4000-8000-00000000001a',
  privateType: '10000000-0000-4000-8000-00000000001b',
  privateSession: '10000000-0000-4000-8000-00000000001c',
  promoPercent: '10000000-0000-4000-8000-00000000001d',
  promoFixed: '10000000-0000-4000-8000-00000000001e',
  promoExpired: '10000000-0000-4000-8000-00000000001f',
  privateTier: '10000000-0000-4000-8000-000000000020',
  creditPeriod: '10000000-0000-4000-8000-000000000021',
  promoBig: '10000000-0000-4000-8000-000000000022',
  promoProducts: '10000000-0000-4000-8000-000000000023',
  promoSpend150: '10000000-0000-4000-8000-000000000024',
  promoSpend80: '10000000-0000-4000-8000-000000000025',
  exhausted: '10000000-0000-4000-8000-000000000026',
  exhaustedPeriod: '10000000-0000-4000-8000-000000000027',
  corePass: '10000000-0000-4000-8000-000000000028',
  ownedCorePass: '10000000-0000-4000-8000-000000000029',
  sauna2: '10000000-0000-4000-8000-00000000002a',
  conflicting: '10000000-0000-4000-8000-00000000002b',
  privateTierThreeToFour: '10000000-0000-4000-8000-00000000002c',
  privateTierFiveUp: '10000000-0000-4000-8000-00000000002d',
  peakPrivateSession: '10000000-0000-4000-8000-000000000040',
  laterPrivateSession: '10000000-0000-4000-8000-000000000041',
  laterPublicSession: '10000000-0000-4000-8000-000000000042',
}

/** All apply to everything, events included, and none to member prices, unless the name says. */
export const PROMO = { percent: 'ALLTEN', fixed: 'FIVER', expired: 'OLDCODE', big: 'TAKE150', productsOnly: 'SOAPONLY', spend150: 'SPEND150', spend80: 'SPEND80' }

const STRIPE_CUSTOMER = 'cus_seed'
const MONTHLY_PRICE = 'price_seed_monthly'

const YEARLY_PRICE = 'price_seed_yearly'
const MEMBER_STRIPE_CUSTOMER = 'cus_member'
const EVERY_KIND = ['booking', 'addon', 'product', 'session_pass', 'membership', 'event']

/** One of everything the scenarios sell. */
export async function seed(db: Db, stripe: FakeStripe): Promise<void> {
  await insert(db, 'staff', {
    id: ID.staff,
    role: 'admin',
    first_name: 'Jo',
    last_name: 'Staff',
    email: 'jo@example.com',
    can_issue_refunds: true,
    can_manage_pricing: true,
  })
  await insert(db, 'service_types', { id: ID.serviceType, name: 'Sauna', booking_type: 'public' })
  await insert(db, 'session_bands', { id: ID.band, code: 'core', name: 'Core', price: '20.00' })
  await insert(db, 'sessions', {
    id: ID.session,
    service_type_id: ID.serviceType,
    start_time: '2026-11-12 10:00:00+00',
    end_time: '2026-11-12 11:00:00+00',
    type: 'public',
    capacity: 10,
    band_id: ID.band,
  })
  await insert(db, 'customers', {
    id: ID.customer,
    first_name: 'Sam',
    last_name: 'Test',
    email: 'sam@example.com',
    date_of_birth: '1990-01-01',
    stripe_customer_id: STRIPE_CUSTOMER,
    saved_payment_method_id: 'pm_seed',
    saved_card_last4: '4242',
    saved_card_brand: 'visa',
    store_credit_balance: '30.00',
  })
  await insert(db, 'addons', { id: ID.addon, name: 'Towel', sku: 'TOWEL', base_price: '5.00' })
  await insert(db, 'products', { id: ID.product, name: 'Soap', base_price: '12.00', fulfillment_method: 'pickup' })
  await insert(db, 'product_variants', { id: ID.variant, product_id: ID.product, sku: 'SOAP-1', stock_quantity: 5 })
  await insert(db, 'gift_cards', {
    id: ID.giftCard,
    code: 'SEEDCARD',
    type: 'monetary',
    original_value: '40.00',
    remaining_balance: '40.00',
    origin: 'customer_purchase',
    expiry_date: '2030-01-01',
  })
  await insert(db, 'membership_plans', {
    id: ID.plan,
    name: 'Core',
    level: 'core',
    sessions_included: 4,
    price_monthly: '40.00',
    price_yearly: '400.00',
    stripe_product_id: 'prod_seed',
    stripe_price_id: MONTHLY_PRICE,
    stripe_price_id_yearly: YEARLY_PRICE,
  })
  await insert(db, 'membership_band_terms', {
    id: ID.terms,
    membership_level: 'core',
    band_id: ID.band,
    credit_eligible: true,
  })
  stripe.addCustomer(STRIPE_CUSTOMER)
  stripe.addCustomer(MEMBER_STRIPE_CUSTOMER)
  stripe.addPrice(MONTHLY_PRICE, 4000, 'month')
  stripe.addPrice(YEARLY_PRICE, 40000, 'year')

  // A Peak session, where a Core member pays 15% less and has no credit.
  await insert(db, 'session_bands', { id: ID.peakBand, code: 'peak', name: 'Peak', price: '25.50' })
  await insert(db, 'membership_band_terms', {
    id: ID.peakTerms,
    membership_level: 'core',
    band_id: ID.peakBand,
    credit_eligible: false,
    discount_percent: '15.00',
  })
  await insert(db, 'sessions', {
    id: ID.peakSession,
    service_type_id: ID.serviceType,
    start_time: '2026-11-14 18:00:00+00',
    end_time: '2026-11-14 19:00:00+00',
    type: 'public',
    capacity: 10,
    band_id: ID.peakBand,
  })

  // A Herd member with session and add-on credits. The period starts on the membership's monthly
  // anniversary, so allocate_membership_credit_periods finds it there and adds nothing.
  await insert(db, 'customers', {
    id: ID.member,
    first_name: 'Mo',
    last_name: 'Member',
    email: 'mo@example.com',
    date_of_birth: '1985-05-05',
    stripe_customer_id: MEMBER_STRIPE_CUSTOMER,
    saved_payment_method_id: 'pm_member',
    saved_card_last4: '4444',
    saved_card_brand: 'visa',
  })
  await insert(db, 'customer_memberships', {
    id: ID.membership,
    customer_id: ID.member,
    plan_id: ID.plan,
    start_date: '2026-01-10',
    subscription_status: 'active',
    billing_frequency: 'monthly',
    is_herd: true,
    addon_credits_remaining: 2,
  })
  await insert(db, 'membership_credit_periods', {
    id: ID.creditPeriod,
    membership_id: ID.membership,
    period_start: '2026-11-10',
    period_end: '2026-12-09',
    credits_allocated: 4,
  })

  await insert(db, 'addons', { id: ID.robe, name: 'Robe', sku: 'ROBE', base_price: '10.00', member_price: '8.00' })
  await insert(db, 'products', { id: ID.candle, name: 'Candle', base_price: '20.00', fulfillment_method: 'shipping' })
  await insert(db, 'product_variants', { id: ID.candleVariant, product_id: ID.candle, sku: 'CANDLE-1', stock_quantity: 5 })
  await insert(db, 'products', { id: ID.mug, name: 'Mug', base_price: '15.00', fulfillment_method: 'both' })
  await insert(db, 'product_variants', { id: ID.mugVariant, product_id: ID.mug, sku: 'MUG-1', stock_quantity: 5 })
  await db.query(`INSERT INTO postage_settings (standard_price, express_price, free_shipping_threshold) VALUES ('4.95', '9.95', '50.00')`)

  await insert(db, 'session_pass_types', { id: ID.passType, name: 'Five Sessions', price: '50.00', sessions_included: 5, level: 'all_access' })
  await insert(db, 'customer_session_passes', {
    id: ID.ownedPass,
    customer_id: ID.customer,
    pass_type_id: ID.passType,
    sessions_remaining: 3,
    expiry_date: '2030-01-01',
  })

  await insert(db, 'events', {
    id: ID.event,
    name: 'Full Moon Sauna',
    starts_at: '2026-12-01 19:00:00+00',
    ends_at: '2026-12-01 21:00:00+00',
    refund_cutoff_at: '2026-11-30 19:00:00+00',
    capacity: 10,
    access: 'public',
    active: true,
    price_public: '40.00',
    price_pre_herd: '30.00',
    price_herd: '20.00',
  })

  await insert(db, 'gift_card_types', {
    id: ID.giftCardType,
    name: 'Gift Card',
    custom_amount_enabled: true,
    custom_amount_min: '10.00',
    custom_amount_max: '200.00',
  })
  await insert(db, 'gift_card_presets', { id: ID.giftCardPreset, gift_card_type_id: ID.giftCardType, amount: '60.00' })

  await insert(db, 'service_types', { id: ID.privateType, name: 'Private Hire', booking_type: 'private' })
  await insert(db, 'sessions', {
    id: ID.privateSession,
    service_type_id: ID.privateType,
    start_time: '2026-11-13 10:00:00+00',
    end_time: '2026-11-13 12:00:00+00',
    type: 'private',
    capacity: 10,
    band_id: ID.band,
  })
  await insert(db, 'service_type_price_tiers', { id: ID.privateTier, service_type_id: ID.privateType, band_id: ID.band, min_people: 1, max_people: 10, price: '100.00' })

  await insert(db, 'promo_codes', { id: ID.promoPercent, code: PROMO.percent, discount_type: 'percentage', discount_value: '10', applies_to: EVERY_KIND })
  await insert(db, 'promo_codes', { id: ID.promoFixed, code: PROMO.fixed, discount_type: 'fixed', discount_value: '5', applies_to: EVERY_KIND })
  await insert(db, 'promo_codes', { id: ID.promoExpired, code: PROMO.expired, discount_type: 'percentage', discount_value: '10', applies_to: EVERY_KIND, expires_on: '2026-01-01' })
  await insert(db, 'promo_codes', { id: ID.promoBig, code: PROMO.big, discount_type: 'fixed', discount_value: '150', applies_to: EVERY_KIND })
  await insert(db, 'promo_codes', { id: ID.promoProducts, code: PROMO.productsOnly, discount_type: 'percentage', discount_value: '10', applies_to: ['product'] })
  await insert(db, 'promo_codes', { id: ID.promoSpend150, code: PROMO.spend150, discount_type: 'percentage', discount_value: '10', applies_to: EVERY_KIND, min_spend: '150.00' })
  await insert(db, 'promo_codes', { id: ID.promoSpend80, code: PROMO.spend80, discount_type: 'percentage', discount_value: '10', applies_to: EVERY_KIND, min_spend: '80.00' })
}

/** A membership Sam still pays for with no session credit left this period. */
export async function seedExhaustedMembership(db: Db, stripe: FakeStripe): Promise<void> {
  await insert(db, 'customer_memberships', {
    id: ID.exhausted,
    customer_id: ID.customer,
    plan_id: ID.plan,
    start_date: '2026-01-10',
    subscription_status: 'active',
    billing_frequency: 'monthly',
    stripe_subscription_id: 'sub_exhausted',
  })
  await insert(db, 'membership_credit_periods', {
    id: ID.exhaustedPeriod,
    membership_id: ID.exhausted,
    period_start: '2026-11-10',
    period_end: '2026-12-09',
    credits_allocated: 0,
  })
  stripe.addSubscription('sub_exhausted', STRIPE_CUSTOMER, MONTHLY_PRICE)
}

/** A pass that doesn't cover Peak, owned by Sam. */
export async function seedCorePass(db: Db): Promise<void> {
  await insert(db, 'session_pass_types', { id: ID.corePass, name: 'Core Five', price: '40.00', sessions_included: 5, level: 'core' })
  await insert(db, 'customer_session_passes', {
    id: ID.ownedCorePass,
    customer_id: ID.customer,
    pass_type_id: ID.corePass,
    sessions_remaining: 3,
    expiry_date: '2030-01-01',
  })
}

/** Someone else's confirmed booking in another service type, overlapping the Core session. */
export async function seedOverlappingBooking(db: Db): Promise<void> {
  await insert(db, 'service_types', { id: ID.sauna2, name: 'Cold Plunge', booking_type: 'public' })
  await insert(db, 'sessions', {
    id: ID.conflicting,
    service_type_id: ID.sauna2,
    start_time: '2026-11-12 10:30:00+00',
    end_time: '2026-11-12 11:30:00+00',
    type: 'public',
    capacity: 10,
    band_id: ID.band,
  })
  await insert(db, 'bookings', { session_id: ID.conflicting, customer_id: ID.member, party_size: 1, price_paid: '20', status: 'confirmed' })
}

/** The last day of Mo's membership, for the cancel_effective_date scenarios. */
export const lastDayIs = (date: string) => async (db: Db) => {
  await db.query('UPDATE customer_memberships SET cancel_effective_date = $1 WHERE id = $2', [date, ID.membership])
}

const twoGuests = [
  { name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01' },
  { name: 'Alex Guest', email: 'alex@example.com' },
]

const paidBooking = {
  sessionId: ID.session,
  guests: twoGuests,
  redemptionSource: 'paid',
  guestsOver18Confirmed: true,
  addons: [{ addonId: ID.addon, quantity: 1, unitPrice: 5, redemptionSource: 'paid', systemUnitPrice: 5 }],
}

const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12, systemUnitPrice: 12 }

interface Guest {
  name: string
  email: string
  dateOfBirth?: string
}
export const sam: Guest = { name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01' }
export const mo: Guest = { name: 'Mo Member', email: 'mo@example.com', dateOfBirth: '1985-05-05' }
const alex: Guest = { name: 'Alex Guest', email: 'alex@example.com' }
const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5 }
const candle = { productVariantId: ID.candleVariant, quantity: 1, unitPrice: 20, systemUnitPrice: 20 }
const address = { name: 'Sam Test', line1: '1 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' }
const shipped = { shippingAddress: address, postageMethod: 'standard' }
const monthly = { membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', membershipIdempotencyKey: 'replay-membership-key' }
export const paidSeat = (guests: Guest[] = [sam]) => ({
  sessionId: ID.session,
  guests,
  redemptionSource: 'paid',
  ...(guests.length > 1 ? { guestsOver18Confirmed: true } : {}),
})
const eventPlaces = {
  eventId: ID.event,
  accountHolderAttending: true,
  guestsOver18Confirmed: true,
  attendees: [
    { ...sam, isAccountHolder: true },
    { ...alex, isAccountHolder: false },
  ],
}
const cash = (amount: number) => ({ method: 'cash', confirmedCashAmount: amount })

/** One createOrder call on the shared seed, with anything the scenario needs set up first. */
function order(name: string, params: Record<string, unknown>, prepare?: (db: Db, stripe: FakeStripe) => Promise<void>): Scenario {
  return {
    name,
    async seed(db, stripe) {
      await seed(db, stripe)
      await prepare?.(db, stripe)
    },
    async run({ call }) {
      await call('createOrder', { customerId: ID.customer, ...params })
    },
  }
}

/** A part refund needs a reason, and the screen always sends one. */
export const goodwill = { reason: 'Goodwill' }

/** An order, then refunds on its booking, in the order given. */
function refunded(name: string, params: Record<string, unknown>, refunds: Array<Record<string, unknown>>): Scenario {
  return {
    name,
    seed,
    async run({ call }) {
      const placed = (await call('createOrder', { customerId: ID.customer, ...params })) as { bookingId: string }
      for (const refund of refunds) await call('refundBooking', { bookingId: placed.bookingId, ...refund, ...('amount' in refund ? goodwill : {}) })
    },
  }
}

/** A reader order saving the card, tapped and finalised, as a membership needs. */
function readerThenFinalise(name: string, params: Record<string, unknown>): Scenario {
  return {
    name,
    seed,
    async run({ call, stripe }) {
      const placed = (await call('createOrder', { customerId: ID.customer, ...params, payment: { method: 'reader', readerSaveCard: true } })) as {
        orderId: string
        pendingReaderPayment: { paymentIntentId: string }
      }
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { generatedCard: 'pm_reader_saved' })
      await call('finaliseReaderOrder', { orderId: placed.orderId })
    },
  }
}

const privateSeats = { ...paidSeat([sam, alex]), sessionId: ID.privateSession }
const promoOnCard = { booking: privateSeats, promoCode: PROMO.percent, payment: { method: 'card' } }
const promoInCash = { booking: privateSeats, promoCode: PROMO.percent, payment: cash(90) }
const freeBooking = { booking: privateSeats, promoCode: PROMO.big, payment: {} }
const toCard = [{ refundMethod: 'card' }]
const toCredit = [{ refundMethod: 'credit' }]
const noPricing = async (db: Db) => {
  await db.query('UPDATE staff SET can_manage_pricing = false')
}
export const memberCredit = { redemptionSource: 'membership_credit', membershipId: ID.membership }
const ownedPass = { redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }
const buyNewReplacing = (id: string) => ({ ...paidSeat(), redemptionSource: 'buy_new_membership', cancelExhaustedMembershipId: id })

/** The private price by group size: £100 up to two, £150 up to four, £200 above. */
async function tieredPrivatePrices(db: Db): Promise<void> {
  await db.query('UPDATE service_type_price_tiers SET max_people = 2 WHERE id = $1', [ID.privateTier])
  const tier = { service_type_id: ID.privateType, band_id: ID.band }
  await insert(db, 'service_type_price_tiers', { ...tier, id: ID.privateTierThreeToFour, min_people: 3, max_people: 4, price: '150.00' })
  await insert(db, 'service_type_price_tiers', { ...tier, id: ID.privateTierFiveUp, min_people: 5, max_people: 10, price: '200.00' })
}

export const bea = { guestName: 'Bea Guest', guestEmail: 'bea@example.com', guestsOver18Confirmed: true }
const cy = { guestName: 'Cy Guest', guestEmail: 'cy@example.com', guestsOver18Confirmed: true }

interface GuestAdded {
  /** The createOrder params. */
  order: Record<string, unknown>
  /** Sent on a second call, as the screen does once it has the price. Omit when nothing is due. */
  payment?: Record<string, unknown>
  /** Tap the reader and finalise, after the second call. */
  reader?: boolean
  /** Send the payment straight away, as a screen with an out-of-date figure would. */
  noQuote?: boolean
  extra?: Record<string, unknown>
  prepare?(db: Db, stripe: FakeStripe): Promise<void>
  refunds?: Array<Record<string, unknown>>
}

/** An order, a guest added the way the screen does it (price first, then payment), then refunds. */
function guestAdded(name: string, { order, payment, reader, noQuote, extra, prepare, refunds = [] }: GuestAdded): Scenario {
  return {
    name,
    async seed(db, stripe) {
      await seed(db, stripe)
      await prepare?.(db, stripe)
    },
    async run({ call, stripe }) {
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string }
      const guest = { bookingId, ...bea, ...extra }
      if (!noQuote) await call('addBookingGuest', guest)
      if (payment) {
        const paid = (await call('addBookingGuest', { ...guest, payment })) as { pendingReaderPayment?: { pendingId: string; paymentIntentId: string } }
        if (reader && paid.pendingReaderPayment) {
          stripe.completeReaderPayment(paid.pendingReaderPayment.paymentIntentId)
          await call('finaliseReaderPayment', { pendingId: paid.pendingReaderPayment.pendingId })
        }
      }
      for (const refund of refunds) await call('refundBooking', { bookingId, ...refund })
    },
  }
}

/** A guest in the next tier and an add-on on one card payment, then Cancel & Refund of both. */
function addonRefundedToo(name: string, order: Record<string, unknown>): Scenario {
  return {
    name,
    async seed(db, stripe) {
      await seed(db, stripe)
      await tieredPrivatePrices(db)
    },
    async run({ call }) {
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string }
      const added = (await call('addBookingGuest', {
        bookingId,
        ...bea,
        addons: [{ addonId: ID.addon, quantity: 1 }],
        payment: { method: 'card' },
      })) as { addonLineIds: string[] }
      await call('refundBooking', { bookingId, refundMethod: 'card', addonLineIds: added.addonLineIds })
    },
  }
}

/** Peak private prices (£140 up to two, £190 for three or four) on a session of their own, and a
 *  later session at the Core prices, to move a booking between. */
export async function sessionsToMoveBetween(db: Db): Promise<void> {
  await tieredPrivatePrices(db)
  const session = { service_type_id: ID.privateType, type: 'private', capacity: 10 }
  await insert(db, 'sessions', { ...session, id: ID.peakPrivateSession, start_time: '2026-11-14 10:00:00+00', end_time: '2026-11-14 12:00:00+00', band_id: ID.peakBand })
  await insert(db, 'sessions', { ...session, id: ID.laterPrivateSession, start_time: '2026-11-20 10:00:00+00', end_time: '2026-11-20 12:00:00+00', band_id: ID.band })
  const tier = { service_type_id: ID.privateType, band_id: ID.peakBand }
  await insert(db, 'service_type_price_tiers', { ...tier, min_people: 1, max_people: 2, price: '140.00' })
  await insert(db, 'service_type_price_tiers', { ...tier, min_people: 3, max_people: 4, price: '190.00' })
}

/** A later public session at the Core price, to move a public booking to. */
export async function laterPublicSession(db: Db): Promise<void> {
  await insert(db, 'sessions', {
    id: ID.laterPublicSession,
    service_type_id: ID.serviceType,
    start_time: '2026-11-20 10:00:00+00',
    end_time: '2026-11-20 11:00:00+00',
    type: 'public',
    capacity: 10,
    band_id: ID.band,
  })
}

export const noPromoOnCard = { booking: privateSeats, payment: { method: 'card' } }
export const peakPrivateOnCard = { booking: { ...privateSeats, sessionId: ID.peakPrivateSession }, payment: { method: 'card' } }
export const publicOnCard = { booking: paidSeat([sam, alex]), payment: { method: 'card' } }
const oneOnCard = { booking: { ...paidSeat([sam]), sessionId: ID.peakPrivateSession }, payment: { method: 'card' } }
export const publicPeakOnCard = { booking: { ...paidSeat([sam, alex]), sessionId: ID.peakSession }, payment: { method: 'card' } }
const towelOnBooking = { addons: [{ ...towel, redemptionSource: 'paid' }] }
const towelAdded = { addons: [{ addonId: ID.addon, quantity: 1 }] }

interface BookingSteps {
  bookingId: string
  call(action: string, params: unknown): Promise<unknown>
  db: Db
  stripe: FakeStripe
  /** Adds to the booking the way the screen does it: price first, then payment, then the reader. */
  add(params: Record<string, unknown>, payment?: Record<string, unknown>): Promise<AddAnswer>
  move(newSessionId: string, confirm: Record<string, unknown>): Promise<void>
  addonLineIds(): Promise<string[]>
}

interface AddAnswer {
  addonLineIds?: string[]
  guest?: { id: string }
  pendingReaderPayment?: { pendingId: string; paymentIntentId: string }
}

/** An order, then whatever a scenario does to the booking it made. */
function booked(
  name: string,
  order: Record<string, unknown>,
  steps: (booking: BookingSteps) => Promise<void>,
  prepare?: (db: Db, stripe: FakeStripe) => Promise<void>
): Scenario {
  return {
    name,
    async seed(db, stripe) {
      await seed(db, stripe)
      await prepare?.(db, stripe)
    },
    async run({ call, stripe, db }) {
      const placed = (await call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string }
      const { bookingId } = placed
      await steps({
        bookingId,
        call,
        db,
        stripe,
        async add(params, payment) {
          const quoted = (await call('addBookingGuest', { bookingId, ...params })) as AddAnswer
          if (!payment) return quoted
          const paid = (await call('addBookingGuest', { bookingId, ...params, payment })) as AddAnswer
          if (payment['method'] === 'reader' && paid.pendingReaderPayment) {
            stripe.completeReaderPayment(paid.pendingReaderPayment.paymentIntentId)
            await call('finaliseReaderPayment', { pendingId: paid.pendingReaderPayment.pendingId })
          }
          return paid
        },
        async move(newSessionId, confirm) {
          await call('moveBooking', { bookingId, newSessionId })
          const moved = (await call('moveBooking', { bookingId, newSessionId, confirmed: true, ...confirm })) as AddAnswer
          if (moved.pendingReaderPayment) {
            stripe.completeReaderPayment(moved.pendingReaderPayment.paymentIntentId)
            await call('finaliseReaderPayment', { pendingId: moved.pendingReaderPayment.pendingId })
          }
        },
        async addonLineIds() {
          const rows = await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1 ORDER BY created_at', [bookingId])
          return rows.map((row) => row.id)
        },
      })
    },
  }
}

interface PartRefund {
  order: Record<string, unknown>
  /** The part refunds, given before the guest is added. */
  parts: Array<Record<string, unknown>>
  payment?: Record<string, unknown>
  prepare?(db: Db, stripe: FakeStripe): Promise<void>
  refunds?: Array<Record<string, unknown>>
}

/** Part refunds, then a guest, then whatever is refunded after. */
function partRefunded(name: string, { order, parts, payment, prepare, refunds = [] }: PartRefund): Scenario {
  return booked(
    name,
    order,
    async ({ bookingId, call, add }) => {
      for (const part of parts) await call('refundBooking', { bookingId, ...part, ...goodwill })
      await add(bea, payment)
      for (const refund of refunds) await call('refundBooking', { bookingId, ...refund })
    },
    prepare
  )
}

/** A part refund, a move, then Cancel & Refund to the card. */
function partThenMove(part: Record<string, unknown>, newSessionId: string, confirm: Record<string, unknown>) {
  return async ({ bookingId, call, move }: BookingSteps) => {
    await call('refundBooking', { bookingId, refundMethod: 'card', ...part, ...goodwill })
    await move(newSessionId, confirm)
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }
}

/** A write the database refuses: `when` is a trigger condition on `NEW` (and `OLD` for an update). */
export interface WriteFailure {
  table: string
  event: 'INSERT' | 'UPDATE' | 'DELETE'
  when: string
}

export const refundCreditFails: WriteFailure = { table: 'store_credit_transactions', event: 'INSERT', when: `NEW.reason = 'refund' AND NEW.amount > 0` }
export const takeBackFails: WriteFailure = { table: 'store_credit_transactions', event: 'INSERT', when: `NEW.reason = 'refund' AND NEW.amount < 0` }
/** Cancel & Refund's last statement, after the money: it releases the session. */
export const cancelWriteFails: WriteFailure = { table: 'sessions', event: 'UPDATE', when: 'true' }

/**
 * Runs `steps` with those writes failing as a lost connection would. It lives in the database, so a
 * new route's different SQL fails at the same point as the old function's.
 */
export async function whileFailing<T>(db: Db, { table, event, when }: WriteFailure, steps: () => Promise<T>): Promise<T> {
  // Tables belong to the owner, not to the Worker's role. Test data only: every name here is fixed.
  const createTrigger = `CREATE TRIGGER fail_write BEFORE ${event} ON public.${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION public.fail_write()`
  const dropTrigger = `DROP TRIGGER fail_write ON public.${table}`
  await db.query('RESET ROLE')
  await db.query(`CREATE OR REPLACE FUNCTION public.fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'connection lost'; END $$`)
  await db.query(createTrigger)
  await db.query('SET ROLE paddock_worker')
  try {
    return await steps()
  } finally {
    await db.query('RESET ROLE')
    await db.query(dropTrigger)
    await db.query('SET ROLE paddock_worker')
  }
}

/**
 * A statement that works, and whose answer is lost on the way back: what a write failing with a
 * database error can't rule out. `paddockData` is the old side's own, so this wraps it for `steps`.
 */
export async function losingTheAnswer<T>(matches: (sql: string, params: unknown[]) => boolean, steps: () => Promise<T>): Promise<T> {
  type Query = (sql: string, params?: unknown[]) => Promise<unknown>
  const real = (globalThis as unknown as { paddockData: { query: Query } }).paddockData
  vi.stubGlobal('paddockData', {
    async query(sql: string, params: unknown[] = []) {
      const answer = await real.query(sql, params)
      if (matches(sql, params)) throw new Error('connection lost')
      return answer
    },
  })
  try {
    return await steps()
  } finally {
    vi.stubGlobal('paddockData', real)
  }
}

type RawRequest = (request: { path: string }) => Promise<unknown>
const backendApi = () => (globalThis as unknown as { paddockBackendApi2: { rawRequest: RawRequest } }).paddockBackendApi2

/** The Worker did the work and its answer never reached the function: what a lost connection leaves. */
export async function losingTheWorkersAnswer<T>(path: string, steps: () => Promise<T>): Promise<T> {
  const real = backendApi()
  let lost = false
  vi.stubGlobal('paddockBackendApi2', {
    async rawRequest(request: { path: string }) {
      const answer = await real.rawRequest(request)
      if (request.path === path && !lost) {
        lost = true
        throw new Error('socket hang up')
      }
      return answer
    },
  })
  try {
    return await steps()
  } finally {
    vi.stubGlobal('paddockBackendApi2', real)
  }
}

/**
 * The function stops dead once the Worker has answered `path`: nothing after that reaches the
 * database or the Worker, so no catch block can put anything back. What is left is what a Retool
 * function killed at its limit leaves. `steps` is expected to fail.
 *
 * A function killed at its limit has run that long, so the clock then moves on past the longest a
 * press can run (61 seconds, against shared/bookingCardCharge's 60): until then a press on the same
 * booking is told a payment is still being taken. `secondsLater` sets a shorter death.
 */
export async function dyingAfter(path: string, steps: () => Promise<unknown>, { secondsLater = 61 }: { secondsLater?: number } = {}): Promise<void> {
  type Query = (sql: string, params?: unknown[]) => Promise<unknown>
  const realData = (globalThis as unknown as { paddockData: { query: Query } }).paddockData
  const realApi = backendApi()
  let dead = false
  const died = () => Promise.reject(new Error('the function died'))
  vi.stubGlobal('paddockData', { query: (sql: string, params: unknown[] = []) => (dead ? died() : realData.query(sql, params)) })
  vi.stubGlobal('paddockBackendApi2', {
    async rawRequest(request: { path: string }) {
      if (dead) return died()
      const answer = await realApi.rawRequest(request)
      if (request.path === path) dead = true
      return answer
    },
  })
  try {
    await steps().catch(() => undefined)
    if (!dead) throw new Error(`The function never reached ${path}.`)
  } finally {
    vi.stubGlobal('paddockData', realData)
    vi.stubGlobal('paddockBackendApi2', realApi)
  }
  vi.setSystemTime(Date.now() + secondsLater * 1000)
}

const CHARGE_PATH = '/api/payments/charge-saved-card'
const REFUND_PATH = '/api/payments/refund-order'
type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown>
const dataApi = () => (globalThis as unknown as { paddockData: { query: QueryFn } }).paddockData

/**
 * Two presses that overlap (W05k): the first call to `path` gets its real answer, then `gap` runs to
 * the end, then the answer goes back to the first press. What a second press that starts while the
 * first is waiting on the Worker looks like to the database.
 */
export function afterTheWorker(path: string, gap: () => Promise<unknown>): void {
  const real = backendApi()
  vi.stubGlobal('paddockBackendApi2', {
    async rawRequest(request: { path: string }) {
      const answer = await real.rawRequest(request)
      if (request.path === path) {
        vi.stubGlobal('paddockBackendApi2', real)
        await gap()
      }
      return answer
    },
  })
}

/** The first saved-card charge of Move, Add Guest or Settle: overlapped as afterTheWorker does. */
export const afterTheCharge = (gap: () => Promise<unknown>) => afterTheWorker(CHARGE_PATH, gap)
/** The first card refund: overlapped as afterTheWorker does. */
export const afterTheRefund = (gap: () => Promise<unknown>) => afterTheWorker(REFUND_PATH, gap)

/**
 * The other way round: the first press stops just before writing its started row (it has read the
 * booking and taken its parts, so it builds the same key), `gap` runs to the end, then it carries on.
 */
export function beforeTheStartedRow(gap: () => Promise<unknown>): void {
  const real = dataApi()
  vi.stubGlobal('paddockData', {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('INSERT INTO audit_log') && sql.includes('booking.card_charge_started')) {
        vi.stubGlobal('paddockData', real)
        await gap()
      }
      return real.query(sql, params)
    },
  })
}

/**
 * Retool stops waiting for the charge (the press is told it may have gone through and gives its
 * parts back), and the Worker carries on: `steps` runs with that charge's request held, then the
 * held request is sent, as the Worker finishing late. Answers what `steps` answered.
 */
export async function chargeLandingLate<T>(steps: () => Promise<T>): Promise<T> {
  const real = backendApi()
  let held: { path: string } | null = null
  vi.stubGlobal('paddockBackendApi2', {
    async rawRequest(request: { path: string }) {
      if (request.path === CHARGE_PATH && !held) {
        held = request
        throw new Error('socket hang up')
      }
      return real.rawRequest(request)
    },
  })
  try {
    return await steps()
  } finally {
    vi.stubGlobal('paddockBackendApi2', real)
    if (held) await real.rawRequest(held)
  }
}

/** Longer than a press can run (shared/bookingCardCharge), so an earlier press counts as dead. */
export const A_PRESS_LATER = 61_000
export const TWO_DAYS = 48 * 60 * 60 * 1000
export const later = (ms: number) => vi.setSystemTime(Date.now() + ms)

export const creditRefund = (sql: string, params: unknown[]) => sql.includes('store_credit_apply') && params[2] === 'refund' && Number(params[1]) > 0

/**
 * Store credit that lands with its answer lost, and the look for it afterwards failing too: since
 * W05j the one case left where nobody can say whether it landed (shared/storeCreditRefund in the
 * staff app). A lost answer alone is now a clear yes, as the credit is found by its note.
 */
export const creditCantBeTold = <T>(steps: () => Promise<T>): Promise<T> =>
  losingTheAnswer((sql, params) => creditRefund(sql, params) || sql.includes('FOR SHARE'), steps)

/** Cancel & Refund with its final statement failing. It throws, so the step moves on. */
async function cancelThatFails({ bookingId, call, db }: Pick<BookingSteps, 'bookingId' | 'call' | 'db'>, refundMethod = 'card'): Promise<void> {
  await whileFailing(db, cancelWriteFails, () => call('refundBooking', { bookingId, refundMethod }).catch(() => undefined))
}

/** A guest on the card, a part refund, then Remove Guest at the figure it quotes. */
function removeAfterPart(part: Record<string, unknown>, confirmedRefundAmount: number, confirm: Record<string, unknown>, cancelAfter = false) {
  return async ({ bookingId, call, add }: BookingSteps) => {
    const guest = await add(bea, payments.card)
    await call('refundBooking', { bookingId, refundMethod: 'card', ...part, ...goodwill })
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount, ...confirm })
    if (cancelAfter) await call('refundBooking', { bookingId, refundMethod: 'card' })
  }
}

interface AddonOnGuest {
  order: Record<string, unknown>
  payment: Record<string, unknown>
  /** Tick the add-on on Cancel & Refund. */
  ticked: boolean
  refundMethod?: string
  prepare?(db: Db, stripe: FakeStripe): Promise<void>
  /** Add the add-on with no guest. */
  noGuest?: boolean
}

/** An add-on paid in the same payment as a guest, then Cancel & Refund, ticked or not. */
function addonOnGuest(name: string, { order, payment, ticked, refundMethod = 'card', prepare, noGuest }: AddonOnGuest): Scenario {
  return booked(
    name,
    order,
    async ({ bookingId, call, add, addonLineIds }) => {
      await add({ ...(noGuest ? {} : bea), ...towelAdded }, payment)
      await call('refundBooking', { bookingId, refundMethod, ...(ticked ? { addonLineIds: await addonLineIds() } : {}) })
    },
    prepare
  )
}

// £40 with £30 of it store credit, so £10 is on the card, and a £20 guest in cash. Removing them can
// put only that £10 on the card: the other £10 needs store credit.
const publicMostlyStoreCredit = { booking: paidSeat([sam, alex]), payment: { method: 'card', storeCredit: { amount: 30 } } }
// £51 and £140 with £30 of each store credit, so £21 and £110 are on the card.
const publicPeakPartCredit = { booking: { ...paidSeat([sam, alex]), sessionId: ID.peakSession }, payment: { method: 'card', storeCredit: { amount: 30 } } }
const peakPrivatePartCredit = { booking: { ...privateSeats, sessionId: ID.peakPrivateSession }, payment: { method: 'card', storeCredit: { amount: 30 } } }

// Mo on a membership credit, Alex paid on the card: the seat's £20 is on the first order's line.
const creditAndPaidSeat = { customerId: ID.member, booking: { ...paidSeat([mo, alex]), ...memberCredit }, payment: { method: 'card' } }

/** The paid seat's £20 part refunded, then Cancel & return credit, which gives no money itself. */
async function partRefundThenCancelCredit({ bookingId, call }: BookingSteps, refundMethod: string): Promise<void> {
  await call('refundBooking', { bookingId, refundMethod, amount: 20, ...goodwill })
  await call('cancelCreditBooking', { bookingId })
}

/** Adds a guest on the reader and leaves it open. Answers its pending id. */
async function readerGuestLeftOpen(bookingId: string, call: BookingSteps['call']): Promise<string | undefined> {
  const started = (await call('addBookingGuest', { bookingId, ...cy, payment: { method: 'reader' } })) as AddAnswer
  return started.pendingReaderPayment?.pendingId
}

/** Starts a move to the dearer session on the reader and leaves it open. Answers its pending id. */
async function readerMoveLeftOpen(bookingId: string, call: BookingSteps['call']): Promise<string | undefined> {
  const started = (await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } })) as AddAnswer
  return started.pendingReaderPayment?.pendingId
}

const itArrived = { amount: 40, owedArrived: true, reason: 'Found on their balance' }

/** The same £40 as fortyOwed, but the store credit landed and only its answer was lost. */
async function fortyLanded({ move }: Pick<BookingSteps, 'move'>): Promise<void> {
  await creditCantBeTold(() => move(ID.laterPrivateSession, { refundMethod: 'credit' }))
}

const payments = {
  card: { method: 'card' },
  reader: { method: 'reader' },
  storeCreditAndCard: { method: 'card', storeCredit: { amount: 10 } },
  giftCardAndReader: { method: 'reader', giftCard: { giftCardId: ID.giftCard, amount: 20 } },
  publicGiftCardAndReader: { method: 'reader', giftCard: { giftCardId: ID.giftCard, amount: 10 } },
}

/** A dearer booking's move to £100 at Core, with the store credit refund failing: all of it owed. */
async function fortyOwed({ db, move }: Pick<BookingSteps, 'db' | 'move'>): Promise<void> {
  await whileFailing(db, refundCreditFails, () => move(ID.laterPrivateSession, { refundMethod: 'credit' }))
}

/** A third guest's £50 on a card, then a £120 part refund stopping after the first £50. */
async function add120Failing({ bookingId, call, db, stripe, add }: BookingSteps): Promise<void> {
  await add(bea, payments.card)
  stripe.failNext('refunds.create', { kind: 'none' })
  stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
  await whileFailing(db, refundCreditFails, () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 120, ...goodwill }))
}

/** What the Part refund dialog shows straight after an order. */
function figures(name: string, order: Record<string, unknown>): Scenario {
  return booked(name, order, async ({ bookingId, call }) => {
    await call('getBookingRefundFigures', { bookingId })
  })
}

/** W05l: a gift card part on Move and Settle, £5 of the seeded £40 card. */
export const W05L_GIFT = { giftCardId: ID.giftCard, amount: 5 }
export const w05lPay = {
  card: { method: 'card', giftCard: W05L_GIFT },
  reader: { method: 'reader', giftCard: W05L_GIFT },
  /** Move's £11 difference less the £5: £6 in cash. */
  cash: { ...cash(6), giftCard: W05L_GIFT },
}
/** The gift card's redemption row can't be written: its statement fails. */
export const giftCardRowFails: WriteFailure = { table: 'gift_card_redemptions', event: 'INSERT', when: 'true' }
/** Move's and Settle's final statements, by the pending row they can write. */
export const MOVE_STATEMENT = (sql: string) => sql.includes("SELECT 'move', bk.id")
export const SETTLE_STATEMENT = (sql: string) => sql.includes("SELECT 'settle', bk.id")
export const ADD_GUEST_STATEMENT = (sql: string) => sql.includes("SELECT 'add_guest', ok.id")
/** A press looking for its own finished row after its statement threw. */
export const PRESS_LOOK = (sql: string) => sql.includes("action = 'booking.press_finished'")
/** The statement wrote and its answer was lost, and the look for its row fails too. */
export const andTheLookFails = (statement: (sql: string) => boolean) => (sql: string) => statement(sql) || PRESS_LOOK(sql)

/** A member's £20 seat whose credit lapsed: awaiting payment, for Settle. */
export async function lapsedSeat(call: ScenarioContext['call'], db: Db): Promise<string> {
  const placed = (await call('createOrder', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} })) as { bookingId: string }
  await db.query(`UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1`, [placed.bookingId])
  return placed.bookingId
}

/** Settle, and on the reader, collect and finalise as the screen does. */
export async function settle(call: ScenarioContext['call'], stripe: FakeStripe, bookingId: string, payment: Record<string, unknown>): Promise<AddAnswer> {
  const settled = (await call('settleLapsedBooking', { bookingId, payment })) as AddAnswer
  if (settled.pendingReaderPayment) {
    stripe.completeReaderPayment(settled.pendingReaderPayment.paymentIntentId)
    await call('finaliseReaderPayment', { pendingId: settled.pendingReaderPayment.pendingId })
  }
  return settled
}

/** Settle scenarios: a lapsed seat, then `steps`. */
function lapsed(name: string, steps: (context: ScenarioContext, bookingId: string) => Promise<void>): Scenario {
  return {
    name,
    seed,
    async run(context) {
      await steps(context, await lapsedSeat(context.call, context.db))
    },
  }
}

export const scenarios: Scenario[] = [
  {
    // Two guests, because their order is what section 2.4's item 7 is about.
    name: 'cash-booking-two-guests-addon',
    seed,
    async run({ call }) {
      await call('createOrder', {
        customerId: ID.customer,
        booking: paidBooking,
        payment: { method: 'cash', confirmedCashAmount: 45 },
      })
    },
  },
  {
    name: 'saved-card-product-gift-card-store-credit',
    seed,
    async run({ call }) {
      await call('createOrder', {
        customerId: ID.customer,
        products: [soap],
        booking: paidBooking,
        payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 10 }, storeCredit: { amount: 15 } },
      })
    },
  },
  {
    // Both halves of the pipeline: prepare, the customer taps, then finalise.
    name: 'reader-booking-then-finalise',
    seed,
    async run({ call, stripe }) {
      const placed = (await call('createOrder', {
        customerId: ID.customer,
        booking: paidBooking,
        payment: { method: 'reader' },
      })) as { orderId: string; pendingReaderPayment: { paymentIntentId: string } }
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      await call('finaliseReaderOrder', { orderId: placed.orderId, paymentIntentId: placed.pendingReaderPayment.paymentIntentId })
    },
  },
  {
    name: 'membership-on-saved-card',
    seed,
    async run({ call }) {
      await call('createOrder', {
        customerId: ID.customer,
        membershipPlanId: ID.plan,
        membershipBillingFrequency: 'monthly',
        membershipIdempotencyKey: 'replay-membership-key',
        payment: { method: 'card' },
      })
    },
  },
  {
    // A refusal after the writes: everything must be given back.
    name: 'saved-card-declined-rolls-back',
    seed,
    async run({ call, stripe }) {
      const { fakeStripeErrors } = await import('@/server/stripe/fake')
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      await call('createOrder', {
        customerId: ID.customer,
        products: [soap],
        booking: paidBooking,
        payment: { method: 'card', storeCredit: { amount: 15 } },
      })
    },
  },

  // --- Every line kind
  order('member-credit-seat-guest-and-addon-credit', {
    customerId: ID.member,
    booking: {
      ...paidSeat([mo, alex]),
      redemptionSource: 'membership_credit',
      membershipId: ID.membership,
      addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }],
    },
    payment: cash(20),
  }),
  order('peak-member-pays-discounted-seat', {
    customerId: ID.member,
    booking: { ...paidSeat([mo]), sessionId: ID.peakSession, redemptionSource: 'membership_credit', membershipId: ID.membership },
    payment: { method: 'card' },
  }),
  order('pass-credit-seat-and-guest', {
    booking: { ...paidSeat([sam, alex]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass },
    payment: cash(20),
  }),
  order('private-booking-in-cash', {
    booking: { ...paidSeat([sam, alex]), sessionId: ID.privateSession },
    payment: cash(100),
  }),
  order('standalone-addon-at-member-price', {
    customerId: ID.member,
    standaloneAddons: [{ addonId: ID.robe, quantity: 2, unitPrice: 8, systemUnitPrice: 8 }],
    payment: { method: 'card' },
  }),
  order('pickup-and-shipped-products-standard-postage', {
    products: [soap, { productVariantId: ID.mugVariant, quantity: 1, unitPrice: 15, systemUnitPrice: 15, fulfillmentChoice: 'shipping' }],
    ...shipped,
    payment: { method: 'card' },
  }),
  order('shipped-product-over-threshold-is-free', {
    products: [{ ...candle, quantity: 3 }],
    ...shipped,
    payment: { method: 'card' },
  }),
  order('shipped-product-express-postage', {
    products: [{ ...candle, quantity: 3 }],
    ...shipped,
    postageMethod: 'express',
    payment: { method: 'card' },
  }),
  order('session-pass-on-the-reader', { sessionPassTypeId: ID.passType, payment: { method: 'reader' } }),
  order('yearly-membership-on-saved-card', {
    ...monthly,
    membershipBillingFrequency: 'yearly',
    payment: { method: 'card' },
  }),
  order('membership-on-the-reader', { ...monthly, payment: { method: 'reader', readerSaveCard: true } }),
  order('gift-card-preset-in-cash', { giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' }, payment: cash(60) }),
  order('gift-card-custom-amount-on-card', {
    giftCard: { giftCardTypeId: ID.giftCardType, amount: 25, fulfillmentMethod: 'pickup', recipientName: 'Ali' },
    payment: { method: 'card' },
  }),
  order('event-with-a-guest-in-cash', { event: eventPlaces, payment: cash(80) }),
  order('event-at-member-price-with-a-new-membership', { event: eventPlaces, ...monthly, payment: { method: 'card' } }),
  order('store-credit-covers-everything', { products: [soap], payment: { storeCredit: { amount: 24 } } }),
  order('gift-card-and-cash', {
    booking: paidSeat(),
    payment: { giftCard: { giftCardId: ID.giftCard, amount: 5 }, ...cash(15) },
  }),
  // --- A promo on each kind
  order('promo-on-a-booking', { booking: paidSeat([sam, alex]), promoCode: PROMO.percent, payment: cash(36) }),
  order('promo-on-a-standalone-addon', { standaloneAddons: [towel], promoCode: PROMO.percent, payment: cash(4.5) }),
  order('promo-on-a-product', { products: [soap], promoCode: PROMO.percent, payment: cash(21.6) }),
  order('promo-on-a-pass', { sessionPassTypeId: ID.passType, promoCode: PROMO.percent, payment: cash(45) }),
  order('promo-on-a-membership', { ...monthly, promoCode: PROMO.percent, payment: { method: 'card' } }),
  order('promo-on-an-event', { event: eventPlaces, promoCode: PROMO.percent, payment: cash(72) }),
  order('fixed-promo-spread-across-a-basket', {
    booking: paidSeat([sam, alex]),
    products: [soap],
    standaloneAddons: [towel],
    promoCode: PROMO.fixed,
    payment: { method: 'card' },
  }),
  // --- Price overrides
  order('override-with-permission', {
    products: [{ ...soap, unitPrice: 10, priceOverrideReason: 'Damaged box' }],
    standaloneAddons: [{ ...towel, unitPrice: 3, priceOverrideReason: 'Regular' }],
    payment: { method: 'card' },
  }),
  order(
    'override-without-permission-is-ignored',
    {
      products: [{ ...soap, unitPrice: 1 }],
      standaloneAddons: [{ ...towel, unitPrice: 1 }],
      payment: { method: 'card' },
    },
    async (db) => {
      await db.query('UPDATE staff SET can_manage_pricing = false')
    }
  ),
  // --- Memberships in the basket, and credit spilling onto them
  order('spill-onto-a-membership', { products: [soap], ...monthly, payment: { method: 'card', storeCredit: { amount: 30 } } }),
  order('buy-new-membership-covers-the-seat', {
    booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_membership' },
    ...monthly,
    payment: { method: 'card' },
  }),
  order('buy-new-membership-on-peak-pays-the-seat', {
    booking: { ...paidSeat([sam]), sessionId: ID.peakSession, redemptionSource: 'buy_new_membership' },
    ...monthly,
    payment: { method: 'card' },
  }),
  order('buy-new-pass-covers-the-seat', {
    booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_session_pass' },
    sessionPassTypeId: ID.passType,
    payment: cash(70),
  }),
  // --- The agreed fixes: W03-decisions Q1 to Q6
  order('q1-postage-before-the-spill', { products: [candle], ...shipped, ...monthly, payment: { method: 'card', storeCredit: { amount: 30 } } }),
  order('q2-standalone-addon-before-the-spill', {
    booking: { ...paidSeat(), redemptionSource: 'buy_new_membership' },
    standaloneAddons: [towel],
    ...monthly,
    payment: { method: 'card', storeCredit: { amount: 20 } },
  }),
  order('q3-buy-new-membership-with-a-pass', {
    booking: { ...paidSeat(), redemptionSource: 'buy_new_membership' },
    sessionPassTypeId: ID.passType,
    ...monthly,
    payment: { method: 'card' },
  }),
  order('q3-buy-new-pass-with-a-membership', {
    booking: { ...paidSeat(), redemptionSource: 'buy_new_session_pass' },
    sessionPassTypeId: ID.passType,
    ...monthly,
    payment: { method: 'card' },
  }),
  readerThenFinalise('q3-reader-buy-new-membership-with-a-pass', {
    booking: { ...paidSeat(), redemptionSource: 'buy_new_membership' },
    sessionPassTypeId: ID.passType,
    ...monthly,
  }),
  readerThenFinalise('q3-reader-buy-new-pass-with-a-membership', {
    booking: { ...paidSeat(), redemptionSource: 'buy_new_session_pass' },
    sessionPassTypeId: ID.passType,
    ...monthly,
  }),
  order('q4-shipped-gift-card-earns-free-postage', {
    giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'shipping' },
    ...shipped,
    payment: cash(64.95),
  }),
  order('q5-buy-new-keeps-address-and-requests', {
    booking: { ...paidSeat(), redemptionSource: 'buy_new_membership', specialRequests: 'Step-free access' },
    products: [candle],
    ...shipped,
    ...monthly,
    payment: { method: 'card' },
  }),
  order('q6-promo-on-buy-new-seats', {
    booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_membership' },
    ...monthly,
    promoCode: PROMO.percent,
    payment: { method: 'card' },
  }),
  // --- Refusals: the quote's first problem must be the order's refusal
  order('refused-session-full', { booking: paidSeat(), payment: cash(20) }, async (db) => {
    await db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session])
  }),
  order('refused-out-of-stock', { products: [{ ...soap, quantity: 6 }], payment: cash(72) }),
  order('refused-a-booking-that-day', { booking: paidSeat(), payment: cash(20) }, async (db) => {
    await insert(db, 'bookings', { session_id: ID.session, customer_id: ID.customer, party_size: 1, price_paid: '20', status: 'confirmed' })
  }),
  order('refused-an-expired-promo', { products: [soap], promoCode: PROMO.expired, payment: cash(24) }),
  order('refused-store-credit-over-the-total', { products: [soap], payment: { storeCredit: { amount: 25 } } }),
  order('refused-no-method-chosen', { products: [soap], payment: {} }),
  order('refused-account-holder-under-18', {
    booking: paidSeat([{ ...sam, dateOfBirth: '2015-01-01' }]),
    payment: cash(20),
  }),
  order('refused-guests-not-confirmed', { booking: { ...paidSeat([sam, alex]), guestsOver18Confirmed: false }, payment: cash(40) }),
  // --- Every createBooking reason W05 left untested
  order('refused-session-blocked', { booking: paidSeat(), payment: cash(20) }, async (db) => {
    await db.query(`UPDATE sessions SET status = 'blocked' WHERE id = $1`, [ID.session])
  }),
  order('refused-session-already-started', { booking: paidSeat(), payment: cash(20) }, async (db) => {
    await db.query(`UPDATE sessions SET start_time = '2026-11-10 08:00:00+00', end_time = '2026-11-10 09:30:00+00' WHERE id = $1`, [ID.session])
  }),
  order('refused-time-conflict', { booking: paidSeat(), payment: cash(20) }, seedOverlappingBooking),
  order('refused-private-price-not-set', { booking: privateSeats, payment: cash(100) }, async (db) => {
    await db.query('UPDATE service_type_price_tiers SET min_people = 5 WHERE id = $1', [ID.privateTier])
  }),
  order('refused-private-price-pending', { booking: privateSeats, payment: cash(100) }, async (db) => {
    await db.query('UPDATE service_type_price_tiers SET price = NULL WHERE id = $1', [ID.privateTier])
  }),
  order('refused-someone-elses-membership', { booking: { ...paidSeat(), ...memberCredit }, payment: cash(20) }),
  order('refused-no-membership-credit-left', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: cash(20) }, async (db) => {
    await db.query('UPDATE membership_credit_periods SET credits_allocated = 0 WHERE id = $1', [ID.creditPeriod])
  }),
  order('refused-someone-elses-pass', { customerId: ID.member, booking: { ...paidSeat([mo]), ...ownedPass }, payment: cash(20) }),
  order('refused-no-pass-sessions-left', { booking: { ...paidSeat(), ...ownedPass }, payment: cash(20) }, async (db) => {
    await db.query('UPDATE customer_session_passes SET sessions_remaining = 0 WHERE id = $1', [ID.ownedPass])
  }),
  order('refused-an-expired-pass', { booking: { ...paidSeat(), ...ownedPass }, payment: cash(20) }, async (db) => {
    await db.query(`UPDATE customer_session_passes SET expiry_date = '2026-11-09' WHERE id = $1`, [ID.ownedPass])
  }),
  order(
    'refused-pass-not-valid-for-the-band',
    { booking: { ...paidSeat(), sessionId: ID.peakSession, redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedCorePass }, payment: cash(25.5) },
    seedCorePass
  ),
  // --- A standalone add-on can't draw a credit
  order('refused-standalone-addon-on-a-credit', {
    customerId: ID.member,
    standaloneAddons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }],
    payment: cash(5),
  }),
  order('refused-standalone-addon-on-a-credit-with-no-membership', {
    customerId: ID.member,
    standaloneAddons: [{ ...towel, redemptionSource: 'membership_credit' }],
    payment: cash(5),
  }),
  // --- Replacing an exhausted membership
  order('replace-an-exhausted-membership', { booking: buyNewReplacing(ID.exhausted), ...monthly, payment: { method: 'card' } }, seedExhaustedMembership),
  order('refused-exhausted-membership-not-found', { booking: buyNewReplacing(ID.membership), ...monthly, payment: { method: 'card' } }),
  order('refused-exhausted-membership-cancelled', { booking: buyNewReplacing(ID.exhausted), ...monthly, payment: { method: 'card' } }, async (db, stripe) => {
    await seedExhaustedMembership(db, stripe)
    await db.query(`UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1`, [ID.exhausted])
  }),
  order('refused-exhausted-membership-past-its-last-day', { booking: buyNewReplacing(ID.exhausted), ...monthly, payment: { method: 'card' } }, async (db, stripe) => {
    await seedExhaustedMembership(db, stripe)
    await db.query(`UPDATE customer_memberships SET cancel_effective_date = '2026-11-09' WHERE id = $1`, [ID.exhausted])
  }),
  // --- Migration 018: a membership past its last day gives nothing
  order(
    'member-on-their-last-day-pays-the-member-price',
    { customerId: ID.member, booking: { ...paidSeat([mo]), sessionId: ID.peakSession }, payment: cash(21.68) },
    lastDayIs('2026-11-10')
  ),
  order(
    'member-past-their-last-day-pays-the-list-price',
    { customerId: ID.member, booking: { ...paidSeat([mo]), sessionId: ID.peakSession }, payment: cash(25.5) },
    lastDayIs('2026-11-09')
  ),
  order('member-on-their-last-day-can-use-a-credit', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} }, lastDayIs('2026-11-10')),
  order('refused-a-credit-past-the-last-day', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: cash(20) }, lastDayIs('2026-11-09')),
  // --- Q23: free postage is judged on the corrected price
  order('q23-a-sent-price-cannot-earn-free-postage', { products: [{ ...candle, unitPrice: 60 }], ...shipped, payment: { method: 'card' } }, noPricing),
  order('q23-a-sent-price-cannot-lose-free-postage', { products: [{ ...candle, quantity: 3, unitPrice: 1 }], ...shipped, payment: { method: 'card' } }, noPricing),
  order('q23-an-allowed-price-still-counts', {
    products: [{ ...candle, unitPrice: 60, priceOverrideReason: 'Gift set' }],
    ...shipped,
    payment: { method: 'card' },
  }),
  // --- Q24: a promo applies to a private booking, on its whole price
  order('q24-percent-promo-on-a-private-booking', { booking: privateSeats, promoCode: PROMO.percent, payment: cash(90) }),
  order('q24-fixed-promo-on-a-private-booking', { booking: privateSeats, promoCode: PROMO.fixed, payment: cash(95) }),
  order('q24-fixed-promo-bigger-than-the-private-price', { booking: privateSeats, promoCode: PROMO.big, payment: {} }),
  order('q24-percent-promo-on-private-and-other-items', {
    booking: privateSeats,
    standaloneAddons: [towel],
    products: [soap],
    promoCode: PROMO.percent,
    payment: { method: 'card' },
  }),
  order('q24-fixed-promo-on-private-and-other-items', {
    booking: privateSeats,
    standaloneAddons: [towel],
    products: [soap],
    promoCode: PROMO.fixed,
    payment: { method: 'card' },
  }),
  order('q24-big-fixed-promo-on-private-and-a-membership', {
    booking: privateSeats,
    products: [soap],
    ...monthly,
    promoCode: PROMO.big,
    payment: { method: 'card', storeCredit: { amount: 12 } },
  }),
  order('q24-attached-addon-stays-out-of-the-promo', {
    booking: { ...privateSeats, addons: [{ ...towel, redemptionSource: 'paid' }] },
    promoCode: PROMO.percent,
    payment: cash(95),
  }),
  order('q24-promo-with-gift-card-and-store-credit', {
    booking: privateSeats,
    promoCode: PROMO.percent,
    payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } },
  }),
  order('q24-the-member-prices-flag-does-not-apply', { customerId: ID.member, booking: { ...privateSeats, guests: [mo, alex] }, promoCode: PROMO.percent, payment: cash(90) }),
  order('q24-min-spend-counts-the-private-price', { booking: privateSeats, promoCode: PROMO.spend80, payment: cash(90) }),
  order('q24-refused-below-min-spend', { booking: privateSeats, promoCode: PROMO.spend150, payment: cash(100) }),
  order('q24-refused-a-code-not-for-bookings', { booking: privateSeats, promoCode: PROMO.productsOnly, payment: cash(100) }),
  order('q24-refused-an-expired-code', { booking: privateSeats, promoCode: PROMO.expired, payment: cash(100) }),
  {
    name: 'q24-promo-on-the-reader',
    seed,
    async run({ call, stripe }) {
      const placed = (await call('createOrder', {
        customerId: ID.customer,
        booking: privateSeats,
        promoCode: PROMO.percent,
        payment: { method: 'reader' },
      })) as { orderId: string; pendingReaderPayment: { paymentIntentId: string } }
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      await call('finaliseReaderOrder', { orderId: placed.orderId })
    },
  },
  {
    // A refusal after the promo came off price_paid: everything must be given back.
    name: 'q24-card-declined-rolls-back',
    seed,
    async run({ call, stripe }) {
      const { fakeStripeErrors } = await import('@/server/stripe/fake')
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      await call('createOrder', { customerId: ID.customer, booking: privateSeats, promoCode: PROMO.percent, payment: { method: 'card' } })
    },
  },
  // --- Q24: every refund gives back what was paid, never the list price
  refunded('q24-cancel-and-refund-to-the-card', { booking: privateSeats, promoCode: PROMO.percent, payment: { method: 'card' } }, [{ refundMethod: 'card' }]),
  refunded('q24-cancel-and-refund-to-store-credit', { booking: privateSeats, promoCode: PROMO.percent, payment: { method: 'card' } }, [{ refundMethod: 'credit' }]),
  refunded('q24-cash-booking-refunded-as-card', { booking: privateSeats, promoCode: PROMO.percent, payment: cash(90) }, [{ refundMethod: 'card' }]),
  refunded('q24-cash-booking-refunded-as-credit', { booking: privateSeats, promoCode: PROMO.percent, payment: cash(90) }, [{ refundMethod: 'credit' }]),
  refunded(
    'q24-split-payment-refunded',
    {
      booking: privateSeats,
      promoCode: PROMO.percent,
      payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } },
    },
    [{ refundMethod: 'card' }]
  ),
  refunded('q24-part-refund-then-the-rest', { booking: privateSeats, promoCode: PROMO.percent, payment: { method: 'card' } }, [
    { refundMethod: 'card', amount: 30 },
    { refundMethod: 'card' },
  ]),
  refunded('q24-free-booking-cancelled', { booking: privateSeats, promoCode: PROMO.big, payment: {} }, [{ refundMethod: 'credit' }]),
  refunded('q24-other-items-keep-their-money', { booking: privateSeats, products: [soap], promoCode: PROMO.percent, payment: { method: 'card' } }, [{ refundMethod: 'card' }]),
  // --- Q25: Add Guest keeps the promo. £100 booking, 10% off, so £90 paid; the next tier is £150
  guestAdded('q25-same-tier-then-refund-to-the-card', { order: promoOnCard, refunds: toCard }),
  guestAdded('q25-same-tier-then-refund-to-store-credit', { order: promoOnCard, refunds: toCredit }),
  guestAdded('q25-same-tier-cash-booking-then-refund', { order: promoInCash, refunds: toCredit }),
  guestAdded('q25-same-tier-fixed-promo-then-refund', { order: { ...promoOnCard, promoCode: PROMO.fixed }, refunds: toCard }),
  guestAdded('q25-same-tier-free-booking-then-cancel', { order: freeBooking, refunds: toCredit }),
  guestAdded('q25-higher-tier-in-cash-then-refund', { order: promoOnCard, payment: cash(50), prepare: tieredPrivatePrices, refunds: toCard }),
  guestAdded('q25-higher-tier-all-cash-then-refund', { order: promoInCash, payment: cash(50), prepare: tieredPrivatePrices, refunds: toCredit }),
  guestAdded('q25-higher-tier-on-the-card-then-refund', { order: promoOnCard, payment: { method: 'card' }, prepare: tieredPrivatePrices, refunds: toCard }),
  guestAdded('q25-higher-tier-on-the-card-to-store-credit', { order: promoOnCard, payment: { method: 'card' }, prepare: tieredPrivatePrices, refunds: toCredit }),
  guestAdded('q25-higher-tier-on-the-reader-then-refund', { order: promoOnCard, payment: { method: 'reader' }, reader: true, prepare: tieredPrivatePrices, refunds: toCard }),
  guestAdded('q25-higher-tier-on-the-reader-to-store-credit', { order: promoOnCard, payment: { method: 'reader' }, reader: true, prepare: tieredPrivatePrices, refunds: toCredit }),
  guestAdded('q25-higher-tier-split-on-the-card-then-refund', {
    order: promoOnCard,
    payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } },
    prepare: tieredPrivatePrices,
    refunds: toCard,
  }),
  guestAdded('q25-higher-tier-split-in-cash-then-refund', {
    order: promoOnCard,
    payment: { ...cash(20), giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } },
    prepare: tieredPrivatePrices,
    refunds: toCard,
  }),
  guestAdded('q25-higher-tier-split-on-the-reader-then-refund', {
    order: promoOnCard,
    payment: { method: 'reader', giftCard: { giftCardId: ID.giftCard, amount: 20 } },
    reader: true,
    prepare: tieredPrivatePrices,
    refunds: toCard,
  }),
  guestAdded('q25-higher-tier-free-booking-then-refund', { order: freeBooking, payment: { method: 'card' }, prepare: tieredPrivatePrices, refunds: toCard }),
  guestAdded('q25-higher-tier-guest-and-addon-on-the-card', {
    order: promoOnCard,
    payment: { method: 'card' },
    extra: { addons: [{ addonId: ID.addon, quantity: 1 }] },
    prepare: tieredPrivatePrices,
    refunds: toCard,
  }),
  guestAdded('q25-same-tier-guest-and-addon-on-the-card', {
    order: promoOnCard,
    payment: { method: 'card' },
    extra: { addons: [{ addonId: ID.addon, quantity: 1 }] },
    refunds: toCard,
  }),
  addonRefundedToo('q25-guest-and-addon-both-refunded-to-the-card', promoOnCard),
  addonRefundedToo('q25-no-promo-guest-and-addon-both-refunded-to-the-card', { booking: privateSeats, payment: { method: 'card' } }),
  // £10.30 less £9.27 and £1.03 comes out a hair above nothing in floating point.
  guestAdded('q25-same-tier-leaves-no-stray-pennies', {
    order: { ...promoInCash, payment: cash(9.27) },
    extra: { addons: [{ addonId: ID.addon, quantity: 1 }] },
    prepare: async (db) => {
      await db.query(`UPDATE service_type_price_tiers SET price = '10.30' WHERE id = $1`, [ID.privateTier])
    },
  }),
  guestAdded('q25-refused-a-cash-figure-from-the-old-sum', { order: promoOnCard, payment: cash(60), prepare: tieredPrivatePrices }),
  guestAdded('q25-refused-cash-when-nothing-is-due', { order: promoOnCard, payment: cash(10), noQuote: true }),
  {
    name: 'q25-card-declined-rolls-back',
    async seed(db, stripe) {
      await seed(db, stripe)
      await tieredPrivatePrices(db)
    },
    async run({ call, stripe }) {
      const { fakeStripeErrors } = await import('@/server/stripe/fake')
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...promoOnCard })) as { bookingId: string }
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 10 } } })
    },
  },
  {
    name: 'q25-reader-cancelled-puts-it-all-back',
    async seed(db, stripe) {
      await seed(db, stripe)
      await tieredPrivatePrices(db)
    },
    async run({ call }) {
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...promoOnCard })) as { bookingId: string }
      const paid = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'reader', storeCredit: { amount: 10 } } })) as {
        pendingReaderPayment: { pendingId: string }
      }
      await call('cancelReaderPayment', { pendingId: paid.pendingReaderPayment.pendingId })
    },
  },
  {
    // £150 at three and four people, £200 at five: the promo counts once, however many guests.
    name: 'q25-guests-up-through-the-tiers-then-refund',
    async seed(db, stripe) {
      await seed(db, stripe)
      await tieredPrivatePrices(db)
    },
    async run({ call }) {
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...promoOnCard })) as { bookingId: string }
      await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
      await call('addBookingGuest', { bookingId, ...cy })
      await call('addBookingGuest', { bookingId, guestName: 'Di Guest', guestsOver18Confirmed: true, payment: cash(50) })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
  },
  {
    // Remove Guest refunds nothing on a private booking, so the higher tier stays paid for.
    name: 'q25-guest-removed-then-another-added',
    async seed(db, stripe) {
      await seed(db, stripe)
      await tieredPrivatePrices(db)
    },
    async run({ call }) {
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...promoOnCard })) as { bookingId: string }
      const added = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })) as { guest: { id: string } }
      await call('removeBookingGuest', { guestId: added.guest.id, confirmedRefundAmount: 0 })
      await call('addBookingGuest', { bookingId, ...cy })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
  },
  {
    // A price cut since the booking: nothing is due for the seat, nothing is given back, and it
    // can't eat into an add-on's price.
    name: 'q25-tier-price-fell-since-the-booking',
    seed,
    async run({ call, db }) {
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...promoOnCard })) as { bookingId: string }
      await db.query(`UPDATE service_type_price_tiers SET price = '80.00' WHERE id = $1`, [ID.privateTier])
      await call('addBookingGuest', { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1 }] })
      await call('addBookingGuest', { bookingId, ...bea })
    },
  },
  {
    // A part refund stays with the customer, so the same tier asks for nothing (Q27).
    name: 'q25-part-refund-then-a-guest',
    seed,
    async run({ call }) {
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...promoOnCard })) as { bookingId: string }
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await call('addBookingGuest', { bookingId, ...bea })
    },
  },
  // --- Q25 changes nothing without a promo, and nothing on a public booking
  guestAdded('q25-no-promo-same-tier-then-refund', { order: { booking: privateSeats, payment: { method: 'card' } }, refunds: toCard }),
  guestAdded('q25-no-promo-higher-tier-then-refund', { order: { booking: privateSeats, payment: { method: 'card' } }, payment: { method: 'card' }, prepare: tieredPrivatePrices, refunds: toCard }),
  guestAdded('q25-public-promo-guest-on-the-card-then-refund', { order: { booking: paidSeat([sam, alex]), promoCode: PROMO.percent, payment: { method: 'card' } }, payment: { method: 'card' }, refunds: toCard }),
  guestAdded('q25-public-promo-guest-in-cash-then-refund', { order: { booking: paidSeat([sam, alex]), promoCode: PROMO.percent, payment: { method: 'card' } }, payment: cash(20), refunds: toCard }),
  // --- Q27: a part refund stays with the customer. £100 booking, 10% off, so £90 paid; part refund £30
  partRefunded('q27-part-to-card-same-tier-then-to-the-card', { order: promoOnCard, parts: [{ refundMethod: 'card', amount: 30 }], refunds: toCard }),
  partRefunded('q27-part-to-card-same-tier-then-to-store-credit', { order: promoOnCard, parts: [{ refundMethod: 'card', amount: 30 }], refunds: toCredit }),
  partRefunded('q27-part-to-credit-same-tier-then-to-the-card', { order: promoOnCard, parts: [{ refundMethod: 'credit', amount: 30 }], refunds: toCard }),
  partRefunded('q27-part-to-credit-higher-tier-on-the-card-then-to-the-card', { order: promoOnCard, parts: [{ refundMethod: 'credit', amount: 30 }], payment: payments.card, prepare: tieredPrivatePrices, refunds: toCard }),
  partRefunded('q27-part-to-credit-higher-tier-on-the-card-then-to-store-credit', { order: promoOnCard, parts: [{ refundMethod: 'credit', amount: 30 }], payment: payments.card, prepare: tieredPrivatePrices, refunds: toCredit }),
  partRefunded('q27-part-to-credit-higher-tier-on-the-reader-then-to-the-card', { order: promoOnCard, parts: [{ refundMethod: 'credit', amount: 30 }], payment: payments.reader, prepare: tieredPrivatePrices, refunds: toCard }),
  partRefunded('q27-part-to-credit-higher-tier-on-the-reader-then-to-store-credit', { order: promoOnCard, parts: [{ refundMethod: 'credit', amount: 30 }], payment: payments.reader, prepare: tieredPrivatePrices, refunds: toCredit }),
  partRefunded('q27-part-to-card-higher-tier-on-the-card-then-to-the-card', { order: promoOnCard, parts: [{ refundMethod: 'card', amount: 30 }], payment: payments.card, prepare: tieredPrivatePrices, refunds: toCard }),
  partRefunded('q27-part-to-card-higher-tier-on-the-reader-then-to-the-card', { order: promoOnCard, parts: [{ refundMethod: 'card', amount: 30 }], payment: payments.reader, prepare: tieredPrivatePrices, refunds: toCard }),
  partRefunded('q27-part-to-card-higher-tier-in-cash-then-to-the-card', { order: promoOnCard, parts: [{ refundMethod: 'card', amount: 30 }], payment: cash(50), prepare: tieredPrivatePrices, refunds: toCard }),
  partRefunded('q27-no-promo-part-to-card-same-tier-then-to-the-card', { order: noPromoOnCard, parts: [{ refundMethod: 'card', amount: 30 }], refunds: toCard }),
  partRefunded('q27-no-promo-part-to-credit-higher-tier-then-to-the-card', { order: noPromoOnCard, parts: [{ refundMethod: 'credit', amount: 30 }], payment: payments.card, prepare: tieredPrivatePrices, refunds: toCard }),
  // Cash money comes back as store credit: one movement, counted once.
  partRefunded('q27-cash-booking-part-refund-same-tier-then-refund', { order: promoInCash, parts: [{ refundMethod: 'credit', amount: 30 }], refunds: toCredit }),
  // £60 on the card, £20 gift card, £10 store credit: a £70 part refund is two, as a card one stops at the card money.
  partRefunded('q27-part-refund-split-card-and-credit-counted-once', {
    order: { ...promoOnCard, payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } } },
    parts: [{ refundMethod: 'card', amount: 60 }, { refundMethod: 'credit', amount: 10 }],
    refunds: toCard,
  }),
  partRefunded('q27-two-part-refunds-then-a-higher-tier', { order: promoOnCard, parts: [{ refundMethod: 'card', amount: 20 }, { refundMethod: 'credit', amount: 10 }], payment: payments.card, prepare: tieredPrivatePrices, refunds: toCard }),
  partRefunded('q27-whole-booking-part-refunded-then-same-tier', { order: promoOnCard, parts: [{ refundMethod: 'card', amount: 90 }], refunds: toCard }),
  booked(
    'q27-guests-through-the-tiers-after-a-part-refund',
    promoOnCard,
    async ({ bookingId, call, add }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await add(bea, payments.card)
      await add(cy)
      await add({ guestName: 'Di Guest', guestsOver18Confirmed: true }, cash(50))
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    tieredPrivatePrices
  ),
  booked(
    'q27-reader-cancelled-after-a-part-refund',
    promoOnCard,
    async ({ bookingId, call }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      const started = (await call('addBookingGuest', { bookingId, ...bea, payment: payments.reader })) as AddAnswer
      await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment?.pendingId })
      await call('addBookingGuest', { bookingId, ...bea })
    },
    tieredPrivatePrices
  ),
  booked(
    'q27-public-booking-part-refund-is-unchanged',
    publicOnCard,
    async ({ bookingId, call, add }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, ...goodwill })
      await add(bea, payments.card)
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    }
  ),
  // --- Q27: what is recorded like a part refund but isn't one
  booked(
    'q27-cheaper-move-is-not-a-part-refund',
    peakPrivateOnCard,
    async ({ bookingId, call, add, move }) => {
      await move(ID.laterPrivateSession, { refundMethod: 'card' })
      await add(bea, payments.card)
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'q27-cheaper-move-to-store-credit-is-not-a-part-refund',
    peakPrivateOnCard,
    async ({ bookingId, call, add, move }) => {
      await move(ID.laterPrivateSession, { refundMethod: 'credit' })
      await add(bea, payments.card)
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'q27-part-refund-after-a-cheaper-move-still-counts',
    oneOnCard,
    async ({ bookingId, call, add, move }) => {
      await move(ID.laterPrivateSession, { refundMethod: 'card' })
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await add(bea)
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    // A move no longer collects a part refund (Q28), so the guest pays the tier difference only.
    'q27-part-refund-before-a-same-price-move-still-counts',
    noPromoOnCard,
    async ({ bookingId, call, add, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await move(ID.laterPrivateSession, { payment: payments.card })
      await add(bea, payments.card)
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // The tier rose to £120 after the booking, so the gap to it can't be what keeps these out.
  booked(
    'q27-addon-refund-is-not-a-part-refund',
    { booking: { ...privateSeats, ...towelOnBooking }, payment: { method: 'card' } },
    async ({ call, db, add, addonLineIds }) => {
      const [addonLineId] = await addonLineIds()
      await call('removeBookingAddon', { addonLineId, refund: 'credit' })
      await db.query(`UPDATE service_type_price_tiers SET price = '120.00' WHERE id = $1`, [ID.privateTier])
      await add(bea, cash(20))
    }
  ),
  booked(
    'q27-a-reversed-charge-is-not-a-part-refund',
    noPromoOnCard,
    async ({ bookingId, call, db, add }) => {
      await db.query(`UPDATE service_type_price_tiers SET price = '120.00' WHERE id = $1`, [ID.privateTier])
      const guestRowFails: WriteFailure = { table: 'booking_guests', event: 'INSERT', when: 'true' }
      await whileFailing(db, guestRowFails, () => call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 20 } } }))
      await add(bea)
    },
    tieredPrivatePrices
  ),
  // --- Q27: where the current tier sets the limit
  booked(
    'q27-guest-removed-then-a-part-refund-then-a-guest',
    noPromoOnCard,
    async ({ bookingId, call, add }) => {
      const guest = await add(bea, payments.card)
      await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 0 })
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 50, ...goodwill })
      await add(cy)
    },
    tieredPrivatePrices
  ),
  booked(
    'q27-tier-price-fell-then-a-part-refund-then-a-guest',
    noPromoOnCard,
    async ({ bookingId, call, db, add }) => {
      await db.query(`UPDATE service_type_price_tiers SET price = '80.00' WHERE id = $1`, [ID.privateTier])
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await add(bea)
    },
    tieredPrivatePrices
  ),
  // --- An add-on paid with a guest goes back to the card it was paid on
  addonOnGuest('addon-with-guest-private-card-not-ticked', { order: promoOnCard, payment: payments.card, ticked: false, prepare: tieredPrivatePrices }),
  addonOnGuest('addon-with-guest-private-reader-ticked', { order: promoOnCard, payment: payments.reader, ticked: true, prepare: tieredPrivatePrices }),
  addonOnGuest('addon-with-guest-private-reader-not-ticked', { order: promoOnCard, payment: payments.reader, ticked: false, prepare: tieredPrivatePrices }),
  addonOnGuest('addon-with-guest-private-split-card-ticked', { order: promoOnCard, payment: payments.storeCreditAndCard, ticked: true, prepare: tieredPrivatePrices }),
  addonOnGuest('addon-with-guest-private-split-card-not-ticked', { order: promoOnCard, payment: payments.storeCreditAndCard, ticked: false, prepare: tieredPrivatePrices }),
  addonOnGuest('addon-with-guest-private-split-reader-ticked', { order: promoOnCard, payment: payments.giftCardAndReader, ticked: true, prepare: tieredPrivatePrices }),
  addonOnGuest('addon-with-guest-private-split-reader-not-ticked', { order: promoOnCard, payment: payments.giftCardAndReader, ticked: false, prepare: tieredPrivatePrices }),
  addonOnGuest('addon-with-guest-private-cash-ticked', { order: promoOnCard, payment: cash(55), ticked: true, prepare: tieredPrivatePrices }),
  addonOnGuest('addon-with-guest-private-to-store-credit-ticked', { order: promoOnCard, payment: payments.card, ticked: true, refundMethod: 'credit', prepare: tieredPrivatePrices }),
  addonOnGuest('addon-with-guest-same-tier-ticked', { order: promoOnCard, payment: payments.card, ticked: true }),
  addonOnGuest('addon-with-guest-same-tier-not-ticked', { order: promoOnCard, payment: payments.card, ticked: false }),
  addonOnGuest('addon-with-no-guest-on-the-card-ticked', { order: promoOnCard, payment: payments.card, ticked: true, noGuest: true }),
  addonOnGuest('addon-with-guest-public-card-ticked', { order: publicOnCard, payment: payments.card, ticked: true }),
  addonOnGuest('addon-with-guest-public-card-not-ticked', { order: publicOnCard, payment: payments.card, ticked: false }),
  addonOnGuest('addon-with-guest-public-reader-ticked', { order: publicOnCard, payment: payments.reader, ticked: true }),
  addonOnGuest('addon-with-guest-public-reader-not-ticked', { order: publicOnCard, payment: payments.reader, ticked: false }),
  addonOnGuest('addon-with-guest-public-split-card-ticked', { order: publicOnCard, payment: payments.storeCreditAndCard, ticked: true }),
  addonOnGuest('addon-with-guest-public-split-card-not-ticked', { order: publicOnCard, payment: payments.storeCreditAndCard, ticked: false }),
  addonOnGuest('addon-with-guest-public-split-reader-ticked', { order: publicOnCard, payment: payments.publicGiftCardAndReader, ticked: true }),
  addonOnGuest('addon-with-guest-public-split-reader-not-ticked', { order: publicOnCard, payment: payments.publicGiftCardAndReader, ticked: false }),
  addonOnGuest('addon-with-guest-public-cash-ticked', { order: publicOnCard, payment: cash(25), ticked: true }),
  // On the first order the booking line is the seat alone: nothing comes off it.
  booked('addon-on-the-first-order-public-ticked', { booking: { ...paidSeat([sam, alex]), ...towelOnBooking }, payment: { method: 'card' } }, async ({ bookingId, call, addonLineIds }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card', addonLineIds: await addonLineIds() })
  }),
  booked('addon-on-the-first-order-public-not-ticked', { booking: { ...paidSeat([sam, alex]), ...towelOnBooking }, payment: { method: 'card' } }, async ({ bookingId, call }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('addon-on-the-first-order-private-ticked', { booking: { ...privateSeats, ...towelOnBooking }, promoCode: PROMO.percent, payment: { method: 'card' } }, async ({ bookingId, call, addonLineIds }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card', addonLineIds: await addonLineIds() })
  }),
  booked('addon-on-the-first-order-private-not-ticked', { booking: { ...privateSeats, ...towelOnBooking }, promoCode: PROMO.percent, payment: { method: 'card' } }, async ({ bookingId, call }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // --- The other refunds that read the same figure
  booked('addon-with-guest-then-remove-guest-then-cancel', publicOnCard, async ({ bookingId, call, add, addonLineIds }) => {
    const guest = await add({ ...bea, ...towelAdded }, payments.card)
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
    await call('refundBooking', { bookingId, refundMethod: 'card', addonLineIds: await addonLineIds() })
  }),
  booked(
    'addon-with-guest-removed-to-the-card-then-cancel',
    promoOnCard,
    async ({ bookingId, call, add }) => {
      const paid = await add({ ...bea, ...towelAdded }, payments.card)
      await call('removeBookingAddon', { addonLineId: paid.addonLineIds?.[0], refund: 'card' })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    tieredPrivatePrices
  ),
  booked(
    'addon-with-guest-removed-to-store-credit-then-cancel',
    promoOnCard,
    async ({ bookingId, call, add }) => {
      const paid = await add({ ...bea, ...towelAdded }, payments.card)
      await call('removeBookingAddon', { addonLineId: paid.addonLineIds?.[0], refund: 'credit' })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    tieredPrivatePrices
  ),
  booked(
    'addon-with-guest-part-refund-then-cancel',
    promoOnCard,
    async ({ bookingId, call, add, addonLineIds }) => {
      await add({ ...bea, ...towelAdded }, payments.card)
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 60, ...goodwill })
      await call('refundBooking', { bookingId, refundMethod: 'card', addonLineIds: await addonLineIds() })
    },
    tieredPrivatePrices
  ),
  booked(
    'addon-with-guest-cheaper-move-then-cancel',
    peakPrivateOnCard,
    async ({ bookingId, call, add, move, addonLineIds }) => {
      await add({ ...bea, ...towelAdded }, payments.card)
      await move(ID.laterPrivateSession, { refundMethod: 'card' })
      await call('refundBooking', { bookingId, refundMethod: 'card', addonLineIds: await addonLineIds() })
    },
    sessionsToMoveBetween
  ),
  booked(
    'q28-public-same-price-part-to-the-card',
    publicOnCard,
    async ({ bookingId, call, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, ...goodwill })
      await move(ID.laterPublicSession, {})
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    laterPublicSession
  ),
  // The seat's old £20 is refused, and only the £10 left goes back.
  booked('remove-guest-capped-an-old-quote-refused', publicOnCard, async ({ bookingId, call, add }) => {
    const guest = await add(bea, payments.card)
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 50, ...goodwill })
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 10, refundMethod: 'card' })
  }),
  // An add-on on a membership credit was never paid for, so nothing comes off the guest's line.
  {
    name: 'credit-addon-with-guest-on-the-card',
    seed,
    async run({ call, db }) {
      const { bookingId } = (await call('createOrder', { customerId: ID.member, booking: paidSeat([mo]), payment: { method: 'card' } })) as { bookingId: string }
      const guest = { bookingId, ...bea, addons: [{ addonId: ID.addon, quantity: 1, redemptionSource: 'membership_credit', membershipId: ID.membership }] }
      await call('addBookingGuest', guest)
      await call('addBookingGuest', { ...guest, payment: payments.card })
      const lines = await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1', [bookingId])
      await call('refundBooking', { bookingId, refundMethod: 'card', addonLineIds: lines.map((line) => line.id) })
    },
  },
  // --- Q27: what W05c's limit got wrong, which part_refunded_amount settles
  booked(
    'q27-tier-rise-after-a-cheaper-move',
    peakPrivateOnCard,
    async ({ bookingId, call, db, add, move }) => {
      await move(ID.laterPrivateSession, { refundMethod: 'card' })
      await db.query(`UPDATE service_type_price_tiers SET price = '120.00' WHERE id = $1`, [ID.privateTier])
      await db.query(`UPDATE service_type_price_tiers SET price = '170.00' WHERE id = $1`, [ID.privateTierThreeToFour])
      await add(bea, payments.card)
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // --- Q28: a part refund stays with the customer on a private move. £100 at Core, £140 at Peak
  booked('q28-private-same-price-part-to-the-card', noPromoOnCard, partThenMove({ amount: 30 }, ID.laterPrivateSession, {}), sessionsToMoveBetween),
  booked('q28-private-same-price-part-to-store-credit', noPromoOnCard, partThenMove({ amount: 30, refundMethod: 'credit' }, ID.laterPrivateSession, {}), sessionsToMoveBetween),
  booked('q28-private-dearer-on-the-card', noPromoOnCard, partThenMove({ amount: 30 }, ID.peakPrivateSession, { payment: payments.card }), sessionsToMoveBetween),
  booked('q28-private-dearer-on-the-reader', noPromoOnCard, partThenMove({ amount: 30 }, ID.peakPrivateSession, { payment: payments.reader }), sessionsToMoveBetween),
  booked('q28-private-dearer-in-cash', noPromoOnCard, partThenMove({ amount: 30 }, ID.peakPrivateSession, { payment: cash(40) }), sessionsToMoveBetween),
  booked('q28-private-dearer-store-credit-and-card', noPromoOnCard, partThenMove({ amount: 30 }, ID.peakPrivateSession, { payment: payments.storeCreditAndCard }), sessionsToMoveBetween),
  booked('q28-private-cheaper-to-the-card', peakPrivateOnCard, partThenMove({ amount: 30 }, ID.laterPrivateSession, { refundMethod: 'card' }), sessionsToMoveBetween),
  booked('q28-private-cheaper-to-store-credit', peakPrivateOnCard, partThenMove({ amount: 30 }, ID.laterPrivateSession, { refundMethod: 'credit' }), sessionsToMoveBetween),
  // The difference is £40, but only £10 is left to give back.
  booked('q28-private-cheaper-stops-at-what-is-left', peakPrivateOnCard, partThenMove({ amount: 130 }, ID.laterPrivateSession, { refundMethod: 'card' }), sessionsToMoveBetween),
  booked('q28-private-cheaper-with-nothing-left', peakPrivateOnCard, partThenMove({ amount: 140 }, ID.laterPrivateSession, {}), sessionsToMoveBetween),
  booked(
    'q28-private-there-and-back',
    noPromoOnCard,
    async ({ bookingId, call, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await move(ID.peakPrivateSession, { payment: payments.card })
      await move(ID.laterPrivateSession, { refundMethod: 'card' })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'q28-private-cheaper-move-then-part-then-dearer-move',
    peakPrivateOnCard,
    async ({ bookingId, call, move }) => {
      await move(ID.laterPrivateSession, { refundMethod: 'card' })
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await move(ID.peakPrivateSession, { payment: payments.card })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'q28-private-part-then-guest-then-move',
    noPromoOnCard,
    async ({ bookingId, call, add, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await add(bea, payments.card)
      await move(ID.peakPrivateSession, { payment: payments.card })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'q28-private-reader-cancelled-puts-it-all-back',
    noPromoOnCard,
    async ({ bookingId, call }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      const newSessionId = ID.peakPrivateSession
      const started = (await call('moveBooking', { bookingId, newSessionId, confirmed: true, payment: payments.reader })) as AddAnswer
      await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment?.pendingId })
      await call('moveBooking', { bookingId, newSessionId })
    },
    sessionsToMoveBetween
  ),
  booked(
    'q28-promo-booking-still-cannot-move',
    promoOnCard,
    async ({ bookingId, call }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession })
    },
    sessionsToMoveBetween
  ),
  // --- Q28 on a public booking. Two seats: £40 at Core, £51 at Peak
  booked('q28-public-same-price-part-to-store-credit', publicOnCard, partThenMove({ amount: 10, refundMethod: 'credit' }, ID.laterPublicSession, {}), laterPublicSession),
  booked('q28-public-dearer-on-the-card', publicOnCard, partThenMove({ amount: 10 }, ID.peakSession, { payment: payments.card })),
  booked('q28-public-dearer-on-the-reader', publicOnCard, partThenMove({ amount: 10 }, ID.peakSession, { payment: payments.reader })),
  booked('q28-public-dearer-in-cash', publicOnCard, partThenMove({ amount: 10 }, ID.peakSession, { payment: cash(11) })),
  booked('q28-public-cheaper-to-the-card', publicPeakOnCard, partThenMove({ amount: 10 }, ID.laterPublicSession, { refundMethod: 'card' }), laterPublicSession),
  booked('q28-public-cheaper-to-store-credit', publicPeakOnCard, partThenMove({ amount: 10 }, ID.laterPublicSession, { refundMethod: 'credit' }), laterPublicSession),
  // The difference is £11, but only £6 is left to give back.
  booked('q28-public-cheaper-stops-at-what-is-left', publicPeakOnCard, partThenMove({ amount: 45 }, ID.laterPublicSession, { refundMethod: 'card' }), laterPublicSession),
  {
    // Mo's own seat is on a credit that Peak doesn't take, so it is paid in full. The guest's £5 stays.
    name: 'q28-public-credit-released-after-a-part-refund',
    seed,
    async run({ call }) {
      const placed = (await call('createOrder', {
        customerId: ID.member,
        booking: { ...paidSeat([mo, alex]), ...memberCredit },
        payment: { method: 'card' },
      })) as { bookingId: string }
      const { bookingId } = placed
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 5, ...goodwill })
      await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
      await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: payments.card })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
  },
  // The removal took £10 where the seat said £20, so £60 of seats now hold £70 paid and given back.
  // A same-price move is still £0.
  booked(
    'q28-public-same-price-after-a-capped-remove-guest',
    publicOnCard,
    async ({ bookingId, call, add, move }) => {
      const guest = await add(bea, payments.card)
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 50, ...goodwill })
      await call('removeBookingGuest', { guestId: guest.guest?.id })
      await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 10, refundMethod: 'card' })
      await add(cy, payments.card)
      await move(ID.laterPublicSession, {})
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    laterPublicSession
  ),
  // --- Remove Guest stops at what is left. Three seats, £60
  booked('remove-guest-more-left-than-the-seat', publicOnCard, removeAfterPart({ amount: 30 }, 20, { refundMethod: 'card' })),
  booked('remove-guest-capped-to-store-credit', publicOnCard, removeAfterPart({ amount: 50 }, 10, { refundMethod: 'credit' })),
  booked('remove-guest-capped-then-cancel', publicOnCard, removeAfterPart({ amount: 45 }, 15, { refundMethod: 'card' }, true)),
  booked('remove-guest-nothing-left', publicOnCard, removeAfterPart({ amount: 60 }, 0, {})),
  // --- part_refunded_amount: a refund that failed leaves it alone
  booked('part-refund-declined-changes-nothing', noPromoOnCard, async ({ bookingId, call, stripe }) => {
    stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill }).catch(() => undefined)
  }),
  // --- A line that gave nothing back isn't stamped
  addonOnGuest('addon-with-guest-same-tier-to-store-credit-not-ticked', { order: promoOnCard, payment: payments.card, ticked: false, refundMethod: 'credit' }),
  addonOnGuest('addon-with-guest-same-tier-to-store-credit-ticked', { order: promoOnCard, payment: payments.card, ticked: true, refundMethod: 'credit' }),
  // --- A lost answer (W05i): the money may have gone, so it stays owed until staff say which
  booked('unsure-part-refund-store-credit-arrived', noPromoOnCard, async ({ bookingId, call }) => {
    await creditCantBeTold(() => call('refundBooking', { bookingId, refundMethod: 'credit', amount: 40, ...goodwill }))
    await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 40, owedArrived: true, reason: 'Found on their balance' })
  }),
  booked('unsure-part-refund-card-then-the-rest-then-cancel', noPromoOnCard, async ({ bookingId, call }) => {
    await losingTheWorkersAnswer('/api/payments/refund-order', () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, ...goodwill }))
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('unsure-part-refund-card-arrived', noPromoOnCard, async ({ bookingId, call }) => {
    await losingTheWorkersAnswer('/api/payments/refund-order', () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, ...goodwill }))
    await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 40, owedArrived: true, reason: 'Seen in Stripe' })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('unsure-cancel-store-credit-arrived', noPromoOnCard, async ({ bookingId, call }) => {
    await creditCantBeTold(() => call('refundBooking', { bookingId, refundMethod: 'credit' }))
    await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 100, owedArrived: true, reason: 'Found on their balance' })
    await call('refundBooking', { bookingId, refundMethod: 'credit' })
  }),
  booked('unsure-cancel-card-pressed-again', noPromoOnCard, async ({ bookingId, call }) => {
    await losingTheWorkersAnswer('/api/payments/refund-order', () => call('refundBooking', { bookingId, refundMethod: 'card' }))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('unsure-remove-guest-store-credit-arrived', publicOnCard, async ({ bookingId, call, add }) => {
    const guest = await add(bea, payments.card)
    const guestId = guest.guest?.id
    await creditCantBeTold(() => call('removeBookingGuest', { guestId, confirmedRefundAmount: 20, refundMethod: 'credit' }))
    await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 20, owedArrived: true, reason: 'Found on their balance' })
    await call('removeBookingGuest', { guestId, confirmedRefundAmount: 0 })
  }),
  booked(
    'unsure-cheaper-move-card-then-the-rest',
    peakPrivateOnCard,
    async ({ bookingId, call, move }) => {
      await losingTheWorkersAnswer('/api/payments/refund-order', () => move(ID.laterPrivateSession, { refundMethod: 'card' }))
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
    },
    sessionsToMoveBetween
  ),
  booked('decline-then-the-same-part-refund-again', noPromoOnCard, async ({ bookingId, call, stripe }) => {
    stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, ...goodwill }).catch(() => undefined)
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, ...goodwill })
  }),
  // --- The function dies after the charge: pressing again charges once and finishes the write
  booked(
    'dies-after-the-charge-move',
    publicOnCard,
    async ({ bookingId, call }) => {
      const confirmed = { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card', storeCredit: { amount: 5 } } }
      await dyingAfter('/api/payments/charge-saved-card', () => call('moveBooking', confirmed))
      await call('moveBooking', confirmed)
    }
  ),
  booked('dies-after-the-charge-add-guest', publicOnCard, async ({ bookingId, call }) => {
    const guest = { bookingId, ...bea, payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 5 } } }
    await dyingAfter('/api/payments/charge-saved-card', () => call('addBookingGuest', guest))
    await call('addBookingGuest', guest)
  }),
  booked(
    'capped-move-down-then-back-up',
    publicPeakOnCard,
    async ({ bookingId, call, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 45, ...goodwill })
      await move(ID.laterPublicSession, { refundMethod: 'card' })
      await move(ID.peakSession, { payment: { method: 'card' } })
    },
    laterPublicSession
  ),
  // --- Cancel & Refund's last statement fails: what went to the card is a part refund, and the booking stays
  booked('cancel-write-fails-after-the-card', noPromoOnCard, (steps) => cancelThatFails(steps)),
  booked(
    'cancel-write-fails-then-a-same-price-move',
    noPromoOnCard,
    async (steps) => {
      await cancelThatFails(steps)
      await steps.move(ID.laterPrivateSession, {})
    },
    sessionsToMoveBetween
  ),
  booked(
    'cancel-write-fails-then-a-guest',
    noPromoOnCard,
    async (steps) => {
      await cancelThatFails(steps)
      await steps.add(bea, payments.card)
    },
    tieredPrivatePrices
  ),
  booked(
    'cancel-write-fails-public-then-a-same-price-move',
    publicOnCard,
    async (steps) => {
      await cancelThatFails(steps)
      await steps.move(ID.laterPublicSession, {})
    },
    laterPublicSession
  ),
  // £90 to the card, and the £10 of store credit taken back, then the retry gives that £10.
  booked('cancel-write-fails-card-and-credit-then-retried', { booking: privateSeats, payment: payments.storeCreditAndCard }, async (steps) => {
    await cancelThatFails(steps)
    await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'card' })
  }),
  booked('cancel-write-fails-to-store-credit', noPromoOnCard, (steps) => cancelThatFails(steps, 'credit')),
  // --- All the seat money went back before the cancel: the cancel gives £0, and the lines are still refunded
  booked('all-part-refunded-to-the-card-then-cancel', noPromoOnCard, async ({ bookingId, call }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('all-part-refunded-to-store-credit-then-cancel', noPromoOnCard, async ({ bookingId, call }) => {
    await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 100, ...goodwill })
    await call('refundBooking', { bookingId, refundMethod: 'credit' })
  }),
  booked('all-part-refunded-card-and-credit-then-cancel', { booking: privateSeats, payment: payments.storeCreditAndCard }, async ({ bookingId, call }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 90, ...goodwill })
    await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 10, ...goodwill })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked(
    'all-part-refunded-with-a-guest-then-cancel',
    noPromoOnCard,
    async ({ bookingId, call, add }) => {
      await add(bea, payments.card)
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 150, ...goodwill })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    tieredPrivatePrices
  ),
  booked('all-part-refunded-addon-not-ticked-then-cancel', { booking: { ...privateSeats, ...towelOnBooking }, payment: payments.card }, async ({ bookingId, call }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('all-part-refunded-addon-ticked-then-cancel', { booking: { ...privateSeats, ...towelOnBooking }, payment: payments.card }, async ({ bookingId, call, addonLineIds }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
    await call('refundBooking', { bookingId, refundMethod: 'card', addonLineIds: await addonLineIds() })
  }),
  booked('nearly-all-part-refunded-then-cancel', noPromoOnCard, async ({ bookingId, call }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 99, ...goodwill })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // price_paid is forced to £0 in these three, so only the refunds themselves can say what went back.
  booked('price-paid-cleared-nothing-back-then-cancel', noPromoOnCard, async ({ bookingId, call, db }) => {
    await db.query(`UPDATE bookings SET price_paid = 0 WHERE id = $1`, [bookingId])
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('price-paid-cleared-half-back-then-cancel', noPromoOnCard, async ({ bookingId, call, db }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 50, ...goodwill })
    await db.query(`UPDATE bookings SET price_paid = 0 WHERE id = $1`, [bookingId])
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // £95 of seat money and the £5 Towel's store credit reach the £100 seats only if the Towel counts.
  booked('price-paid-cleared-addon-credit-is-not-seat-money', { booking: { ...privateSeats, ...towelOnBooking }, payment: payments.card }, async ({ bookingId, call, db, addonLineIds }) => {
    const [addonLineId] = await addonLineIds()
    await call('removeBookingAddon', { addonLineId, refund: 'credit' })
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 95, ...goodwill })
    await db.query(`UPDATE bookings SET price_paid = 0 WHERE id = $1`, [bookingId])
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // --- Store credit fails partway through Remove Guest: the £10 it couldn't give stays on the booking
  booked('remove-guest-credit-fails-partway', publicMostlyStoreCredit, async ({ call, db, add }) => {
    const guest = await add(bea, cash(20))
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await whileFailing(db, refundCreditFails, () =>
      call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
    )
  }),
  booked('remove-guest-credit-fails-partway-then-retried', publicMostlyStoreCredit, async ({ bookingId, call, db, add }) => {
    const guest = await add(bea, cash(20))
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await whileFailing(db, refundCreditFails, () =>
      call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
    )
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, refundOwed: true })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // --- Store credit fails partway through a move's refund: the same
  // £15 part refund leaves £6 on the card for the £11 the move gives back, so £5 fails.
  booked(
    'public-move-credit-fails-partway',
    publicPeakPartCredit,
    async ({ bookingId, call, db, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 15, ...goodwill })
      await whileFailing(db, refundCreditFails, () => move(ID.laterPublicSession, { refundMethod: 'card' }))
    },
    laterPublicSession
  ),
  booked(
    'public-move-credit-fails-partway-then-retried',
    publicPeakPartCredit,
    async ({ bookingId, call, db, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 15, ...goodwill })
      await whileFailing(db, refundCreditFails, () => move(ID.laterPublicSession, { refundMethod: 'card' }))
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 5, refundOwed: true })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    laterPublicSession
  ),
  // £100 part refund leaves £10 on the card for the £40 the move gives back, so £30 fails.
  booked(
    'private-move-credit-fails-partway',
    peakPrivatePartCredit,
    async ({ bookingId, call, db, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
      await whileFailing(db, refundCreditFails, () => move(ID.laterPrivateSession, { refundMethod: 'card' }))
    },
    sessionsToMoveBetween
  ),
  booked(
    'private-move-credit-fails-partway-then-retried',
    peakPrivatePartCredit,
    async ({ bookingId, call, db, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
      await whileFailing(db, refundCreditFails, () => move(ID.laterPrivateSession, { refundMethod: 'card' }))
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, refundOwed: true })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // Not retried: the next same-price move costs nothing and leaves the £30 owed.
  booked(
    'private-move-credit-fails-then-a-same-price-move-leaves-it-owed',
    peakPrivatePartCredit,
    async ({ bookingId, call, db, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
      await whileFailing(db, refundCreditFails, () => move(ID.laterPrivateSession, { refundMethod: 'card' }))
      await move(ID.privateSession, { refundMethod: 'credit' })
    },
    sessionsToMoveBetween
  ),
  // Given with Refund the rest, then moved at the same price: the £10 is not given a second time.
  booked(
    'private-move-rest-retried-then-a-same-price-move',
    peakPrivatePartCredit,
    async ({ bookingId, call, db, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 80, ...goodwill })
      await whileFailing(db, refundCreditFails, () => move(ID.laterPrivateSession, { refundMethod: 'card' }))
      await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 10, refundOwed: true })
      await move(ID.privateSession, { refundMethod: 'credit' })
    },
    sessionsToMoveBetween
  ),
  // --- A move's refund fails outright: all of it stays on the booking, owed
  booked(
    'move-refund-store-credit-fails-outright',
    peakPrivateOnCard,
    ({ db, move }) => whileFailing(db, refundCreditFails, () => move(ID.laterPrivateSession, { refundMethod: 'credit' })),
    sessionsToMoveBetween
  ),
  booked(
    'move-refund-store-credit-fails-outright-then-retried',
    peakPrivateOnCard,
    async ({ bookingId, call, db, move }) => {
      await whileFailing(db, refundCreditFails, () => move(ID.laterPrivateSession, { refundMethod: 'credit' }))
      await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 40, refundOwed: true })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'move-refund-card-declined',
    peakPrivateOnCard,
    async ({ stripe, move }) => {
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      await move(ID.laterPrivateSession, { refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'move-refund-card-declined-then-retried',
    peakPrivateOnCard,
    async ({ bookingId, call, stripe, move }) => {
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      await move(ID.laterPrivateSession, { refundMethod: 'card' })
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'public-move-refund-fails-outright-then-retried',
    publicPeakOnCard,
    async ({ bookingId, call, db, move }) => {
      await whileFailing(db, refundCreditFails, () => move(ID.laterPublicSession, { refundMethod: 'credit' }))
      await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 11, refundOwed: true })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    laterPublicSession
  ),
  // --- Store credit counts as seat money gone back on a live booking
  booked('part-refund-to-store-credit-stays-live', noPromoOnCard, async ({ bookingId, call }) => {
    await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 30, ...goodwill })
  }),
  booked(
    'cheaper-move-to-store-credit-stays-live',
    peakPrivateOnCard,
    ({ move }) => move(ID.laterPrivateSession, { refundMethod: 'credit' }),
    sessionsToMoveBetween
  ),
  // --- Remove Guest: the guest's own order is refunded when their seat's money has gone back
  booked('remove-guest-on-the-card', publicOnCard, async ({ call, add }) => {
    const guest = await add(bea, payments.card)
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
  }),
  booked('remove-guest-to-store-credit', publicOnCard, async ({ call, add }) => {
    const guest = await add(bea, payments.card)
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'credit' })
  }),
  booked('remove-guest-paid-in-cash', publicOnCard, async ({ call, add }) => {
    const guest = await add(bea, cash(20))
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'credit' })
  }),
  booked('remove-guest-the-older-of-two', publicOnCard, async ({ call, add }) => {
    const older = await add(bea, payments.card)
    await add(cy, payments.card)
    await call('removeBookingGuest', { guestId: older.guest?.id })
    await call('removeBookingGuest', { guestId: older.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
  }),
  booked('remove-guest-both-of-two', publicOnCard, async ({ call, add }) => {
    for (const person of [await add(bea, payments.card), await add(cy, payments.card)]) {
      await call('removeBookingGuest', { guestId: person.guest?.id })
      await call('removeBookingGuest', { guestId: person.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
    }
  }),
  booked('remove-guest-their-addon-left', publicOnCard, async ({ call, add }) => {
    const guest = await add({ ...bea, ...towelAdded }, payments.card)
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
  }),
  // Alex's seat is on the first order's line with Sam's, so that line can't say refunded.
  booked('remove-a-seat-from-the-first-order', publicOnCard, async ({ bookingId, call, db }) => {
    const seats = await db.query<{ id: string }>(`SELECT id FROM booking_guests WHERE booking_id = $1 AND guest_type = 'additional_guest'`, [bookingId])
    await call('removeBookingGuest', { guestId: seats[0]?.id })
    await call('removeBookingGuest', { guestId: seats[0]?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
  }),
  // Peak seats at £25.50 fall to £20 and £16.50 goes back on the move, so Bea's £25.50 line holds more
  // than the seat removed. It stays unstamped: nothing says which seat that line was.
  booked(
    'remove-guest-after-a-cheaper-move',
    publicPeakOnCard,
    async ({ call, add, move }) => {
      const guest = await add(bea, payments.card)
      await move(ID.laterPublicSession, { refundMethod: 'card' })
      await call('removeBookingGuest', { guestId: guest.guest?.id })
      await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
    },
    laterPublicSession
  ),
  booked('remove-guest-then-cancel', publicOnCard, async ({ bookingId, call, add }) => {
    const guest = await add(bea, payments.card)
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'credit' })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // --- Cancel & return credit on a credit booking whose paid seat's money has gone back
  booked('credit-booking-paid-seat-part-refunded-to-the-card-then-cancelled', creditAndPaidSeat, (steps) => partRefundThenCancelCredit(steps, 'card')),
  booked('credit-booking-paid-seat-part-refunded-to-store-credit-then-cancelled', creditAndPaidSeat, (steps) => partRefundThenCancelCredit(steps, 'credit')),
  // price_paid forced to £0: the seat's money never went back, so the cancel must not say it did.
  booked('credit-booking-price-paid-cleared-then-cancelled', creditAndPaidSeat, async ({ bookingId, call, db }) => {
    await db.query(`UPDATE bookings SET price_paid = 0 WHERE id = $1`, [bookingId])
    await call('cancelCreditBooking', { bookingId })
  }),
  // The paid seat is on the first line, and nothing is left, so that line can say refunded.
  booked('credit-booking-paid-seat-removed', creditAndPaidSeat, async ({ bookingId, call, db }) => {
    const seats = await db.query<{ id: string }>(`SELECT id FROM booking_guests WHERE booking_id = $1 AND guest_type = 'additional_guest'`, [bookingId])
    await call('removeBookingGuest', { guestId: seats[0]?.id })
    await call('removeBookingGuest', { guestId: seats[0]?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
  }),
  booked('credit-booking-paid-guest-removed-then-cancelled', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} }, async ({ bookingId, call, add }) => {
    const guest = await add(bea, payments.card)
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
    await call('cancelCreditBooking', { bookingId })
  }),
  booked('credit-booking-no-money-cancelled', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} }, async ({ bookingId, call }) => {
    await call('cancelCreditBooking', { bookingId })
  }),
  // --- A reader move is open: price_paid is put back from a snapshot if it's cancelled, so nothing may change it
  booked('remove-guest-while-a-reader-move-is-open', publicOnCard, async ({ bookingId, call, add }) => {
    const guest = await add(bea, payments.card)
    const pendingId = await readerMoveLeftOpen(bookingId, call)
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 25.5, refundMethod: 'card' })
    await call('cancelReaderPayment', { pendingId })
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('cancel-while-a-reader-move-is-open', publicOnCard, async ({ bookingId, call }) => {
    const pendingId = await readerMoveLeftOpen(bookingId, call)
    await call('refundBooking', { bookingId, refundMethod: 'card' }).catch(() => undefined)
    await call('cancelReaderPayment', { pendingId })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('add-guest-while-a-reader-move-is-open', publicOnCard, async ({ bookingId, call, add }) => {
    const pendingId = await readerMoveLeftOpen(bookingId, call)
    await add(bea, payments.card)
    await call('cancelReaderPayment', { pendingId })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked(
    'second-move-while-a-reader-move-is-open',
    publicOnCard,
    async ({ bookingId, call }) => {
      const pendingId = await readerMoveLeftOpen(bookingId, call)
      await call('moveBooking', { bookingId, newSessionId: ID.laterPublicSession, confirmed: true, refundMethod: 'card' })
      await call('cancelReaderPayment', { pendingId })
    },
    laterPublicSession
  ),
  booked('reader-move-finished-then-remove-guest', publicOnCard, async ({ bookingId, call, stripe, add }) => {
    const guest = await add(bea, payments.card)
    const started = (await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: payments.reader })) as AddAnswer
    stripe.completeReaderPayment(started.pendingReaderPayment?.paymentIntentId ?? '')
    await call('finaliseReaderPayment', { pendingId: started.pendingReaderPayment?.pendingId })
    await call('removeBookingGuest', { guestId: guest.guest?.id })
    await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 25.5, refundMethod: 'card' })
  }),
  // --- W05g: Refund the rest, and what a later action does with money owed
  // Peak £140 moved to £100 with the store credit failing: £40 owed, £140 on price_paid.
  booked(
    'owed-then-a-same-price-move',
    peakPrivateOnCard,
    async ({ bookingId, call, db, move }) => {
      await fortyOwed({ db, move })
      await move(ID.privateSession, {})
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'owed-then-a-dearer-move',
    peakPrivateOnCard,
    async ({ bookingId, call, db, move }) => {
      await fortyOwed({ db, move })
      await move(ID.peakPrivateSession, { payment: payments.card })
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // The dearer move, then Cancel & Refund with the money still owed: it gives that too.
  booked(
    'owed-then-a-dearer-move-then-cancel',
    peakPrivateOnCard,
    async ({ bookingId, call, db, move }) => {
      await fortyOwed({ db, move })
      await move(ID.peakPrivateSession, { payment: payments.card })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // £110 part refund leaves £30, all of it owed once the move's refund fails. A same-price move
  // works out £10 too much was given, and has nothing left to take it from: it must not touch the £30.
  booked(
    'owed-with-nothing-left-then-a-same-price-move',
    peakPrivateOnCard,
    async ({ bookingId, call, db, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 110, ...goodwill })
      await whileFailing(db, refundCreditFails, () => move(ID.laterPrivateSession, { refundMethod: 'credit' }))
      await move(ID.privateSession, { refundMethod: 'credit' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'owed-public-then-a-same-price-move',
    publicPeakOnCard,
    async ({ bookingId, call, db, move }) => {
      await whileFailing(db, refundCreditFails, () => move(ID.laterPublicSession, { refundMethod: 'credit' }))
      await move(ID.session, {})
      await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 11, refundOwed: true })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    laterPublicSession
  ),
  // One seat at Peak, moved to £100: a second guest is the same tier, so nothing is due.
  booked(
    'owed-then-a-guest-same-tier',
    oneOnCard,
    async ({ bookingId, call, db, move, add }) => {
      await fortyOwed({ db, move })
      await add(bea)
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // Three people at Core is £150, and only £100 was paid toward it: the £40 owed pays for nothing.
  booked(
    'owed-then-a-guest-higher-tier',
    peakPrivateOnCard,
    async ({ bookingId, call, db, move, add }) => {
      await fortyOwed({ db, move })
      await add(bea, payments.card)
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // £76.50 for three at Peak, moved to £60 with £16.50 owed, then £50 part refunded: £10 is left,
  // so the guest's £20 seat stops at £10 and the £16.50 stays owed.
  booked(
    'owed-then-remove-guest-stops-at-what-is-left',
    publicPeakOnCard,
    async ({ bookingId, call, db, move, add }) => {
      const guest = await add(bea, payments.card)
      await whileFailing(db, refundCreditFails, () => move(ID.laterPublicSession, { refundMethod: 'credit' }))
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 50, ...goodwill })
      await call('removeBookingGuest', { guestId: guest.guest?.id })
      await call('removeBookingGuest', { guestId: guest.guest?.id, confirmedRefundAmount: 10, refundMethod: 'card' })
      await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 16.5, refundOwed: true })
    },
    laterPublicSession
  ),
  booked(
    'owed-then-cancel',
    peakPrivateOnCard,
    async ({ bookingId, call, db, move }) => {
      await fortyOwed({ db, move })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // All £140 reaches the card and the cancel then fails: £40 of it was the money owed.
  booked(
    'owed-then-cancel-write-fails',
    peakPrivateOnCard,
    async ({ bookingId, call, db, move }) => {
      await fortyOwed({ db, move })
      await cancelThatFails({ bookingId, call, db })
    },
    sessionsToMoveBetween
  ),
  // £110 reaches the card and the £30 store credit is taken back, so £30 is left to retry.
  booked(
    'owed-then-cancel-write-fails-after-part-of-it',
    peakPrivatePartCredit,
    async ({ bookingId, call, db, move }) => {
      await fortyOwed({ db, move })
      await cancelThatFails({ bookingId, call, db })
      await call('refundBooking', { bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // £100 part refund leaves £10 on the card, then £40 owed: card money doesn't cover what's owed.
  booked(
    'refund-the-rest-card-then-store-credit',
    peakPrivatePartCredit,
    async ({ bookingId, call, db, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
      await fortyOwed({ db, move })
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
    },
    sessionsToMoveBetween
  ),
  booked(
    'refund-the-rest-fails-partway-then-retried',
    peakPrivatePartCredit,
    async ({ bookingId, call, db, move }) => {
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
      await fortyOwed({ db, move })
      await whileFailing(db, refundCreditFails, () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true }))
      await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 30, refundOwed: true })
    },
    sessionsToMoveBetween
  ),
  // --- W05g: a part refund failing partway. £100 and a third guest's £50 on their own order: a £120
  // part refund takes £50 from the newest order, the card then declines, and store credit fails.
  booked(
    'part-refund-fails-partway',
    noPromoOnCard,
    async (steps) => {
      await add120Failing(steps)
    },
    sessionsToMoveBetween
  ),
  booked(
    'part-refund-fails-partway-then-the-rest',
    noPromoOnCard,
    async (steps) => {
      await add120Failing(steps)
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'credit', amount: 70, refundOwed: true })
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  booked(
    'part-refund-fails-partway-then-a-same-price-move',
    noPromoOnCard,
    async (steps) => {
      await add120Failing(steps)
      await steps.move(ID.laterPrivateSession, {})
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'card', amount: 70, refundOwed: true })
      await steps.move(ID.privateSession, {})
    },
    sessionsToMoveBetween
  ),
  booked(
    'part-refund-fails-partway-then-a-guest',
    noPromoOnCard,
    async (steps) => {
      await add120Failing(steps)
      await steps.add(cy)
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // --- W05g: a reader payment left open blocks both, until it is cancelled
  booked('part-refund-while-a-reader-move-is-open', publicOnCard, async ({ bookingId, call }) => {
    const pendingId = await readerMoveLeftOpen(bookingId, call)
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, ...goodwill }).catch(() => undefined)
    await call('cancelReaderPayment', { pendingId })
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, ...goodwill })
  }),
  booked(
    'refund-the-rest-while-a-reader-move-is-open',
    publicPeakOnCard,
    async ({ bookingId, call, db, move }) => {
      await whileFailing(db, refundCreditFails, () => move(ID.laterPublicSession, { refundMethod: 'credit' }))
      const pendingId = await readerMoveLeftOpen(bookingId, call)
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 11, refundOwed: true }).catch(() => undefined)
      await call('cancelReaderPayment', { pendingId })
      await call('refundBooking', { bookingId, refundMethod: 'card', amount: 11, refundOwed: true })
    },
    laterPublicSession
  ),
  // --- W05h: store credit that landed though its answer was lost. Paying it would give £40 twice.
  booked(
    'owed-arrived-after-a-lost-answer',
    peakPrivateOnCard,
    async (steps) => {
      await fortyLanded(steps)
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'credit', ...itArrived })
    },
    sessionsToMoveBetween
  ),
  booked(
    'owed-arrived-then-a-same-price-move',
    peakPrivateOnCard,
    async (steps) => {
      await fortyLanded(steps)
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'credit', ...itArrived })
      await steps.move(ID.privateSession, {})
    },
    sessionsToMoveBetween
  ),
  booked(
    'owed-arrived-then-cancel',
    peakPrivateOnCard,
    async (steps) => {
      await fortyLanded(steps)
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'credit', ...itArrived })
      await steps.call('refundBooking', { bookingId: steps.bookingId, refundMethod: 'card' })
    },
    sessionsToMoveBetween
  ),
  // --- W05h: a guest on the reader, in price_paid but not collected, blocks all of these
  booked('cancel-while-a-guest-is-on-the-reader', publicOnCard, async ({ bookingId, call }) => {
    const pendingId = await readerGuestLeftOpen(bookingId, call)
    await call('refundBooking', { bookingId, refundMethod: 'card' }).catch(() => undefined)
    await call('cancelReaderPayment', { pendingId })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('remove-guest-while-a-guest-is-on-the-reader', publicOnCard, async ({ bookingId, call, add }) => {
    const paid = await add(bea, payments.card)
    const pendingId = await readerGuestLeftOpen(bookingId, call)
    const removal = { guestId: paid.guest?.id, confirmedRefundAmount: 20, refundMethod: 'card' }
    await call('removeBookingGuest', removal)
    await call('cancelReaderPayment', { pendingId })
    await call('removeBookingGuest', removal)
  }),
  booked('second-guest-while-a-guest-is-on-the-reader', publicOnCard, async ({ bookingId, call, add }) => {
    const pendingId = await readerGuestLeftOpen(bookingId, call)
    await call('addBookingGuest', { bookingId, ...bea })
    await call('cancelReaderPayment', { pendingId })
    await add(bea, payments.card)
  }),
  booked('move-while-a-guest-is-on-the-reader', publicOnCard, async ({ bookingId, call, move }) => {
    const pendingId = await readerGuestLeftOpen(bookingId, call)
    await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: payments.card })
    await call('cancelReaderPayment', { pendingId })
    await move(ID.peakSession, { payment: payments.card })
  }),
  // --- W05g: what the dialogs show
  figures('figures-on-the-card', noPromoOnCard),
  figures('figures-in-cash', { booking: privateSeats, payment: cash(100) }),
  figures('figures-card-gift-card-and-store-credit', {
    booking: privateSeats,
    payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } },
  }),
  booked('figures-after-a-part-refund', noPromoOnCard, async ({ bookingId, call }) => {
    await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
    await call('getBookingRefundFigures', { bookingId })
  }),
  booked('figures-card-order-and-a-cash-guest', publicOnCard, async ({ bookingId, call, add }) => {
    await add(bea, cash(20))
    await call('getBookingRefundFigures', { bookingId })
  }),
  booked('figures-card-order-and-a-guest-on-store-credit', publicOnCard, async ({ bookingId, call, add }) => {
    await add(bea, { storeCredit: { amount: 20 } })
    await call('getBookingRefundFigures', { bookingId })
  }),
  booked(
    'figures-with-money-owed',
    peakPrivateOnCard,
    async ({ bookingId, call, db, move }) => {
      await fortyOwed({ db, move })
      await call('getBookingRefundFigures', { bookingId })
    },
    sessionsToMoveBetween
  ),
  // --- W05k: two presses at once on one booking share one charge (review 2, finding 1) ----------------
  // Settle: a £20 seat, £2 of it store credit and £18 on the card.
  {
    name: 'p1-two-settles-at-once',
    seed,
    async run({ call, db }) {
      const placed = (await call('createOrder', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} })) as { bookingId: string }
      await db.query(`UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1`, [placed.bookingId])
      await db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.member])
      const press = () => call('settleLapsedBooking', { bookingId: placed.bookingId, payment: { method: 'card', storeCredit: { amount: 2 } } })
      afterTheCharge(press)
      await press()
    },
  },
  {
    name: 'p1-two-settles-the-other-way-round',
    seed,
    async run({ call, db }) {
      const placed = (await call('createOrder', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} })) as { bookingId: string }
      await db.query(`UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1`, [placed.bookingId])
      await db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.member])
      const press = () => call('settleLapsedBooking', { bookingId: placed.bookingId, payment: { method: 'card', storeCredit: { amount: 2 } } })
      beforeTheStartedRow(press)
      await press()
    },
  },
  // Add Guest: a £20 guest, £5 of it store credit and £15 on the card.
  booked('p2-two-add-guests-at-once', publicOnCard, async ({ bookingId, call, db }) => {
    await db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.customer])
    const press = () => call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } })
    afterTheCharge(press)
    await press()
  }),
  booked('p2-two-add-guests-the-other-way-round', publicOnCard, async ({ bookingId, call, db }) => {
    await db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.customer])
    const press = () => call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } })
    beforeTheStartedRow(press)
    await press()
  }),
  booked('p2-add-guest-first-press-alive-a-minute-later', publicOnCard, async ({ bookingId, call, db }) => {
    await db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.customer])
    const press = () => call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } })
    afterTheCharge(async () => {
      later(A_PRESS_LATER)
      await press()
    })
    await press()
  }),
  // Move: £40 to the £51 session, £2 of the £11 in store credit and £9 on the card.
  booked('p2-two-moves-the-other-way-round', publicOnCard, async ({ bookingId, call, db }) => {
    await db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.customer])
    const press = () => call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card', storeCredit: { amount: 2 } } })
    beforeTheStartedRow(press)
    await press()
  }),
  // --- W05k: two cancels of the same event place to the card at once (finding 2)
  {
    name: 'p3-one-event-place-cancelled-twice-at-once',
    seed,
    async run({ call, db }) {
      const placed = (await call('createOrder', { customerId: ID.customer, event: eventPlaces, payment: { method: 'card' } })) as { eventBookingId: string }
      const places = await db.query<{ id: string }>('SELECT id FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id', [placed.eventBookingId])
      const cancel = (id: string) => call('cancelEventPlaces', { eventBookingId: placed.eventBookingId, attendeeIds: [id], refund: 'card' })
      afterTheRefund(() => cancel(places[0]!.id))
      await cancel(places[0]!.id)
      await cancel(places[1]!.id)
    },
  },
  // --- W05k: a charge whose order lands after the press gave up, then pressed again (finding 4)
  booked('p4-charge-lands-after-the-press-gave-up', publicOnCard, async ({ bookingId, call, db }) => {
    await db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.customer])
    const guest = { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } }
    await chargeLandingLate(() => call('addBookingGuest', guest))
    await call('addBookingGuest', guest)
  }),
  // --- W05k: a held event card refund, then the next presses two days later (finding 3)
  {
    name: 'p5-held-event-refund-two-days-later',
    seed,
    async run({ call, db, stripe }) {
      const placed = (await call('createOrder', { customerId: ID.customer, event: eventPlaces, payment: { method: 'card' } })) as { eventBookingId: string }
      const places = await db.query<{ id: string }>('SELECT id FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id', [placed.eventBookingId])
      const cancel = (id: string) => call('cancelEventPlaces', { eventBookingId: placed.eventBookingId, attendeeIds: [id], refund: 'card' })
      await losingTheWorkersAnswer(REFUND_PATH, () => cancel(places[0]!.id))
      later(TWO_DAYS)
      stripe.forgetIdempotencyKeys()
      await cancel(places[1]!.id)
      await cancel(places[0]!.id)
    },
  },
  // --- W05l: a gift card part on Move and Settle writes its redemption row, as Add Guest does ----------
  // Move: £40 to the £51 session, £5 of the £11 on the gift card and £6 on the card, reader or in cash.
  booked('w05l-move-gift-card-and-card-then-cancel', publicOnCard, async ({ bookingId, call, move }) => {
    await move(ID.peakSession, { payment: w05lPay.card })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('w05l-move-gift-card-and-reader-then-cancel', publicOnCard, async ({ bookingId, call, move }) => {
    await move(ID.peakSession, { payment: w05lPay.reader })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('w05l-move-gift-card-and-cash-then-cancel', publicOnCard, async ({ bookingId, call, move }) => {
    await move(ID.peakSession, { payment: w05lPay.cash })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('w05l-move-gift-card-and-reader-undone-then-cancel', publicOnCard, async ({ bookingId, call }) => {
    const started = (await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: w05lPay.reader })) as AddAnswer
    await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment?.pendingId })
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('w05l-move-gift-card-row-fails-then-cancel', publicOnCard, async ({ bookingId, call, db, move }) => {
    await whileFailing(db, giftCardRowFails, () => move(ID.peakSession, { payment: w05lPay.card }))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('w05l-move-gift-card-answer-lost-then-cancel', publicOnCard, async ({ bookingId, call, move }) => {
    await losingTheAnswer(MOVE_STATEMENT, () => move(ID.peakSession, { payment: w05lPay.card }))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // Settle: a £20 seat, £5 on the gift card and £15 on the card or the reader.
  lapsed('w05l-settle-gift-card-and-card-then-cancel', async ({ call, stripe }, bookingId) => {
    await settle(call, stripe, bookingId, w05lPay.card)
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  lapsed('w05l-settle-gift-card-and-reader-then-cancel', async ({ call, stripe }, bookingId) => {
    await settle(call, stripe, bookingId, w05lPay.reader)
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // Undone on the reader, then settled again on the saved card: one row, for the second.
  lapsed('w05l-settle-gift-card-and-reader-undone-then-settled', async ({ call, stripe }, bookingId) => {
    const started = (await call('settleLapsedBooking', { bookingId, payment: w05lPay.reader })) as AddAnswer
    await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment?.pendingId })
    await settle(call, stripe, bookingId, w05lPay.card)
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  lapsed('w05l-settle-gift-card-row-fails', async ({ call, db, stripe }, bookingId) => {
    await whileFailing(db, giftCardRowFails, () => settle(call, stripe, bookingId, w05lPay.card))
  }),
  lapsed('w05l-settle-gift-card-answer-lost-then-cancel', async ({ call, stripe }, bookingId) => {
    await losingTheAnswer(SETTLE_STATEMENT, () => settle(call, stripe, bookingId, w05lPay.card))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // --- W05l: a statement that wrote and lost its answer, with no card charge, is never undone ------------
  booked('w05l-move-gift-card-and-cash-answer-lost-then-cancel', publicOnCard, async ({ bookingId, call, move }) => {
    await losingTheAnswer(MOVE_STATEMENT, () => move(ID.peakSession, { payment: w05lPay.cash }))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('w05l-move-gift-card-and-reader-answer-lost-then-cancel', publicOnCard, async ({ bookingId, call, move }) => {
    await losingTheAnswer(MOVE_STATEMENT, () => move(ID.peakSession, { payment: w05lPay.reader }))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // £51 to the £40 session: the £11 difference still goes back to the card.
  booked(
    'w05l-move-cheaper-answer-lost',
    publicPeakOnCard,
    async ({ move }) => {
      await losingTheAnswer(MOVE_STATEMENT, () => move(ID.laterPublicSession, { refundMethod: 'card' }))
    },
    laterPublicSession
  ),
  booked('w05l-move-answer-lost-and-the-look-fails', publicOnCard, async ({ move }) => {
    await losingTheAnswer(andTheLookFails(MOVE_STATEMENT), () => move(ID.peakSession, { payment: w05lPay.cash }))
  }),
  lapsed('w05l-settle-gift-card-and-cash-answer-lost-then-cancel', async ({ call, stripe }, bookingId) => {
    await losingTheAnswer(SETTLE_STATEMENT, () => settle(call, stripe, bookingId, { ...w05lPay.card, method: 'cash', confirmedCashAmount: 15 }))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  lapsed('w05l-settle-gift-card-and-reader-answer-lost-then-cancel', async ({ call, stripe }, bookingId) => {
    await losingTheAnswer(SETTLE_STATEMENT, () => settle(call, stripe, bookingId, w05lPay.reader))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  lapsed('w05l-settle-answer-lost-and-the-look-fails', async ({ call, stripe }, bookingId) => {
    await losingTheAnswer(andTheLookFails(SETTLE_STATEMENT), () => settle(call, stripe, bookingId, { ...w05lPay.card, method: 'cash', confirmedCashAmount: 15 }))
  }),
  // Bea's £20 seat: £5 on the gift card and £15 in cash.
  booked('w05l-add-guest-gift-card-and-cash-answer-lost-then-cancel', publicOnCard, async ({ bookingId, call, add }) => {
    await losingTheAnswer(ADD_GUEST_STATEMENT, () => add(bea, { ...cash(15), giftCard: W05L_GIFT }))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('w05l-add-guest-gift-card-and-reader-answer-lost-then-cancel', publicOnCard, async ({ bookingId, call, add }) => {
    await losingTheAnswer(ADD_GUEST_STATEMENT, () => add(bea, w05lPay.reader))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  // An earlier press's row on the same booking is not this press's: a statement that really failed is undone.
  booked('w05l-move-fails-after-another-press-finished', publicOnCard, async ({ bookingId, call, db, add, move }) => {
    await add(bea, cash(20))
    await whileFailing(db, giftCardRowFails, () => move(ID.peakSession, { payment: { ...w05lPay.cash, confirmedCashAmount: 11.5 } }))
    await call('refundBooking', { bookingId, refundMethod: 'card' })
  }),
  booked('w05l-add-guest-answer-lost-and-the-look-fails', publicOnCard, async ({ add }) => {
    await losingTheAnswer(andTheLookFails(ADD_GUEST_STATEMENT), () => add(bea, { ...cash(15), giftCard: W05L_GIFT }))
  }),
  ...w06Scenarios(),
]

// --- W06: the Worker's order core. Every createOrder and createBooking reason in W06's scope that had
// no scenario yet, and the paid and nothing-owed shapes it builds. They run through the old createOrder
// for their golden files, and order-replay.test.ts runs them through the new route too.
function w06Scenarios(): Scenario[] {
  const robe = { addonId: ID.robe, quantity: 1, unitPrice: 8, systemUnitPrice: 8 }
  const moCredit = { ...paidSeat([mo]), ...memberCredit }
  const UNKNOWN = '10000000-0000-4000-8000-0000000000ff'
  return [
    // Paid and nothing owed
    order('w06-standalone-addon-in-cash', { standaloneAddons: [towel], payment: cash(5) }),
    order('w06-booking-and-a-standalone-addon-in-cash', { booking: paidSeat(), standaloneAddons: [towel], payment: cash(25) }),
    order('w06-private-booking-with-an-addon', { booking: { ...privateSeats, addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: cash(105) }),
    order('w06-member-credit-and-nothing-owed', { customerId: ID.member, booking: moCredit, payment: {} }),
    order('w06-pass-credit-and-nothing-owed', { booking: { ...paidSeat(), ...ownedPass }, payment: {} }),
    order('w06-cash-chosen-with-nothing-owed', { customerId: ID.member, booking: moCredit, payment: cash(0) }),
    order('w06-two-addon-credits-on-one-membership', {
      customerId: ID.member,
      booking: {
        ...paidSeat([mo, alex]),
        ...memberCredit,
        addons: [
          { ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership },
          { ...robe, redemptionSource: 'membership_credit', membershipId: ID.membership },
        ],
      },
      payment: cash(20),
    }),
    order('w06-special-requests-kept', { booking: { ...paidSeat(), specialRequests: '  Step-free access, please  ' }, payment: cash(20) }),
    order('w06-a-full-public-party', { booking: paidSeat([sam, alex, alex, alex, alex, alex]), payment: cash(120) }),
    order('w06-override-with-permission-in-cash', { standaloneAddons: [{ ...towel, unitPrice: 3, priceOverrideReason: '  Regular  ' }], payment: cash(3) }),
    order('w06-override-without-permission-is-ignored-in-cash', { standaloneAddons: [{ ...towel, unitPrice: 1 }], payment: cash(5) }, noPricing),
    // Stage 1 and 2: before anything is read
    order('w06-refused-no-customer', { customerId: undefined, booking: paidSeat(), payment: cash(20) }),
    order('w06-refused-empty-order', { payment: cash(0) }),
    order('w06-refused-gift-card-booking-source', { booking: { ...paidSeat(), redemptionSource: 'gift_card' }, payment: cash(0) }),
    order('w06-refused-unknown-customer', { customerId: UNKNOWN, booking: paidSeat(), payment: cash(20) }),
    // Stage 3
    order('w06-refused-credit-on-a-private-booking', { customerId: ID.member, booking: { ...privateSeats, guests: [mo, alex], ...memberCredit }, payment: cash(0) }),
    // Stage 11 and 12: add-ons and prices, which come before the booking's own checks
    order('w06-refused-addon-quantity', { booking: { ...paidSeat(), addons: [{ ...towel, quantity: 0 }] }, payment: cash(20) }),
    order('w06-refused-addon-credit-with-no-membership', { booking: { ...paidSeat(), addons: [{ ...towel, redemptionSource: 'membership_credit' }] }, payment: cash(20) }),
    order('w06-refused-unknown-addon', { standaloneAddons: [{ ...towel, addonId: UNKNOWN }], payment: cash(5) }),
    order('w06-refused-inactive-addon', { standaloneAddons: [towel], payment: cash(5) }, async (db) => {
      await db.query('UPDATE addons SET active = false WHERE id = $1', [ID.addon])
    }),
    order('w06-refused-a-changed-price-with-no-reason', { standaloneAddons: [{ ...towel, unitPrice: 3 }], payment: cash(3) }),
    order('w06-refused-addon-checked-before-the-booking', {
      booking: { ...paidSeat([{ ...sam, dateOfBirth: 'not a date' }]), addons: [towel] },
      payment: cash(25),
    }, async (db) => {
      await db.query('UPDATE addons SET active = false WHERE id = $1', [ID.addon])
    }),
    // Stage 14
    order('w06-refused-unknown-method', { booking: paidSeat(), payment: { method: 'cheque' } }),
    // createBooking's reasons
    order('w06-refused-unknown-redemption-source', { booking: { ...paidSeat(), redemptionSource: 'loyalty' }, payment: cash(20) }),
    order('w06-refused-no-guests', { booking: paidSeat([]), payment: cash(0) }),
    order('w06-refused-too-many-guests', { booking: paidSeat([sam, alex, alex, alex, alex, alex, alex]), payment: cash(140) }),
    order('w06-refused-guest-with-no-name', { booking: paidSeat([sam, { ...alex, name: '  ' }]), payment: cash(40) }),
    order('w06-refused-no-date-of-birth', { booking: paidSeat([{ name: 'Sam Test', email: 'sam@example.com' }]), payment: cash(20) }),
    order('w06-refused-a-date-of-birth-that-is-not-a-date', { booking: paidSeat([{ ...sam, dateOfBirth: 'not a date' }]), payment: cash(20) }),
    order('w06-refused-membership-not-chosen', { customerId: ID.member, booking: { ...paidSeat([mo]), redemptionSource: 'membership_credit' }, payment: cash(0) }),
    order('w06-refused-pass-not-chosen', { booking: { ...paidSeat(), redemptionSource: 'session_pass_credit' }, payment: cash(0) }),
    order('w06-refused-unknown-session', { booking: { ...paidSeat(), sessionId: UNKNOWN }, payment: cash(20) }),
    order('w06-refused-a-session-with-no-band', { booking: paidSeat(), payment: cash(20) }, async (db) => {
      await db.query('UPDATE sessions SET band_id = NULL WHERE id = $1', [ID.session])
    }),
    order('w06-refused-a-private-session-already-taken', { booking: privateSeats, payment: cash(100) }, async (db) => {
      await db.query('UPDATE sessions SET total_booked = 1 WHERE id = $1', [ID.privateSession])
    }),
    order('w06-refused-a-full-session-with-a-wrong-figure', { booking: paidSeat(), payment: cash(1) }, async (db) => {
      await db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session])
    }),
    // createOrder's add-on credit reasons, after the booking
    order('w06-refused-someone-elses-addon-credit', {
      booking: { ...paidSeat(), addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] },
      payment: cash(20),
    }),
    order('w06-refused-addon-credit-not-herd-yet', {
      customerId: ID.member,
      booking: { ...moCredit, addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] },
      payment: cash(0),
    }, async (db) => {
      await db.query('UPDATE customer_memberships SET is_herd = false WHERE id = $1', [ID.membership])
    }),
    order('w06-refused-not-enough-addon-credit', {
      customerId: ID.member,
      booking: { ...moCredit, addons: [{ ...towel, quantity: 3, redemptionSource: 'membership_credit', membershipId: ID.membership }] },
      payment: cash(0),
    }),
    // Stage 24: the cash figure, then the amount checks
    order('w06-refused-cash-figure-changed', { booking: paidBooking, payment: cash(40) }),
    order('w06-refused-cash-not-confirmed', { booking: paidBooking, payment: { method: 'cash' } }),
    order('w06-refused-cash-but-nothing-owed', { customerId: ID.member, booking: moCredit, payment: cash(20) }),
    order('w06-refused-something-owed-with-no-method', { booking: paidSeat(), payment: {} }),
  ]
}

import { vi } from 'vitest'
import type { Db, SqlParam } from '@/server/db'
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

/** W13: an All-Access plan (seedAllAccess), and its Stripe prices. */
const ALL_ACCESS_PLAN = '10000000-0000-4000-8000-000000000a13'
const ALL_ACCESS_MONTHLY = 'price_seed_all_access_monthly'
const ALL_ACCESS_YEARLY = 'price_seed_all_access_yearly'

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
  ...w07Scenarios(),
  ...w08Scenarios(),
  ...w09Scenarios(),
  ...w10Scenarios(),
  ...w11Scenarios(),
  ...w13Scenarios(),
  ...w17Scenarios(),
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

// --- W07: products, the delivery address and postage, session passes and gift cards bought. Every
// createOrder reason for stages 5, 7, 9, 10 and 13, and the shapes stages 19, 22, 25, 26 and 35 write,
// in cash or with nothing owed. They run through the old createOrder for their golden files, and
// order-replay.test.ts runs them through the new route too.
function w07Scenarios(): Scenario[] {
  const UNKNOWN = '10000000-0000-4000-8000-0000000000fe'
  const mug = (fulfillmentChoice?: string) => ({ productVariantId: ID.mugVariant, quantity: 1, unitPrice: 15, systemUnitPrice: 15, ...(fulfillmentChoice ? { fulfillmentChoice } : {}) })
  const preset = (fulfillmentMethod: string) => ({ giftCardPresetId: ID.giftCardPreset, fulfillmentMethod })
  const custom = (amount: number | undefined, fulfillmentMethod: string) => ({ giftCardTypeId: ID.giftCardType, amount, fulfillmentMethod })
  const newPass = { sessionPassTypeId: ID.passType }
  const buyNewPass = (guests: Guest[] = [sam]) => ({ ...paidSeat(guests), redemptionSource: 'buy_new_session_pass' })
  const saved = { ...shipped, saveShippingAddressToCustomer: true }
  const stockIs = (quantity: number) => async (db: Db) => {
    await db.query('UPDATE product_variants SET stock_quantity = $1 WHERE id = $2', [quantity, ID.variant])
  }
  const thresholdIs = (amount: string) => async (db: Db) => {
    await db.query('UPDATE postage_settings SET free_shipping_threshold = $1', [amount])
  }
  const passTypeSql = {
    active: 'UPDATE session_pass_types SET active = $1 WHERE id = $2',
    sessions_included: 'UPDATE session_pass_types SET sessions_included = $1 WHERE id = $2',
    price: 'UPDATE session_pass_types SET price = $1 WHERE id = $2',
    expiry_months: 'UPDATE session_pass_types SET expiry_months = $1 WHERE id = $2',
  } as const
  const passTypeHas = (column: keyof typeof passTypeSql, value: SqlParam) => async (db: Db) => {
    await db.query(passTypeSql[column], [value, ID.passType])
  }
  const sessionFull = async (db: Db) => {
    await db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session])
  }
  const bookedThatDay = async (db: Db) => {
    await insert(db, 'bookings', { session_id: ID.session, customer_id: ID.customer, party_size: 1, price_paid: '20', status: 'confirmed' })
  }
  return [
    // Products: picked up, shipped, both, and their prices
    order('w07-pickup-product-in-cash', { products: [soap], payment: cash(24) }),
    order('w07-shipped-product-in-cash', { products: [candle], ...shipped, payment: cash(24.95) }),
    order('w07-shipped-and-pickup-products-in-cash', { products: [soap, mug('shipping')], ...shipped, payment: cash(43.95) }),
    order('w07-a-both-product-picked-up-needs-no-address', { products: [mug('pickup')], payment: cash(15) }),
    order('w07-an-address-with-nothing-to-ship-is-not-kept', { products: [soap], ...saved, payment: cash(24) }),
    order('w07-two-lines-of-one-variant-take-the-last-stock', { products: [soap, { ...soap, quantity: 3 }], payment: cash(60) }),
    order('w07-the-last-item-in-stock', { products: [{ ...soap, quantity: 1 }], payment: cash(12) }, stockIs(1)),
    order('w07-two-shipped-variants-reach-free-postage', { products: [{ ...candle, quantity: 2 }, mug('shipping')], ...shipped, payment: cash(55) }),
    order('w07-member-price-on-a-product', { customerId: ID.member, products: [{ ...soap, quantity: 1, unitPrice: 10, systemUnitPrice: 10 }], payment: cash(10) }, async (db) => {
      await db.query(`UPDATE products SET member_price = '10.00' WHERE id = $1`, [ID.product])
    }),
    order('w07-variant-price-override', { products: [{ ...soap, unitPrice: 9, systemUnitPrice: 9 }], payment: cash(18) }, async (db) => {
      await db.query(`UPDATE product_variants SET price_override = '9.00' WHERE id = $1`, [ID.variant])
    }),
    order('w07-product-override-with-permission-in-cash', { products: [{ ...soap, unitPrice: 10, priceOverrideReason: '  Damaged box  ' }], payment: cash(20) }),
    order('w07-product-override-without-permission-is-ignored-in-cash', { products: [{ ...soap, unitPrice: 1 }], payment: cash(24) }, noPricing),
    order('w07-booking-and-products-in-cash', { booking: paidSeat(), products: [soap], payment: cash(44) }),
    order('w07-member-credit-seat-and-a-product', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, products: [{ ...soap, quantity: 1 }], payment: cash(12) }),
    order('w07-every-kind-in-cash', {
      booking: { ...paidSeat(), addons: [{ ...towel, redemptionSource: 'paid' }] },
      standaloneAddons: [towel],
      products: [soap],
      ...newPass,
      giftCard: preset('digital'),
      payment: cash(164),
    }),
    // Stage 7 and 19: product refusals
    order('w07-refused-product-quantity-zero', { products: [{ ...soap, quantity: 0 }], payment: cash(0) }),
    order('w07-refused-product-quantity-not-whole', { products: [{ ...soap, quantity: 1.5 }], payment: cash(18) }),
    // The product's own id where a variant's belongs: seeded, so the recording names it the same on both sides.
    order('w07-refused-unknown-variant', { products: [{ ...soap, productVariantId: ID.product }], payment: cash(24) }),
    order('w07-refused-inactive-product', { products: [soap], payment: cash(24) }, async (db) => {
      await db.query('UPDATE products SET active = false WHERE id = $1', [ID.product])
    }),
    order('w07-refused-two-lines-over-the-stock', { products: [{ ...soap, quantity: 3 }, { ...soap, quantity: 3 }], payment: cash(72) }),
    order('w07-refused-product-checked-before-the-address', { products: [{ ...soap, quantity: 0 }, candle], postageMethod: 'standard', payment: cash(24.95) }),
    order('w07-refused-a-full-session-before-the-stock', { booking: paidSeat(), products: [{ ...soap, quantity: 6 }], payment: cash(92) }, sessionFull),
    order('w07-refused-a-changed-product-price-with-no-reason', { products: [{ ...soap, unitPrice: 10 }], payment: cash(20) }),
    // Stage 9 and 35: the delivery address
    order('w07-refused-no-delivery-address', { products: [candle], postageMethod: 'standard', payment: cash(24.95) }),
    order('w07-refused-delivery-address-missing-the-postcode', { products: [candle], shippingAddress: { ...address, postcode: ' ' }, postageMethod: 'standard', payment: cash(24.95) }),
    order('w07-refused-delivery-address-missing-several-parts', {
      products: [candle],
      shippingAddress: { ...address, name: '', city: '   ' },
      postageMethod: 'standard',
      payment: cash(24.95),
    }),
    order('w07-delivery-address-trimmed-with-defaults', {
      products: [candle],
      shippingAddress: { name: '  Sam Test ', line1: ' 1 Mill Lane ', line2: '   ', city: ' Hebden Bridge ', postcode: ' HX7 1AA ', country: '  ' },
      postageMethod: 'standard',
      payment: cash(24.95),
    }),
    order('w07-delivery-address-saved-to-the-customer', { products: [candle], ...saved, payment: cash(24.95) }),
    {
      // W07: the save moves inside T1, so a failure refuses the order instead of warning after it.
      name: 'w07-address-save-fails',
      seed,
      async run({ call, db }) {
        await whileFailing(db, { table: 'customers', event: 'UPDATE', when: 'true' }, () =>
          call('createOrder', { customerId: ID.customer, products: [candle], ...saved, payment: cash(24.95) })
        )
      },
    },
    // Stage 10 and 26: postage
    order('w07-refused-no-postage-method', { products: [candle], shippingAddress: address, payment: cash(24.95) }),
    order('w07-refused-an-unknown-postage-method', { products: [candle], shippingAddress: address, postageMethod: 'pigeon', payment: cash(24.95) }),
    order('w07-refused-postage-settings-missing', { products: [candle], ...shipped, payment: cash(24.95) }, async (db) => {
      await db.query('DELETE FROM postage_settings')
    }),
    order('w07-free-standard-postage-exactly-at-the-threshold', { products: [{ ...candle, quantity: 2 }], ...shipped, payment: cash(40) }, thresholdIs('40.00')),
    order('w07-express-postage-is-never-free', { products: [{ ...candle, quantity: 3 }], ...shipped, postageMethod: 'express', payment: cash(69.95) }),
    order('w07-no-free-postage-when-the-threshold-is-0', { products: [{ ...candle, quantity: 3 }], ...shipped, payment: cash(64.95) }, thresholdIs('0.00')),
    order('w07-q23-a-sent-price-cannot-earn-free-postage-in-cash', { products: [{ ...candle, unitPrice: 60 }], ...shipped, payment: cash(24.95) }, noPricing),
    order('w07-q23-a-sent-price-cannot-lose-free-postage-in-cash', { products: [{ ...candle, quantity: 3, unitPrice: 1 }], ...shipped, payment: cash(60) }, noPricing),
    order('w07-q23-an-allowed-price-still-counts-in-cash', { products: [{ ...candle, unitPrice: 50, priceOverrideReason: 'Display piece' }], ...shipped, payment: cash(50) }),
    order('w07-q4-shipped-gift-card-and-product-reach-free-postage', { products: [candle], giftCard: custom(30, 'shipping'), ...shipped, payment: cash(54.95) }),
    order('w07-a-picked-up-gift-card-does-not-count-towards-postage', { products: [candle], giftCard: preset('pickup'), ...shipped, payment: cash(84.95) }),
    // Stage 13 and 22: gift cards bought
    order('w07-gift-card-custom-amount-picked-up-in-cash', {
      giftCard: { ...custom(25, 'pickup'), recipientName: 'Ali Friend', recipientEmail: 'ali@example.com', giftMessage: 'Happy birthday' },
      payment: cash(25),
    }),
    order('w07-gift-card-shipped-under-the-threshold', { giftCard: custom(30, 'shipping'), ...shipped, payment: cash(34.95) }),
    order('w07-gift-card-blank-recipient-kept-as-sent', { giftCard: { ...preset('digital'), recipientName: '', giftMessage: '' }, payment: cash(60) }),
    order('w07-refused-gift-card-preset-and-custom', { giftCard: { ...preset('digital'), giftCardTypeId: ID.giftCardType, amount: 20 }, payment: cash(60) }),
    order('w07-refused-gift-card-neither', { giftCard: { fulfillmentMethod: 'digital' }, payment: cash(0) }),
    order('w07-refused-unknown-gift-card-preset', { giftCard: { ...preset('digital'), giftCardPresetId: UNKNOWN }, payment: cash(60) }),
    order('w07-refused-inactive-gift-card-preset', { giftCard: preset('digital'), payment: cash(60) }, async (db) => {
      await db.query('UPDATE gift_card_presets SET active = false WHERE id = $1', [ID.giftCardPreset])
    }),
    order('w07-refused-unknown-gift-card-type', { giftCard: { ...custom(25, 'digital'), giftCardTypeId: UNKNOWN }, payment: cash(25) }),
    order('w07-refused-inactive-gift-card-type', { giftCard: custom(25, 'digital'), payment: cash(25) }, async (db) => {
      await db.query('UPDATE gift_card_types SET active = false WHERE id = $1', [ID.giftCardType])
    }),
    order('w07-refused-gift-card-custom-amount-not-allowed', { giftCard: custom(25, 'digital'), payment: cash(25) }, async (db) => {
      await db.query('UPDATE gift_card_types SET custom_amount_enabled = false WHERE id = $1', [ID.giftCardType])
    }),
    order('w07-refused-gift-card-amount-zero', { giftCard: custom(0, 'digital'), payment: cash(0) }),
    order('w07-refused-gift-card-no-amount', { giftCard: custom(undefined, 'digital'), payment: cash(0) }),
    order('w07-refused-gift-card-below-the-minimum', { giftCard: custom(5, 'digital'), payment: cash(5) }),
    order('w07-refused-gift-card-above-the-maximum', { giftCard: custom(250, 'digital'), payment: cash(250) }),
    order('w07-refused-gift-card-fulfilment', { giftCard: preset('email'), payment: cash(60) }),
    order('w07-refused-postage-checked-before-the-gift-card', { giftCard: preset('shipping'), shippingAddress: address, payment: cash(60) }, async (db) => {
      await db.query('UPDATE gift_card_presets SET active = false WHERE id = $1', [ID.giftCardPreset])
    }),
    // Stage 5, 18a and 25: session passes
    order('w07-pass-on-its-own-in-cash', { ...newPass, payment: cash(50) }),
    order('w07-buy-new-pass-covers-the-seat-alone', { booking: buyNewPass(), ...newPass, payment: cash(50) }),
    order('w07-pass-bought-beside-a-paid-booking', { booking: paidSeat(), ...newPass, payment: cash(70) }),
    order('w07-pass-bought-beside-a-booking-on-another-pass', { booking: { ...paidSeat(), ...ownedPass }, ...newPass, payment: cash(50) }),
    order('w07-a-pass-with-no-price', { ...newPass, payment: {} }, passTypeHas('price', null)),
    order('w07-a-pass-lasts-its-own-months', { ...newPass, payment: cash(50) }, passTypeHas('expiry_months', 6)),
    order('w07-a-gift-card-lasts-its-types-months', { giftCard: preset('digital'), payment: cash(60) }, async (db) => {
      await db.query('UPDATE gift_card_types SET expiry_months = 18 WHERE id = $1', [ID.giftCardType])
    }),
    // Q33 (W07a): bought on 29 Feb 2028, each lasting 12 months. The Worker clamps to 28 Feb 2029; the
    // old createOrder rolls over to 1 Mar 2029. The clock moves for this scenario only (replay() resets it).
    order('w07a-q33-pass-and-gift-card-bought-on-29-february', { ...newPass, giftCard: preset('digital'), payment: cash(110) }, async () => {
      vi.setSystemTime(new Date('2028-02-29T10:00:00.000Z'))
    }),
    order('w07-q5-buy-new-pass-keeps-address-and-requests', {
      booking: { ...buyNewPass(), specialRequests: 'Step-free access' },
      ...newPass,
      products: [candle],
      ...saved,
      payment: cash(74.95),
    }),
    order('w07-worst-basket', {
      booking: buyNewPass([sam, alex]),
      ...newPass,
      products: [candle, mug('shipping')],
      giftCard: custom(10, 'shipping'),
      ...saved,
      payment: cash(119.95),
    }),
    order('w07-refused-unknown-pass-type', { sessionPassTypeId: UNKNOWN, payment: cash(50) }),
    order('w07-refused-inactive-pass-type', { ...newPass, payment: cash(50) }, passTypeHas('active', false)),
    order('w07-refused-buy-new-pass-not-chosen', { booking: buyNewPass(), payment: cash(0) }),
    order('w07-refused-buy-new-pass-with-no-sessions', { booking: buyNewPass(), ...newPass, payment: cash(50) }, passTypeHas('sessions_included', 0)),
    order('w07-refused-buy-new-core-pass-on-peak', { booking: { ...buyNewPass(), sessionId: ID.peakSession }, sessionPassTypeId: ID.corePass, payment: cash(40) }, seedCorePass),
    order('w07-refused-buy-new-pass-on-a-private-booking', { booking: { ...privateSeats, redemptionSource: 'buy_new_session_pass' }, ...newPass, payment: cash(150) }),
    order('w07-refused-buy-new-pass-session-full', { booking: buyNewPass(), ...newPass, payment: cash(50) }, sessionFull),
    order('w07-refused-buy-new-pass-a-booking-that-day', { booking: buyNewPass(), ...newPass, payment: cash(50) }, bookedThatDay),
  ]
}

// --- W08: events. Every createOrder reason for stage 8 (event_booking_block_reason's six, the
// attendee list, the ages, the 18+ tick, the quote) and stage 21 (event_full), where each comes among
// the other stages, and the shapes stage 21 writes: the places claimed, the event booking, an
// attendee row per place in place order, and the event's line, at member and public prices, in cash
// or with nothing owed. They run through the old createOrder for their golden files, and
// order-replay.test.ts runs them through the new route too.

/** The live check that an event on sale is complete (events_on_sale_complete), as it stands, put back NOT VALID. */
const RESTORE_ON_SALE_COMPLETE =
  "ALTER TABLE public.events ADD CONSTRAINT events_on_sale_complete CHECK (((NOT active) OR ((starts_at IS NOT NULL) AND (capacity IS NOT NULL) AND (refund_cutoff_at IS NOT NULL) AND (price_public IS NOT NULL) AND (price_pre_herd IS NOT NULL) AND (price_herd IS NOT NULL) AND ((access <> 'members_first'::text) OR (public_release_at IS NOT NULL)) AND (cancelled_at IS NULL)))) NOT VALID"

/**
 * Lifts events_on_sale_complete, for an event live can't have (on sale with a price missing, or on
 * sale and cancelled). Put back with restoreOnSaleCheck, NOT VALID, so the row left behind doesn't
 * block it; new rows are still checked.
 */
export async function liftOnSaleCheck(db: Db): Promise<void> {
  await db.query('RESET ROLE')
  await db.query('ALTER TABLE public.events DROP CONSTRAINT events_on_sale_complete')
  await db.query('SET ROLE paddock_worker')
}

export async function restoreOnSaleCheck(db: Db): Promise<void> {
  await db.query('RESET ROLE')
  await db.query(RESTORE_ON_SALE_COMPLETE)
  await db.query('SET ROLE paddock_worker')
}

function w08Scenarios(): Scenario[] {
  const UNKNOWN = '10000000-0000-4000-8000-0000000000fd'
  const samAttending = { ...sam, isAccountHolder: true }
  const moAttending = { ...mo, isAccountHolder: true }
  const alexGuest = { ...alex, isAccountHolder: false }
  const beaGuest = { name: 'Bea Guest', email: 'bea@example.com', isAccountHolder: false }
  type Attendee = { name: string; email: string; dateOfBirth?: string; isAccountHolder: boolean }
  /** The event's places, with the 18+ tick when anyone isn't the account holder, as the screen sends it. */
  const places = (attendees: Attendee[], more: Record<string, unknown> = {}) => ({
    eventId: ID.event,
    accountHolderAttending: attendees.some((attendee) => attendee.isAccountHolder),
    ...(attendees.some((attendee) => !attendee.isAccountHolder) ? { guestsOver18Confirmed: true } : {}),
    attendees,
    ...more,
  })
  const asMo = { customerId: ID.member }
  const eventSql = {
    access: 'UPDATE events SET access = $1 WHERE id = $2',
    public_release_at: 'UPDATE events SET public_release_at = $1 WHERE id = $2',
    places_booked: 'UPDATE events SET places_booked = $1 WHERE id = $2',
    price_herd: 'UPDATE events SET price_herd = $1 WHERE id = $2',
    active: 'UPDATE events SET active = $1 WHERE id = $2',
  } as const
  const eventHas = (column: keyof typeof eventSql, value: SqlParam) => async (db: Db) => {
    await db.query(eventSql[column], [value, ID.event])
  }
  const membersOnly = eventHas('access', 'members_only')
  /** Members first, with the public release on `releasedAt` (the replay's today is 10 Nov 2026). */
  const membersFirst = (releasedAt: string) => async (db: Db) => {
    await eventHas('public_release_at', releasedAt)(db)
    await eventHas('access', 'members_first')(db)
  }
  const soldOut = eventHas('places_booked', 10)
  const notHerd = async (db: Db) => {
    await db.query('UPDATE customer_memberships SET is_herd = false WHERE id = $1', [ID.membership])
  }
  const sessionFull = async (db: Db) => {
    await db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session])
  }
  const both = (...steps: Array<(db: Db) => Promise<void>>) => async (db: Db) => {
    for (const step of steps) await step(db)
  }
  return [
    // Who attends, and at what price
    order('w08-event-account-holder-alone-in-cash', { event: places([samAttending]), payment: cash(40) }),
    order('w08-event-guests-only-in-cash', { event: places([alexGuest, beaGuest]), payment: cash(80) }),
    order('w08-event-account-holder-listed-second', { event: places([alexGuest, samAttending]), payment: cash(80) }),
    order('w08-event-attendee-details-trimmed', {
      event: places([
        { name: '  Sam Test ', email: ' sam@example.com ', dateOfBirth: '1990-01-01', isAccountHolder: true },
        // A guest's date of birth is never kept: the 18+ tick covers guests.
        { name: ' Alex Guest  ', email: '   ', dateOfBirth: '1991-02-02', isAccountHolder: false },
      ]),
      payment: cash(80),
    }),
    order('w08-event-herd-member-and-a-guest', { ...asMo, event: places([moAttending, alexGuest]), payment: cash(60) }),
    order('w08-event-pre-herd-member', { ...asMo, event: places([moAttending]), payment: cash(30) }, notHerd),
    order('w08-event-member-not-attending-guests-pay-public', { ...asMo, event: places([alexGuest, beaGuest]), payment: cash(80) }),
    order('w08-event-members-only-for-a-member', { ...asMo, event: places([moAttending]), payment: cash(20) }, membersOnly),
    order('w08-event-members-only-member-on-their-last-day', { ...asMo, event: places([moAttending]), payment: cash(20) }, both(membersOnly, lastDayIs('2026-11-10'))),
    order('w08-event-members-first-member-before-release', { ...asMo, event: places([moAttending]), payment: cash(20) }, membersFirst('2026-11-20 09:00:00+00')),
    order('w08-event-members-first-public-after-release', { event: places([samAttending]), payment: cash(40) }, membersFirst('2026-11-01 09:00:00+00')),
    order('w08-event-account-holder-18-on-the-day', { event: places([{ ...samAttending, dateOfBirth: '2008-12-01' }]), payment: cash(40) }),
    order('w08-event-takes-the-last-places', { event: places([samAttending, alexGuest]), payment: cash(80) }, eventHas('places_booked', 8)),
    order('w08-free-event-nothing-owed', { ...asMo, event: places([moAttending]), payment: {} }, eventHas('price_herd', '0.00')),
    // Beside the other kinds: events are never paid with session credits, and don't count as a booking that day
    order('w08-event-and-a-booking-in-cash', { booking: paidSeat(), event: places([samAttending, alexGuest]), payment: cash(100) }),
    order('w08-member-credit-seat-and-an-event-in-cash', { ...asMo, booking: { ...paidSeat([mo]), ...memberCredit }, event: places([moAttending]), payment: cash(20) }),
    order('w08-event-and-a-product-in-cash', { products: [soap], event: places([samAttending]), payment: cash(64) }),
    order('w08-every-kind-in-cash', {
      booking: { ...paidSeat(), addons: [{ ...towel, redemptionSource: 'paid' }] },
      standaloneAddons: [towel],
      products: [soap],
      sessionPassTypeId: ID.passType,
      giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' },
      event: places([samAttending, alexGuest]),
      payment: cash(244),
    }),
    order('w08-worst-basket', {
      booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] },
      products: [candle],
      giftCard: { giftCardTypeId: ID.giftCardType, amount: 10, fulfillmentMethod: 'shipping' },
      event: places([samAttending, alexGuest, beaGuest]),
      ...shipped,
      saveShippingAddressToCustomer: true,
      payment: cash(199.95),
    }),
    // Stage 8: who may book now (event_booking_block_reason's six)
    order('w08-refused-event-not-found', { event: { ...places([samAttending]), eventId: UNKNOWN }, payment: cash(40) }),
    order('w08-refused-event-cancelled', { event: places([samAttending]), payment: cash(40) }, async (db) => {
      await db.query("UPDATE events SET active = false, cancelled_at = '2026-11-09 12:00:00+00' WHERE id = $1", [ID.event])
    }),
    order('w08-refused-event-not-on-sale', { event: places([samAttending]), payment: cash(40) }, eventHas('active', false)),
    order('w08-refused-event-started', { event: places([samAttending]), payment: cash(40) }, async (db) => {
      await db.query(
        "UPDATE events SET starts_at = '2026-11-10 08:00:00+00', ends_at = '2026-11-10 10:00:00+00', refund_cutoff_at = '2026-11-09 08:00:00+00' WHERE id = $1",
        [ID.event]
      )
    }),
    order('w08-refused-event-members-only', { event: places([samAttending]), payment: cash(40) }, membersOnly),
    order('w08-refused-event-members-only-lapsed-member', { ...asMo, event: places([moAttending]), payment: cash(20) }, both(membersOnly, lastDayIs('2026-11-09'))),
    order('w08-refused-event-not-released-yet', { event: places([samAttending]), payment: cash(40) }, membersFirst('2026-11-20 09:00:00+00')),
    // Stage 8: the attendee list, the ages and the 18+ tick
    order('w08-refused-event-no-places', { event: { ...places([]), accountHolderAttending: true }, payment: cash(0) }),
    order('w08-refused-event-attending-with-no-account-holder', { event: { ...places([alexGuest]), accountHolderAttending: true }, payment: cash(40) }),
    order('w08-refused-event-not-attending-with-an-account-holder', { event: { ...places([samAttending]), accountHolderAttending: false }, payment: cash(40) }),
    order('w08-refused-event-two-account-holders', { event: places([samAttending, { ...alex, isAccountHolder: true }]), payment: cash(80) }),
    order('w08-refused-event-attendee-with-no-name', { event: places([samAttending, { ...alexGuest, name: '  ' }]), payment: cash(80) }),
    order('w08-refused-event-account-holder-with-no-date-of-birth', { event: places([{ name: 'Sam Test', email: 'sam@example.com', isAccountHolder: true }]), payment: cash(40) }),
    order('w08-refused-event-date-of-birth-not-a-date', { event: places([{ ...samAttending, dateOfBirth: 'not a date' }]), payment: cash(40) }),
    order('w08-refused-event-account-holder-under-18', { event: places([{ ...samAttending, dateOfBirth: '2008-12-02' }]), payment: cash(40) }),
    order('w08-refused-event-guests-not-confirmed', { event: { ...places([samAttending, alexGuest]), guestsOver18Confirmed: false }, payment: cash(80) }),
    {
      // quote_event refuses an event with a price missing. Live, an event on sale must have all three
      // (events_on_sale_complete), so this can't happen there; the check is lifted for this scenario
      // only, and put back as it was (NOT VALID, so the row left behind doesn't block it).
      name: 'w08-refused-event-with-no-prices',
      async seed(db, stripe) {
        await seed(db, stripe)
        await liftOnSaleCheck(db)
        await db.query('UPDATE events SET price_pre_herd = NULL WHERE id = $1', [ID.event])
      },
      async run({ call, db }) {
        try {
          await call('createOrder', { customerId: ID.customer, event: places([samAttending]), payment: cash(40) })
        } finally {
          await restoreOnSaleCheck(db)
        }
      },
    },
    // Stage 21: the places
    order('w08-refused-event-sold-out', { event: places([samAttending]), payment: cash(40) }, soldOut),
    order('w08-refused-event-one-place-left-for-two', { event: places([samAttending, alexGuest]), payment: cash(80) }, eventHas('places_booked', 9)),
    // Where stage 8 and stage 21 come among the others
    order('w08-refused-product-checked-before-the-event', { products: [soap], event: { ...places([samAttending]), eventId: UNKNOWN }, payment: cash(64) }, async (db) => {
      await db.query('UPDATE products SET active = false WHERE id = $1', [ID.product])
    }),
    order('w08-refused-event-checked-before-the-address', { products: [candle], postageMethod: 'standard', event: places([samAttending]), payment: cash(64.95) }, membersOnly),
    order('w08-refused-event-checked-before-the-addons', { standaloneAddons: [{ ...towel, addonId: UNKNOWN }], event: places([samAttending]), payment: cash(45) }, eventHas('active', false)),
    order('w08-refused-event-checked-before-the-booking', { booking: paidSeat(), event: places([{ ...samAttending, dateOfBirth: '2008-12-02' }]), payment: cash(60) }, sessionFull),
    order('w08-refused-a-full-session-before-a-sold-out-event', { booking: paidSeat(), event: places([samAttending]), payment: cash(60) }, both(sessionFull, soldOut)),
    order('w08-refused-out-of-stock-before-a-sold-out-event', { products: [{ ...soap, quantity: 6 }], event: places([samAttending]), payment: cash(112) }, soldOut),
    order('w08-refused-sold-out-event-with-a-wrong-figure', { event: places([samAttending]), payment: cash(1) }, soldOut),
    // Stage 24: the cash figure, then the amount checks
    order('w08-refused-event-cash-figure-changed', { event: places([samAttending, alexGuest]), payment: cash(70) }),
    order('w08-refused-event-owed-with-no-method', { event: places([samAttending]), payment: {} }),
    // A membership bought in the same basket would price the account holder as a member: not built until W13
    order('w08-event-with-a-membership-bought-in-cash', { event: places([samAttending]), ...monthly, payment: cash(80) }),
  ]
}

// --- W09: promo codes, store credit and gift cards used to pay. Every reason of stages 15, 16, 20, 24,
// 25a and 30 in scope with its words, the discount on everything a code applies to (seats, private
// bookings, event places, add-ons, products, passes), the payment method each mix records, and W02's
// noise cases (exact cover, fully covered orders, half pennies). Each runs through the old createOrder
// for its golden file, and order-replay.test.ts runs it through the new route too.
function w09Scenarios(): Scenario[] {
  const UNKNOWN = '10000000-0000-4000-8000-0000000000fc'
  const beaSeat: Guest = { name: 'Bea Guest', email: 'bea@example.com' }
  const robe = { addonId: ID.robe, quantity: 1, unitPrice: 8, systemUnitPrice: 8 }
  const asMo = { customerId: ID.member }
  const samAttending = { ...sam, isAccountHolder: true }
  const moAttending = { ...mo, isAccountHolder: true }
  const alexGuest = { ...alex, isAccountHolder: false }
  const beaGuest = { ...beaSeat, isAccountHolder: false }
  type Attendee = { name: string; email: string; dateOfBirth?: string; isAccountHolder: boolean }
  const places = (attendees: Attendee[]) => ({
    eventId: ID.event,
    accountHolderAttending: attendees.some((attendee) => attendee.isAccountHolder),
    ...(attendees.some((attendee) => !attendee.isAccountHolder) ? { guestsOver18Confirmed: true } : {}),
    attendees,
  })
  const gift = (amount: number, giftCardId: string = ID.giftCard) => ({ giftCard: { giftCardId, amount } })
  const credit = (amount: number) => ({ storeCredit: { amount } })
  /** A price staff typed, with Manage pricing and a reason, as W02's noise cases needed one. */
  const towelAt = (unitPrice: number) => ({ ...towel, unitPrice, priceOverrideReason: 'Noise case' })
  const promoHas = (sql: string, ...values: SqlParam[]) => async (db: Db) => {
    await db.query(sql, [...values, ID.promoPercent])
  }
  /** An earlier order of `customerId`'s that used ALLTEN. */
  const usedBefore = (customerId: string) => async (db: Db) => {
    const orderId = await insert(db, 'orders', { customer_id: customerId, order_total: '20.00', payment_status: 'paid', order_source: 'staff_created' })
    await insert(db, 'promo_code_redemptions', { promo_code_id: ID.promoPercent, order_id: orderId, customer_id: customerId, discount_amount: '2.00' })
  }
  const both = (...steps: Array<(db: Db) => Promise<void>>) => async (db: Db) => {
    for (const step of steps) await step(db)
  }
  const cardHas = (sql: string, ...values: SqlParam[]) => async (db: Db) => {
    await db.query(sql, [...values, ID.giftCard])
  }
  const sessionFull = async (db: Db) => {
    await db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session])
  }
  const eventSoldOut = async (db: Db) => {
    await db.query('UPDATE events SET places_booked = capacity WHERE id = $1', [ID.event])
  }
  /** The seed customer with a full address on file, a second line among it (the seed has only a country). */
  const addressOnFile = async (db: Db) => {
    await db.query(
      `UPDATE customers SET address_line1 = $1, address_line2 = $2, city = $3, postcode = $4, country = $5 WHERE id = $6`,
      ['7 Canal Street', 'Flat 2', 'Todmorden', 'OL14 5AA', 'United Kingdom', ID.customer]
    )
  }
  /** A fixed £5 off that also takes member prices, for every kind. */
  const membersFiver = async (db: Db) => {
    await insert(db, 'promo_codes', { id: '10000000-0000-4000-8000-0000000000fb', code: 'MEMBERS5', discount_type: 'fixed', discount_value: '5', applies_to: EVERY_KIND, applies_on_member_prices: true })
  }
  /** One of every kind W06 to W08 build: a seat, a standalone towel, two soaps, a pass, a £60 gift card bought and an event place (£199). */
  const everyKind = {
    booking: paidSeat(),
    standaloneAddons: [towel],
    products: [soap],
    sessionPassTypeId: ID.passType,
    giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' },
    event: places([samAttending]),
  }
  return [
    // --- The discount on what a code applies to, written at creation
    // A fixed £5 over three £20 seats: 1.66, 1.66, 1.68 (the leftover pennies go to the last line with room).
    order('w09-fixed-promo-spread-across-three-seats', { booking: paidSeat([sam, alex, beaSeat]), promoCode: PROMO.fixed, payment: cash(55) }),
    // W8-6: the same across three £40 event places: 1.66, 1.66, 1.68.
    order('w09-fixed-promo-spread-across-event-places', { event: places([samAttending, alexGuest, beaGuest]), promoCode: PROMO.fixed, payment: cash(115) }),
    // A Herd member's £20 place and a guest's £40, with a code that takes member prices: 1.66 and 3.34.
    order('w09-fixed-promo-on-a-member-place-and-a-guest', { ...asMo, event: places([moAttending, alexGuest]), promoCode: 'MEMBERS5', payment: cash(55) }, membersFiver),
    // FIVER doesn't take member prices: all of it on the guest's place.
    order('w09-fixed-promo-skips-a-member-place', { ...asMo, event: places([moAttending, alexGuest]), promoCode: PROMO.fixed, payment: cash(55) }),
    // A Core member's Peak seat is a member price (£21.68): only the guest's £25.50 seat is discounted.
    order('w09-promo-skips-a-member-priced-seat', { ...asMo, booking: { ...paidSeat([mo, alex]), sessionId: ID.peakSession }, promoCode: PROMO.percent, payment: cash(44.63) }),
    order('w09-promo-on-a-guest-beside-a-credit-seat', { ...asMo, booking: { ...paidSeat([mo, alex]), ...memberCredit }, promoCode: PROMO.percent, payment: cash(18) }),
    // Q6: the server's rule, kept: a buy-new pass booking's paid seats take the promo, and so does the pass.
    order('w09-promo-on-a-buy-new-pass-and-its-guest', {
      booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_session_pass' },
      sessionPassTypeId: ID.passType,
      promoCode: PROMO.percent,
      payment: cash(63),
    }),
    order('w09-promo-skips-a-member-priced-addon', { ...asMo, standaloneAddons: [robe, towel], promoCode: PROMO.percent, payment: cash(12.5) }),
    order('w09-percent-promo-on-every-kind-in-cash', { ...everyKind, promoCode: PROMO.percent, payment: cash(185.1) }),
    // £5 over a £20 seat, a £5 towel, £24 of soap, a £50 pass and a £40 place: 0.71, 0.17, 0.86, 1.79, 1.47.
    order('w09-fixed-promo-spread-across-every-kind', { ...everyKind, promoCode: PROMO.fixed, payment: cash(194) }),
    order('w09-promo-covers-everything-nothing-owed', { booking: paidSeat([sam, alex]), promoCode: PROMO.big, payment: {} }),
    // Postage is never discounted, and free postage is judged before the promo.
    order('w09-promo-does-not-touch-free-postage', { products: [{ ...candle, quantity: 3 }], ...shipped, promoCode: PROMO.percent, payment: cash(54) }),
    order('w09-promo-does-not-touch-postage', { products: [candle], ...shipped, promoCode: PROMO.percent, payment: cash(22.95) }),
    order('w09-promo-typed-in-lower-case-with-spaces', { booking: paidSeat([sam, alex]), promoCode: '  allten ', payment: cash(36) }),
    order('w09-promo-with-a-use-left', { booking: paidSeat(), promoCode: PROMO.percent, payment: cash(18) }, both(promoHas('UPDATE promo_codes SET max_total_uses = $1 WHERE id = $2', 2), usedBefore(ID.member))),
    order('w09-promo-once-per-customer-used-by-someone-else', { booking: paidSeat(), promoCode: PROMO.percent, payment: cash(18) }, both(promoHas('UPDATE promo_codes SET one_use_per_customer = $1 WHERE id = $2', true), usedBefore(ID.member))),
    order('w09-promo-for-this-customer', { booking: paidSeat(), promoCode: PROMO.percent, payment: cash(18) }, promoHas('UPDATE promo_codes SET restricted_customer_id = $1 WHERE id = $2', ID.customer)),
    order('w09-promo-on-its-last-day', { booking: paidSeat(), promoCode: PROMO.percent, payment: cash(18) }, promoHas('UPDATE promo_codes SET expires_on = $1 WHERE id = $2', '2026-11-10')),
    // --- Stage 20's reasons, with createOrder's words
    order('w09-refused-unknown-promo', { booking: paidSeat(), promoCode: 'NOSUCH', payment: cash(20) }),
    order('w09-refused-inactive-promo', { booking: paidSeat(), promoCode: PROMO.percent, payment: cash(18) }, promoHas('UPDATE promo_codes SET active = $1 WHERE id = $2', false)),
    order('w09-refused-promo-at-its-limit', { booking: paidSeat(), promoCode: PROMO.percent, payment: cash(18) }, both(promoHas('UPDATE promo_codes SET max_total_uses = $1 WHERE id = $2', 1), usedBefore(ID.member))),
    order('w09-refused-promo-already-used-by-the-customer', { booking: paidSeat(), promoCode: PROMO.percent, payment: cash(18) }, both(promoHas('UPDATE promo_codes SET one_use_per_customer = $1 WHERE id = $2', true), usedBefore(ID.customer))),
    order('w09-refused-promo-for-another-customer', { booking: paidSeat(), promoCode: PROMO.percent, payment: cash(18) }, promoHas('UPDATE promo_codes SET restricted_customer_id = $1 WHERE id = $2', ID.member)),
    order('w09-refused-promo-nothing-eligible', { booking: paidSeat(), promoCode: PROMO.productsOnly, payment: cash(20) }),
    order('w09-refused-promo-below-min-spend', { booking: paidSeat([sam, alex]), promoCode: PROMO.spend150, payment: cash(36) }),
    // --- Where stage 20 comes among the others
    order('w09-refused-promo-after-the-stock', { products: [{ ...soap, quantity: 6 }], promoCode: 'NOSUCH', payment: cash(72) }),
    order('w09-refused-a-full-session-before-the-promo', { booking: paidSeat(), promoCode: 'NOSUCH', payment: cash(20) }, sessionFull),
    order('w09-refused-promo-before-the-event-places', { event: places([samAttending]), promoCode: 'NOSUCH', payment: cash(40) }, eventSoldOut),
    // A buy-new booking works its promo out before anything is written, so before a full session.
    order(
      'w09-refused-buy-new-promo-before-the-booking',
      { booking: { ...paidSeat(), redemptionSource: 'buy_new_session_pass' }, sessionPassTypeId: ID.passType, promoCode: 'NOSUCH', payment: cash(50) },
      sessionFull
    ),
    order('w09-refused-promo-cash-figure-changed', { booking: paidSeat([sam, alex]), promoCode: PROMO.percent, payment: cash(40) }),
    order('w09-refused-promo-owed-with-no-method', { booking: paidSeat([sam, alex]), promoCode: PROMO.percent, payment: {} }),
    // --- Store credit: stages 16, 24 and 30
    order('w09-store-credit-and-cash', { booking: paidSeat(), payment: { ...cash(15), ...credit(5) } }),
    order('w09-store-credit-uses-the-whole-balance', { booking: paidSeat(), standaloneAddons: [towel], products: [soap], payment: { ...cash(19), ...credit(30) } }),
    order('w09-refused-store-credit-amount-zero', { products: [soap], payment: { ...cash(24), ...credit(0) } }),
    order('w09-refused-store-credit-amount-negative', { products: [soap], payment: { ...cash(29), ...credit(-5) } }),
    order('w09-refused-store-credit-more-than-the-balance', { booking: paidSeat([sam, alex]), payment: { ...cash(9), ...credit(31) } }),
    order('w09-refused-store-credit-for-a-customer-with-none', { ...asMo, standaloneAddons: [towel], payment: { ...cash(0), ...credit(5) } }),
    order('w09-refused-store-credit-with-nothing-owed', { ...asMo, booking: { ...paidSeat([mo]), ...memberCredit }, payment: credit(5) }, async (db) => {
      await db.query(`UPDATE customers SET store_credit_balance = '10.00' WHERE id = $1`, [ID.member])
    }),
    order('w09-refused-store-credit-checked-before-the-booking', { booking: paidSeat(), payment: { ...cash(0), ...credit(31) } }, sessionFull),
    order('w09-refused-store-credit-leaves-something-owed-with-no-method', { products: [soap], payment: credit(10) }),
    order('w09-refused-cash-figure-before-the-store-credit-over-the-total', { products: [soap], payment: { ...cash(5), ...credit(25) } }),
    // --- Gift cards used to pay: stages 15, 24 and 30
    order('w09-gift-card-covers-everything', { products: [soap], payment: gift(24) }),
    order('w09-gift-card-uses-the-whole-balance', { booking: paidSeat([sam, alex]), payment: gift(40) }),
    order('w09-gift-card-already-marked-redeemed-stays-so', { products: [soap], payment: gift(24) }, cardHas(`UPDATE gift_cards SET redeemed_at = $1 WHERE id = $2`, '2026-10-01 12:00:00+00')),
    order('w09-gift-card-on-its-last-day', { products: [soap], payment: gift(24) }, cardHas('UPDATE gift_cards SET expiry_date = $1 WHERE id = $2', '2026-11-10')),
    order('w09-refused-gift-card-amount-zero', { products: [soap], payment: { ...cash(24), ...gift(0) } }),
    order('w09-refused-gift-card-not-found', { products: [soap], payment: { ...cash(14), ...gift(10, UNKNOWN) } }),
    order('w09-refused-gift-card-voided', { products: [soap], payment: { ...cash(14), ...gift(10) } }, cardHas('UPDATE gift_cards SET voided = $1 WHERE id = $2', true)),
    order('w09-refused-gift-card-expired', { products: [soap], payment: { ...cash(14), ...gift(10) } }, cardHas('UPDATE gift_cards SET expiry_date = $1 WHERE id = $2', '2026-11-09')),
    order('w09-refused-gift-card-with-nothing-left', { products: [soap], payment: { ...cash(14), ...gift(10) } }, cardHas(`UPDATE gift_cards SET remaining_balance = $1 WHERE id = $2`, '0.00')),
    order('w09-refused-gift-card-more-than-its-balance', { booking: paidSeat([sam, alex, beaSeat]), payment: { ...cash(19), ...gift(41) } }),
    order('w09-refused-gift-card-over-the-total', { products: [soap], payment: gift(30) }),
    order('w09-refused-gift-card-checked-before-store-credit', { products: [soap], payment: { ...cash(0), ...gift(10), ...credit(31) } }, cardHas('UPDATE gift_cards SET voided = $1 WHERE id = $2', true)),
    order('w09-refused-method-checked-before-the-gift-card', { products: [soap], payment: { method: 'cheque', ...gift(10) } }, cardHas('UPDATE gift_cards SET voided = $1 WHERE id = $2', true)),
    // The card bought in this basket doesn't exist yet when the order looks the paying card up.
    order('w09-refused-a-gift-card-bought-in-the-same-basket', { giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' }, payment: { ...cash(0), ...gift(60, UNKNOWN) } }),
    order('w09-refused-cash-figure-before-the-gift-card-over-the-total', { products: [soap], payment: { ...cash(5), ...gift(30) } }),
    // --- What each mix records as the method (W03-decisions Q9), and W02's noise cases
    order('w09-gift-card-and-store-credit-cover-everything', { products: [soap], payment: { ...gift(14), ...credit(10) } }),
    order('w09-gift-card-store-credit-and-cash', { booking: paidSeat([sam, alex]), payment: { ...cash(20), ...gift(10), ...credit(10) } }),
    // £6.95 covered exactly by £2.90 store credit and £4.05 on the gift card: no refusal, nothing owed.
    order('w09-exact-cover-gift-card-and-store-credit', { standaloneAddons: [towelAt(6.95)], payment: { ...gift(4.05), ...credit(2.9) } }),
    // £1.00 covered by 95p and 5p: nothing left to pay, so no method needed.
    order('w09-exact-cover-ninety-five-and-five-pence', { standaloneAddons: [towelAt(1)], payment: { ...gift(0.95), ...credit(0.05) } }),
    // Half pennies. £19.995 of store credit on £20 leaves a hair under half a penny, which is nothing to
    // collect: a 1p cash figure is refused, as createOrder refused it.
    order('w09-half-penny-store-credit', { booking: paidSeat(), payment: { ...cash(0.01), ...credit(19.995) } }),
    // And with no method it covers the seat; the balance after rounds as store_credit_apply rounds it (£10.01, from £30).
    order('w09-half-penny-store-credit-covers-it', { booking: paidSeat(), payment: credit(19.995) }),
    order('w09-half-penny-price-in-cash', { standaloneAddons: [towelAt(18.995)], payment: { ...cash(9), ...credit(10) } }),
    // --- Everything at once
    order('w09-every-part-in-cash', { ...everyKind, promoCode: PROMO.fixed, payment: { ...cash(164), ...gift(20), ...credit(10) } }),
    order('w09-worst-basket', {
      booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] },
      products: [candle],
      giftCard: { giftCardTypeId: ID.giftCardType, amount: 10, fulfillmentMethod: 'shipping' },
      event: places([samAttending, alexGuest, beaGuest]),
      ...shipped,
      saveShippingAddressToCustomer: true,
      promoCode: PROMO.fixed,
      payment: { ...cash(164.95), ...gift(20), ...credit(10) },
    }),
    // --- Brief W09a (W09 review S1): a customer with an address on file. The store credit claim and the
    // address save share one UPDATE of the customer, so hold what that UPDATE does to an address already there.
    // Saving an address with no second line clears the old "Flat 2" (review A3).
    order('w09a-saved-address-with-no-second-line-replaces-one-with-it', { products: [candle], ...shipped, saveShippingAddressToCustomer: true, payment: { ...cash(14.95), ...credit(10) } }, addressOnFile),
    // Store credit alone, nothing shipped: the address on file stays as it was (review A1).
    order('w09a-store-credit-alone-leaves-the-address-on-file', { products: [soap], payment: credit(24) }, addressOnFile),
    // A promo beside a membership bought in the same basket would take a share of its first payment: not built until W13.
    order('w09-promo-with-a-membership-bought-in-cash', { booking: paidSeat(), ...monthly, promoCode: PROMO.percent, payment: cash(54) }),
  ]
}

// --- W10: the saved card. Every kind T1 takes, paid by the saved card, alone and with a gift card,
// store credit and a promo code; then the card declined, needing authentication, and missing, and an
// unclear answer. Each runs through the old createOrder (and its charge route) with the fake Stripe for
// its golden file, and order-replay.test.ts runs it through the new route too.
function w10Scenarios(): Scenario[] {
  const card = { method: 'card' }
  const beaSeat: Guest = { name: 'Bea Guest', email: 'bea@example.com' }
  const samAttending = { ...sam, isAccountHolder: true }
  const alexGuest = { ...alex, isAccountHolder: false }
  const beaGuest = { ...beaSeat, isAccountHolder: false }
  const robe = { addonId: ID.robe, quantity: 1, unitPrice: 8, systemUnitPrice: 8 }
  const gift = (amount: number) => ({ giftCard: { giftCardId: ID.giftCard, amount } })
  const credit = (amount: number) => ({ storeCredit: { amount } })
  const event = (attendees: Array<Record<string, unknown>>) => ({
    eventId: ID.event,
    accountHolderAttending: true,
    ...(attendees.length > 1 ? { guestsOver18Confirmed: true } : {}),
    attendees,
  })
  const everyKind = {
    booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] },
    standaloneAddons: [towel],
    products: [soap],
    sessionPassTypeId: ID.passType,
    giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' },
    event: event([samAttending, alexGuest]),
  }
  const worst = {
    booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] },
    products: [candle],
    giftCard: { giftCardTypeId: ID.giftCardType, amount: 10, fulfillmentMethod: 'shipping' },
    event: event([samAttending, alexGuest, beaGuest]),
    ...shipped,
    saveShippingAddressToCustomer: true,
  }
  const declined = (stripe: FakeStripe) => stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
  const needsAuthentication = (stripe: FakeStripe) => stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.authenticationRequired() })
  const atTheCharge = (fault: (stripe: FakeStripe) => void) => async (_db: Db, stripe: FakeStripe) => {
    fault(stripe)
  }
  const asMo = { customerId: ID.member }
  return [
    // --- Every kind T1 takes, on the saved card
    order('w10-card-public-booking-with-an-addon', { booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: card }),
    order('w10-card-private-booking', { booking: { ...paidSeat([sam, alex]), sessionId: ID.privateSession }, payment: card }),
    order('w10-card-member-credit-seat-paid-guest-and-addon-credit', {
      ...asMo,
      booking: { ...paidSeat([mo, alex]), ...memberCredit, addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] },
      standaloneAddons: [robe],
      payment: card,
    }),
    order('w10-card-pass-seat-and-a-paid-guest', { booking: { ...paidSeat([sam, alex]), ...ownedPass }, payment: card }),
    order('w10-card-standalone-addons', { standaloneAddons: [towel, { ...robe, unitPrice: 10, systemUnitPrice: 10 }], payment: card }),
    order('w10-card-products-picked-up', { products: [soap], payment: card }),
    order('w10-card-shipped-product-address-saved', { products: [candle], ...shipped, saveShippingAddressToCustomer: true, payment: card }),
    order('w10-card-pass-alone', { sessionPassTypeId: ID.passType, payment: card }),
    order('w10-card-buy-new-pass-booking', { booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_session_pass' }, sessionPassTypeId: ID.passType, payment: card }),
    order('w10-card-gift-card-digital', { giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital', recipientName: 'Ali Friend' }, payment: card }),
    order('w10-card-gift-card-shipped', { giftCard: { giftCardTypeId: ID.giftCardType, amount: 25, fulfillmentMethod: 'shipping' }, ...shipped, payment: card }),
    order('w10-card-event-with-guests', { event: event([samAttending, alexGuest, beaGuest]), payment: card }),
    order('w10-card-every-kind', { ...everyKind, payment: card }),
    // --- With a gift card, store credit and a promo code
    order('w10-card-with-a-gift-card', { ...everyKind, payment: { ...card, ...gift(20) } }),
    order('w10-card-with-store-credit', { ...everyKind, payment: { ...card, ...credit(10) } }),
    order('w10-card-with-a-promo-code', { ...everyKind, promoCode: PROMO.percent, payment: card }),
    order('w10-card-with-all-three', { ...everyKind, promoCode: PROMO.fixed, payment: { ...card, ...gift(20), ...credit(10) } }),
    order('w10-card-worst-basket', { ...worst, promoCode: PROMO.fixed, payment: { ...card, ...gift(20), ...credit(10) } }),
    // £48 of soap: the card's whole £40, then £8 on the saved card.
    order('w10-card-gift-card-uses-its-whole-balance', { products: [{ ...soap, quantity: 4 }], payment: { ...card, ...gift(40) } }),
    // Nothing left for the card: no Stripe call, as createOrder.
    order('w10-card-chosen-with-nothing-left-to-charge', { products: [soap], payment: { ...card, ...gift(14), ...credit(10) } }),
    // --- The card declined, needing authentication, or not there: everything given back
    order('w10-declined-every-kind-with-all-three', { ...everyKind, promoCode: PROMO.fixed, payment: { ...card, ...gift(20), ...credit(10) } }, atTheCharge(declined)),
    order('w10-declined-worst-basket', { ...worst, promoCode: PROMO.fixed, payment: { ...card, ...gift(20), ...credit(10) } }, atTheCharge(declined)),
    order('w10-declined-gift-card-used-up', { products: [{ ...soap, quantity: 4 }], payment: { ...card, ...gift(40) } }, atTheCharge(declined)),
    order(
      'w10-declined-member-credit-and-addon-credit',
      {
        ...asMo,
        booking: { ...paidSeat([mo, alex]), ...memberCredit, addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] },
        payment: card,
      },
      atTheCharge(declined)
    ),
    order('w10-declined-pass-seat', { booking: { ...paidSeat([sam, alex]), ...ownedPass }, payment: card }, atTheCharge(declined)),
    order('w10-declined-buy-new-pass-booking', { booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_session_pass' }, sessionPassTypeId: ID.passType, payment: card }, atTheCharge(declined)),
    order('w10-declined-private-booking', { booking: { ...paidSeat([sam, alex]), sessionId: ID.privateSession }, payment: card }, atTheCharge(declined)),
    order('w10-authentication-needed', { booking: paidSeat(), products: [soap], payment: card }, atTheCharge(needsAuthentication)),
    order('w10-authentication-needed-with-store-credit', { booking: paidSeat(), payment: { ...card, ...credit(10) } }, atTheCharge(needsAuthentication)),
    order('w10-no-saved-card', { booking: paidSeat(), payment: card }, async (db) => {
      await db.query('UPDATE customers SET saved_payment_method_id = NULL WHERE id = $1', [ID.customer])
    }),
    // --- An unclear answer: a 500, which Stripe keeps against the key. createOrder rolled it back; the
    // Worker holds the order pending (W03-plan 2.5), a named difference with its own test.
    order('w10-unclear-answer', { booking: paidSeat(), payment: { ...card, ...credit(10) } }, atTheCharge((stripe) => stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.server() }))),
  ]
}

// --- W11: the reader. Every kind T1 takes, paid on the reader, alone and with a gift card, store credit
// and a promo code; the card saved (a reusable card, and the simulated reader's, bug 7) and not; the tap
// declined and the order cancelled (bugs 8 and 9); cancel finding the payment taken; the amount off; the
// intent refused or unclear; finalise and cancel twice. Each runs through the old createOrder,
// finaliseReaderOrder and cancelReaderOrder (and their legacy routes) with the fake Stripe for its golden
// file, and order-replay.test.ts runs it through the new routes too.

/** What the customer does at the reader. */
type Tap =
  /** No tap that took money: declined, cancelled on the reader, or walked away. */
  | 'none'
  /** Paid, with no card saved. */
  | 'paid'
  /** Paid, and Stripe made a reusable card (a physical reader). */
  | 'paid-reusable'
  /** Paid on the simulated reader, which never makes a reusable card (W03-decisions Q16). */
  | 'paid-simulated'
  /** Paid, but the reader took this many pence. */
  | { pence: number }

interface ReaderRun {
  tap?: Tap
  /** What the screen calls afterwards, in order. By default: finalise after a tap, cancel after none. */
  then?: Array<'finalise' | 'cancel'>
  prepare?(db: Db, stripe: FakeStripe): Promise<void> | void
}

function onTheReader(name: string, params: Record<string, unknown>, { tap = 'paid', then, prepare }: ReaderRun = {}): Scenario {
  return {
    name,
    async seed(db, stripe) {
      await seed(db, stripe)
      await prepare?.(db, stripe)
    },
    async run({ call, stripe }) {
      const placed = (await call('createOrder', { customerId: ID.customer, ...params })) as { orderId?: string; pendingReaderPayment?: { paymentIntentId: string } }
      const intent = placed.pendingReaderPayment?.paymentIntentId
      if (!placed.orderId || !intent) return
      if (tap === 'paid') stripe.completeReaderPayment(intent)
      else if (tap === 'paid-reusable') stripe.completeReaderPayment(intent, { generatedCard: 'pm_reader_saved' })
      else if (tap === 'paid-simulated') stripe.completeReaderPayment(intent, { simulatedReader: true })
      else if (tap !== 'none') stripe.completeReaderPayment(intent, { amount: tap.pence })
      for (const step of then ?? [tap === 'none' ? 'cancel' : 'finalise']) {
        await call(step === 'finalise' ? 'finaliseReaderOrder' : 'cancelReaderOrder', { orderId: placed.orderId })
      }
    },
  }
}

function w11Scenarios(): Scenario[] {
  const reader = { method: 'reader' }
  const saving = { method: 'reader', readerSaveCard: true }
  const beaSeat: Guest = { name: 'Bea Guest', email: 'bea@example.com' }
  const samAttending = { ...sam, isAccountHolder: true }
  const alexGuest = { ...alex, isAccountHolder: false }
  const beaGuest = { ...beaSeat, isAccountHolder: false }
  const robe = { addonId: ID.robe, quantity: 1, unitPrice: 8, systemUnitPrice: 8 }
  const gift = (amount: number) => ({ giftCard: { giftCardId: ID.giftCard, amount } })
  const credit = (amount: number) => ({ storeCredit: { amount } })
  const event = (attendees: Array<Record<string, unknown>>) => ({
    eventId: ID.event,
    accountHolderAttending: true,
    ...(attendees.length > 1 ? { guestsOver18Confirmed: true } : {}),
    attendees,
  })
  const withTowel = { booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] } }
  const everyKind = {
    ...withTowel,
    standaloneAddons: [towel],
    products: [soap],
    sessionPassTypeId: ID.passType,
    giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' },
    event: event([samAttending, alexGuest]),
  }
  const worst = {
    ...withTowel,
    products: [candle],
    giftCard: { giftCardTypeId: ID.giftCardType, amount: 10, fulfillmentMethod: 'shipping' },
    event: event([samAttending, alexGuest, beaGuest]),
    ...shipped,
    saveShippingAddressToCustomer: true,
  }
  const asMo = { customerId: ID.member }
  const moCreditAndAddonCredit = {
    ...asMo,
    booking: { ...paidSeat([mo, alex]), ...memberCredit, addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] },
  }
  const noStripeCustomer = async (db: Db) => {
    await db.query('UPDATE customers SET stripe_customer_id = NULL WHERE id = $1', [ID.customer])
  }
  const atTheIntent = (error: Error) => (_db: Db, stripe: FakeStripe) => stripe.failNext('paymentIntents.create', { kind: 'error', error })
  return [
    // --- Every kind T1 takes, tapped and finalised
    onTheReader('w11-reader-public-booking-with-an-addon', { ...withTowel, payment: reader }),
    onTheReader('w11-reader-private-booking', { booking: { ...paidSeat([sam, alex]), sessionId: ID.privateSession }, payment: reader }),
    onTheReader('w11-reader-member-credit-seat-paid-guest-and-addon-credit', { ...moCreditAndAddonCredit, standaloneAddons: [robe], payment: reader }),
    onTheReader('w11-reader-pass-seat-and-a-paid-guest', { booking: { ...paidSeat([sam, alex]), ...ownedPass }, payment: reader }),
    onTheReader('w11-reader-standalone-addons', { standaloneAddons: [towel, { ...robe, unitPrice: 10, systemUnitPrice: 10 }], payment: reader }),
    onTheReader('w11-reader-products-picked-up', { products: [soap], payment: reader }),
    onTheReader('w11-reader-shipped-product-address-saved', { products: [candle], ...shipped, saveShippingAddressToCustomer: true, payment: reader }),
    onTheReader('w11-reader-pass-alone', { sessionPassTypeId: ID.passType, payment: reader }),
    onTheReader('w11-reader-buy-new-pass-booking', { booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_session_pass' }, sessionPassTypeId: ID.passType, payment: reader }),
    onTheReader('w11-reader-gift-card-digital', { giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital', recipientName: 'Ali Friend' }, payment: reader }),
    onTheReader('w11-reader-gift-card-shipped', { giftCard: { giftCardTypeId: ID.giftCardType, amount: 25, fulfillmentMethod: 'shipping' }, ...shipped, payment: reader }),
    onTheReader('w11-reader-event-with-guests', { event: event([samAttending, alexGuest, beaGuest]), payment: reader }),
    onTheReader('w11-reader-every-kind', { ...everyKind, payment: reader }),
    // --- With a gift card, store credit and a promo code
    onTheReader('w11-reader-with-a-gift-card', { ...everyKind, payment: { ...reader, ...gift(20) } }),
    onTheReader('w11-reader-with-store-credit', { ...everyKind, payment: { ...reader, ...credit(10) } }),
    onTheReader('w11-reader-with-a-promo-code', { ...everyKind, promoCode: PROMO.percent, payment: reader }),
    onTheReader('w11-reader-with-all-three', { ...everyKind, promoCode: PROMO.fixed, payment: { ...reader, ...gift(20), ...credit(10) } }),
    onTheReader('w11-reader-worst-basket', { ...worst, promoCode: PROMO.fixed, payment: { ...reader, ...gift(20), ...credit(10) } }),
    // £48 of soap: the gift card's whole £40, then £8 on the reader.
    onTheReader('w11-reader-gift-card-uses-its-whole-balance', { products: [{ ...soap, quantity: 4 }], payment: { ...reader, ...gift(40) } }),
    // --- The card saved, or not
    onTheReader('w11-reader-save-card-reusable', { ...withTowel, payment: saving }, { tap: 'paid-reusable' }),
    // Bug 7: the simulated reader never makes a reusable card. Paid all the same, with the warning.
    onTheReader('w11-reader-save-card-simulated-reader', { ...withTowel, payment: saving }, { tap: 'paid-simulated' }),
    onTheReader('w11-reader-save-card-with-all-three', { ...everyKind, promoCode: PROMO.fixed, payment: { ...saving, ...gift(20), ...credit(10) } }, { tap: 'paid-reusable' }),
    // A customer with no Stripe customer yet: found or made first (ensureStripeCustomer), then the intent.
    onTheReader('w11-reader-new-stripe-customer', { ...withTowel, payment: reader }, { prepare: noStripeCustomer }),
    onTheReader('w11-reader-new-stripe-customer-saves-the-card', { products: [soap], payment: saving }, { tap: 'paid-reusable', prepare: noStripeCustomer }),
    // --- No tap: cancelled, everything given back (bugs 8 and 9)
    onTheReader('w11-reader-cancelled-public-booking-with-an-addon', { ...withTowel, payment: reader }, { tap: 'none' }),
    onTheReader('w11-reader-cancelled-every-kind-with-all-three', { ...everyKind, promoCode: PROMO.fixed, payment: { ...reader, ...gift(20), ...credit(10) } }, { tap: 'none' }),
    onTheReader('w11-reader-cancelled-worst-basket', { ...worst, promoCode: PROMO.fixed, payment: { ...reader, ...gift(20), ...credit(10) } }, { tap: 'none' }),
    onTheReader('w11-reader-cancelled-gift-card-used-up', { products: [{ ...soap, quantity: 4 }], payment: { ...reader, ...gift(40) } }, { tap: 'none' }),
    onTheReader('w11-reader-cancelled-member-credit-and-addon-credit', { ...moCreditAndAddonCredit, payment: reader }, { tap: 'none' }),
    onTheReader('w11-reader-cancelled-pass-seat', { booking: { ...paidSeat([sam, alex]), ...ownedPass }, payment: reader }, { tap: 'none' }),
    onTheReader('w11-reader-cancelled-buy-new-pass-booking', { booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_session_pass' }, sessionPassTypeId: ID.passType, payment: reader }, { tap: 'none' }),
    onTheReader('w11-reader-cancelled-private-booking', { booking: { ...paidSeat([sam, alex]), sessionId: ID.privateSession }, payment: reader }, { tap: 'none' }),
    onTheReader('w11-reader-cancelled-event', { event: event([samAttending, alexGuest]), payment: { ...reader, ...credit(10) } }, { tap: 'none' }),
    // --- Cancel finds the payment taken: finalised instead (alreadySucceeded)
    onTheReader('w11-reader-cancel-finds-it-paid', { ...withTowel, payment: reader }, { tap: 'paid', then: ['cancel'] }),
    onTheReader('w11-reader-cancel-finds-it-paid-and-saves-the-card', { ...withTowel, payment: { ...saving, ...gift(10) } }, { tap: 'paid-reusable', then: ['cancel'] }),
    // --- The amount the reader took isn't the order's: £1 short (both refuse), and 1p over (the old
    // check let a penny through; the Worker checks to the penny, W03-plan 2.7)
    onTheReader('w11-reader-amount-mismatch-a-pound-short', { ...withTowel, payment: reader }, { tap: { pence: 4400 } }),
    onTheReader('w11-reader-amount-a-penny-over', { ...withTowel, payment: reader }, { tap: { pence: 4501 } }),
    // --- Twice, and in the wrong order
    onTheReader('w11-reader-finalise-twice', { ...withTowel, payment: reader }, { then: ['finalise', 'finalise'] }),
    onTheReader('w11-reader-cancel-twice', { ...withTowel, payment: { ...reader, ...gift(10) } }, { tap: 'none', then: ['cancel', 'cancel'] }),
    onTheReader('w11-reader-finalise-before-the-tap-then-cancel', { ...withTowel, payment: reader }, { tap: 'none', then: ['finalise', 'cancel'] }),
    onTheReader('w11-reader-cancelled-then-finalised-late', { ...withTowel, payment: reader }, { tap: 'none', then: ['cancel', 'finalise'] }),
    // --- The intent: refused, unclear, nothing to take, or no Stripe customer could be made
    onTheReader('w11-reader-intent-refused', { ...withTowel, payment: { ...reader, ...credit(10) } }, { prepare: atTheIntent(fakeStripeErrors.invalid('parameter_invalid_integer', 'Invalid integer: 0')) }),
    // A 500, which Stripe keeps against the key: createOrder rolled back; the Worker holds the order
    // pending (W03-plan 2.5), a named difference with its own test.
    onTheReader('w11-reader-intent-unclear', { ...withTowel, payment: { ...reader, ...credit(10) } }, { prepare: atTheIntent(fakeStripeErrors.server()) }),
    onTheReader('w11-reader-nothing-to-charge', { products: [soap], payment: { ...reader, ...gift(24) } }),
    onTheReader('w11-reader-stripe-customer-not-made', { ...withTowel, payment: reader }, {
      prepare: async (db, stripe) => {
        await noStripeCustomer(db)
        stripe.failNext('customers.create', { kind: 'error', error: fakeStripeErrors.invalid('email_invalid', 'Invalid email address: sam@example') })
      },
    }),
  ]
}

// --- W13: memberships. Each plan (Core, All-Access) and frequency, on the saved card (with the remainder
// charged as well, Q21) and on the reader (the tap taking the first payment), with a promo, a gift card,
// store credit spilling onto the first payment (Q1, Q2), a buy-new booking (alone, with a pass, Q3, and with
// a pass and an event, W08 review L2), replacing an exhausted membership (Q8), and refused at each Stripe
// step. Each runs through the old createOrder (and finaliseReaderOrder or cancelReaderOrder) with the fake
// Stripe for its golden file, and order-replay.test.ts runs it through the new routes too.


/** An unlimited All-Access plan, covering Core and Peak sessions on credit, with add-on credits. */
export async function seedAllAccess(db: Db, stripe: FakeStripe): Promise<void> {
  await insert(db, 'membership_plans', {
    id: ALL_ACCESS_PLAN,
    name: 'All-Access',
    level: 'all_access',
    sessions_included: 0,
    is_unlimited: true,
    addons_included: 4,
    price_monthly: '75.00',
    price_yearly: '750.00',
    stripe_product_id: 'prod_seed_all_access',
    stripe_price_id: ALL_ACCESS_MONTHLY,
    stripe_price_id_yearly: ALL_ACCESS_YEARLY,
  })
  await insert(db, 'membership_band_terms', { id: '10000000-0000-4000-8000-000000000a14', membership_level: 'all_access', band_id: ID.band, credit_eligible: true })
  await insert(db, 'membership_band_terms', { id: '10000000-0000-4000-8000-000000000a15', membership_level: 'all_access', band_id: ID.peakBand, credit_eligible: true })
  stripe.addPrice(ALL_ACCESS_MONTHLY, 7500, 'month')
  stripe.addPrice(ALL_ACCESS_YEARLY, 75000, 'year')
}

/** Two presses of the same basket, as staff press Complete Order again after a refusal (bug 13). */
function pressedTwice(name: string, params: Record<string, unknown>, prepare: (db: Db, stripe: FakeStripe) => Promise<void> | void): Scenario {
  return {
    name,
    async seed(db, stripe) {
      await seed(db, stripe)
      await prepare(db, stripe)
    },
    async run({ call }) {
      await call('createOrder', { customerId: ID.customer, ...params })
      await call('createOrder', { customerId: ID.customer, ...params })
    },
  }
}

function w13Scenarios(): Scenario[] {
  const card = { method: 'card' }
  const saving = { method: 'reader', readerSaveCard: true }
  const gift = (amount: number) => ({ giftCard: { giftCardId: ID.giftCard, amount } })
  const credit = (amount: number) => ({ storeCredit: { amount } })
  const yearly = { ...monthly, membershipBillingFrequency: 'yearly' }
  const allAccess = { ...monthly, membershipPlanId: ALL_ACCESS_PLAN }
  const allAccessYearly = { ...allAccess, membershipBillingFrequency: 'yearly' }
  const samAttending = { ...sam, isAccountHolder: true }
  const buyNew = (guests: Guest[] = [sam]) => ({ ...paidSeat(guests), redemptionSource: 'buy_new_membership' })
  const replacing = (guests: Guest[] = [sam]) => ({ ...paidSeat(guests), redemptionSource: 'buy_new_membership', cancelExhaustedMembershipId: ID.exhausted })
  const passEventAndMembership = {
    booking: { ...paidSeat([sam]), redemptionSource: 'buy_new_session_pass' },
    sessionPassTypeId: ID.passType,
    event: { eventId: ID.event, accountHolderAttending: true, guestsOver18Confirmed: true, attendees: [samAttending] },
    ...monthly,
  }
  const at = (method: string, error: () => Error) => async (_db: Db, stripe: FakeStripe) => {
    stripe.failNext(method, { kind: 'error', error: error() })
  }
  const replacingAnd = (method: string, error: () => Error) => async (db: Db, stripe: FakeStripe) => {
    await seedExhaustedMembership(db, stripe)
    stripe.failNext(method, { kind: 'error', error: error() })
  }
  return [
    // --- The saved card: each plan and frequency, with the remainder charged too (Q21: two charges)
    order('w13-card-all-access-monthly', { ...allAccess, payment: card }, seedAllAccess),
    order('w13-card-all-access-yearly-buy-new-on-peak', { booking: { ...buyNew(), sessionId: ID.peakSession }, ...allAccessYearly, payment: card }, seedAllAccess),
    order('w13-card-membership-and-products', { products: [soap], ...monthly, payment: card }),
    order('w13-card-yearly-and-a-shipped-product', { products: [candle], ...shipped, saveShippingAddressToCustomer: true, ...yearly, payment: card }),
    // A gift card and store credit: the soap first, then the rest of the first payment (Q1, Q2); Q9 records split.
    order('w13-card-membership-with-a-gift-card', { products: [soap], ...monthly, payment: { ...card, ...gift(30) } }),
    order('w13-card-membership-covered-by-gift-card-and-store-credit', { ...monthly, payment: { ...card, ...gift(20), ...credit(20) } }),
    order('w13-card-promo-and-spill', { products: [soap], ...monthly, promoCode: PROMO.percent, payment: { ...card, ...credit(30) } }),
    order('w13-card-buy-new-membership-with-a-guest-and-an-addon', { booking: { ...buyNew([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] }, ...monthly, payment: card }),
    // Q8: the exhausted subscription cancelled last, after the guest's seat is charged.
    order('w13-card-replace-exhausted-with-a-paid-guest', { booking: replacing([sam, alex]), ...monthly, payment: card }, seedExhaustedMembership),
    // W08 review L2: a buy-new pass booking, an event and a membership in one basket.
    order('w13-card-buy-new-pass-event-and-membership', { ...passEventAndMembership, payment: card }),
    // --- Refused at each Stripe step
    order('w13-card-subscription-declined', { products: [soap], ...monthly, payment: card }, at('subscriptions.create', fakeStripeErrors.cardDeclined)),
    // The rest of the basket declined once the subscription exists: it is cancelled and its first invoice refunded.
    order('w13-card-charge-declined-after-the-subscription', { products: [soap], ...monthly, payment: card }, at('paymentIntents.create', fakeStripeErrors.cardDeclined)),
    // Q8: the old subscription's cancel refused: everything reversed.
    order('w13-card-old-cancel-refused', { booking: replacing([sam, alex]), ...monthly, payment: card }, replacingAnd('subscriptions.cancel', () => fakeStripeErrors.invalid('resource_missing', "No such subscription: 'sub_exhausted'"))),
    // W03-plan 2.7: Stripe's price isn't the plan's (createOrder charged Stripe's silently), or is archived.
    order('w13-card-stripe-price-differs', { ...monthly, payment: card }, async (_db, stripe) => {
      stripe.addPrice('price_seed_monthly', 4500, 'month')
    }),
    order('w13-card-stripe-price-archived', { ...monthly, payment: card }, async (_db, stripe) => {
      stripe.addPrice('price_seed_monthly', 4000, 'month', 'gbp', false)
    }),
    // A 500 on the subscription: createOrder rolled back; the Worker holds the order (W03-plan 2.5).
    order('w13-card-subscription-unclear', { products: [soap], ...monthly, payment: card }, at('subscriptions.create', fakeStripeErrors.server)),
    // Bug 13: declined, then pressed again. createOrder's key was the basket's, so Stripe replayed the decline.
    pressedTwice('w13-card-declined-then-retried', { products: [soap], ...monthly, payment: card }, at('subscriptions.create', fakeStripeErrors.cardDeclined)),
    // --- The reader: the tap takes the first payment, the coupon covers the first invoice
    onTheReader('w13-reader-membership', { ...monthly, payment: saving }, { tap: 'paid-reusable' }),
    onTheReader('w13-reader-all-access-yearly', { ...allAccessYearly, payment: saving }, { tap: 'paid-reusable', prepare: seedAllAccess }),
    onTheReader('w13-reader-membership-products-and-store-credit', { products: [soap], ...monthly, payment: { ...saving, ...credit(30) } }, { tap: 'paid-reusable' }),
    onTheReader('w13-reader-buy-new-membership-with-a-guest', { booking: buyNew([sam, alex]), ...monthly, payment: saving }, { tap: 'paid-reusable' }),
    onTheReader('w13-reader-replace-an-exhausted-membership', { booking: replacing(), ...monthly, payment: saving }, { tap: 'paid-reusable', prepare: seedExhaustedMembership }),
    onTheReader('w13-reader-buy-new-pass-event-and-membership', { ...passEventAndMembership, payment: saving }, { tap: 'paid-reusable' }),
    // The simulated reader makes no reusable card: a membership can't renew, so the tap is refunded.
    onTheReader('w13-reader-card-not-reusable', { ...monthly, payment: saving }, { tap: 'paid-simulated' }),
    onTheReader('w13-reader-membership-cancelled', { ...monthly, payment: saving }, { tap: 'none' }),
    onTheReader('w13-reader-buy-new-membership-cancelled', { booking: buyNew([sam, alex]), ...monthly, payment: saving }, { tap: 'none' }),
    // Q8 on the reader: the old subscription's cancel refused: the tap refunded, the new subscription cancelled.
    onTheReader('w13-reader-old-cancel-refused', { booking: replacing(), ...monthly, payment: saving }, { tap: 'paid-reusable', prepare: replacingAnd('subscriptions.cancel', () => fakeStripeErrors.invalid('resource_missing', "No such subscription: 'sub_exhausted'")) }),
  ]
}

// --- W17 (lead call L6, D-plan 4.11 item 6): the golden gaps, recorded from the old functions while they exist (the
// frozen copy, legacy-booking/), with today's outcomes, so step D's named differences are held against real
// recordings. R1a to R4b are the third W05 release review's proofs (briefs/W05-release-review-3-report.md, findings 1
// to 4); N1, N3 and N4 are D-plan section 3's bugs. Each records what the old code does today, faults included:
// the slice that moves the action names the difference (W19 Settle, W20 Add Guest, W23 Cancel, W24 Move, W18 status).

/**
 * The statement matching `matches` gets no answer before it has run (the driver gave up while it waited, for a lock
 * or in the pooler's queue), and then runs once `steps` is over: what a statement that commits after the press looked
 * for it and undid everything leaves (the review's `landingAfterTheLook`). The late statement's own answer is lost.
 */
export async function landingAfterTheLook<T>(matches: (sql: string) => boolean, steps: () => Promise<T>): Promise<T> {
  const real = dataApi()
  let held: { sql: string; params: unknown[] } | null = null
  vi.stubGlobal('paddockData', {
    async query(sql: string, params: unknown[] = []) {
      if (!held && matches(sql)) {
        held = { sql, params }
        throw new Error('timeout exceeded when trying to connect')
      }
      return real.query(sql, params)
    },
  })
  try {
    return await steps()
  } finally {
    vi.stubGlobal('paddockData', real)
    const late = held as { sql: string; params: unknown[] } | null
    if (late) await real.query(late.sql, late.params).catch(() => undefined)
  }
}

/** Sam's other booking on `day`, in the cold plunge, so a move onto that day meets the one-a-day trigger (N1). */
const samsOtherBookingOn = (day: string) => async (db: Db) => {
  await insert(db, 'service_types', { id: ID.sauna2, name: 'Cold Plunge', booking_type: 'public' })
  await insert(db, 'sessions', {
    id: ID.conflicting,
    service_type_id: ID.sauna2,
    start_time: `${day} 08:00:00+00`,
    end_time: `${day} 09:00:00+00`,
    type: 'public',
    capacity: 10,
    total_booked: 1,
    band_id: ID.band,
  })
  // With its times: a booking with none is an unbounded range to bookings_no_cross_session_overlap.
  await insert(db, 'bookings', {
    session_id: ID.conflicting,
    customer_id: ID.customer,
    party_size: 1,
    price_paid: '20',
    status: 'confirmed',
    start_time: `${day} 08:00:00+00`,
    end_time: `${day} 09:00:00+00`,
  })
}

/** A write to `table` the database refuses, as a lost connection would (N4's later statements). */
const sessionsWriteFails: WriteFailure = { table: 'sessions', event: 'UPDATE', when: 'true' }
const passWriteFails: WriteFailure = { table: 'customer_session_passes', event: 'UPDATE', when: 'true' }

function w17Scenarios(): Scenario[] {
  const placeSamsTwoSeats = async (call: ScenarioContext['call']) =>
    ((await call('createOrder', { customerId: ID.customer, ...publicOnCard })) as { bookingId: string }).bookingId
  const movingSeed = async (db: Db, stripe: FakeStripe) => {
    await seed(db, stripe)
    await sessionsToMoveBetween(db)
  }
  const R1_MONEY = { storeCredit: { amount: 15 }, giftCard: { giftCardId: ID.giftCard, amount: 5 } }
  const toPeak = (bookingId: string, payment?: Record<string, unknown>) => ({
    bookingId,
    newSessionId: ID.peakSession,
    ...(payment ? { confirmed: true, payment } : {}),
  })
  return [
    // R1 (review 3, finding 1): a no-card press whose statement commits after the press looked for it and undid.
    {
      name: 'w17-r1a-settle-store-credit-and-gift-card-statement-lands-late',
      seed,
      async run({ call, attempt, db }) {
        const bookingId = await lapsedSeat(call, db)
        await db.query('UPDATE customers SET store_credit_balance = 15 WHERE id = $1', [ID.member])
        await landingAfterTheLook(SETTLE_STATEMENT, () => attempt('settleLapsedBooking', { bookingId, payment: R1_MONEY }))
      },
    },
    {
      name: 'w17-r1a-control-settle-store-credit-and-card-statement-lands-late',
      seed,
      async run({ call, attempt, db }) {
        const bookingId = await lapsedSeat(call, db)
        await db.query('UPDATE customers SET store_credit_balance = 15 WHERE id = $1', [ID.member])
        await landingAfterTheLook(SETTLE_STATEMENT, () => attempt('settleLapsedBooking', { bookingId, payment: { method: 'card', storeCredit: { amount: 5 } } }))
      },
    },
    {
      name: 'w17-r1b-move-store-credit-and-gift-card-statement-lands-late',
      seed: movingSeed,
      async run({ call, attempt }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('moveBooking', toPeak(bookingId))
        await landingAfterTheLook(MOVE_STATEMENT, () => attempt('moveBooking', toPeak(bookingId, { storeCredit: { amount: 6 }, giftCard: { giftCardId: ID.giftCard, amount: 5 } })))
      },
    },
    {
      name: 'w17-r1c-add-guest-store-credit-and-gift-card-statement-lands-late',
      seed,
      async run({ call, attempt }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('addBookingGuest', { bookingId, ...bea })
        await landingAfterTheLook(ADD_GUEST_STATEMENT, () => attempt('addBookingGuest', { bookingId, ...bea, payment: R1_MONEY }))
      },
    },
    {
      name: 'w17-r1d-move-gift-card-and-reader-statement-lands-late-then-cancel',
      seed: movingSeed,
      async run({ call, attempt, db }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('moveBooking', toPeak(bookingId))
        await landingAfterTheLook(MOVE_STATEMENT, () => attempt('moveBooking', toPeak(bookingId, { method: 'reader', giftCard: { giftCardId: ID.giftCard, amount: 5 } })))
        const open = (await db.query<{ id: string }>("SELECT id FROM pending_reader_payments WHERE record_id = $1 AND status = 'pending'", [bookingId]))[0]
        // As the old sweep does after 15 minutes: cancel the reader payment the late statement left open.
        if (open) await attempt('cancelReaderPayment', { pendingId: open.id })
      },
    },
    // R2 (finding 2): what a press that died took is recorded nowhere.
    {
      name: 'w17-r2a-add-guest-press-dies-after-the-charge-then-paid-on-the-card',
      seed,
      async run({ call, attempt }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('addBookingGuest', { bookingId, ...bea })
        await dyingAfter(CHARGE_PATH, () => call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } }))
        await attempt('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
      },
    },
    {
      name: 'w17-r2b-add-guest-press-dies-after-the-charge-then-resumed-with-a-gift-card',
      seed,
      async run({ call, attempt }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('addBookingGuest', { bookingId, ...bea })
        await dyingAfter(CHARGE_PATH, () => call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } }))
        await attempt('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 5 } } })
      },
    },
    {
      name: 'w17-r2c-settle-press-dies-after-a-decline-then-declined-again',
      seed,
      async run({ call, attempt, db, stripe }) {
        const bookingId = await lapsedSeat(call, db)
        await db.query('UPDATE customers SET store_credit_balance = 10 WHERE id = $1', [ID.member])
        stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        await dyingAfter(CHARGE_PATH, () => call('settleLapsedBooking', { bookingId, payment: { method: 'card', storeCredit: { amount: 5 } } }))
        stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        await attempt('settleLapsedBooking', { bookingId, payment: { method: 'card', storeCredit: { amount: 5 } } })
      },
    },
    {
      name: 'w17-r2d-add-guest-press-dies-while-the-worker-charges-and-writes-no-order',
      seed,
      async run({ call, attempt, db }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('addBookingGuest', { bookingId, ...bea })
        const payment = { method: 'card', storeCredit: { amount: 5 } }
        await whileFailing(db, { table: 'orders', event: 'INSERT', when: 'true' }, () =>
          dyingAfter(CHARGE_PATH, () => call('addBookingGuest', { bookingId, ...bea, payment }))
        )
        await attempt('addBookingGuest', { bookingId, ...bea, payment })
      },
    },
    // R3 (finding 4): two losing presses record the one refund twice.
    {
      name: 'w17-r3-move-two-presses-the-new-session-full-for-both',
      seed: movingSeed,
      async run({ call, attempt, db }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('moveBooking', toPeak(bookingId))
        await db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.peakSession])
        const press = () => attempt('moveBooking', toPeak(bookingId, { method: 'card' }))
        beforeTheStartedRow(press)
        await press()
        await call('getBookingRefundFigures', { bookingId })
      },
    },
    // R4 (finding 3): a store credit claim whose answer is lost is kept.
    {
      name: 'w17-r4a-add-guest-store-credit-claim-answer-lost-then-pressed-again',
      seed,
      async run({ call, attempt }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('addBookingGuest', { bookingId, ...bea })
        const redemption = (sql: string, params: unknown[]) => sql.includes('store_credit_apply') && params[2] === 'redemption'
        await losingTheAnswer(redemption, () => attempt('addBookingGuest', { bookingId, ...bea, payment: R1_MONEY }))
        await attempt('addBookingGuest', { bookingId, ...bea, payment: R1_MONEY })
      },
    },
    {
      name: 'w17-r4b-move-store-credit-claim-answer-lost',
      seed: movingSeed,
      async run({ call, attempt }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('moveBooking', toPeak(bookingId))
        const redemption = (sql: string, params: unknown[]) => sql.includes('store_credit_apply') && params[2] === 'redemption'
        await losingTheAnswer(redemption, () => attempt('moveBooking', toPeak(bookingId, { method: 'card', storeCredit: { amount: 6 } })))
      },
    },
    // N1: Move meets the one-booking-a-day rule only at its write.
    {
      name: 'w17-n1-dearer-move-on-the-card-to-a-day-with-another-booking',
      async seed(db, stripe) {
        await movingSeed(db, stripe)
        await samsOtherBookingOn('2026-11-14')(db)
      },
      async run({ call, attempt }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('moveBooking', toPeak(bookingId))
        await attempt('moveBooking', toPeak(bookingId, { method: 'card' }))
      },
    },
    {
      name: 'w17-n1-same-price-move-to-a-day-with-another-booking',
      async seed(db, stripe) {
        await seed(db, stripe)
        await laterPublicSession(db)
        await samsOtherBookingOn('2026-11-20')(db)
      },
      async run({ call, attempt }) {
        const bookingId = await placeSamsTwoSeats(call)
        await call('moveBooking', { bookingId, newSessionId: ID.laterPublicSession })
        await attempt('moveBooking', { bookingId, newSessionId: ID.laterPublicSession, confirmed: true })
      },
    },
    // N3: setBookingStatus takes statuses the screen never offers.
    {
      name: 'w17-n3-status-set-to-cancelled-on-a-paid-booking',
      seed,
      async run({ call, attempt }) {
        const bookingId = await placeSamsTwoSeats(call)
        await attempt('setBookingStatus', { bookingId, status: 'cancelled' })
        await call('getBookingRefundFigures', { bookingId })
      },
    },
    {
      name: 'w17-n3-status-set-to-payment-needed-then-settled-again',
      seed,
      async run({ call, attempt }) {
        const bookingId = await placeSamsTwoSeats(call)
        await attempt('setBookingStatus', { bookingId, status: 'payment_needed' })
        await attempt('settleLapsedBooking', { bookingId, payment: cash(20) })
      },
    },
    {
      name: 'w17-n3-status-set-to-confirmed-from-payment-needed',
      seed,
      async run({ call, attempt, db }) {
        const bookingId = await lapsedSeat(call, db)
        await attempt('setBookingStatus', { bookingId, status: 'confirmed' })
      },
    },
    // N4: Cancel & return credit writes the cancel, then the places and the pass session separately.
    {
      name: 'w17-n4-cancel-credit-places-write-fails-after-the-cancel',
      seed,
      async run({ call, attempt, db }) {
        const { bookingId } = (await call('createOrder', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} })) as { bookingId: string }
        await whileFailing(db, sessionsWriteFails, () => attempt('cancelCreditBooking', { bookingId }))
      },
    },
    {
      name: 'w17-n4-cancel-credit-pass-session-write-fails-after-the-cancel',
      seed,
      async run({ call, attempt, db }) {
        const booking = { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }
        const { bookingId } = (await call('createOrder', { customerId: ID.customer, booking, payment: {} })) as { bookingId: string }
        await whileFailing(db, passWriteFails, () => attempt('cancelCreditBooking', { bookingId }))
      },
    },
  ]
}

import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { insert } from '../database'
import type { Scenario } from './harness'

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
}

const STRIPE_CUSTOMER = 'cus_seed'
const MONTHLY_PRICE = 'price_seed_monthly'

/** One of everything the five scenarios sell. */
async function seed(db: Db, stripe: FakeStripe): Promise<void> {
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
  })
  await insert(db, 'membership_band_terms', {
    id: ID.terms,
    membership_level: 'core',
    band_id: ID.band,
    credit_eligible: true,
  })
  stripe.addCustomer(STRIPE_CUSTOMER)
  stripe.addPrice(MONTHLY_PRICE, 4000, 'month')
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
]

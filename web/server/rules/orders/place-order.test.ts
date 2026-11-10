import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { orderDryRunOutputSchema, placeOrderOutputSchema, type OrderDryRunOutput } from '@/contracts'
import { POST as dryRunRoute } from '@/app/api/v1/staff/orders/dry-run/route'
import { createDb, type Db, type DbDriver, type DriverSession } from '@/server/db'
import { createPostgresDriver } from '@/server/db/postgres-driver'
import { insert } from '@/server/rules/testing/database'
import type { Recording } from '@/server/rules/testing/replay/compare'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type Scenario } from '@/server/rules/testing/replay/harness'
import { newOrderSide, oldResult, orderInput, postOrder, type OrderAnswer } from '@/server/rules/testing/replay/order-side'
import { ID, liftOnSaleCheck, mo, memberCredit, paidSeat, restoreOnSaleCheck, sam, seed, seedCorePass, whileFailing, type WriteFailure } from '@/server/rules/testing/replay/scenarios'
import { herdWaitMessage } from './failure-messages'
import { GIFT_CARD_CODE_FORMAT } from './gift-card-code'
import type { BasketFacts } from './load-basket'
import { readOrderRows } from './order-rows'
import { refusalCode, refusalDetails } from './order-refusal'
import { dryRunOrder, GIFT_CARD_CODE_TRIES, placeOrder, recordedPaymentMethod, STORE_CREDIT_NOTE } from './place-order'
import { amountChangedRefusal } from './amounts'
import { orderRefusal } from './order-refusal'
import { eventFullRefusal } from './basket-event'
import { writeBooking, type BookingToWrite, type SeatToWrite } from './write-booking'

// T1 on PGlite with the live schema and the replay seed, through the real routes. The parity proof
// is order-replay.test.ts; this file is about the transaction: refusals that come after writes,
// errors Postgres raises, round trips, request idempotency, the dry run, the audit rows, and what a
// database error leaves behind (B11).

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

let environment: ReplayEnvironment
let db: Db

beforeAll(async () => {
  process.env.STAFF_API_KEY = 'test-staff-api-key'
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

// --- Baskets, as createOrder's params

const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5 }
const robe = { addonId: ID.robe, quantity: 1, unitPrice: 8 }
const alex = { name: 'Alex Guest', email: 'alex@example.com' }
const cash = (amount: number) => ({ method: 'cash', confirmedCashAmount: amount })
const cashBooking = { customerId: ID.customer, booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: cash(45) }
const creditAddons = [
  { ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership },
  { ...robe, redemptionSource: 'membership_credit', membershipId: ID.membership },
]
const memberBooking = {
  customerId: ID.member,
  booking: { ...paidSeat([mo, alex]), ...memberCredit, addons: creditAddons },
  standaloneAddons: [robe],
  payment: cash(28),
}
const passBooking = { customerId: ID.customer, booking: { ...paidSeat(), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} }

// W07's baskets
const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12 }
const candle = { productVariantId: ID.candleVariant, quantity: 1, unitPrice: 20 }
const shippedMug = { productVariantId: ID.mugVariant, quantity: 1, unitPrice: 15, fulfillmentChoice: 'shipping' }
const address = { name: 'Sam Test', line1: '1 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' }
const savedAddress = { shippingAddress: address, postageMethod: 'standard', saveShippingAddressToCustomer: true }
const productsInCash = { customerId: ID.customer, products: [soap], payment: cash(24) }
const passAlone = { customerId: ID.customer, sessionPassTypeId: ID.passType, payment: cash(50) }
const giftCardInCash = { customerId: ID.customer, giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital', recipientName: 'Ali Friend' }, payment: cash(60) }
const buyNewPass = { customerId: ID.customer, booking: { ...paidSeat(), redemptionSource: 'buy_new_session_pass' }, sessionPassTypeId: ID.passType, payment: cash(50) }
/** The brief's worst basket: a booking on a pass bought in it, two shipped products, a shipped gift card and postage. */
const worstBasket = {
  customerId: ID.customer,
  booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_session_pass' },
  sessionPassTypeId: ID.passType,
  products: [candle, shippedMug],
  giftCard: { giftCardTypeId: ID.giftCardType, amount: 10, fulfillmentMethod: 'shipping' },
  ...savedAddress,
  payment: cash(119.95),
}

// W08's baskets
const bea = { name: 'Bea Guest', email: 'bea@example.com' }
const samAttending = { ...sam, isAccountHolder: true }
const eventPlaces = (attendees: Array<Record<string, unknown>>) => ({ eventId: ID.event, accountHolderAttending: true, guestsOver18Confirmed: true, attendees })
const eventAlone = { customerId: ID.customer, event: eventPlaces([samAttending]), payment: cash(40) }
const eventWithAGuest = { customerId: ID.customer, event: eventPlaces([samAttending, { ...alex, isAccountHolder: false }]), payment: cash(80) }
/** An event beside a booking and a product: the order statement claims stock before the places. */
const eventBesideOthers = { customerId: ID.customer, booking: paidSeat(), products: [soap], event: eventPlaces([samAttending, { ...alex, isAccountHolder: false }]), payment: cash(124) }
/** The brief's worst basket for W08: an event for three, a booking for two with an add-on, a shipped product, a shipped gift card and postage. */
const eventWorstBasket = {
  customerId: ID.customer,
  booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] },
  products: [candle],
  giftCard: { giftCardTypeId: ID.giftCardType, amount: 10, fulfillmentMethod: 'shipping' },
  event: eventPlaces([samAttending, { ...alex, isAccountHolder: false }, { ...bea, isAccountHolder: false }]),
  ...savedAddress,
  payment: cash(199.95),
}

// W09's baskets
const promoBooking = { customerId: ID.customer, booking: paidSeat([sam, alex]), promoCode: 'ALLTEN', payment: cash(36) }
const storeCreditOnly = { customerId: ID.customer, products: [soap], payment: { storeCredit: { amount: 24 } } }
const giftCardOnly = { customerId: ID.customer, products: [soap], payment: { giftCard: { giftCardId: ID.giftCard, amount: 24 } } }
/** W08's worst basket with FIVER, £20 on the seed's gift card and £10 of Sam's £30 store credit: £164.95 in cash. */
const w09WorstBasket = {
  ...eventWorstBasket,
  promoCode: 'FIVER',
  payment: { ...cash(164.95), giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } },
}

/** One order through the new route, on a fresh seed, with `prepare` run first. */
function orderScenario(params: Record<string, unknown>, prepare?: (db: Db) => Promise<void>, during?: (steps: () => Promise<unknown>) => Promise<unknown>): Scenario {
  return {
    name: 'place-order test',
    async seed(seedDb, stripe) {
      await seed(seedDb, stripe)
      await prepare?.(seedDb)
    },
    async run({ call }) {
      const steps = () => call('createOrder', params)
      await (during ? during(steps) : steps())
    },
  }
}

async function placeThrough(params: Record<string, unknown>, prepare?: (db: Db) => Promise<void>, during?: (steps: () => Promise<unknown>) => Promise<unknown>) {
  const answers: OrderAnswer[] = []
  const recording = await replay(environment, orderScenario(params, prepare, during), newOrderSide(answers))
  return { recording, answer: answers[0] as OrderAnswer }
}

const tablesTouched = (recording: Recording) => Object.keys(recording.tables).sort()

/** A write Postgres skips without an error: a BEFORE trigger that returns NULL. The claim's guard then finds nothing. */
async function whileSkipping<T>(target: Db, { table, event, when }: WriteFailure, steps: () => Promise<T>): Promise<T> {
  // Test data only: every name here is fixed, as in whileFailing.
  const createTrigger = `CREATE TRIGGER skip_write BEFORE ${event} ON public.${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION public.skip_write()`
  const dropTrigger = `DROP TRIGGER skip_write ON public.${table}`
  await target.query('RESET ROLE')
  await target.query('CREATE OR REPLACE FUNCTION public.skip_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$')
  await target.query(createTrigger)
  await target.query('SET ROLE paddock_worker')
  try {
    return await steps()
  } finally {
    await target.query('RESET ROLE')
    await target.query(dropTrigger)
    await target.query('SET ROLE paddock_worker')
  }
}

/** A write Postgres refuses with its own words, as a trigger or a constraint would. */
async function whileRaising<T>(target: Db, table: string, raise: string, steps: () => Promise<T>): Promise<T> {
  // Test data only: the table and the raise are fixed strings from this file.
  const createFunction = `CREATE OR REPLACE FUNCTION public.raise_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${raise}; END $$`
  const createTrigger = `CREATE TRIGGER raise_write BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.raise_write()`
  const dropTrigger = `DROP TRIGGER raise_write ON public.${table}`
  await target.query('RESET ROLE')
  await target.query(createFunction)
  await target.query(createTrigger)
  await target.query('SET ROLE paddock_worker')
  try {
    return await steps()
  } finally {
    await target.query('RESET ROLE')
    await target.query(dropTrigger)
    await target.query('SET ROLE paddock_worker')
  }
}

const refusalOf = (answer: OrderAnswer) => (answer.body.ok ? null : { status: answer.status, code: answer.body.error.code, ...(answer.body.error.details as object) })

describe('a refusal commits nothing, even after the order has written', () => {
  it('the add-on credits fail after the booking and its seats were written: all of it goes', async () => {
    const skipped: WriteFailure = { table: 'customer_memberships', event: 'UPDATE', when: 'true' }
    const { recording, answer } = await placeThrough(memberBooking, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(refusalOf(answer)).toMatchObject({ code: 'VALIDATION', stage: 'booking', reason: 'insufficient_addon_membership_credit' })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('the pass fails after the session place was taken: the place comes back', async () => {
    const skipped: WriteFailure = { table: 'customer_session_passes', event: 'UPDATE', when: 'true' }
    const { recording, answer } = await placeThrough(passBooking, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(refusalOf(answer)).toMatchObject({ reason: 'insufficient_session_pass_credit', bookingFailureReason: 'insufficient_session_pass_credit' })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('the guarded insert finds no credit after the place was taken: refused, not paid for', async () => {
    const skipped: WriteFailure = { table: 'bookings', event: 'INSERT', when: 'NEW.credit_period_id IS NOT NULL' }
    const { recording, answer } = await placeThrough(memberBooking, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(refusalOf(answer)).toMatchObject({ reason: 'insufficient_membership_credit' })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('the session claim finds no room: createBooking\'s reason and code', async () => {
    const skipped: WriteFailure = { table: 'sessions', event: 'UPDATE', when: 'true' }
    const { recording, answer } = await placeThrough(cashBooking, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(refusalOf(answer)).toMatchObject({ status: 409, code: 'SESSION_FULL', reason: 'insufficient_capacity' })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })
})

describe('what Postgres refuses is turned into its reason after the rollback', () => {
  it('a second booking that day, caught by the trigger', async () => {
    const raise = `RAISE EXCEPTION 'This customer already has a booking on 12 Nov 2026. Only one booking per customer per day is allowed.'`
    const { recording, answer } = await placeThrough(cashBooking, undefined, (steps) => whileRaising(db, 'bookings', raise, steps))
    expect(refusalOf(answer)).toEqual({
      status: 409,
      code: 'DAY_ALREADY_BOOKED',
      stage: 'booking',
      reason: 'duplicate_day_booking',
      bookingFailureReason: 'duplicate_day_booking',
    })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('an overlapping booking, caught by the exclusion constraint', async () => {
    const raise = `RAISE EXCEPTION 'conflicting key value violates exclusion constraint' USING ERRCODE = '23P01', CONSTRAINT = 'bookings_no_cross_session_overlap'`
    const { recording, answer } = await placeThrough(cashBooking, undefined, (steps) => whileRaising(db, 'bookings', raise, steps))
    expect(refusalOf(answer)).toMatchObject({ code: 'VALIDATION', reason: 'time_conflict', bookingFailureReason: 'time_conflict' })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('quote_booking failing is an unpriced band, as createBooking took it', async () => {
    const original = (await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.quote_booking(uuid, uuid, integer)'::regprocedure) AS body`))[0]?.body as string
    const raising = original.replace(/BEGIN\n/, "BEGIN\n  RAISE EXCEPTION 'Session % is not a public session with a band', p_session_id;\n")
    expect(raising).not.toBe(original)
    const swap = async (sql: string) => {
      await db.query('RESET ROLE')
      await db.query(sql)
      await db.query('SET ROLE paddock_worker')
    }
    const { recording, answer } = await placeThrough(cashBooking, undefined, async (steps) => {
      await swap(raising)
      try {
        return await steps()
      } finally {
        await swap(original)
      }
    })
    expect(refusalOf(answer)).toMatchObject({ reason: 'band_unpriced', bookingFailureReason: 'band_unpriced' })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('anything else is a fault: the safe words, nothing kept, the detail only in the log', async () => {
    const { recording, answer } = await placeThrough(cashBooking, undefined, (steps) => whileFailing(db, { table: 'booking_guests', event: 'INSERT', when: 'true' }, steps))
    expect(answer.status).toBe(500)
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong and the action may not have finished. Check before trying again.' } })
    expect(JSON.stringify(answer.body)).not.toContain('connection lost')
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })
})

describe('B11: a database error anywhere in the order leaves nothing behind', () => {
  const writes: Array<[string, WriteFailure]> = [
    ['the session place', { table: 'sessions', event: 'UPDATE', when: 'true' }],
    ['the pass session', { table: 'customer_session_passes', event: 'UPDATE', when: 'true' }],
    ['the booking', { table: 'bookings', event: 'INSERT', when: 'true' }],
    ['a seat', { table: 'booking_guests', event: 'INSERT', when: "NEW.guest_type = 'additional_guest'" }],
    ['an add-on credit', { table: 'customer_memberships', event: 'UPDATE', when: 'true' }],
    ['the order', { table: 'orders', event: 'INSERT', when: 'true' }],
    ['the last order line', { table: 'order_line_items', event: 'INSERT', when: "NEW.item_type = 'addon'" }],
    ['a booking add-on', { table: 'addon_order_lines', event: 'INSERT', when: 'true' }],
    ['the audit rows', { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'order.paid'" }],
  ]

  it.each(writes)('%s fails', async (_, failure) => {
    const basket = failure.table === 'customer_session_passes' ? passBooking : memberBooking
    const { recording, answer } = await placeThrough(basket, undefined, (steps) => whileFailing(db, failure, steps))
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  // W07: each write the worst basket makes. A failed gift card write answers INTERNAL with the safe
  // words, where createOrder answered gift_card_creation_failed with the database's own (W03-plan 2.9).
  const w07Writes: Array<[string, WriteFailure]> = [
    ['the gift card', { table: 'gift_cards', event: 'INSERT', when: 'true' }],
    ['the order', { table: 'orders', event: 'INSERT', when: 'true' }],
    ['the pass line', { table: 'order_line_items', event: 'INSERT', when: "NEW.item_type = 'session_pass'" }],
    ['a product line', { table: 'order_line_items', event: 'INSERT', when: "NEW.item_type = 'product' AND NEW.product_variant_id = '" + ID.mugVariant + "'" }],
    ['the gift card line', { table: 'order_line_items', event: 'INSERT', when: "NEW.item_type = 'gift_card'" }],
    ['the postage line', { table: 'order_line_items', event: 'INSERT', when: "NEW.item_type = 'postage'" }],
    ['a stock claim', { table: 'product_variants', event: 'UPDATE', when: "NEW.id = '" + ID.mugVariant + "'" }],
    ['a stock ledger row', { table: 'stock_adjustments', event: 'INSERT', when: "NEW.variant_id = '" + ID.mugVariant + "'" }],
    ['the pass bought', { table: 'customer_session_passes', event: 'INSERT', when: 'true' }],
    ['the address saved to the customer', { table: 'customers', event: 'UPDATE', when: 'true' }],
    ['the booking claiming a session from the pass bought', { table: 'customer_session_passes', event: 'UPDATE', when: 'true' }],
    ['the booking line', { table: 'order_line_items', event: 'INSERT', when: "NEW.item_type = 'booking'" }],
    ['a seat', { table: 'booking_guests', event: 'INSERT', when: "NEW.guest_type = 'additional_guest'" }],
  ]

  it.each(w07Writes)('W07, the worst basket: %s fails', async (_, failure) => {
    const { recording, answer } = await placeThrough(worstBasket, undefined, (steps) => whileFailing(db, failure, steps))
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong and the action may not have finished. Check before trying again.' } })
    expect(JSON.stringify(answer.body)).not.toContain('connection lost')
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('the old createOrder, failing as it marks the order paid, keeps the booking and a pending order', async () => {
    const markPaid: WriteFailure = { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }
    const recording = await replay(environment, orderScenario(cashBooking, undefined, (steps) => whileFailing(db, markPaid, steps)), oldSide)
    expect(recording.results[0]).toMatchObject({ success: true, warning: expect.stringContaining('marking the order as paid failed') })
    expect(recording.tables['orders']?.added).toMatchObject([{ payment_status: 'pending' }])
    expect(recording.tables['bookings']?.added).toHaveLength(1)
    expect(recording.tables['sessions']?.changed).toMatchObject([{ total_booked: [0, 2] }])
  })
})

describe('for the Worker step: the old createBooking when the credit has gone at the claim', () => {
  // createBooking.ts:445-451. The guarded insert finds no credit (here a trigger skips it, as a
  // credit spent a moment earlier would), so the seat is written as paid instead, and on the saved
  // card the customer is charged for it: there is no confirmed figure for a card until W10. The
  // Worker refuses instead (writeBooking, "a credit period with nothing left").
  it('charges the card for the seat, and staff are told the order went through', async () => {
    const onCredit = { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: { method: 'card' } }
    const skipped: WriteFailure = { table: 'bookings', event: 'INSERT', when: 'NEW.credit_period_id IS NOT NULL' }
    const recording = await replay(environment, orderScenario(onCredit, undefined, (steps) => whileSkipping(db, skipped, steps)), oldSide)
    expect(recording.results[0]).toMatchObject({ success: true, cardCharged: true, cardAmount: 20 })
    expect(recording.stripeCalls.map((call) => [call.method, (call.params as { amount?: number }).amount])).toEqual([['paymentIntents.create', 2000]])
    expect(recording.tables['bookings']?.added).toMatchObject([{ redemption_source: 'paid', price_paid: '20.00', credit_period_id: null }])
  })
})

describe('before anything is touched', () => {
  /** A client that counts what it sends, BEGIN and COMMIT included. */
  function countingDb(): { db: Db; statements: string[] } {
    const statements: string[] = []
    const real = createPostgresDriver(environment.database.url)
    const counted = (session: DriverSession): DriverSession => ({
      run(sql, params) {
        statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '))
        return session.run(sql, params)
      },
    })
    const driver: DbDriver = {
      ...counted(real),
      async reserve() {
        const reserved = await real.reserve()
        return {
          ...counted(reserved),
          runScript(sql) {
            statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '))
            return reserved.runScript(sql)
          },
          release: () => reserved.release(),
        }
      },
      close: () => real.close(),
    }
    return { db: createDb(driver), statements }
  }

  async function counting<T>(work: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
    const { db: countedDb, statements } = countingDb()
    holder.db = countedDb
    try {
      return { result: await work(), statements }
    } finally {
      holder.db = db
      await countedDb.close()
    }
  }

  async function freshSeed(): Promise<void> {
    await replay(environment, { name: 'seed only', seed, run: async () => {} }, oldSide)
  }

  it('NOT_BUILT: only the staff member is looked up and the answer kept against the key', async () => {
    await freshSeed()
    // W10 built the saved card, so the reader is what isn't built here.
    const { result, statements } = await counting(() => postOrder(orderInput({ customerId: ID.customer, booking: paidSeat(), promoCode: 'ALLTEN', payment: { method: 'reader' } })))
    expect(result.status).toBe(501)
    expect(statements).toEqual(['SELECT id,', 'INSERT INTO', 'UPDATE api_idempotency'])
  })

  it('an empty basket, a missing customer and the removed gift card source: the same', async () => {
    await freshSeed()
    for (const params of [{ customerId: ID.customer, payment: {} }, { booking: paidSeat(), payment: {} }, { customerId: ID.customer, booking: { ...paidSeat(), redemptionSource: 'gift_card' }, payment: {} }]) {
      const { result, statements } = await counting(() => postOrder(orderInput(params)))
      expect(result.body.ok).toBe(false)
      expect(statements).toHaveLength(3)
    }
  })

  it('the gift card source is refused with the old words', async () => {
    await freshSeed()
    const answer = await postOrder(orderInput({ customerId: ID.customer, booking: { ...paidSeat(), redemptionSource: 'gift_card' }, payment: {} }))
    expect(answer.body).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'Gift Card is no longer a booking option. Choose Paid and apply the gift card at payment.',
        details: { stage: 'validation', reason: 'gift_card_source_removed' },
      },
    })
  })

  describe('round trips (about 20 ms each through Hyperdrive)', () => {
    // BEGIN with the transaction's time limits (one round trip, W06 N2), the locks, the facts, the
    // booking, the order, the audit rows, COMMIT.
    const T1 = ['BEGIN; SELECT', 'SELECT s.id', 'WITH london', 'WITH clock', 'WITH clock', 'WITH clock', 'COMMIT']
    const ROUTE = ['SELECT id,', 'INSERT INTO', ...T1, 'UPDATE api_idempotency']

    it('a typical basket: a cash booking with a guest and an add-on', async () => {
      await freshSeed()
      const { result, statements } = await counting(() => postOrder(orderInput(cashBooking)))
      expect(result.body.ok).toBe(true)
      expect(statements).toEqual(ROUTE)
      expect(statements).toHaveLength(10)
    })

    it('the worst basket in scope: a credit seat, a guest, two add-on credits and a standalone add-on, the same', async () => {
      await freshSeed()
      const { result, statements } = await counting(() => postOrder(orderInput(memberBooking)))
      expect(result.body.ok).toBe(true)
      expect(statements).toEqual(ROUTE)
    })

    it('add-ons alone skip the booking statement', async () => {
      await freshSeed()
      const { result, statements } = await counting(() => postOrder(orderInput({ customerId: ID.customer, standaloneAddons: [towel], payment: cash(5) })))
      expect(result.body.ok).toBe(true)
      expect(statements).toHaveLength(ROUTE.length - 1)
    })

    it('a refusal stops after the facts', async () => {
      await freshSeed()
      const { result, statements } = await counting(() => postOrder(orderInput({ ...cashBooking, payment: cash(40) })))
      expect(refusalOf(result)).toMatchObject({ reason: 'cash_amount_changed' })
      expect(statements).toEqual(['SELECT id,', 'INSERT INTO', 'BEGIN; SELECT', 'SELECT s.id', 'WITH london', 'ROLLBACK', 'UPDATE api_idempotency'])
    })

    it('the dry run: no key, a read back, a rollback', async () => {
      await freshSeed()
      const { result, statements } = await counting(() => dryRun(orderInput(memberBooking)))
      expect(result.status).toBe(200)
      expect(statements).toEqual(['SELECT id,', ...T1.slice(0, -1), 'WITH o', 'ROLLBACK'])
    })

    // W07: the gift card, the stock, the ledger, the pass, the postage and the saved address are all
    // in the order's statement, so a basket of any of them costs no more than W06's.
    const NO_BOOKING = ROUTE.filter((_, i) => i !== ROUTE.indexOf('WITH clock'))
    it.each([
      ['a pickup product', productsInCash, NO_BOOKING],
      ['a pass on its own', passAlone, NO_BOOKING],
      ['a gift card', giftCardInCash, NO_BOOKING],
      ['a shipped product with postage and the address saved', { customerId: ID.customer, products: [candle], ...savedAddress, payment: cash(24.95) }, NO_BOOKING],
      ['a booking on a pass bought in the same basket', buyNewPass, ROUTE],
      ['the worst basket: a booking on a pass bought, two shipped products, a shipped gift card and postage', worstBasket, ROUTE],
    ])('W07, %s', async (_, params, expected) => {
      await freshSeed()
      const { result, statements } = await counting(() => postOrder(orderInput(params)))
      expect(result.body.ok).toBe(true)
      expect(statements).toEqual(expected)
    })

    // W08: the event's places, its booking, its attendees and its line are in the order's statement
    // too, so an event costs nothing more, whatever else the basket holds.
    it.each([
      ['an event for one', eventAlone, NO_BOOKING],
      ['an event with a guest', eventWithAGuest, NO_BOOKING],
      ['an event beside a booking and a product', eventBesideOthers, ROUTE],
      ['the worst basket: an event for three, a booking for two with an add-on, a shipped product, a shipped gift card and postage', eventWorstBasket, ROUTE],
    ])('W08, %s', async (_, params, expected) => {
      await freshSeed()
      const { result, statements } = await counting(() => postOrder(orderInput(params)))
      expect(result.body.ok).toBe(true)
      expect(statements).toEqual(expected)
    })

    it('W08, a sold-out event stops after the facts, as any refusal', async () => {
      await freshSeed()
      await db.query('UPDATE events SET places_booked = capacity WHERE id = $1', [ID.event])
      const { result, statements } = await counting(() => postOrder(orderInput(eventAlone)))
      expect(refusalOf(result)).toMatchObject({ code: 'EVENT_SOLD_OUT', reason: 'event_full' })
      expect(statements).toEqual(['SELECT id,', 'INSERT INTO', 'BEGIN; SELECT', 'SELECT s.id', 'WITH london', 'ROLLBACK', 'UPDATE api_idempotency'])
    })

    // W09: the promo's use, the store credit and the gift card are in the order's statement, and their
    // locks in the lock statement, so none of them costs a round trip.
    it.each([
      ['a booking with a promo code', promoBooking, ROUTE],
      ['store credit only', storeCreditOnly, NO_BOOKING],
      ['a gift card only', giftCardOnly, NO_BOOKING],
      ['the worst basket: W08\'s with a promo code, a gift card, store credit and cash', w09WorstBasket, ROUTE],
    ])('W09, %s', async (_, params, expected) => {
      await freshSeed()
      const { result, statements } = await counting(() => postOrder(orderInput(params)))
      expect(result.body.ok).toBe(true)
      expect(statements).toEqual(expected)
    })

    it('W09, an inactive promo code stops after the facts, as any refusal', async () => {
      await freshSeed()
      await db.query('UPDATE promo_codes SET active = false WHERE id = $1', [ID.promoPercent])
      const { result, statements } = await counting(() => postOrder(orderInput(promoBooking)))
      expect(refusalOf(result)).toMatchObject({ code: 'VALIDATION', reason: 'promo_code_invalid' })
      expect(statements).toEqual(['SELECT id,', 'INSERT INTO', 'BEGIN; SELECT', 'SELECT s.id', 'WITH london', 'ROLLBACK', 'UPDATE api_idempotency'])
    })
  })
})

async function dryRun(input: unknown, email = REPLAY_USER.email) {
  const response = await dryRunRoute(
    new Request('https://worker.test/api/v1/staff/orders/dry-run', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.STAFF_API_KEY}`, 'x-staff-email': email, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  )
  return { status: response.status, body: (await response.json()) as { ok: boolean; data?: OrderDryRunOutput; error?: { code: string; details?: unknown } } }
}

describe('the dry run', () => {
  const dryScenario = (params: Record<string, unknown>, answers: Array<Awaited<ReturnType<typeof dryRun>>>): Scenario => ({
    name: 'dry run',
    seed,
    async run() {
      answers.push(await dryRun(orderInput(params)))
    },
  })

  it('keeps nothing at all, not even a key', async () => {
    const answers: Array<Awaited<ReturnType<typeof dryRun>>> = []
    const recording = await replay(environment, dryScenario(memberBooking, answers), oldSide)
    expect(answers[0]?.status).toBe(200)
    expect(orderDryRunOutputSchema.safeParse(answers[0]?.body.data).success).toBe(true)
    expect(recording.tables).toEqual({})
  })

  it('reads back exactly what the real order then writes', async () => {
    const answers: Array<Awaited<ReturnType<typeof dryRun>>> = []
    let written: unknown = null
    await replay(
      environment,
      {
        name: 'dry run then order',
        seed,
        async run() {
          answers.push(await dryRun(orderInput(memberBooking)))
          const placed = await postOrder(orderInput(memberBooking))
          if (placed.body.ok) written = await readOrderRows(db, placed.body.data.orderId)
        },
      },
      oldSide
    )
    expect(written).not.toBeNull()
    expect(answers[0]?.body.data?.rows).toEqual(written)
  })

  it('answers a refusal exactly as the order route does', async () => {
    const params = { ...cashBooking, payment: cash(40) }
    const answers: Array<Awaited<ReturnType<typeof dryRun>>> = []
    await replay(environment, dryScenario(params, answers), oldSide)
    const { answer } = await placeThrough(params)
    expect(answers[0]?.status).toBe(answer.status)
    expect(answers[0]?.body.error).toEqual(answer.body.ok ? null : answer.body.error)
  })

  it('answers NOT_BUILT before it opens a transaction', async () => {
    const answers: Array<Awaited<ReturnType<typeof dryRun>>> = []
    const recording = await replay(environment, dryScenario({ customerId: ID.customer, booking: paidSeat(), payment: { method: 'reader' } }, answers), oldSide)
    expect(answers[0]).toMatchObject({ status: 501, body: { error: { code: 'NOT_BUILT', details: { notBuilt: ['reader'] } } } })
    expect(recording.tables).toEqual({})
  })
})

describe('request idempotency', () => {
  it('the same key twice runs once and answers the same', async () => {
    const key = crypto.randomUUID()
    const answers: OrderAnswer[] = []
    const recording = await replay(
      environment,
      {
        name: 'twice',
        seed,
        async run() {
          answers.push(await postOrder(orderInput(cashBooking), { key }))
          answers.push(await postOrder(orderInput(cashBooking), { key }))
        },
      },
      oldSide
    )
    expect(answers[1]?.body).toEqual(answers[0]?.body)
    expect(recording.tables['orders']?.added).toHaveLength(1)
    expect(recording.tables['bookings']?.added).toHaveLength(1)
  })

  it('a refusal is kept too, and the same key with a different basket is refused', async () => {
    const key = crypto.randomUUID()
    const answers: OrderAnswer[] = []
    await replay(
      environment,
      {
        name: 'refused twice',
        seed,
        async run() {
          answers.push(await postOrder(orderInput({ ...cashBooking, payment: cash(40) }), { key }))
          answers.push(await postOrder(orderInput({ ...cashBooking, payment: cash(40) }), { key }))
          answers.push(await postOrder(orderInput(cashBooking), { key }))
        },
      },
      oldSide
    )
    expect(answers[1]?.body).toEqual(answers[0]?.body)
    expect(answers[2]?.body).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_MISMATCH' } })
  })
})

describe('the audit rows', () => {
  it('record who, what was confirmed and the override reasons, and that it was paid', async () => {
    const params = { ...cashBooking, standaloneAddons: [{ ...towel, unitPrice: 3, priceOverrideReason: 'Regular' }], payment: cash(48) }
    const { recording, answer } = await placeThrough(params)
    expect(answer.body.ok).toBe(true)
    const rows = recording.tables['audit_log']?.added
    expect(rows).toMatchObject([
      {
        actor_type: 'staff',
        actor_id: ID.staff,
        action: 'order.create',
        entity_type: 'order',
        entity_id: 'orders#1',
        details: {
          method: 'cash',
          bookingId: 'bookings#1',
          orderTotal: 48,
          amountDue: 48,
          toCollect: 48,
          confirmed: { toCollect: 48 },
          overrides: [{ line: 'addon:0', unitPrice: 3, systemUnitPrice: 5, reason: 'Regular' }],
        },
      },
      { action: 'order.paid', details: { method: 'cash', collected: 48 } },
    ])
  })

  it('W08: name the event booking', async () => {
    const { recording } = await placeThrough(eventWithAGuest)
    expect(recording.tables['audit_log']?.added[0]).toMatchObject({ action: 'order.create', details: { eventBookingId: 'event_bookings#1', bookingId: null, orderTotal: 80 } })
  })
})

describe('B5: special requests are kept on every booking T1 writes', () => {
  const requests = async (specialRequests: unknown) => {
    const { recording } = await placeThrough({ customerId: ID.customer, booking: { ...paidSeat(), specialRequests }, payment: cash(20) })
    return recording.tables['bookings']?.added[0]?.['special_requests']
  }

  it('trimmed, at most 500 characters, and nothing when empty', async () => {
    expect(await requests('  Step-free access  ')).toBe('Step-free access')
    expect(await requests(`${'a'.repeat(499)}bc`)).toBe(`${'a'.repeat(499)}b`)
    expect(await requests('   ')).toBeNull()
    expect(await requests(null)).toBeNull()
  })
})

describe('the Herd gate names its waiting period, as the screen did', () => {
  const notHerd = {
    customerId: ID.member,
    booking: { ...paidSeat([mo]), ...memberCredit, addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] },
    payment: {},
  }
  const prepare = (settings: boolean) => async (target: Db) => {
    await target.query('UPDATE customer_memberships SET is_herd = false WHERE id = $1', [ID.membership])
    if (settings) await insert(target, 'membership_settings', { addon_credit_wait_months: 1 }).catch(async () => {
      await target.query('UPDATE membership_settings SET addon_credit_wait_months = 1')
    })
  }

  it('with the setting', async () => {
    const { answer } = await placeThrough(notHerd, prepare(true))
    expect(answer.body).toMatchObject({ ok: false, error: { message: herdWaitMessage(1), details: { reason: 'addon_membership_too_new' } } })
    expect(herdWaitMessage(1)).toContain('monthly members after 1 month,')
  })

  it('without it, the map\'s words', async () => {
    await db.query('DELETE FROM membership_settings')
    const { answer } = await placeThrough(notHerd, prepare(false))
    expect(answer.body).toMatchObject({ ok: false, error: { message: 'That membership is not a Herd member yet, so its add-on credits cannot be used.' } })
  })
})

describe('the answer', () => {
  it('matches its contract, and comes back to createOrder\'s shape whole', async () => {
    const { answer } = await placeThrough(cashBooking)
    expect(answer.body.ok).toBe(true)
    if (!answer.body.ok) return
    expect(placeOrderOutputSchema.safeParse(answer.body.data).success).toBe(true)
    expect(answer.body.data).toMatchObject({ status: 'paid', payment: { method: 'cash', collected: 45, cardCharged: false } })
    expect(oldResult(answer.body)).toEqual({
      success: true,
      orderId: answer.body.data.orderId,
      bookingId: answer.body.data.bookingId,
      cardCharged: false,
      cardAmount: 45,
      paymentMethodUsed: 'cash',
    })
  })

  it('refuses inactive staff and an unknown email before anything else', async () => {
    await db.query("INSERT INTO staff (role, first_name, last_name, email, active) VALUES ('staff', 'Ex', 'Staff', 'ex@example.com', false) ON CONFLICT DO NOTHING")
    expect((await postOrder(orderInput(cashBooking), { email: 'ex@example.com' })).status).toBe(403)
    expect((await postOrder(orderInput(cashBooking), { email: 'nobody@example.com' })).status).toBe(401)
  })

  it.each([
    ['insufficient_capacity', 'SESSION_FULL'],
    ['duplicate_day_booking', 'DAY_ALREADY_BOOKED'],
    ['cash_amount_changed', 'TOTAL_CHANGED'],
    ['guests_over_18_not_confirmed', 'AGE_CONFIRMATION_REQUIRED'],
    ['session_not_found', 'NOT_FOUND'],
    ['addon_membership_not_found', 'NOT_FOUND'],
    ['insufficient_stock', 'OUT_OF_STOCK'],
    ['event_full', 'EVENT_SOLD_OUT'],
    ['event_members_only', 'EVENT_NOT_OPEN'],
    ['time_conflict', 'VALIDATION'],
    ['band_unpriced', 'VALIDATION'],
  ])('%s answers %s', (reason, code) => {
    expect(refusalCode(reason)).toBe(code)
  })
})

describe('writeBooking refuses on its own, without the checks T1 runs first', () => {
  const seat = (payBy: 'paid' | 'membership_credit' | 'session_pass_credit' = 'paid'): SeatToWrite => ({
    guestType: 'account_holder',
    name: 'Sam Test',
    email: 'sam@example.com',
    dateOfBirth: '1990-01-01',
    unitPrice: '20.00',
    discount: 0,
    payBy,
  })
  const paid: BookingToWrite = {
    sessionId: ID.session,
    customerId: ID.customer,
    bookingType: 'public',
    pricePaid: 20,
    redemptionSource: 'paid',
    redeemedMembershipId: null,
    redeemedSessionPassId: null,
    creditPeriodId: null,
    passToClaim: null,
    bandId: ID.band,
    specialRequests: null,
    seats: [seat()],
  }

  /** writeBooking alone in a transaction on a fresh seed: its refusal, and what was kept. */
  async function write(booking: BookingToWrite, prepare?: (db: Db) => Promise<void>) {
    let refusal: unknown = null
    let bookingId: string | null = null
    const recording = await replay(
      environment,
      {
        name: 'writeBooking',
        async seed(seedDb, stripe) {
          await seed(seedDb, stripe)
          await prepare?.(seedDb)
        },
        async run() {
          try {
            bookingId = await db.transaction((tx) => writeBooking(tx, booking))
          } catch (err) {
            refusal = refusalDetails(err)
            if (!refusal) throw err
          }
        },
      },
      oldSide
    )
    return { refusal, bookingId, recording }
  }

  it('a full session', async () => {
    const { refusal, recording } = await write(paid, async (target) => {
      await target.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session])
    })
    expect(refusal).toMatchObject({ reason: 'insufficient_capacity', bookingFailureReason: 'insufficient_capacity' })
    expect(recording.tables).toEqual({})
  })

  it('a private session someone has taken: the first booking claims all of it', async () => {
    const privately: BookingToWrite = { ...paid, sessionId: ID.privateSession, bookingType: 'private', pricePaid: 100, seats: [{ ...seat(), unitPrice: null }] }
    const { refusal, recording } = await write(privately, async (target) => {
      await target.query('UPDATE sessions SET total_booked = 1 WHERE id = $1', [ID.privateSession])
    })
    expect(refusal).toMatchObject({ reason: 'insufficient_capacity' })
    expect(recording.tables).toEqual({})
    const taken = await write(privately)
    expect(taken.recording.tables['sessions']?.changed).toMatchObject([{ total_booked: [0, 10] }])
  })

  it('a pass with no sessions left: the place it took comes back', async () => {
    const onPass: BookingToWrite = { ...paid, redemptionSource: 'session_pass_credit', redeemedSessionPassId: ID.ownedPass, passToClaim: ID.ownedPass, pricePaid: 0, seats: [seat('session_pass_credit')] }
    const { refusal, recording } = await write(onPass, async (target) => {
      await target.query('UPDATE customer_session_passes SET sessions_remaining = 0 WHERE id = $1', [ID.ownedPass])
    })
    expect(refusal).toMatchObject({ reason: 'insufficient_session_pass_credit' })
    expect(recording.tables).toEqual({})
  })

  it('a Core pass on a Peak session, with the words for it', async () => {
    const onCorePass: BookingToWrite = {
      ...paid,
      sessionId: ID.peakSession,
      bandId: ID.peakBand,
      redemptionSource: 'session_pass_credit',
      redeemedSessionPassId: ID.ownedCorePass,
      passToClaim: ID.ownedCorePass,
      pricePaid: 0,
      seats: [seat('session_pass_credit')],
    }
    const { refusal, recording } = await write(onCorePass, seedCorePass)
    expect(refusal).toMatchObject({
      reason: 'session_pass_not_valid_for_band',
      message: "This is a Core pass, which can't be used for Peak sessions. Choose another way to pay.",
    })
    expect(recording.tables).toEqual({})
    const unbanded = await write({ ...onCorePass, bandId: null }, seedCorePass)
    expect(unbanded.refusal).toMatchObject({ message: "This session has no time band set, so a pass can't be used. Set the session's band or choose another way to pay." })
  })

  it('a credit period with nothing left: refused, not written as paid', async () => {
    const onCredit: BookingToWrite = {
      ...paid,
      customerId: ID.member,
      redemptionSource: 'membership_credit',
      redeemedMembershipId: ID.membership,
      creditPeriodId: ID.creditPeriod,
      pricePaid: 0,
      seats: [{ ...seat('membership_credit'), name: 'Mo Member' }],
    }
    const { refusal, recording } = await write(onCredit, async (target) => {
      await target.query('UPDATE membership_credit_periods SET credits_allocated = 0 WHERE id = $1', [ID.creditPeriod])
    })
    expect(refusal).toMatchObject({ reason: 'insufficient_membership_credit' })
    expect(recording.tables).toEqual({})
    const spent = await write(onCredit)
    expect(spent.recording.tables['bookings']?.added).toMatchObject([{ credit_period_id: ID.creditPeriod, redemption_source: 'membership_credit' }])
  })

  it('writes the booking and its seats in seat order when the claims hold', async () => {
    const three: BookingToWrite = {
      ...paid,
      pricePaid: 60,
      seats: [seat(), { ...seat(), guestType: 'additional_guest', name: 'Alex Guest', dateOfBirth: null }, { ...seat(), guestType: 'additional_guest', name: 'Bea Guest', email: null, dateOfBirth: null }],
    }
    const { bookingId, recording } = await write(three)
    expect(bookingId).toEqual(expect.any(String))
    expect(recording.tables['booking_guests']?.tied).toBe(0)
    expect(recording.tables['booking_guests']?.added.map((row) => [row['guest_name'], row['guest_email'], row['date_of_birth']])).toEqual([
      ['Sam Test', 'sam@example.com', '1990-01-01'],
      ['Alex Guest', 'sam@example.com', null],
      ['Bea Guest', null, null],
    ])
    expect(recording.tables['bookings']?.added).toMatchObject([{ party_size: 3, price_paid: '60.00', guests_over_18_confirmed_at: '<set>' }])
  })
})

// --- W07: products, postage, passes and gift cards bought

/** placeOrder or dryRunOrder straight, on a fresh seed, with a code maker of the test's choosing. */
async function directly(params: Record<string, unknown>, codes: () => string, { dry = false, prepare }: { dry?: boolean; prepare?: (db: Db) => Promise<void> } = {}) {
  const outcome: { value?: unknown; error?: unknown } = {}
  const recording = await replay(
    environment,
    {
      name: 'directly',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await prepare?.(seedDb)
      },
      async run() {
        const options = { actor: { type: 'staff' as const, id: ID.staff }, requestId: 'w07-test', allowPriceOverrides: true, giftCardCode: codes }
        try {
          outcome.value = await (dry ? dryRunOrder : placeOrder)(db, orderInput(params), options)
        } catch (err) {
          outcome.error = err
        }
      },
    },
    oldSide
  )
  return { recording, ...outcome }
}

/** A code maker that gives `codes` in turn, then fresh ones, and counts how often it was asked. */
function codesInTurn(...codes: string[]) {
  let asked = 0
  const next = () => {
    asked += 1
    return codes[asked - 1] ?? `PWC-${String(asked).padStart(8, 'A').replace(/[01]/g, 'B')}`
  }
  return { next, asked: () => asked }
}

describe('gift card codes (W03-plan 2.4 item 3)', () => {
  // The seed has a gift card whose code is SEEDCARD. Shipped, so postage (free: Q4) and the saved address are in it too.
  const bought = {
    ...giftCardInCash,
    giftCard: { ...giftCardInCash.giftCard, fulfillmentMethod: 'shipping' },
    products: [soap],
    sessionPassTypeId: ID.passType,
    ...savedAddress,
    payment: cash(134),
  }
  // W08a (W08 review S1): the collision tests carry an event for two (£80), so they prove the places claim
  // waits on the gift card's go and the event booking is written only from the claimed row.
  const boughtWithAnEvent = { ...bought, event: eventPlaces([samAttending, { ...alex, isAccountHolder: false }]), payment: cash(214) }

  it('a new code has the app\'s format, and is the one written', async () => {
    const { recording, answer } = await placeThrough(giftCardInCash)
    expect(answer.body.ok).toBe(true)
    const code = answer.body.ok ? answer.body.data.giftCardCode : null
    expect(code).toMatch(GIFT_CARD_CODE_FORMAT)
    expect(recording.tables['gift_cards']?.added).toMatchObject([{ code: '<code#1>', original_value: '60.00', remaining_balance: '60.00', recipient_name: 'Ali Friend', origin: 'customer_purchase', expiry_date: '2027-11-10' }])
  })

  it('a code already taken is skipped and another drawn, in the same transaction: every row written once', async () => {
    const codes = codesInTurn('SEEDCARD', 'PWC-ABCDEFGH')
    const { recording, value, error } = await directly(boughtWithAnEvent, codes.next)
    expect(error).toBeUndefined()
    expect(codes.asked()).toBe(2)
    expect(value).toMatchObject({ giftCardCode: 'PWC-ABCDEFGH' })
    expect(recording.tables['gift_cards']?.added).toHaveLength(1)
    expect(recording.tables['orders']?.added).toHaveLength(1)
    expect(recording.tables['order_line_items']?.added.map((line) => line['item_type'])).toEqual(['event', 'product', 'session_pass', 'gift_card', 'postage'])
    // The places are claimed once (not again on the retry) and the booking comes only from that claim.
    expect(recording.tables['events']?.changed).toEqual([{ id: ID.event, places_booked: [0, 2] }])
    expect(recording.tables['event_bookings']?.added).toHaveLength(1)
    expect(recording.tables['event_attendees']?.added).toHaveLength(2)
    expect(recording.tables['product_variants']?.changed).toEqual([{ id: ID.variant, stock_quantity: [5, 3] }])
    expect(recording.tables['stock_adjustments']?.added).toHaveLength(1)
    expect(recording.tables['customer_session_passes']?.added).toHaveLength(1)
    expect(recording.tables['customers']?.changed).toHaveLength(1)
  })

  it(`${GIFT_CARD_CODE_TRIES} codes taken in a row: createOrder's gift_card_code_exhausted and words, after exactly ${GIFT_CARD_CODE_TRIES} tries, nothing kept`, async () => {
    const codes = codesInTurn(...Array.from({ length: 10 }, () => 'SEEDCARD'))
    const { recording, error } = await directly(bought, codes.next)
    expect(codes.asked()).toBe(5)
    expect(refusalDetails(error)).toEqual({ stage: 'gift_card', reason: 'gift_card_code_exhausted' })
    expect((error as Error).message).toBe('Failed to generate a unique gift card code — please try again.')
    expect(recording.tables).toEqual({})
  })

  it('a collision inside the dry run: it reads back one gift card of the right format, and nothing is kept', async () => {
    const codes = codesInTurn('SEEDCARD', 'PWC-ABCDEFGH')
    const { recording, value, error } = await directly(boughtWithAnEvent, codes.next, { dry: true })
    expect(error).toBeUndefined()
    expect(codes.asked()).toBe(2)
    const rows = (value as { rows: { gift_cards: Array<{ code_format_ok: boolean }>; stock: unknown; event_booking: { event_places_booked: number } | null } }).rows
    expect(rows.gift_cards).toEqual([expect.objectContaining({ code_format_ok: true, original_value: 60 })])
    expect(rows.stock).toEqual([{ variant_id: ID.variant, stock_quantity: 3 }])
    // Claimed once inside the dry run: the event reads back two places booked, not four.
    expect(rows.event_booking?.event_places_booked).toBe(2)
    expect(recording.tables).toEqual({})
  })
})

describe('B3 (pass half): a pass line is never kept without its pass, nor a pass without its line', () => {
  it('the pass row is skipped: the order fails whole, and its pass line goes with it', async () => {
    const skipped: WriteFailure = { table: 'customer_session_passes', event: 'INSERT', when: 'true' }
    const { recording, answer } = await placeThrough(passAlone, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('the pass line is skipped: no pass is issued, and the order fails whole', async () => {
    const skipped: WriteFailure = { table: 'order_line_items', event: 'INSERT', when: "NEW.item_type = 'session_pass'" }
    const { recording, answer } = await placeThrough(passAlone, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('a booking on a pass bought in the basket that cannot take its session: no pass, no line, no order', async () => {
    const skipped: WriteFailure = { table: 'customer_session_passes', event: 'UPDATE', when: 'true' }
    const { recording, answer } = await placeThrough(buyNewPass, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(refusalOf(answer)).toMatchObject({ reason: 'insufficient_session_pass_credit', bookingFailureReason: 'insufficient_session_pass_credit' })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('placed: the pass, its line and the booking that took a session from it, in one order', async () => {
    const { recording, answer } = await placeThrough(buyNewPass)
    expect(answer.body).toMatchObject({ ok: true, data: { sessionPassId: expect.any(String), bookingId: expect.any(String), giftCardId: null, giftCardCode: null } })
    expect(recording.tables['customer_session_passes']?.added).toMatchObject([{ order_line_item_id: 'order_line_items#1', sessions_remaining: 4, purchase_date: '2026-11-10', expiry_date: '2027-11-10' }])
    expect(recording.tables['order_line_items']?.added).toMatchObject([
      { item_type: 'session_pass', session_pass_type_id: ID.passType, unit_price: '50.00' },
      { item_type: 'booking', booking_id: 'bookings#1', unit_price: '0.00' },
    ])
    expect(recording.tables['bookings']?.added).toMatchObject([{ redemption_source: 'session_pass_credit', redeemed_session_pass_id: 'customer_session_passes#1', price_paid: '0.00' }])
  })
})

describe('the stock claim refuses on its own, without the checks T1 runs first', () => {
  /** A client whose basket facts show `stock` of every variant, whatever is really there. */
  function staleStockDb(stock: number): Db {
    const real = createPostgresDriver(environment.database.url)
    const stale = (session: DriverSession): DriverSession => ({
      async run<Row>(sql: string, params: Parameters<DriverSession['run']>[1]): Promise<Row[]> {
        const rows = await session.run<Row>(sql, params)
        if (!sql.trim().startsWith('WITH london')) return rows
        return rows.map((row) => {
          const facts = row as unknown as BasketFacts
          return { ...facts, variants: facts.variants?.map((v) => ({ ...v, stock_quantity: stock })) ?? null } as unknown as Row
        })
      },
    })
    const driver: DbDriver = {
      ...stale(real),
      async reserve() {
        const reserved = await real.reserve()
        return { ...stale(reserved), runScript: (sql) => reserved.runScript(sql), release: () => reserved.release() }
      },
      close: () => real.close(),
    }
    return createDb(driver)
  }

  it("facts that think there is enough: the claim's own guard refuses, with createOrder's reason, nothing kept", async () => {
    const staleDb = staleStockDb(100)
    holder.db = staleDb
    try {
      const { recording, answer } = await placeThrough({ ...productsInCash, products: [{ ...soap, quantity: 6 }], payment: cash(72) })
      expect(refusalOf(answer)).toEqual({ status: 409, code: 'OUT_OF_STOCK', stage: 'product', reason: 'insufficient_stock', productVariantId: ID.variant })
      expect(tablesTouched(recording)).toEqual(['api_idempotency'])
    } finally {
      holder.db = db
      await staleDb.close()
    }
  })

  it('a claim that finds the stock gone: createOrder\'s reason, its variant and OUT_OF_STOCK, nothing kept', async () => {
    const skipped: WriteFailure = { table: 'product_variants', event: 'UPDATE', when: 'true' }
    const { recording, answer } = await placeThrough(productsInCash, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(refusalOf(answer)).toEqual({ status: 409, code: 'OUT_OF_STOCK', stage: 'product', reason: 'insufficient_stock', productVariantId: ID.variant })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })
})

describe('B5 (address half): the delivery address is kept on every path T1 writes', () => {
  const kept = { name: 'Sam Test', line1: '1 Mill Lane', line2: null, city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' }
  it.each([
    ['a shipped product', { customerId: ID.customer, products: [candle], ...savedAddress, payment: cash(24.95) }],
    ['a shipped gift card', { customerId: ID.customer, giftCard: { giftCardTypeId: ID.giftCardType, amount: 30, fulfillmentMethod: 'shipping' }, ...savedAddress, payment: cash(34.95) }],
    ['a booking on a pass bought in the same basket (Q5)', { ...buyNewPass, products: [candle], ...savedAddress, payment: cash(74.95) }],
  ])('%s', async (_, params) => {
    const { recording, answer } = await placeThrough(params)
    expect(answer.body.ok).toBe(true)
    expect(recording.tables['orders']?.added[0]?.['shipping_address']).toEqual(kept)
    expect(recording.tables['customers']?.changed).toEqual([
      { id: ID.customer, address_line1: [null, '1 Mill Lane'], city: [null, 'Hebden Bridge'], postcode: [null, 'HX7 1AA'], country: ['GB', 'United Kingdom'] },
    ])
  })

  it('nothing shipped: no address on the order and none saved, whatever was sent', async () => {
    const { recording } = await placeThrough({ ...productsInCash, ...savedAddress })
    expect(recording.tables['orders']?.added[0]?.['shipping_address']).toBeNull()
    expect(recording.tables['customers']).toBeUndefined()
  })
})

describe('the dry run, for what W07 adds', () => {
  it('reads back exactly what the real order then writes, for the worst basket', async () => {
    let dry: unknown = null
    let written: unknown = null
    await replay(
      environment,
      {
        name: 'dry run then order, W07',
        seed,
        async run() {
          dry = (await dryRun(orderInput(worstBasket))).body.data?.rows
          const placed = await postOrder(orderInput(worstBasket))
          if (placed.body.ok) written = await readOrderRows(db, placed.body.data.orderId)
        },
      },
      oldSide
    )
    expect(written).not.toBeNull()
    expect(dry).toEqual(written)
    expect(written).toMatchObject({
      stock: [
        { variant_id: ID.candleVariant, stock_quantity: 4 },
        { variant_id: ID.mugVariant, stock_quantity: 4 },
      ],
      stock_adjustments: [
        { variant_id: ID.candleVariant, change_amount: -1, by_staff: false },
        { variant_id: ID.mugVariant, change_amount: -1, by_staff: false },
      ],
      session_passes: [{ sessions_remaining: 4, for_the_order_customer: true, pays_for_the_booking: true }],
      gift_cards: [{ code_format_ok: true, original_value: 10, fulfillment_method: 'shipping', bought_by_the_order_customer: true }],
      booking: { redeemed_session_pass_id: 'bought in this order', pass_sessions_remaining: 4 },
      customer_address: { line1: '1 Mill Lane', country: 'United Kingdom' },
    })
  })
})

describe('for the Worker step (W07): the old createOrder when a write after the stock claim fails', () => {
  // createOrder.ts claims the stock at stage 19 and writes the gift card at stage 22. A database error
  // there (here the gift card's INSERT) rolls back by hand, and rollbackAll swallows a failed step: if
  // the stock's own put-back fails too, the stock stays claimed with no order, no line and no ledger
  // row, and staff see the database's raw words. T1 is one transaction: nothing is kept.
  it('keeps the two soaps out of stock, with no order to show for them', async () => {
    const basket = { ...productsInCash, giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' }, payment: cash(84) }
    const putBackFails: WriteFailure = { table: 'product_variants', event: 'UPDATE', when: 'NEW.stock_quantity > OLD.stock_quantity' }
    const giftCardFails: WriteFailure = { table: 'gift_cards', event: 'INSERT', when: 'true' }
    const recording = await replay(
      environment,
      orderScenario(basket, undefined, (steps) => whileFailing(db, putBackFails, () => whileFailing(db, giftCardFails, steps))),
      oldSide
    )
    expect(recording.results[0]).toEqual({ success: false, stage: 'gift_card', reason: 'gift_card_creation_failed', message: 'connection lost' })
    expect(recording.tables['product_variants']?.changed).toEqual([{ id: ID.variant, stock_quantity: [5, 3] }])
    expect(Object.keys(recording.tables).sort()).toEqual(['product_variants'])

    const worker = await placeThrough(basket, undefined, (steps) => whileFailing(db, putBackFails, () => whileFailing(db, giftCardFails, steps)))
    expect(worker.answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(tablesTouched(worker.recording)).toEqual(['api_idempotency'])
  })
})

// --- W08: events

describe('B11 (W08): a database error writing any part of the event leaves nothing behind', () => {
  const writes: Array<[string, WriteFailure]> = [
    ['the places claimed', { table: 'events', event: 'UPDATE', when: 'true' }],
    ['the event booking', { table: 'event_bookings', event: 'INSERT', when: 'true' }],
    ['an attendee', { table: 'event_attendees', event: 'INSERT', when: "NEW.attendee_type = 'guest'" }],
    ['the event line', { table: 'order_line_items', event: 'INSERT', when: "NEW.item_type = 'event'" }],
  ]

  it.each(writes)('the worst basket: %s fails', async (_, failure) => {
    const { recording, answer } = await placeThrough(eventWorstBasket, undefined, (steps) => whileFailing(db, failure, steps))
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong and the action may not have finished. Check before trying again.' } })
    expect(JSON.stringify(answer.body)).not.toContain('connection lost')
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })
})

describe('the event claim refuses on its own, without the checks T1 runs first (W08)', () => {
  /** A client whose basket facts show the event as `change` makes it, whatever is really there. */
  function staleEventDb(change: (event: NonNullable<BasketFacts['event']>) => NonNullable<BasketFacts['event']>): Db {
    const real = createPostgresDriver(environment.database.url)
    const stale = (session: DriverSession): DriverSession => ({
      async run<Row>(sql: string, params: Parameters<DriverSession['run']>[1]): Promise<Row[]> {
        const rows = await session.run<Row>(sql, params)
        if (!sql.trim().startsWith('WITH london')) return rows
        return rows.map((row) => {
          const facts = row as unknown as BasketFacts
          return { ...facts, event: facts.event && change(facts.event) } as unknown as Row
        })
      },
    })
    const driver: DbDriver = {
      ...stale(real),
      async reserve() {
        const reserved = await real.reserve()
        return { ...stale(reserved), runScript: (sql) => reserved.runScript(sql), release: () => reserved.release() }
      },
      close: () => real.close(),
    }
    return createDb(driver)
  }

  async function placeWithStaleFacts(change: (event: NonNullable<BasketFacts['event']>) => NonNullable<BasketFacts['event']>, prepare: (target: Db) => Promise<void>) {
    const staleDb = staleEventDb(change)
    holder.db = staleDb
    try {
      return await placeThrough(eventBesideOthers, prepare)
    } finally {
      holder.db = db
      await staleDb.close()
    }
  }

  const eventFull = { status: 409, code: 'EVENT_SOLD_OUT', stage: 'event', reason: 'event_full', message: 'Not enough places are left on this event (or it has just gone off sale).' }
  const onSale = (event: NonNullable<BasketFacts['event']>) => ({ ...event, block_reason: null, active: true, cancelled: false, places_left: 10 })

  it("facts that think there is room: the claim's own guard refuses, with createOrder's reason and words, after the stock, nothing kept", async () => {
    const { recording, answer } = await placeWithStaleFacts(onSale, async (target) => {
      await target.query('UPDATE events SET places_booked = 9 WHERE id = $1', [ID.event])
    })
    expect(refusalOf(answer)).toEqual(eventFull)
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it("facts that think the event is on sale: the claim's guard refuses one that has gone off sale", async () => {
    const { recording, answer } = await placeWithStaleFacts(onSale, async (target) => {
      await target.query('UPDATE events SET active = false WHERE id = $1', [ID.event])
    })
    expect(refusalOf(answer)).toEqual(eventFull)
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it("facts that think the event is on: the claim's guard refuses one that has been cancelled, even one still marked on sale", async () => {
    // Live, a cancelled event is never on sale (events_on_sale_complete), so the active guard would
    // refuse it first; the check is lifted here so only the cancelled guard can.
    try {
      const { recording, answer } = await placeWithStaleFacts(onSale, async (target) => {
        await liftOnSaleCheck(target)
        await target.query("UPDATE events SET cancelled_at = '2026-11-09 12:00:00+00' WHERE id = $1", [ID.event])
      })
      expect(refusalOf(answer)).toEqual(eventFull)
      expect(tablesTouched(recording)).toEqual(['api_idempotency'])
    } finally {
      await restoreOnSaleCheck(db)
    }
  })

  it("a claim that finds the event gone: createOrder's reason, EVENT_SOLD_OUT, nothing kept", async () => {
    const skipped: WriteFailure = { table: 'events', event: 'UPDATE', when: 'true' }
    const { recording, answer } = await placeThrough(eventBesideOthers, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(refusalOf(answer)).toEqual(eventFull)
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it.each([
    ['the event booking', { table: 'event_bookings', event: 'INSERT', when: 'true' } as WriteFailure],
    ['an attendee', { table: 'event_attendees', event: 'INSERT', when: "NEW.attendee_type = 'guest'" } as WriteFailure],
  ])('%s written short: the order fails whole, with the safe words', async (_, skipped) => {
    const { recording, answer } = await placeThrough(eventBesideOthers, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('is the refusal the quote gives for a sold-out event, word for word', () => {
    expect(orderRefusal(eventFullRefusal()).message).toBe(eventFull.message)
  })
})

describe('what T1 writes for an event (W08)', () => {
  it('the dry run reads back exactly what the real order then writes, for the worst basket', async () => {
    let dry: unknown = null
    let written: unknown = null
    await replay(
      environment,
      {
        name: 'dry run then order, W08',
        seed,
        async run() {
          dry = (await dryRun(orderInput(eventWorstBasket))).body.data?.rows
          const placed = await postOrder(orderInput(eventWorstBasket))
          if (placed.body.ok) written = await readOrderRows(db, placed.body.data.orderId)
        },
      },
      oldSide
    )
    expect(written).not.toBeNull()
    expect(dry).toEqual(written)
    expect(written).toMatchObject({
      lines: [{ item_type: 'booking' }, { item_type: 'event', quantity: 3, unit_price: 40, line_total: 120 }, { item_type: 'product' }, { item_type: 'gift_card' }, { item_type: 'postage' }],
      event_booking: {
        event_id: ID.event,
        status: 'confirmed',
        places: 3,
        account_holder_attending: true,
        price_paid: 120,
        created_by_staff_id: ID.staff,
        guests_over_18_confirmed: true,
        for_the_order_customer: true,
        event_places_booked: 3,
        attendees: [
          { attendee_type: 'account_holder', name: 'Sam Test', email: 'sam@example.com', date_of_birth: '1990-01-01', unit_price: 40, price_level: 'public' },
          { attendee_type: 'guest', name: 'Alex Guest', email: 'alex@example.com', date_of_birth: null, unit_price: 40, price_level: 'public' },
          { attendee_type: 'guest', name: 'Bea Guest', email: 'bea@example.com', date_of_birth: null, unit_price: 40, price_level: 'public' },
        ],
      },
    })
  })

  it("the answer names the event booking, in its contract and in createOrder's shape", async () => {
    const { answer } = await placeThrough(eventWithAGuest)
    expect(answer.body.ok).toBe(true)
    if (!answer.body.ok) return
    expect(placeOrderOutputSchema.safeParse(answer.body.data).success).toBe(true)
    expect(answer.body.data).toMatchObject({ bookingId: null, eventBookingId: expect.any(String), payment: { method: 'cash', collected: 80, cardCharged: false } })
    expect(oldResult(answer.body)).toEqual({
      success: true,
      orderId: answer.body.data.orderId,
      eventBookingId: answer.body.data.eventBookingId,
      cardCharged: false,
      cardAmount: 80,
      paymentMethodUsed: 'cash',
    })
  })

  it('placed for a customer (the website, later), the booking names no member of staff', async () => {
    const recording = await replay(
      environment,
      {
        name: 'placed by the customer',
        seed,
        async run() {
          await placeOrder(db, orderInput(eventAlone), { actor: { type: 'customer', id: ID.customer }, requestId: 'customer-test' })
        },
      },
      oldSide
    )
    expect(recording.tables['event_bookings']?.added).toMatchObject([{ created_by_staff_id: null, customer_id: ID.customer, places: 1 }])
  })

  it('a membership bought beside an event is not built yet, before anything is written', async () => {
    const { recording, answer } = await placeThrough({ ...eventAlone, membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', payment: { method: 'card' } })
    // W10 built the saved card: the membership is what isn't built.
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'NOT_BUILT', details: { notBuilt: ['membership'] } } })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })
})

describe('for the Worker step (W08): the old createOrder when an attendee write fails after the places were claimed', () => {
  // createOrder.ts claims the places at stage 21 (eventOrders.ts writeEventBooking), then writes the
  // booking and one attendee per statement. A database error on an attendee rolls back by hand, and
  // rollbackAll swallows a failed step: if giving the places back fails too, the places stay claimed
  // with no booking, and staff see the database's raw words. T1 is one transaction: nothing is kept.
  it('keeps the two places claimed, with no booking to show for them', async () => {
    const releaseFails: WriteFailure = { table: 'events', event: 'UPDATE', when: 'NEW.places_booked < OLD.places_booked' }
    const attendeeFails: WriteFailure = { table: 'event_attendees', event: 'INSERT', when: "NEW.attendee_type = 'guest'" }
    const during = (steps: () => Promise<unknown>) => whileFailing(db, releaseFails, () => whileFailing(db, attendeeFails, steps))
    const recording = await replay(environment, orderScenario(eventWithAGuest, undefined, during), oldSide)
    expect(recording.results[0]).toEqual({ success: false, stage: 'validation', reason: 'unexpected_error', message: 'connection lost' })
    expect(recording.tables['events']?.changed).toEqual([{ id: ID.event, places_booked: [0, 2] }])
    expect(Object.keys(recording.tables).sort()).toEqual(['events'])

    const worker = await placeThrough(eventWithAGuest, undefined, during)
    expect(worker.answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(tablesTouched(worker.recording)).toEqual(['api_idempotency'])
  })
})

// --- W09: promo codes, store credit and gift cards used to pay

/** One input straight to the route (the confirmed figures as sent), on a fresh seed, with `prepare` run first. */
async function placeInput(input: unknown, prepare?: (db: Db) => Promise<void>) {
  const answers: OrderAnswer[] = []
  const recording = await replay(
    environment,
    {
      name: 'w09 input',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await prepare?.(seedDb)
      },
      async run() {
        answers.push(await postOrder(input))
      },
    },
    oldSide
  )
  return { recording, answer: answers[0] as OrderAnswer }
}

/** A client whose basket facts are changed by `change`, whatever is really there. */
function staleFactsDb(change: (facts: BasketFacts) => BasketFacts): Db {
  const real = createPostgresDriver(environment.database.url)
  const stale = (session: DriverSession): DriverSession => ({
    async run<Row>(sql: string, params: Parameters<DriverSession['run']>[1]): Promise<Row[]> {
      const rows = await session.run<Row>(sql, params)
      if (!sql.trim().startsWith('WITH london')) return rows
      return rows.map((row) => change(row as unknown as BasketFacts) as unknown as Row)
    },
  })
  const driver: DbDriver = {
    ...stale(real),
    async reserve() {
      const reserved = await real.reserve()
      return { ...stale(reserved), runScript: (sql) => reserved.runScript(sql), release: () => reserved.release() }
    },
    close: () => real.close(),
  }
  return createDb(driver)
}

async function placeWithStaleFacts(params: Record<string, unknown>, change: (facts: BasketFacts) => BasketFacts, prepare: (target: Db) => Promise<void>) {
  const staleDb = staleFactsDb(change)
  holder.db = staleDb
  try {
    return await placeThrough(params, prepare)
  } finally {
    holder.db = db
    await staleDb.close()
  }
}

describe('what orders.payment_method records (W03-decisions Q9)', () => {
  it.each([
    ['store credit only', undefined, 0, 0, 24, 'store_credit'],
    ['a gift card only', undefined, 0, 24, 0, 'gift_card'],
    ['a gift card and store credit', undefined, 0, 14, 10, 'split'],
    ['store credit and cash', 'cash', 15, 0, 5, 'cash'],
    ['a gift card and cash', 'cash', 15, 5, 0, 'split'],
    ['a gift card, store credit and cash', 'cash', 20, 10, 10, 'split'],
    ['cash alone', 'cash', 20, 0, 0, 'cash'],
    ['nothing owed', undefined, 0, 0, 0, null],
    ['cash chosen with nothing owed', 'cash', 0, 0, 0, null],
  ] as const)('%s: %s', (_, method, collected, giftCard, storeCredit, expected) => {
    expect(recordedPaymentMethod(method, collected, giftCard, storeCredit)).toBe(expected)
  })

  it('through the route, on the order and in the answer', async () => {
    for (const [params, method] of [
      [storeCreditOnly, 'store_credit'],
      [giftCardOnly, 'gift_card'],
      [{ ...storeCreditOnly, payment: { storeCredit: { amount: 10 }, giftCard: { giftCardId: ID.giftCard, amount: 14 } } }, 'split'],
    ] as const) {
      const { recording, answer } = await placeThrough(params)
      expect(answer.body).toMatchObject({ ok: true, data: { payment: { method, collected: 0, cardCharged: false } } })
      expect(recording.tables['orders']?.added).toMatchObject([{ payment_method: method, payment_status: 'paid' }])
    }
  })
})

describe('the confirmed amounts, for every method with no Stripe step (W03-plan 2.7)', () => {
  const words = (figure: string) => `The amount due has changed to £${figure}. Check it with the customer and confirm again.`

  describe('amountChangedRefusal on its own', () => {
    const figures = { amountDue: 24, toCollect: 0 }
    it('an amount due not sent is not checked; one sent is, to half a penny either way', () => {
      expect(amountChangedRefusal(undefined, {}, figures)).toBeNull()
      expect(amountChangedRefusal(undefined, { amountDue: 24.005 }, figures)).toBeNull()
      expect(amountChangedRefusal(undefined, { amountDue: 23.995 }, figures)).toBeNull()
      expect(amountChangedRefusal(undefined, { amountDue: 24.006 }, figures)).toEqual({ reason: 'amount_changed', message: words('24.00') })
      expect(amountChangedRefusal(undefined, { amountDue: 30 }, figures)).toEqual({ reason: 'amount_changed', message: words('24.00') })
    })

    it('what the method takes now: missing counts as nothing; cash is left to the cash check', () => {
      expect(amountChangedRefusal(undefined, { toCollect: 5 }, figures)).toEqual({ reason: 'amount_changed', message: words('0.00') })
      expect(amountChangedRefusal(undefined, undefined, { amountDue: 24, toCollect: 4 })).toEqual({ reason: 'amount_changed', message: words('4.00') })
      expect(amountChangedRefusal('cash', { toCollect: 1 }, { amountDue: 24, toCollect: 4 })).toBeNull()
      // £9.00 against £8.995: adding-up noise, not a change.
      expect(amountChangedRefusal('reader', { toCollect: 9, amountDue: 9 }, { amountDue: 8.995, toCollect: 8.995 })).toBeNull()
    })
  })

  const coveredByGiftCard = { customerId: ID.customer, products: [soap], payment: { giftCard: { giftCardId: ID.giftCard, amount: 24 } } }

  it('figures that still hold: placed', async () => {
    const { answer } = await placeInput({ ...coveredByGiftCard, confirmed: { amountDue: 24, toCollect: 0 } })
    expect(answer.body).toMatchObject({ ok: true, data: { payment: { method: 'gift_card', giftCardApplied: 24 } } })
  })

  it("an amount due that changed: amount_changed with Q11's words and the new figure, TOTAL_CHANGED, nothing kept", async () => {
    const { recording, answer } = await placeInput({ ...coveredByGiftCard, confirmed: { amountDue: 30, toCollect: 0 } })
    expect(refusalOf(answer)).toEqual({ status: 409, code: 'TOTAL_CHANGED', stage: 'payment', reason: 'amount_changed', message: words('24.00'), amountDueTotal: 24 })
    expect(answer.body.ok ? null : answer.body.error.message).toBe(words('24.00'))
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('the order of checks: the cash figure first, whatever else changed', async () => {
    const { answer } = await placeInput({ customerId: ID.customer, products: [soap], payment: { method: 'cash' }, confirmed: { toCollect: 20, amountDue: 30 } })
    expect(refusalOf(answer)).toMatchObject({ reason: 'cash_amount_changed', amountDueTotal: 24 })
  })

  it('then a gift card or store credit over the total, never cut down to fit', async () => {
    const giftOver = await placeInput({ ...coveredByGiftCard, payment: { giftCard: { giftCardId: ID.giftCard, amount: 30 } }, confirmed: { amountDue: 30 } })
    expect(refusalOf(giftOver.answer)).toMatchObject({ reason: 'gift_card_amount_exceeds_total', amountDueTotal: 24 })
    const creditOver = await placeInput({ ...coveredByGiftCard, payment: { storeCredit: { amount: 25 } }, confirmed: { amountDue: 25 } })
    expect(refusalOf(creditOver.answer)).toMatchObject({ reason: 'store_credit_amount_exceeds_total', amountDueTotal: 24 })
    expect(tablesTouched(creditOver.recording)).toEqual(['api_idempotency'])
  })

  it('then payment_method_required, then amount_changed last', async () => {
    const owed = await placeInput({ ...coveredByGiftCard, payment: { storeCredit: { amount: 10 } }, confirmed: { amountDue: 30 } })
    expect(refusalOf(owed.answer)).toMatchObject({ reason: 'payment_method_required', amountDueTotal: 24 })
    const stale = await placeInput({ ...coveredByGiftCard, payment: { storeCredit: { amount: 24 } }, confirmed: { amountDue: 24, toCollect: 5 } })
    expect(refusalOf(stale.answer)).toMatchObject({ reason: 'amount_changed', message: words('0.00') })
  })

  it('the shadow and the replay send no amount due, as the old createOrder took none: not checked', async () => {
    const { answer } = await placeThrough(storeCreditOnly)
    expect(answer.body.ok).toBe(true)
  })
})

describe('B11 (W09): a database error writing the promo, the store credit or the gift card leaves nothing behind', () => {
  const writes: Array<[string, WriteFailure]> = [
    ['the order, with its promo code', { table: 'orders', event: 'INSERT', when: 'true' }],
    ["the promo code's use", { table: 'promo_code_redemptions', event: 'INSERT', when: 'true' }],
    ['the store credit claimed (and the address saved)', { table: 'customers', event: 'UPDATE', when: 'true' }],
    ['the store credit ledger row', { table: 'store_credit_transactions', event: 'INSERT', when: 'true' }],
    ['the gift card claimed', { table: 'gift_cards', event: 'UPDATE', when: 'true' }],
    ["the gift card's redemption row", { table: 'gift_card_redemptions', event: 'INSERT', when: 'true' }],
    ['a discounted seat', { table: 'booking_guests', event: 'INSERT', when: "NEW.guest_type = 'additional_guest'" }],
    ['a discounted place', { table: 'event_attendees', event: 'INSERT', when: "NEW.attendee_type = 'guest'" }],
  ]

  it.each(writes)('the worst basket: %s fails', async (_, failure) => {
    const { recording, answer } = await placeThrough(w09WorstBasket, undefined, (steps) => whileFailing(db, failure, steps))
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong and the action may not have finished. Check before trying again.' } })
    expect(JSON.stringify(answer.body)).not.toContain('connection lost')
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })
})

describe('the claims refuse on their own, without the checks T1 runs first (W09)', () => {
  /** The refusal's details, and the words staff see. */
  const refused = (reason: string, message: string) => ({ details: { status: 400, code: 'VALIDATION', stage: 'payment', reason }, message })
  const outcome = (answer: OrderAnswer) => ({ details: refusalOf(answer), message: answer.body.ok ? null : answer.body.error.message })

  it("store credit: facts that think there is enough; the claim's own guard refuses with createOrder's reason, nothing kept", async () => {
    const { recording, answer } = await placeWithStaleFacts(
      storeCreditOnly,
      (facts) => ({ ...facts, customer: facts.customer && { ...facts.customer, store_credit_balance: '100.00' } }),
      async (target) => {
        await target.query(`UPDATE customers SET store_credit_balance = '5.00' WHERE id = $1`, [ID.customer])
      }
    )
    expect(outcome(answer)).toEqual(refused('store_credit_insufficient', 'The customer no longer has enough store credit remaining.'))
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('store credit: a claim that writes nothing though the balance is there is store_credit_failed, with its words', async () => {
    const skipped: WriteFailure = { table: 'customers', event: 'UPDATE', when: 'true' }
    const { recording, answer } = await placeThrough(storeCreditOnly, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(outcome(answer)).toEqual(refused('store_credit_failed', 'Applying the store credit failed — no payment was taken.'))
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  const cardThinksItIsFine = (facts: BasketFacts): BasketFacts => ({
    ...facts,
    redeemed_gift_card: facts.redeemed_gift_card && { ...facts.redeemed_gift_card, remaining_balance: '40.00', voided: false, expiry_date: '2030-01-01' },
  })
  const cardWords = refused('gift_card_insufficient_or_invalid', 'That gift card no longer has enough balance remaining.')

  it.each([
    ['has too little left', `UPDATE gift_cards SET remaining_balance = '5.00' WHERE id = $1`],
    ['has been voided', 'UPDATE gift_cards SET voided = true WHERE id = $1'],
    ['expired yesterday', `UPDATE gift_cards SET expiry_date = '2026-11-09' WHERE id = $1`],
  ])("a gift card the facts think is fine but %s: the claim's guard refuses with createOrder's reason, nothing kept", async (_, sql) => {
    const { recording, answer } = await placeWithStaleFacts(giftCardOnly, cardThinksItIsFine, async (target) => {
      await target.query(sql, [ID.giftCard])
    })
    expect(outcome(answer)).toEqual(cardWords)
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('a gift card claim that writes nothing: the same', async () => {
    const skipped: WriteFailure = { table: 'gift_cards', event: 'UPDATE', when: 'true' }
    const { recording, answer } = await placeThrough(giftCardOnly, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(outcome(answer)).toEqual(cardWords)
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it.each([
    ["the promo code's use", { table: 'promo_code_redemptions', event: 'INSERT', when: 'true' } as WriteFailure, promoBooking],
    ['the store credit ledger row', { table: 'store_credit_transactions', event: 'INSERT', when: 'true' } as WriteFailure, storeCreditOnly],
    ["the gift card's redemption row", { table: 'gift_card_redemptions', event: 'INSERT', when: 'true' } as WriteFailure, giftCardOnly],
  ])('%s written short: the order fails whole, with the safe words', async (_, skipped, params) => {
    const { recording, answer } = await placeThrough(params, undefined, (steps) => whileSkipping(db, skipped, steps))
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })
})

describe("every W09 write waits on the gift card's go (W08 review S1)", () => {
  // W08a's collision basket (a shipped £60 gift card, two soaps, a pass, the address saved and an event for
  // two, £214), with FIVER, £20 on the seed's gift card and £10 of store credit: £179 in cash. The first
  // code drawn is the seed card's own, SEEDCARD, so the first try writes nothing.
  const everythingBought = {
    ...giftCardInCash,
    giftCard: { ...giftCardInCash.giftCard, fulfillmentMethod: 'shipping' },
    products: [soap],
    sessionPassTypeId: ID.passType,
    ...savedAddress,
    event: eventPlaces([samAttending, { ...alex, isAccountHolder: false }]),
    promoCode: 'FIVER',
    payment: { ...cash(179), giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } },
  }

  it('a code already taken: the promo used, the store credit and the gift card claimed, each once', async () => {
    const codes = codesInTurn('SEEDCARD', 'PWC-ABCDEFGH')
    const { recording, value, error } = await directly(everythingBought, codes.next)
    expect(error).toBeUndefined()
    expect(codes.asked()).toBe(2)
    expect(value).toMatchObject({ giftCardCode: 'PWC-ABCDEFGH', payment: { method: 'split', collected: 179, giftCardApplied: 20, storeCreditApplied: 10 } })
    expect(recording.tables['orders']?.added).toMatchObject([{ promo_code: 'FIVER', discount_amount: '5.00', payment_method: 'split' }])
    expect(recording.tables['promo_code_redemptions']?.added).toMatchObject([{ promo_code_id: ID.promoFixed, customer_id: ID.customer, discount_amount: '5.00' }])
    expect(recording.tables['customers']?.changed).toMatchObject([{ id: ID.customer, store_credit_balance: ['30.00', '20.00'] }])
    expect(recording.tables['store_credit_transactions']?.added).toMatchObject([{ amount: '-10.00', balance_after: '20.00', reason: 'redemption', order_id: 'orders#1', staff_id: ID.staff, note: STORE_CREDIT_NOTE }])
    expect(recording.tables['gift_cards']?.changed).toMatchObject([{ id: ID.giftCard, remaining_balance: ['40.00', '20.00'] }])
    expect(recording.tables['gift_cards']?.added).toHaveLength(1)
    expect(recording.tables['gift_card_redemptions']?.added).toMatchObject([{ gift_card_id: ID.giftCard, order_id: 'orders#1', amount_used: '20.00' }])
    expect(recording.tables['events']?.changed).toEqual([{ id: ID.event, places_booked: [0, 2] }])
  })

  it('inside the dry run: each read back once, and nothing kept', async () => {
    const codes = codesInTurn('SEEDCARD', 'PWC-ABCDEFGH')
    const { recording, value, error } = await directly(everythingBought, codes.next, { dry: true })
    expect(error).toBeUndefined()
    expect(codes.asked()).toBe(2)
    const rows = (value as OrderDryRunOutput).rows
    expect(rows.promo_redemptions).toEqual([{ promo_code_id: ID.promoFixed, for_the_order_customer: true, discount_amount: 5 }])
    expect(rows.store_credit_transactions).toHaveLength(1)
    expect(rows.gift_card_redemptions).toEqual([expect.objectContaining({ amount_used: 20, card_remaining_balance: 20 })])
    expect(rows.customer_store_credit_balance).toBe(20)
    expect(recording.tables).toEqual({})
  })
})

describe('what T1 writes for a promo code, store credit and a gift card (W09)', () => {
  it('the dry run reads back exactly what the real order then writes, for the worst basket', async () => {
    let dry: unknown = null
    let written: unknown = null
    await replay(
      environment,
      {
        name: 'dry run then order, W09',
        seed,
        async run() {
          dry = (await dryRun(orderInput(w09WorstBasket))).body.data?.rows
          const placed = await postOrder(orderInput(w09WorstBasket))
          if (placed.body.ok) written = await readOrderRows(db, placed.body.data.orderId)
        },
      },
      oldSide
    )
    expect(written).not.toBeNull()
    expect(dry).toEqual(written)
    expect(written).toMatchObject({
      order: { order_total: 199.95, discount_amount: 5, promo_code: 'FIVER', payment_method: 'split', payment_status: 'paid' },
      // FIVER over £180 of seats, the candle and the places (the towel on the booking is never a promo line):
      // 55p a seat and on the candle, £1.11 a place, the 2p left over on the last place.
      lines: [
        { item_type: 'booking', unit_price: 40, discount_amount: 1.1 },
        { item_type: 'event', line_total: 120, discount_amount: 3.35 },
        { item_type: 'product', discount_amount: 0.55 },
        { item_type: 'gift_card', discount_amount: 0 },
        { item_type: 'postage', discount_amount: 0 },
      ],
      booking: { price_paid: 38.9, seats: [{ unit_price: 19.45 }, { unit_price: 19.45 }] },
      event_booking: { price_paid: 116.65, attendees: [{ unit_price: 38.89 }, { unit_price: 38.89 }, { unit_price: 38.87 }] },
      promo_redemptions: [{ promo_code_id: ID.promoFixed, for_the_order_customer: true, discount_amount: 5 }],
      store_credit_transactions: [
        { amount: -10, balance_after: 20, reason: 'redemption', for_the_order_customer: true, for_a_booking: false, from_a_gift_card: false, staff_id: ID.staff, note: STORE_CREDIT_NOTE },
      ],
      gift_card_redemptions: [
        { gift_card_id: ID.giftCard, amount_used: 20, for_a_booking: false, for_an_event_booking: false, card_remaining_balance: 20, card_redeemed: false, card_voided: false },
      ],
      customer_store_credit_balance: 20,
    })
  })

  it("a gift card used up is marked redeemed; one partly used isn't (createOrder's rule)", async () => {
    const usedUp = await placeThrough({ customerId: ID.customer, booking: paidSeat([sam, alex]), payment: { giftCard: { giftCardId: ID.giftCard, amount: 40 } } })
    expect(usedUp.recording.tables['gift_cards']?.changed).toMatchObject([{ id: ID.giftCard, remaining_balance: ['40.00', '0.00'], redeemed_at: [null, '<set>'] }])
    const partly = await placeThrough(giftCardOnly)
    expect(partly.recording.tables['gift_cards']?.changed).toEqual([{ id: ID.giftCard, remaining_balance: ['40.00', '16.00'] }])
    // Brief W09a (W09 review C1): a card already marked redeemed keeps the date it was first used up, as
    // createOrder kept it. The recording shows every timestamp as '<set>', so read the date itself.
    const firstRedeemed = '2026-10-01 12:00:00+00'
    const again = await placeThrough(giftCardOnly, async (seedDb) => {
      await seedDb.query(`UPDATE gift_cards SET remaining_balance = '24.00', redeemed_at = $1 WHERE id = $2`, [firstRedeemed, ID.giftCard])
    })
    expect(again.answer.body.ok).toBe(true)
    expect(again.recording.tables['gift_cards']?.changed).toEqual([{ id: ID.giftCard, remaining_balance: ['24.00', '0.00'] }])
    const card = await db.query<{ kept: boolean }>(`SELECT redeemed_at = $1::timestamptz AS kept FROM gift_cards WHERE id = $2`, [firstRedeemed, ID.giftCard])
    expect(card).toEqual([{ kept: true }])
  })

  it('the audit rows name the promo code, the gift card and the store credit', async () => {
    const { recording } = await placeThrough(w09WorstBasket)
    expect(recording.tables['audit_log']?.added).toMatchObject([
      {
        action: 'order.create',
        details: { promo: { code: 'FIVER', discount: 5 }, giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: 10, amountDue: 194.95, toCollect: 164.95 },
      },
      { action: 'order.paid', details: { method: 'split', collected: 164.95, giftCard: 20, storeCredit: 10 } },
    ])
  })

  it("the answer names the gift card and store credit taken, and comes back to createOrder's shape", async () => {
    const { answer } = await placeThrough(w09WorstBasket)
    expect(answer.body.ok).toBe(true)
    if (!answer.body.ok) return
    expect(placeOrderOutputSchema.safeParse(answer.body.data).success).toBe(true)
    expect(answer.body.data.payment).toEqual({ method: 'split', collected: 164.95, cardCharged: false, giftCardApplied: 20, storeCreditApplied: 10 })
    expect(oldResult(answer.body)).toMatchObject({ cardAmount: 164.95, giftCardRedeemedAmount: 20, storeCreditRedeemedAmount: 10, paymentMethodUsed: 'split' })
    const giftOnly = await placeThrough(giftCardOnly)
    const shape = oldResult(giftOnly.answer.body)
    expect(shape).toMatchObject({ giftCardRedeemedAmount: 24, paymentMethodUsed: 'gift_card' })
    expect(shape).not.toHaveProperty('storeCreditRedeemedAmount')
  })

  it('placed for a customer (the website, later), the store credit names no member of staff', async () => {
    const recording = await replay(
      environment,
      {
        name: 'store credit placed by the customer',
        seed,
        async run() {
          await placeOrder(db, orderInput(storeCreditOnly), { actor: { type: 'customer', id: ID.customer }, requestId: 'customer-test' })
        },
      },
      oldSide
    )
    expect(recording.tables['store_credit_transactions']?.added).toMatchObject([{ staff_id: null, amount: '-24.00', balance_after: '6.00' }])
  })

  it('a promo code beside a membership bought in the basket is the membership, not built yet', async () => {
    const { recording, answer } = await placeThrough({ ...promoBooking, membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', payment: cash(54) })
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'NOT_BUILT', details: { notBuilt: ['membership'] } } })
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })
})

describe('for the Worker step (W09): the old createOrder when a claim write fails', () => {
  // createOrder.ts claims the store credit and the gift card after its try block (stage 30,
  // claimStoreCreditAndGiftCard), on the cash and saved-card paths. A database error there throws
  // straight out: nothing is rolled back. The order stays pending, the stock stays taken, and the
  // money already moved stays moved. T1 is one transaction: nothing is kept.
  it('keeps the £10 of store credit and the £14 off the gift card, with a pending order and no redemption row', async () => {
    const basket = { customerId: ID.customer, products: [soap], payment: { giftCard: { giftCardId: ID.giftCard, amount: 14 }, storeCredit: { amount: 10 } } }
    const rowFails: WriteFailure = { table: 'gift_card_redemptions', event: 'INSERT', when: 'true' }
    const thrown: unknown[] = []
    const recording = await replay(
      environment,
      {
        name: 'old claim fails',
        seed,
        async run({ call }) {
          await whileFailing(db, rowFails, async () => {
            await call('createOrder', basket).catch((err: unknown) => thrown.push(err))
          })
        },
      },
      oldSide
    )
    expect(String(thrown[0])).toContain('connection lost')
    expect(recording.tables['orders']?.added).toMatchObject([{ payment_status: 'pending', order_total: '24.00' }])
    expect(recording.tables['customers']?.changed).toMatchObject([{ id: ID.customer, store_credit_balance: ['30.00', '20.00'] }])
    expect(recording.tables['gift_cards']?.changed).toMatchObject([{ id: ID.giftCard, remaining_balance: ['40.00', '26.00'] }])
    expect(recording.tables['gift_card_redemptions']).toBeUndefined()
    expect(recording.tables['product_variants']?.changed).toEqual([{ id: ID.variant, stock_quantity: [5, 3] }])

    const worker = await placeThrough(basket, undefined, (steps) => whileFailing(db, rowFails, steps))
    expect(worker.answer.body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(tablesTouched(worker.recording)).toEqual(['api_idempotency'])
  })
})

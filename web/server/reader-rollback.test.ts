import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'

// The staff app's reader order functions, run for real against real Postgres (PGlite) with the live
// foreign keys. Only Stripe is faked. The app has no test runner, so they run from its checkout
// beside this repo, as in staff-app-helpers.test.ts.
const appDir = staffAppDir()
const backend = path.join(appDir, 'backend/paddock')
const load = (name: string) => import(/* @vite-ignore */ path.join(backend, name))

const user = { email: 'jo@example.com' }
const PI = 'pi_test_1'
const OLD = new Date(Date.now() - 60 * 60_000).toISOString()

type Row = Record<string, unknown>
type Mode = 'before' | 'after'

let database: TestDatabase

/** What the fake Stripe has done, and how it should behave. */
const stripe = {
  piStatus: 'canceled',
  charged: 0,
  refunded: 0,
  refundCalls: 0,
  refundBroken: false,
  cardReusable: true,
  subscriptionsCreated: 0,
  subscriptionsCancelled: 0,
  subscriptionCancelBroken: false,
  subscriptionBroken: false,
  orderId: '',
}

/** Fails statement number `at`, either before it runs or after it commits (a lost response). */
const fault: { at: number; mode: Mode; match: RegExp | null } = { at: 0, mode: 'before', match: null }
let statements = 0
let log: string[] = []

async function query(sql: string, params: unknown[] = []) {
  // This driver maps $N to params[N-1] only if they ascend and none repeats.
  const used = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
  expect(used, sql).toEqual(used.map((_, i) => i + 1))
  statements += 1
  log.push(sql)
  const hit = statements === fault.at || (fault.match !== null && fault.match.test(sql))
  if (hit && fault.mode === 'before') throw new Error('database unavailable')
  const result = await database.pg.query(sql, params as never[])
  if (hit && fault.mode === 'after') throw new Error('connection lost')
  return { data: result.rows as Row[] }
}

async function rawRequest({ path: route, body }: { path: string; body: Row }) {
  if (route === '/api/terminal/payment-intent') {
    const wasSucceeded = stripe.piStatus === 'succeeded'
    if (body['action'] === 'cancel' && !wasSucceeded) stripe.piStatus = 'canceled'
    return {
      data: {
        success: true,
        cancelled: body['action'] === 'cancel' && !wasSucceeded,
        alreadySucceeded: body['action'] === 'cancel' && wasSucceeded,
        paymentIntent: {
          id: PI,
          status: stripe.piStatus,
          amount: stripe.charged,
          amount_received: stripe.piStatus === 'succeeded' ? stripe.charged : 0,
          currency: 'gbp',
          metadata: { order_id: stripe.orderId, flow: 'move', record_id: stripe.orderId },
        },
      },
    }
  }
  if (route === '/api/payments/refund-order') {
    stripe.refundCalls += 1
    if (stripe.refundBroken) return { data: { error: 'Failed to refund payment', details: 'The bank is down.' } }
    if (stripe.refunded + Number(body['amount']) > stripe.charged + 0.001) {
      return { data: { error: 'Failed to refund payment', details: 'Charge ch_1 has already been refunded.' } }
    }
    stripe.refunded += Number(body['amount'])
    return { data: { success: true } }
  }
  if (route === '/api/terminal/resolve-saved-card') {
    return { data: { success: true, paymentMethodId: 'pm_1', reusable: stripe.cardReusable, last4: '4242', brand: 'visa' } }
  }
  if (route === '/api/memberships/create-subscription') {
    if (stripe.subscriptionBroken) return { data: { error: 'Subscription refused' } }
    stripe.subscriptionsCreated += 1
    return { data: { success: true, subscriptionId: `sub_${stripe.subscriptionsCreated}`, status: 'active' } }
  }
  if (route === '/api/memberships/cancel-subscription') {
    if (stripe.subscriptionCancelBroken) return { data: { error: 'Stripe is down' } }
    stripe.subscriptionsCancelled += 1
    return { data: { success: true } }
  }
  throw new Error(`unexpected Worker call: ${route}`)
}

const TABLES = `orders, order_line_items, addon_order_lines, addons, booking_guests, bookings, gift_cards, gift_card_redemptions,
  store_credit_transactions, stock_adjustments, product_variants, event_bookings, events, customer_memberships,
  customer_session_passes, membership_credit_periods, promo_code_redemptions, pending_reader_payments, sessions,
  service_types, customers, membership_plans, session_pass_types, staff`

async function put(table: string, row: Row): Promise<string> {
  const columns = Object.keys(row)
  // Test data only: the table and column names are literals, as in testing/database.ts.
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`
  const result = await database.pg.query<{ id: string }>(sql, Object.values(row) as never[])
  return result.rows[0]!.id
}

interface Fixture {
  orderId: string
  customerId: string
  /** The figures with nothing held by the order: what a finished rollback must leave. */
  before: Row
}

async function base() {
  await put('staff', { role: 'admin', first_name: 'Jo', last_name: 'Test', email: user.email })
  const customerId = await put('customers', {
    first_name: 'Sam',
    last_name: 'Test',
    email: 'sam@example.com',
    date_of_birth: '1990-01-01',
    store_credit_balance: 30,
  })
  const planId = await put('membership_plans', { name: 'Core', level: 'core', addons_included: 2 })
  const passTypeId = await put('session_pass_types', { name: 'Five', level: 'all_access' })
  return { customerId, planId, passTypeId }
}

async function session(bookingType: 'public' | 'private', capacity: number, totalBooked: number) {
  const serviceTypeId = await put('service_types', { name: `Sauna ${bookingType}`, booking_type: bookingType })
  return put('sessions', {
    service_type_id: serviceTypeId,
    start_time: '2030-06-15 10:00:00+00',
    end_time: '2030-06-15 11:00:00+00',
    capacity,
    total_booked: totalBooked,
  })
}

async function order(customerId: string, total: number, snapshot: Row) {
  stripe.charged = total
  const orderId = await put('orders', { customer_id: customerId, order_total: total, payment_status: 'pending', order_source: 'staff_created' })
  stripe.orderId = orderId
  await database.pg.query(`UPDATE orders SET reader_payment = $1::jsonb WHERE id = $2`, [
    JSON.stringify({ flow: 'checkout', payment_intent_id: PI, expected_amount: total, created_at: OLD, ...snapshot }),
    orderId,
  ])
  return orderId
}

async function claimStoreCredit(customerId: string, orderId: string, amount: number) {
  await database.pg.query(`SELECT public.store_credit_apply($1::uuid, $2::numeric, 'redemption', $3::uuid)`, [customerId, -amount, orderId])
}

/** Everything at once: a pass booking with add-ons on credit and a paid add-on, a product, an event,
 *  store credit, a part-used gift card that this order drains to nothing, a gift card bought. */
async function everything(extra: Row = {}): Promise<Fixture> {
  const { customerId, planId, passTypeId } = await base()
  const sessionId = await session('public', 10, 5) // 3 before this order's 2
  const passId = await put('customer_session_passes', { customer_id: customerId, pass_type_id: passTypeId, sessions_remaining: 3, expiry_date: '2099-01-01' })
  const membershipId = await put('customer_memberships', { customer_id: customerId, plan_id: planId, start_date: '2026-01-01', subscription_status: 'active', addon_credits_remaining: 2 })
  const addonId = await put('addons', { name: 'Towel' })
  const variantId = await put('product_variants', { product_id: crypto.randomUUID(), sku: 'SKU', stock_quantity: 5 })
  const usedCardId = await put('gift_cards', {
    code: 'USED', type: 'monetary', original_value: 50, remaining_balance: 0, origin: 'customer_purchase', expiry_date: '2099-01-01', redeemed_at: new Date().toISOString(),
  })
  const eventId = await put('events', {
    name: 'Night', starts_at: '2099-06-15 18:00:00+00', ends_at: '2099-06-15 20:00:00+00', refund_cutoff_at: '2099-06-14 18:00:00+00', capacity: 10, places_booked: 3, access: 'public',
    active: true, price_public: 40, price_pre_herd: 30, price_herd: 20,
  })
  const eventBookingId = await put('event_bookings', { event_id: eventId, customer_id: customerId, places: 2, status: 'pending' })
  await put('event_attendees', { event_booking_id: eventBookingId, attendee_type: 'guest', name: 'Sam', unit_price: 40, price_level: 'public' })
  const boughtCardId = await put('gift_cards', { code: 'BOUGHT', type: 'monetary', original_value: 25, remaining_balance: 25, origin: 'customer_purchase', expiry_date: '2099-01-01' })

  const adjustmentId = await put('stock_adjustments', { variant_id: variantId, change_amount: -2, reason: 'pending' })
  const orderId = await order(customerId, 60, {
    gift_card_redemption: { gift_card_id: usedCardId, amount: 15 },
    stock_adjustment_ids: [adjustmentId],
    event_booking_id: eventBookingId,
    ...extra,
  })
  const bookingId = await put('bookings', {
    session_id: sessionId, customer_id: customerId, party_size: 2, status: 'confirmed', price_paid: 0, redemption_source: 'session_pass_credit', redeemed_session_pass_id: passId,
  })
  await put('booking_guests', { booking_id: bookingId, guest_name: 'Sam' })
  await put('order_line_items', { order_id: orderId, item_type: 'booking', quantity: 1, unit_price: 0, line_total: 0, booking_id: bookingId })
  await put('order_line_items', { order_id: orderId, item_type: 'product', quantity: 2, unit_price: 5, line_total: 10, product_variant_id: variantId })
  await put('order_line_items', { order_id: orderId, item_type: 'product', quantity: 1, unit_price: 5, line_total: 5, product_variant_id: variantId })
  await put('order_line_items', { order_id: orderId, item_type: 'event', quantity: 2, unit_price: 40, line_total: 80, event_booking_id: eventBookingId })
  await put('order_line_items', { order_id: orderId, item_type: 'gift_card', quantity: 1, unit_price: 25, line_total: 25, gift_card_id: boughtCardId })
  for (const [quantity, source] of [[1, 'membership_credit'], [2, 'membership_credit'], [1, 'paid']] as const) {
    await put('addon_order_lines', {
      booking_id: bookingId, addon_id: addonId, quantity, price_at_purchase: 5, sku_at_purchase: 'T', redemption_source: source, order_id: orderId,
      ...(source === 'membership_credit' ? { redeemed_membership_id: membershipId } : {}),
    })
  }
  await put('gift_card_redemptions', { gift_card_id: usedCardId, order_id: orderId, amount_used: 15 })
  await claimStoreCredit(customerId, orderId, 10)
  const promoCode = crypto.randomUUID()
  await put('promo_code_redemptions', { promo_code_id: promoCode, order_id: orderId, customer_id: customerId, discount_amount: 1 })

  return {
    orderId,
    customerId,
    before: {
      sessions: [3],
      passes: [4],
      memberships: [['active', 5]],
      stock: [8],
      cards: [['USED', 15, false]],
      places: [1],
      credit: 30,
    },
  }
}

/** The buy-new flow on a private session: the booking and an add-on point at a membership row made
 *  for this order, and an exhausted membership was switched off to make way for it. */
async function buyNewMembership(extra: Row = {}): Promise<Fixture> {
  const { customerId, planId } = await base()
  const sessionId = await session('private', 6, 6)
  const oldId = await put('customer_memberships', { customer_id: customerId, plan_id: planId, start_date: '2025-01-01', subscription_status: 'cancelled', addon_credits_remaining: 0 })
  const orderId = await order(customerId, 40, {
    exhausted_membership_previous: { subscription_status: 'active', addon_credits_remaining: 3, membership_id: oldId },
    ...extra,
  })
  const lineId = await put('order_line_items', { order_id: orderId, item_type: 'membership', quantity: 1, unit_price: 40, line_total: 40, membership_plan_id: planId })
  const newId = await put('customer_memberships', { customer_id: customerId, plan_id: planId, start_date: '2026-11-05', subscription_status: 'active', addon_credits_remaining: 1, order_line_item_id: lineId })
  await database.pg.query(`UPDATE orders SET reader_payment = jsonb_set(reader_payment, '{membership}', $1::jsonb) WHERE id = $2`, [
    JSON.stringify({ plan_id: planId, plan_name: 'Core', billing_frequency: 'monthly', price: 40, first_payment_amount: 40, membership_row_id: newId }),
    orderId,
  ])
  const periodId = await put('membership_credit_periods', { membership_id: newId, period_start: '2026-11-05', period_end: '2026-12-04', credits_allocated: 4 })
  const bookingId = await put('bookings', {
    session_id: sessionId, customer_id: customerId, party_size: 2, status: 'confirmed', price_paid: 0, redemption_source: 'membership_credit', redeemed_membership_id: newId, credit_period_id: periodId,
  })
  await put('order_line_items', { order_id: orderId, item_type: 'booking', quantity: 1, unit_price: 0, line_total: 0, booking_id: bookingId })
  const addonId = await put('addons', { name: 'Towel' })
  await put('addon_order_lines', {
    booking_id: bookingId, addon_id: addonId, quantity: 1, price_at_purchase: 5, sku_at_purchase: 'T', redemption_source: 'membership_credit', redeemed_membership_id: newId, order_id: orderId,
  })
  return { orderId, customerId, before: { sessions: [0], passes: [], memberships: [['active', 3]], stock: [], cards: [], places: [], credit: 30 } }
}

/** The buy-new flow with a pass: the booking points at a pass row made for this order. */
async function buyNewPass(): Promise<Fixture> {
  const { customerId, passTypeId } = await base()
  const sessionId = await session('public', 10, 2)
  const orderId = await order(customerId, 30, {})
  const lineId = await put('order_line_items', { order_id: orderId, item_type: 'session_pass', quantity: 1, unit_price: 30, line_total: 30, session_pass_type_id: passTypeId })
  const passId = await put('customer_session_passes', { customer_id: customerId, pass_type_id: passTypeId, sessions_remaining: 4, expiry_date: '2099-01-01', order_line_item_id: lineId })
  const bookingId = await put('bookings', {
    session_id: sessionId, customer_id: customerId, party_size: 1, status: 'confirmed', price_paid: 0, redemption_source: 'session_pass_credit', redeemed_session_pass_id: passId,
  })
  await put('order_line_items', { order_id: orderId, item_type: 'booking', quantity: 1, unit_price: 0, line_total: 0, booking_id: bookingId })
  return { orderId, customerId, before: { sessions: [1], passes: [], memberships: [], stock: [], cards: [], places: [], credit: 30 } }
}

async function rows<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await database.pg.query<T>(sql, params as never[])).rows
}

/** The figures a rollback gives back, read straight from the database. */
async function figures(): Promise<Row> {
  const num = (v: unknown) => Number(v)
  return {
    sessions: (await rows<{ n: number }>('SELECT total_booked AS n FROM sessions')).map((r) => r.n),
    passes: (await rows<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes')).map((r) => r.n),
    memberships: (await rows<{ s: string; n: number }>('SELECT subscription_status AS s, addon_credits_remaining AS n FROM customer_memberships')).map((r) => [r.s, r.n]),
    stock: (await rows<{ n: number }>('SELECT stock_quantity AS n FROM product_variants')).map((r) => r.n),
    cards: (await rows<{ code: string; n: string; at: string | null }>('SELECT code, remaining_balance AS n, redeemed_at AS at FROM gift_cards')).map((r) => [r.code, num(r.n), r.at !== null]),
    places: (await rows<{ n: number }>('SELECT places_booked AS n FROM events')).map((r) => r.n),
    credit: num((await rows<{ n: string }>('SELECT store_credit_balance AS n FROM customers'))[0]?.n),
  }
}

/** Nothing the order made is left behind. */
async function expectNothingLeft(label: string) {
  for (const table of [
    'orders', 'order_line_items', 'bookings', 'booking_guests', 'addon_order_lines', 'store_credit_transactions', 'gift_card_redemptions',
    'stock_adjustments', 'event_bookings', 'event_attendees', 'promo_code_redemptions', 'membership_credit_periods',
  ]) {
    const [count] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
    expect(count?.n, `${label}: ${table}`).toBe(0)
  }
}

const SCENARIOS: Array<[string, () => Promise<Fixture>]> = [
  ['everything at once', () => everything()],
  ['buying a membership', () => buyNewMembership()],
  ['buying a pass', () => buyNewPass()],
]

// The "fails at every statement" tests each run a flow once per statement: under 1s alone, nearly 3s
// beside the replay suites, and once over the default 5s (W05f).
vi.setConfig({ testTimeout: 30_000 })

describe('reader order rollback and finalise', () => {
  beforeAll(async () => {
    database = await startTestDatabase()
    await database.pg.exec('RESET ROLE')
    await database.pg.exec(readFileSync(path.join(__dirname, 'rules/testing/reader-orders-schema.sql'), 'utf8'))
  })
  afterAll(async () => {
    await database.stop()
  })

  async function reset() {
    await database.pg.exec(`TRUNCATE ${TABLES} CASCADE`)
    Object.assign(stripe, {
      piStatus: 'canceled', charged: 0, refunded: 0, refundCalls: 0, refundBroken: false, cardReusable: true, subscriptionsCreated: 0,
      subscriptionsCancelled: 0, subscriptionCancelBroken: false, subscriptionBroken: false, orderId: '',
    })
    Object.assign(fault, { at: 0, mode: 'before', match: null })
    statements = 0
    log = []
  }

  beforeEach(async () => {
    vi.stubGlobal('paddockData', { query })
    vi.stubGlobal('paddockBackendApi2', { rawRequest })
    await reset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const cancel = async (orderId: string) => (await load('cancelReaderOrder.ts')).default({ params: { orderId }, user })
  const finalise = async (orderId: string) => (await load('finaliseReaderOrder.ts')).default({ params: { orderId }, user })
  const sweep = async () => (await load('sweepPendingReaderPayments.ts')).default({ params: { olderThanMinutes: 15 }, user })
  const arm = (at: number, mode: Mode = 'before') => {
    statements = 0
    Object.assign(fault, { at, mode, match: null })
  }
  const disarm = () => Object.assign(fault, { at: 0, match: null })
  /** Runs `fn`, swallowing what a failure throws: the sweep has to cope either way. */
  const survive = async (fn: () => Promise<unknown>) => {
    try {
      return await fn()
    } catch {
      return undefined
    }
  }

  /** How many statements a clean run of `run` makes on a fresh copy of the order. */
  async function countStatements(fixture: () => Promise<Fixture>, run: (orderId: string) => Promise<unknown>) {
    await reset()
    const { orderId } = await fixture()
    statements = 0
    await run(orderId)
    const count = statements
    await reset()
    return count
  }

  describe('bug 8: a failed rollback finishes on the sweep and gives everything back exactly once', () => {
    for (const [name, fixture] of SCENARIOS) {
      it(`${name}: a clean cancel on the reader gives everything back and leaves nothing`, async () => {
        const { orderId, before } = await fixture()
        expect(await cancel(orderId)).toMatchObject({ cancelled: true, orderId })
        expect(await figures()).toEqual(before)
        await expectNothingLeft(name)
      })

      for (const mode of ['before', 'after'] as const) {
        it(`${name}: fails at every statement in turn (${mode} it runs), then the sweep runs twice`, async () => {
          const total = await countStatements(fixture, cancel)
          expect(total).toBeGreaterThan(10)
          for (let at = 1; at <= total; at += 1) {
            await reset()
            const { orderId, before } = await fixture()
            arm(at, mode)
            await survive(() => cancel(orderId))
            disarm()
            await sweep()
            await sweep()
            const label = `${name}, statement ${at} of ${total}, ${mode}`
            expect(await figures(), label).toEqual(before)
            await expectNothingLeft(label)
          }
        })
      }

      it(`${name}: fails at every statement, then fails the same place again on the first sweep`, async () => {
        const total = await countStatements(fixture, cancel)
        for (let at = 1; at <= total; at += 1) {
          await reset()
          const { orderId, before } = await fixture()
          arm(at)
          await survive(() => cancel(orderId))
          arm(at)
          await survive(sweep)
          disarm()
          await sweep()
          await sweep()
          const label = `${name}, statement ${at} of ${total}`
          expect(await figures(), label).toEqual(before)
          await expectNothingLeft(label)
        }
      })
    }

    it('two rollbacks running at once still give everything back once', async () => {
      const { orderId, before } = await everything()
      const { rollbackReaderOrder } = await load('shared/readerOrderRollback.ts')
      await Promise.all([rollbackReaderOrder(orderId), rollbackReaderOrder(orderId), rollbackReaderOrder(orderId)])
      await sweep()
      expect(await figures()).toEqual(before)
      await expectNothingLeft('race')
    })

    it('a sweep with the order still half rolled back never repeats a give-back', async () => {
      const { orderId } = await everything()
      Object.assign(fault, { mode: 'before', match: /DELETE FROM orders/ })
      const first = await cancel(orderId)
      expect(first).toMatchObject({ cancelled: false, reason: 'rollback_incomplete' })
      const held = await figures()
      const again = await cancel(orderId)
      expect(again).toMatchObject({ cancelled: false, reason: 'rollback_incomplete' })
      expect(await figures()).toEqual(held)
    })

    it('tells staff the truth when a rollback stops part-way', async () => {
      const { orderId } = await everything()
      Object.assign(fault, { mode: 'before', match: /UPDATE product_variants/ })
      const result = await cancel(orderId)
      expect(result).toEqual({
        cancelled: false,
        orderId,
        reason: 'rollback_incomplete',
        message:
          "The order couldn't be fully cancelled yet. It's still on the Orders page, and Resolve now will finish it once it's 15 minutes old (restock product: database unavailable; restock product: database unavailable).",
      })
      // A failed give-back stops the deletes, so the rows a repeat needs are still there.
      expect(await rows('SELECT id FROM bookings')).toHaveLength(1)
      expect(await rows('SELECT id FROM orders')).toHaveLength(1)
    })

    it('the sweep reports an order it still could not finish', async () => {
      const { orderId } = await everything()
      Object.assign(fault, { mode: 'before', match: /UPDATE product_variants/ })
      const result = await sweep()
      expect(result).toMatchObject({ checked: 1, cancelled: 0, finalised: 0 })
      expect(result.failed).toEqual([expect.objectContaining({ flow: 'checkout', recordId: orderId })])
    })

    it('a failed credit period refresh, after the order has gone, is only a warning', async () => {
      const { orderId, before } = await everything()
      Object.assign(fault, { mode: 'before', match: /allocate_membership_credit_periods/ })
      const result = await cancel(orderId)
      expect(result).toMatchObject({ cancelled: true })
      expect(result.warning).toContain('refresh membership credit periods')
      expect(await figures()).toEqual(before)
    })

    for (const [name, result] of [
      ['as an object', { ok: false, reason: 'customer_not_found' }],
      ['as text', '{"ok":false,"reason":"customer_not_found"}'],
    ] as const) {
      it(`a store credit reversal the database refuses (${name}) stops the deletes`, async () => {
        const { orderId } = await everything()
        vi.stubGlobal('paddockData', {
          query: async (sql: string, params: unknown[] = []) => (sql.includes('store_credit_apply') ? { data: [{ result }] } : query(sql, params)),
        })
        const outcome = await cancel(orderId)
        expect(outcome).toMatchObject({ cancelled: false, reason: 'rollback_incomplete' })
        expect(outcome.message).toContain('reverse store credit claim: customer_not_found')
        expect(await rows('SELECT id FROM store_credit_transactions')).toHaveLength(1)
        expect(await rows('SELECT id FROM orders')).toHaveLength(1)
      })
    }

    it('a repeat does not overwrite what staff changed on the old membership since the first run', async () => {
      const { orderId } = await buyNewMembership()
      Object.assign(fault, { mode: 'before', match: /DELETE FROM orders/ })
      await cancel(orderId)
      disarm()
      await database.pg.exec(`UPDATE customer_memberships SET addon_credits_remaining = 9 WHERE start_date = '2025-01-01'`)
      await sweep()
      const [old] = await rows<{ n: number }>(`SELECT addon_credits_remaining AS n FROM customer_memberships WHERE start_date = '2025-01-01'`)
      expect(old?.n).toBe(9)
      await expectNothingLeft('staff change')
    })

    it('an add-on line on another booking cannot block the order', async () => {
      const { orderId } = await everything()
      const [order] = await rows<{ customer_id: string }>('SELECT customer_id FROM orders')
      const [existing] = await rows<{ session_id: string; addon_id: string }>(
        'SELECT b.session_id, a.addon_id FROM bookings b JOIN addon_order_lines a ON a.booking_id = b.id LIMIT 1'
      )
      const other = await put('bookings', { session_id: existing?.session_id, customer_id: order?.customer_id, party_size: 1, status: 'confirmed', price_paid: 0, redemption_source: 'paid' })
      await put('addon_order_lines', { booking_id: other, addon_id: existing?.addon_id, quantity: 1, price_at_purchase: 5, sku_at_purchase: 'T', redemption_source: 'paid', order_id: orderId })
      expect(await cancel(orderId)).toMatchObject({ cancelled: true })
      expect(await rows('SELECT id FROM orders')).toHaveLength(0)
      expect(await rows<{ id: string }>('SELECT id FROM bookings')).toEqual([{ id: other }])
    })

    it('deletes the sale audit rows of an older order that recorded no ids', async () => {
      const { orderId, before } = await everything({ stock_adjustment_ids: [] })
      const [variant] = await rows<{ id: string }>('SELECT id FROM product_variants')
      await database.pg.query(`DELETE FROM stock_adjustments`)
      await put('stock_adjustments', { variant_id: variant?.id, change_amount: -2, reason: `Sale (Order #${orderId})` })
      const kept = await put('stock_adjustments', { variant_id: variant?.id, change_amount: -1, reason: 'Sale (Order #another)' })
      await cancel(orderId)
      expect(await figures()).toEqual(before)
      expect(await rows<{ id: string }>('SELECT id FROM stock_adjustments')).toEqual([{ id: kept }])
    })

    it('a paid order is never rolled back', async () => {
      const { orderId } = await everything()
      await database.pg.query(`UPDATE orders SET payment_status = 'paid', stripe_payment_intent_id = $1 WHERE id = $2`, [PI, orderId])
      const held = await figures()
      const { rollbackReaderOrder } = await load('shared/readerOrderRollback.ts')
      expect(await rollbackReaderOrder(orderId)).toEqual({ rolledBack: false, reason: 'already_paid' })
      expect(await figures()).toEqual(held)
    })

    it('an order already gone is a success', async () => {
      const { rollbackReaderOrder } = await load('shared/readerOrderRollback.ts')
      expect(await rollbackReaderOrder(crypto.randomUUID())).toEqual({ rolledBack: true, alreadyGone: true })
    })
  })

  describe('the give-backs match the helpers they stand in for', () => {
    /** The rollback's result on one held item, against the helper's on an identical one. */
    async function compare(bookingType: 'public' | 'private') {
      const { releaseSessionCapacity } = await load('shared/sessionCapacity.ts')
      const { customerId } = await base()
      const sessionId = await session(bookingType, 6, 5)
      const orderId = await order(customerId, 10, {})
      const bookingId = await put('bookings', { session_id: sessionId, customer_id: customerId, party_size: 2, status: 'confirmed', price_paid: 0, redemption_source: 'paid' })
      await put('order_line_items', { order_id: orderId, item_type: 'booking', quantity: 1, unit_price: 10, line_total: 10, booking_id: bookingId })
      const { rollbackReaderOrder } = await load('shared/readerOrderRollback.ts')
      await rollbackReaderOrder(orderId)
      const [viaRollback] = await rows<{ n: number }>('SELECT total_booked AS n FROM sessions')
      await database.pg.query('UPDATE sessions SET total_booked = 5')
      await releaseSessionCapacity(sessionId, 2)
      const [viaHelper] = await rows<{ n: number }>('SELECT total_booked AS n FROM sessions')
      return [viaRollback?.n, viaHelper?.n]
    }

    it('capacity on a public session', async () => {
      expect(await compare('public')).toEqual([3, 3])
    })

    it('capacity on a private session', async () => {
      expect(await compare('private')).toEqual([0, 0])
    })

    for (const [name, expiry, expected] of [['in date', '2099-01-01', 4], ['expired', '2020-01-01', 3]] as const) {
      it(`a session pass ${name}`, async () => {
        const { releaseSessionPassCredit } = await load('shared/creditRedemption.ts')
        const { customerId, passTypeId } = await base()
        const sessionId = await session('public', 10, 2)
        const passId = await put('customer_session_passes', { customer_id: customerId, pass_type_id: passTypeId, sessions_remaining: 3, expiry_date: expiry })
        const orderId = await order(customerId, 10, {})
        const bookingId = await put('bookings', {
          session_id: sessionId, customer_id: customerId, party_size: 1, status: 'confirmed', price_paid: 0, redemption_source: 'session_pass_credit', redeemed_session_pass_id: passId,
        })
        await put('order_line_items', { order_id: orderId, item_type: 'booking', quantity: 1, unit_price: 10, line_total: 10, booking_id: bookingId })
        const { rollbackReaderOrder } = await load('shared/readerOrderRollback.ts')
        expect(await rollbackReaderOrder(orderId)).toEqual({ rolledBack: true })
        const [viaRollback] = await rows<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes')
        await database.pg.query('UPDATE customer_session_passes SET sessions_remaining = 3')
        await releaseSessionPassCredit(passId)
        const [viaHelper] = await rows<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes')
        expect([viaRollback?.n, viaHelper?.n]).toEqual([expected, expected])
      })
    }

    it('membership add-on credit', async () => {
      const { releaseMembershipAddonCredit } = await load('shared/creditRedemption.ts')
      const { orderId } = await everything()
      await cancel(orderId)
      const [viaRollback] = await rows<{ id: string; n: number }>('SELECT id, addon_credits_remaining AS n FROM customer_memberships')
      await database.pg.query('UPDATE customer_memberships SET addon_credits_remaining = 2')
      await releaseMembershipAddonCredit(viaRollback?.id, 3)
      const [viaHelper] = await rows<{ n: number }>('SELECT addon_credits_remaining AS n FROM customer_memberships')
      expect([viaRollback?.n, viaHelper?.n]).toEqual([5, 5])
    })
  })

  describe('bug 9: gift cards', () => {
    it('clears redeemed_at on a part-used card this order drained', async () => {
      const { orderId } = await everything()
      await cancel(orderId)
      const [card] = await rows<{ remaining_balance: string; redeemed_at: string | null }>(`SELECT remaining_balance, redeemed_at FROM gift_cards WHERE code = 'USED'`)
      expect(Number(card?.remaining_balance)).toBe(15)
      expect(card?.redeemed_at).toBeNull()
    })

    it('leaves redeemed_at alone on a card this order did not drain', async () => {
      const { orderId } = await everything()
      await database.pg.exec(`UPDATE gift_cards SET remaining_balance = 5 WHERE code = 'USED'`)
      await cancel(orderId)
      const [card] = await rows<{ remaining_balance: string; redeemed_at: string | null }>(`SELECT remaining_balance, redeemed_at FROM gift_cards WHERE code = 'USED'`)
      expect(Number(card?.remaining_balance)).toBe(20)
      expect(card?.redeemed_at).not.toBeNull()
    })

    it('deletes the card the order bought, and its redemption rows', async () => {
      const { orderId } = await everything()
      await cancel(orderId)
      expect(await rows(`SELECT id FROM gift_cards WHERE code = 'BOUGHT'`)).toHaveLength(0)
      expect(await rows('SELECT id FROM gift_card_redemptions')).toHaveLength(0)
    })
  })

  describe('money taken, then finalise fails: refund once, roll back once, never finalise', () => {
    const failing = async () => {
      stripe.piStatus = 'succeeded'
      stripe.cardReusable = false
      return buyNewMembership({ save_card: true })
    }

    it('a clean failure refunds in full and rolls back', async () => {
      const { orderId, before } = await failing()
      const result = await finalise(orderId)
      expect(result).toEqual({
        finalised: false,
        orderId,
        reason: 'card_not_reusable',
        message: expect.stringMatching(/^Saving the card for the membership failed: .* The customer's card has been refunded in full \(payment pi_test_1\) and the order was rolled back\.$/),
      })
      expect(stripe.refunded).toBe(40)
      expect(await figures()).toEqual(before)
      await expectNothingLeft('refund')
    })

    for (const mode of ['before', 'after'] as const) {
      it(`fails at every statement in turn (${mode} it runs), then the sweep runs twice`, async () => {
        const total = await countStatements(failing, finalise)
        expect(total).toBeGreaterThan(10)
        for (let at = 1; at <= total; at += 1) {
          await reset()
          const { orderId, before } = await failing()
          arm(at, mode)
          await survive(() => finalise(orderId))
          disarm()
          await sweep()
          await sweep()
          const label = `statement ${at} of ${total}, ${mode}`
          expect(stripe.refunded, label).toBe(40)
          expect(await figures(), label).toEqual(before)
          await expectNothingLeft(label)
        }
      })
    }

    it('the sweep can never finalise an order whose rollback has started, however Stripe reads', async () => {
      const { orderId } = await failing()
      Object.assign(fault, { mode: 'before', match: /DELETE FROM orders/ })
      await finalise(orderId)
      stripe.cardReusable = true // the failure that started it has cleared up
      expect(stripe.piStatus).toBe('succeeded')
      expect(await finalise(orderId)).toEqual({
        finalised: false,
        orderId,
        reason: 'rollback_started',
        message: "This order is already being rolled back, so it can't be finalised.",
      })
      await sweep()
      expect(stripe.subscriptionsCreated).toBe(0)
      expect(await rows(`SELECT id FROM orders WHERE payment_status = 'paid'`)).toHaveLength(0)
      expect(stripe.refunded).toBe(40)
    })

    it('a refund that went through is not asked for again when the rollback is picked up', async () => {
      const { orderId } = await failing()
      Object.assign(fault, { mode: 'before', match: /DELETE FROM orders/ })
      await finalise(orderId)
      disarm()
      await sweep()
      expect(stripe.refundCalls).toBe(1)
      await expectNothingLeft('picked up')
    })

    it('says what is left to do when the rollback stops after the refund', async () => {
      const { orderId } = await failing()
      Object.assign(fault, { mode: 'before', match: /DELETE FROM orders/ })
      const result = await finalise(orderId)
      expect(result.reason).toBe('card_not_reusable')
      expect(result.message).toContain(
        "The customer's card has been refunded in full (payment pi_test_1), but the order couldn't be fully rolled back yet. It's still on the Orders page, and Resolve now will finish it once it's 15 minutes old (delete pending order: database unavailable)."
      )
    })

    it('a failed refund gives nothing back until the refund goes through', async () => {
      const { orderId, before } = await failing()
      stripe.refundBroken = true
      const held = await figures()
      const result = await finalise(orderId)
      expect(result.reason).toBe('refund_failed')
      expect(result.message).toContain("AND the automatic refund failed — the customer's card was charged £40.00 with no order kept. REFUND £40.00 in Stripe (payment pi_test_1) NOW, then rebuild the order.")
      expect(await figures()).toEqual(held)

      const swept = await sweep()
      expect(swept.failed[0]?.reason).toBe(
        'The automatic refund failed again (Failed to refund payment: The bank is down.). REFUND £40.00 in Stripe (payment pi_test_1) NOW. The order finishes cancelling the next time Resolve now runs after that.'
      )
      expect(await figures()).toEqual(held)

      stripe.refundBroken = false
      await sweep()
      expect(stripe.refunded).toBe(40)
      expect(await figures()).toEqual(before)
      await expectNothingLeft('refund retried')
    })

    it('finishes after staff refund by hand, without refunding again', async () => {
      const { orderId, before } = await failing()
      stripe.refundBroken = true
      await finalise(orderId)
      stripe.refundBroken = false
      stripe.refunded = 40 // done by hand in Stripe
      await sweep()
      expect(stripe.refunded).toBe(40)
      expect(await figures()).toEqual(before)
      await expectNothingLeft('manual refund')
    })

    it('makes no refund when the order cannot be marked for one', async () => {
      const { orderId } = await failing()
      Object.assign(fault, { mode: 'before', match: /jsonb_build_object/ })
      const result = await finalise(orderId)
      expect(result.reason).toBe('refund_failed')
      expect(result.message).toBe(
        "Finalisation failed (Saving the card for the membership failed: This card cannot be saved for future off-session charges — Stripe reports the captured payment method is not reusable (intent: pi_test_1, resolved payment method: pm_1).) and the order couldn't be set up for its refund (database unavailable), so no refund was made — the customer's card was charged £40.00. Check the order first, and if it isn't paid, REFUND £40.00 in Stripe (payment pi_test_1) NOW, then rebuild the order."
      )
      expect(stripe.refundCalls).toBe(0)
    })
  })

  describe('bug 7: the order is marked paid whenever the money was taken', () => {
    it('a failed card save with no membership completes the order, with the warning', async () => {
      stripe.piStatus = 'succeeded'
      stripe.cardReusable = false
      const { orderId } = await everything({ save_card: true })
      const held = await figures()
      expect(await finalise(orderId)).toEqual({
        finalised: true,
        orderId,
        paymentIntentId: PI,
        warning: "The card couldn't be saved for future charges.",
      })
      const [paid] = await rows<Row>('SELECT payment_status, stripe_payment_intent_id, payment_method FROM orders')
      expect(paid).toEqual({ payment_status: 'paid', stripe_payment_intent_id: PI, payment_method: 'reader' })
      expect(await rows(`SELECT id FROM event_bookings WHERE status = 'confirmed'`)).toHaveLength(1)
      expect(await figures()).toEqual(held)
      expect(stripe.refundCalls).toBe(0)
      expect(await sweep()).toMatchObject({ checked: 0 })
    })

    it('a card save the Worker call fails on counts the same', async () => {
      stripe.piStatus = 'succeeded'
      const { orderId } = await everything({ save_card: true })
      vi.stubGlobal('paddockBackendApi2', {
        rawRequest: async (request: { path: string; body: Row }) => {
          if (request.path === '/api/terminal/resolve-saved-card') throw new Error('Worker down')
          return rawRequest(request)
        },
      })
      expect(await finalise(orderId)).toMatchObject({ finalised: true, warning: "The card couldn't be saved for future charges." })
      expect(await rows(`SELECT id FROM orders WHERE payment_status = 'paid'`)).toHaveLength(1)
    })

    it('keeps both warnings when the address fails too', async () => {
      stripe.piStatus = 'succeeded'
      stripe.cardReusable = false
      const { orderId } = await everything({ save_card: true, save_address_to_customer: true })
      Object.assign(fault, { mode: 'before', match: /SELECT shipping_address/ })
      const result = await finalise(orderId)
      expect(result.finalised).toBe(true)
      expect(result.warning).toBe(
        "The card couldn't be saved for future charges. The order completed, but saving the delivery address to the customer's profile failed and needs a manual check: database unavailable"
      )
    })

    it('a saved card gives no warning', async () => {
      stripe.piStatus = 'succeeded'
      const { orderId } = await everything({ save_card: true })
      expect(await finalise(orderId)).toEqual({ finalised: true, orderId, paymentIntentId: PI })
    })

    it('the cancel path that finds the money taken shows the same result', async () => {
      stripe.piStatus = 'succeeded'
      stripe.cardReusable = false
      const { orderId } = await everything({ save_card: true })
      const result = await cancel(orderId)
      expect(result).toMatchObject({ cancelled: false, finalisedInstead: true, finaliseResult: { finalised: true, warning: "The card couldn't be saved for future charges." } })
      expect(await rows(`SELECT id FROM orders WHERE payment_status = 'paid'`)).toHaveLength(1)
    })

    it('never says completed when no row was marked paid', async () => {
      stripe.piStatus = 'succeeded'
      const { orderId } = await everything()
      // Another run rolled the order back between this run's check and its mark.
      const real = query
      vi.stubGlobal('paddockData', {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes(`payment_status = 'paid', stripe_payment_intent_id`)) {
            await database.pg.query(`UPDATE orders SET reader_payment = jsonb_set(reader_payment, '{rollback}', '{"done":{}}'::jsonb) WHERE id = $1`, [orderId])
          }
          return real(sql, params)
        },
      })
      expect(await finalise(orderId)).toEqual({
        finalised: false,
        orderId,
        reason: 'unexpected_state',
        message: "The order changed while it was being finalised, so it wasn't marked paid. Check the order and the payment (pi_test_1) in Stripe before doing anything.",
      })
    })

    it('reports a run that lost the race to another finalise as already finalised', async () => {
      stripe.piStatus = 'succeeded'
      const { orderId } = await everything()
      const real = query
      vi.stubGlobal('paddockData', {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes(`payment_status = 'paid', stripe_payment_intent_id`)) {
            await database.pg.query(`UPDATE orders SET payment_status = 'paid', stripe_payment_intent_id = $1 WHERE id = $2`, [PI, orderId])
          }
          return real(sql, params)
        },
      })
      expect(await finalise(orderId)).toMatchObject({ finalised: true, alreadyFinalised: true })
    })

    it('every other way out before the money is proven leaves the order untouched and says so', async () => {
      const { orderId } = await everything()
      const held = await figures()
      stripe.piStatus = 'requires_payment_method'
      expect(await finalise(orderId)).toMatchObject({ finalised: false, reason: 'payment_not_succeeded' })
      stripe.piStatus = 'succeeded'
      stripe.orderId = 'someone-else'
      expect(await finalise(orderId)).toMatchObject({ finalised: false, reason: 'metadata_mismatch' })
      stripe.orderId = orderId
      stripe.charged = 61
      expect(await finalise(orderId)).toMatchObject({ finalised: false, reason: 'amount_mismatch' })
      expect(await rows(`SELECT id FROM orders WHERE payment_status = 'pending'`)).toHaveLength(1)
      expect(await figures()).toEqual(held)
      expect(stripe.refundCalls).toBe(0)
    })
  })

  describe('bug 10: no subscription outlives a failed finalise', () => {
    const membershipOrder = async () => {
      stripe.piStatus = 'succeeded'
      return buyNewMembership({ save_card: true })
    }

    for (const [name, match] of [
      ['the membership write', /UPDATE customer_memberships\s+SET stripe_subscription_id/],
      ['marking the order paid', /payment_status = 'paid', stripe_payment_intent_id/],
    ] as const) {
      it(`cancels it, refunds and rolls back when ${name} fails`, async () => {
        const { orderId, before } = await membershipOrder()
        Object.assign(fault, { mode: 'before', match })
        const result = await finalise(orderId)
        expect(result).toMatchObject({ finalised: false, reason: 'finalise_failed' })
        expect(stripe.subscriptionsCreated).toBe(1)
        expect(stripe.subscriptionsCancelled).toBe(1)
        expect(stripe.refunded).toBe(40)
        disarm()
        expect(await figures()).toEqual(before)
        await expectNothingLeft(name)
      })
    }

    it('cancels it when the event confirmation fails', async () => {
      stripe.piStatus = 'succeeded'
      const { planId, customerId } = await (async () => {
        const made = await everything({ save_card: true })
        const [plan] = await rows<{ id: string }>('SELECT id FROM membership_plans')
        return { planId: plan?.id, customerId: made.customerId }
      })()
      expect(customerId).toBeTruthy()
      const [held] = await rows<{ id: string }>('SELECT id FROM orders')
      const lineId = await put('order_line_items', { order_id: held?.id, item_type: 'membership', quantity: 1, unit_price: 0, line_total: 0, membership_plan_id: planId })
      expect(lineId).toBeTruthy()
      await database.pg.query(`UPDATE orders SET reader_payment = jsonb_set(reader_payment, '{membership}', $1::jsonb)`, [
        JSON.stringify({ plan_id: planId, plan_name: 'Core', billing_frequency: 'monthly', price: 40, first_payment_amount: 40 }),
      ])
      Object.assign(fault, { mode: 'before', match: /UPDATE event_bookings SET status = 'confirmed'/ })
      const result = await finalise(held?.id as string)
      expect(result.reason).toBe('finalise_failed')
      expect(stripe.subscriptionsCancelled).toBe(1)
      expect(await rows('SELECT id FROM orders')).toHaveLength(0)
    })

    it('tells staff to cancel it by hand when Stripe refuses', async () => {
      const { orderId } = await membershipOrder()
      stripe.subscriptionCancelBroken = true
      Object.assign(fault, { mode: 'before', match: /payment_status = 'paid', stripe_payment_intent_id/ })
      const result = await finalise(orderId)
      expect(result.message).toContain('The membership subscription (sub_1) could not be cancelled: CANCEL IT in Stripe NOW (Stripe is down).')
    })

    it('a membership with no line to attach to cancels the subscription too', async () => {
      stripe.piStatus = 'succeeded'
      const { orderId } = await buyNewMembership({ save_card: true })
      await database.pg.query(`UPDATE orders SET reader_payment = reader_payment #- '{membership,membership_row_id}'`)
      await database.pg.exec(`
        UPDATE customer_memberships SET order_line_item_id = NULL;
        UPDATE order_line_items SET item_type = 'postage' WHERE item_type = 'membership';
      `)
      const result = await finalise(orderId)
      expect(result).toMatchObject({ finalised: false, reason: 'finalise_failed' })
      expect(stripe.subscriptionsCancelled).toBe(1)
      expect(stripe.refunded).toBe(40)
    })

    it('a subscription Stripe refuses to create is refunded with nothing to cancel', async () => {
      const { orderId, before } = await membershipOrder()
      stripe.subscriptionBroken = true
      expect(await finalise(orderId)).toMatchObject({ finalised: false, reason: 'subscription_failed' })
      expect(stripe.subscriptionsCancelled).toBe(0)
      expect(stripe.refunded).toBe(40)
      expect(await figures()).toEqual(before)
    })

    it('a clean membership finalise keeps its subscription and marks the order paid', async () => {
      const { orderId } = await membershipOrder()
      expect(await finalise(orderId)).toMatchObject({ finalised: true, membershipSubscriptionId: 'sub_1' })
      expect(stripe.subscriptionsCancelled).toBe(0)
      expect(await rows(`SELECT id FROM orders WHERE payment_status = 'paid'`)).toHaveLength(1)
    })
  })

  describe('bug 12: a flow payment that could not be marked is not recorded twice', () => {
    const moveFlow = async () => {
      stripe.piStatus = 'succeeded'
      stripe.charged = 20
      const { customerId, passTypeId } = await base()
      const oldSession = await session('public', 10, 4)
      const passId = await put('customer_session_passes', { customer_id: customerId, pass_type_id: passTypeId, sessions_remaining: 2, expiry_date: '2099-01-01' })
      const bookingId = await put('bookings', { session_id: oldSession, customer_id: customerId, party_size: 2, status: 'confirmed', price_paid: 20, redemption_source: 'paid' })
      stripe.orderId = bookingId
      const pendingId = await put('pending_reader_payments', {
        flow: 'move', record_id: bookingId, payment_intent_id: PI, expected_amount: 20, status: 'pending', created_at: OLD,
        snapshot: JSON.stringify({
          customer_id: customerId, description: 'Move', old_session_id: oldSession, party_size: 2, release_session_pass_on_finalise: true, old_redeemed_session_pass_id: passId,
        }),
      })
      return { pendingId }
    }
    const finaliseFlow = async (pendingId: string) => (await load('finaliseReaderPayment.ts')).default({ params: { pendingId }, user })

    it('a failed mark still reports the payment as done, and the sweep finishes it once', async () => {
      const { pendingId } = await moveFlow()
      Object.assign(fault, { mode: 'before', match: /UPDATE pending_reader_payments/ })
      const result = await finaliseFlow(pendingId)
      expect(result).toMatchObject({ finalised: true, warning: 'The payment was recorded, but these steps need a manual check: mark the payment finalised: database unavailable' })
      disarm()
      await sweep()
      await sweep()
      expect(await rows('SELECT id FROM orders')).toHaveLength(1)
      expect((await figures())['sessions']).toEqual([2])
      expect((await figures())['passes']).toEqual([3])
      expect(await rows(`SELECT id FROM pending_reader_payments WHERE status = 'finalised'`)).toHaveLength(1)
    })

    it('a clean finalise records once', async () => {
      const { pendingId } = await moveFlow()
      expect(await finaliseFlow(pendingId)).toMatchObject({ finalised: true })
      expect(await rows('SELECT id FROM orders')).toHaveLength(1)
      expect((await figures())['sessions']).toEqual([2])
    })

    it('a failed record still refunds and undoes', async () => {
      const { pendingId } = await moveFlow()
      Object.assign(fault, { mode: 'before', match: /INSERT INTO orders/ })
      expect(await finaliseFlow(pendingId)).toMatchObject({ finalised: false, reason: 'record_failed' })
      expect(stripe.refunded).toBe(20)
    })
  })

  describe('a cancel with no clear answer from Stripe gives nothing back', () => {
    const answers: Array<[string, Row]> = [
      ['an error page', { data: '<!DOCTYPE html><html>error</html>' }],
      ['an intent too far along to cancel', { data: { error: 'PaymentIntent cannot be cancelled in status processing', code: 'not_cancellable' } }],
      ['a Stripe failure', { data: { error: 'Stripe is down', code: 'stripe_error' } }],
    ]
    const answerWith = (response: Row) => {
      vi.stubGlobal('paddockBackendApi2', {
        rawRequest: async (request: { path: string; body: Row }) => (request.path === '/api/terminal/payment-intent' ? response : rawRequest(request)),
      })
    }

    for (const [name, response] of answers) {
      it(`checkout: ${name}`, async () => {
        const { orderId } = await everything()
        const held = await figures()
        answerWith(response)
        expect(await cancel(orderId)).toMatchObject({ cancelled: false, reason: 'stripe_error' })
        expect(await figures()).toEqual(held)
        expect(await rows(`SELECT id FROM orders WHERE reader_payment->'rollback' IS NULL`)).toHaveLength(1)
      })

      it(`flows: ${name}`, async () => {
        const { customerId } = await base()
        const sessionId = await session('public', 10, 4)
        const bookingId = await put('bookings', { session_id: sessionId, customer_id: customerId, party_size: 2, status: 'confirmed', price_paid: 20, redemption_source: 'paid' })
        const pendingId = await put('pending_reader_payments', {
          flow: 'settle', record_id: bookingId, payment_intent_id: PI, expected_amount: 20, status: 'pending', snapshot: JSON.stringify({ customer_id: customerId, description: 'Settle' }),
        })
        answerWith(response)
        const { default: cancelFlow } = await load('cancelReaderPayment.ts')
        expect(await cancelFlow({ params: { pendingId }, user })).toMatchObject({ cancelled: false, reason: 'stripe_error' })
        expect(await rows(`SELECT id FROM pending_reader_payments WHERE status = 'pending'`)).toHaveLength(1)
      })
    }

    it('an intent Stripe has never heard of took no money, so the order rolls back', async () => {
      const { orderId, before } = await everything()
      answerWith({ data: { error: 'No such payment_intent', code: 'not_found' } })
      expect(await cancel(orderId)).toMatchObject({ cancelled: true })
      expect(await figures()).toEqual(before)
    })
  })

  describe('the screen', () => {
    it('shows a cancel that did not finish, instead of saying the order was cancelled', () => {
      const source = readFileSync(path.join(appDir, 'frontend/components/CheckoutDialog.tsx'), 'utf8')
      const guard = source.indexOf('if (cancelResult && !cancelResult.cancelled)')
      const claim = source.indexOf('the order has been cancelled.')
      expect(guard).toBeGreaterThan(-1)
      expect(guard).toBeLessThan(claim)
      expect(source.slice(guard, claim)).toContain('setErrorMessage(cancelResult.message')
    })
  })
})

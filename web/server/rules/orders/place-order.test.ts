import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { orderDryRunOutputSchema, placeOrderOutputSchema, type OrderDryRunOutput } from '@/contracts'
import { POST as dryRunRoute } from '@/app/api/v1/staff/orders/dry-run/route'
import { createDb, type Db, type DbDriver, type DriverSession } from '@/server/db'
import { createPostgresDriver } from '@/server/db/postgres-driver'
import { insert } from '@/server/rules/testing/database'
import type { Recording } from '@/server/rules/testing/replay/compare'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type Scenario } from '@/server/rules/testing/replay/harness'
import { newOrderSide, oldResult, orderInput, postOrder, type OrderAnswer } from '@/server/rules/testing/replay/order-side'
import { ID, mo, memberCredit, paidSeat, sam, seed, seedCorePass, whileFailing, type WriteFailure } from '@/server/rules/testing/replay/scenarios'
import { herdWaitMessage } from './failure-messages'
import { readOrderRows } from './order-rows'
import { refusalCode, refusalDetails } from './order-refusal'
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
    const { result, statements } = await counting(() => postOrder(orderInput({ customerId: ID.customer, booking: paidSeat(), promoCode: 'ALLTEN', payment: cash(18) })))
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
    const recording = await replay(environment, dryScenario({ customerId: ID.customer, booking: paidSeat(), payment: { method: 'card' } }, answers), oldSide)
    expect(answers[0]).toMatchObject({ status: 501, body: { error: { code: 'NOT_BUILT', details: { notBuilt: ['card'] } } } })
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
